// scripts/syncPlayers.js
// Pull active NHL players (including injured, as long as they are "active") and write to PLAYERS_FILE.
// Output schema (backward-compatible):
//   id, fullName, firstName, lastName, position, teamAbbrev
//   + birthDate (NEW)
// Safety: only generates players.json; does NOT touch league state.

const fs = require("fs");
const path = require("path");

const DEFAULT_PLAYERS_FILE = path.join(__dirname, "..", "players.json");
const PLAYERS_FILE = process.env.PLAYERS_FILE || DEFAULT_PLAYERS_FILE;

function ensureDirSync(dirPath) {
  if (!dirPath) return;
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (k == null || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

// NHL web API base (player landing, etc.)
const NHL_BASE = "https://api-web.nhle.com/v1";
// NHL search index (best “all active players” source)
const NHL_SEARCH_BASE = "https://search.d3.nhle.com/api/v1/search";

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "hundo-leago/phase2 (players sync)",
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${url} ${txt}`.slice(0, 500));
  }
  return res.json();
}

// NHL API often returns name fields like { default: "Connor" }.
// This safely pulls a usable string out of either a string or object.
function pickName(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();

  if (typeof v === "object") {
    // common NHL shape: { default: "Connor" }
    if (typeof v.default === "string") return v.default.trim();

    // fallback: first string value inside the object
    for (const val of Object.values(v)) {
      if (typeof val === "string" && val.trim()) return val.trim();
    }
  }

  return "";
}

function normalizeNameParts(fullName) {
  const name = String(fullName || "").trim();
  if (!name) return { fullName: "", firstName: "", lastName: "" };

  // Simple split: first token = first name, rest = last
  const parts = name.split(/\s+/);
  if (parts.length === 1) return { fullName: name, firstName: name, lastName: "" };

  return {
    fullName: name,
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

function normalizePosition(pos) {
  const p = String(pos || "").toUpperCase().trim();
  if (p === "D") return "D";
  if (p === "G") return "G";
  // treat anything else as F (C/LW/RW usually appear)
  return "F";
}

// Pull “all active players” from NHL search index.
// This is more complete than walking /roster/{TEAM}/current.
async function fetchAllActivePlayersFromSearchIndex() {
  // q=* returns the full index; active=true filters to active NHL players.
  // Use a very high limit to avoid truncation.
  const url = `${NHL_SEARCH_BASE}/player?culture=en-us&limit=50000&q=*&active=true`;

  const data = await fetchJson(url);

  // Sometimes it's an array, sometimes wrapped — handle both.
  const rows = Array.isArray(data) ? data : Array.isArray(data?.docs) ? data.docs : [];

  const players = [];

  for (const r of rows) {
    // Different shapes exist; be defensive.
    const id = Number(r?.playerId ?? r?.id ?? r?.player_id ?? r?.playerID);
    if (!Number.isFinite(id) || id <= 0) continue;

       // NHL search index uses `name` as the full name (e.g., "Artur Akhtyamov")
    const full = pickName(r?.name);
    const nameParts = normalizeNameParts(full);


    const teamAbbrevRaw =
      pickName(r?.teamAbbrev) ||
      pickName(r?.teamAbbreviation) ||
      pickName(r?.triCode) ||
      pickName(r?.currentTeamAbbrev);

    const posRaw =
      pickName(r?.position) ||
      pickName(r?.positionCode) ||
      pickName(r?.position_code);

    // birthDate might be present on the index for some players
    const birthDate = pickName(r?.birthDate ?? r?.birth_date) || null;

    players.push({
      id,
      ...nameParts,
      position: normalizePosition(posRaw),
      teamAbbrev: teamAbbrevRaw ? String(teamAbbrevRaw).toUpperCase() : "",
      birthDate, // NEW FIELD
      active: true,
    });
  }

  return players;
}

// If some players are missing birthDate in the search index,
// fill it from /v1/player/{id}/landing (specific player info).
async function fillMissingBirthDates(players, { concurrency = 8 } = {}) {
  const need = players.filter((p) => !p.birthDate && Number.isFinite(p?.id));
  if (!need.length) return players;

  console.log(
    `[syncPlayers] birthDate missing for ${need.length} players; filling via /player/{id}/landing`
  );

  let i = 0;

  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= need.length) return;

      const p = need[idx];
      try {
        const info = await fetchJson(`${NHL_BASE}/player/${p.id}/landing`);
        const bd = pickName(info?.birthDate) || pickName(info?.birth_date) || null;
        if (bd) p.birthDate = bd;
      } catch (e) {
        // Don't fail the whole sync for one player.
        console.warn(`[syncPlayers] birthDate fill failed for ${p.id}: ${e?.message || e}`);
      }
    }
  }

  const n = Math.max(1, Math.min(32, Number(concurrency) || 8));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return players;
}

async function main() {
  ensureDirSync(path.dirname(PLAYERS_FILE));

  console.log(`[syncPlayers] writing to: ${PLAYERS_FILE}`);

  const all = await fetchAllActivePlayersFromSearchIndex();
  if (!all.length) {
    throw new Error("No players returned from NHL search index. Response shape may have changed.");
  }

  console.log(`[syncPlayers] active players fetched: ${all.length}`);

  // Fill missing birthdates (safe: only touches players.json generation)
  await fillMissingBirthDates(all, { concurrency: 8 });

  // Deduplicate by player id (defensive)
  const unique = uniqBy(all, (p) => p.id);

  // Sort for stable diffs
  unique.sort((a, b) => {
    const la = String(a.lastName || "");
    const lb = String(b.lastName || "");
    if (la !== lb) return la.localeCompare(lb);
    const fa = String(a.firstName || "");
    const fb = String(b.firstName || "");
    if (fa !== fb) return fa.localeCompare(fb);
    return (a.id || 0) - (b.id || 0);
  });

  const tmp = `${PLAYERS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(unique, null, 2), "utf8");
  fs.renameSync(tmp, PLAYERS_FILE);

  const missingTeam = unique.filter((p) => !p.teamAbbrev).length;
  const missingBD = unique.filter((p) => !p.birthDate).length;

  console.log(
    `[syncPlayers] DONE. players: ${unique.length} (missing teamAbbrev: ${missingTeam}, missing birthDate: ${missingBD})`
  );
}

main().catch((e) => {
  console.error("[syncPlayers] fatal:", e);
  process.exit(1);
});
