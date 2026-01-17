// scripts/syncPlayers.js
// Pull active NHL players and write to PLAYERS_FILE (or default players.json)

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

// NHL web API base
const NHL_BASE = "https://api-web.nhle.com/v1";

// standings/now gives active teams (includes triCode in teamAbbrev-ish fields)
async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "hundo-leago/phase2 (players sync)",
      "Accept": "application/json",
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

async function getActiveTeamTriCodes() {
  const data = await fetchJson(`${NHL_BASE}/standings/now`);

  // The exact JSON shape can vary; handle common patterns defensively.
  // Many responses include an array of standings rows.
  const rows =
    Array.isArray(data?.standings) ? data.standings :
    Array.isArray(data?.records) ? data.records :
    Array.isArray(data) ? data :
    [];

  const codes = [];
  for (const r of rows) {
    // Common: r.teamAbbrev?.default or r.teamAbbrev, or r.team?.abbrev
    const code =
      r?.teamAbbrev?.default ||
      r?.teamAbbrev ||
      r?.team?.abbrev ||
      r?.teamAbbrev?.trim?.();

    if (code && typeof code === "string") {
      codes.push(code.trim().toUpperCase());
    }
  }

  // Fallback if parsing fails: you can hardcode later, but usually not needed
  return Array.from(new Set(codes)).filter(Boolean);
}

async function fetchRosterForTeam(triCode) {
  // /roster/{TEAM}/current is commonly used and may redirect internally
  const url = `${NHL_BASE}/roster/${encodeURIComponent(triCode)}/current`;
  const data = await fetchJson(url);

  // The roster response typically has groups like forwards/defensemen/goalies
  // with items containing id + firstName/lastName or fullName.
  const groups = [
    { key: "forwards", defaultPos: "F" },
    { key: "defensemen", defaultPos: "D" },
    { key: "goalies", defaultPos: "G" },
  ];

  const players = [];

  for (const g of groups) {
    const arr = Array.isArray(data?.[g.key]) ? data[g.key] : [];
    for (const p of arr) {
      const id = Number(p?.id);
      if (!Number.isFinite(id) || id <= 0) continue;

        const first = pickName(p?.firstName);
      const last = pickName(p?.lastName);

      // Some endpoints may provide fullName (sometimes as { default: "..." })
      const full = pickName(p?.fullName) || `${first} ${last}`.trim();

      const nameParts = normalizeNameParts(full);

      players.push({
        id,
        ...nameParts,
        position: normalizePosition(p?.position || g.defaultPos),
        teamAbbrev: triCode,
        active: true,
      });
    }
  }

  return players;
}

async function main() {
  ensureDirSync(path.dirname(PLAYERS_FILE));

  console.log(`[syncPlayers] writing to: ${PLAYERS_FILE}`);

  const teamCodes = await getActiveTeamTriCodes();
  if (!teamCodes.length) {
    throw new Error("No team codes found from standings/now. NHL response shape may have changed.");
  }

  console.log(`[syncPlayers] teams found: ${teamCodes.length}`);

  const all = [];
  for (const code of teamCodes) {
    try {
      const rosterPlayers = await fetchRosterForTeam(code);
      console.log(`[syncPlayers] ${code}: ${rosterPlayers.length} players`);
      all.push(...rosterPlayers);
    } catch (e) {
      console.error(`[syncPlayers] ${code}: FAILED`, e?.message || e);
    }
  }

  // Deduplicate by player id (a player might appear in multiple places depending on endpoint quirks)
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

  console.log(`[syncPlayers] DONE. players: ${unique.length}`);
}

main().catch((e) => {
  console.error("[syncPlayers] fatal:", e);
  process.exit(1);
});
