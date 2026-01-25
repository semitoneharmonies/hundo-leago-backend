// server.js (CommonJS)
// -------------------------------
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const { createLeagueStore } = require("./leagueStore");

const app = express();
const PORT = process.env.PORT || 4000;

// -------------------------------
// CORS allowlist (Netlify + local dev)
// -------------------------------
const allowlist = [
  "http://localhost:5173",
"http://localhost:5174",
"http://127.0.0.1:5173",
"http://127.0.0.1:5174",
"https://hundoleago.netlify.app",
"https://hundoleago.netlify.app",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

// Express CORS (for fetch /api/league)
// Express CORS (for fetch /api/*)
app.use(
  cors({
    origin: function (origin, cb) {
      if (isAllowedOrigin(origin)) return cb(null, true);
      return cb(new Error("CORS blocked: " + origin));
    },
    credentials: true,
  })
);



app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// -------------------------------
// Socket.IO server
// -------------------------------
const server = http.createServer(app);

function isAllowedOrigin(origin) {
  if (!origin) return true; // curl/postman/no-origin
  if (allowlist.includes(origin)) return true;

  // Optional: allow Netlify preview deploys
  try {
    const u = new URL(origin);
    if (u.hostname.endsWith(".netlify.app")) return true;
  } catch {}
  return false;
}

const io = new Server(server, {
  cors: {
    origin: (origin, cb) => {
      if (isAllowedOrigin(origin)) return cb(null, true);
      return cb(new Error("Socket CORS blocked: " + origin));
    },
    methods: ["GET", "POST"],
    credentials: true,
  },
});


// ===============================
//   PERSISTENT STORAGE PATHS
// ===============================
//
// On Render you set:
//   LEAGUE_FILE  = /opt/render/project/data/hundo/league-state.json
//   SNAPSHOT_DIR = /opt/render/project/data/hundo/snapshots
//
// Locally it will fall back to files next to server.js.

const DATA_FILE =
  process.env.LEAGUE_FILE || path.join(__dirname, "league-state.json");

const SNAPSHOT_DIR =
  process.env.SNAPSHOT_DIR || path.join(__dirname, "snapshots");
// Phase 2A: players database file (separate from league state)
//
// IMPORTANT:
// On Render, do NOT derive this from DATA_FILE. DATA_FILE can be /data/... depending on your env,
// while Render’s persistent disk is /opt/render/project/data.
// Default to the same /opt/render/project/data/hundo folder you use for league-state.json.
const DEFAULT_PLAYERS_FILE = "/opt/render/project/data/hundo/players.json";
const PLAYERS_FILE =
  process.env.PLAYERS_FILE ||
  (String(process.env.LEAGUE_FILE || "").includes("/opt/render/project/data/")
    ? path.join(path.dirname(process.env.LEAGUE_FILE), "players.json")
    : DEFAULT_PLAYERS_FILE);

// Phase 2B: stats cache file (separate from league state + players DB)
const DEFAULT_STATS_FILE = "/opt/render/project/data/hundo/stats-cache.json";
const STATS_FILE =
  process.env.STATS_FILE ||
  (String(process.env.LEAGUE_FILE || "").includes("/opt/render/project/data/")
    ? path.join(path.dirname(process.env.LEAGUE_FILE), "stats-cache.json")
    : DEFAULT_STATS_FILE);

// Ensure dirs exist (important on Render disk paths)
function ensureDirSync(dirPath) {
  try {
    if (!dirPath) return;
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
  } catch (e) {
    console.error("[BACKEND] Failed to ensure directory:", dirPath, e);
  }
}
ensureDirSync(path.dirname(DATA_FILE));
ensureDirSync(SNAPSHOT_DIR);
ensureDirSync(path.dirname(PLAYERS_FILE));
ensureDirSync(path.dirname(STATS_FILE));

// If players file is missing on the Render disk, bootstrap it from repo players.json (one-time).
// This avoids “empty DB” in production after deploys.
try {
  if (!fs.existsSync(PLAYERS_FILE)) {
    const repoPlayers = path.join(__dirname, "players.json");
    if (fs.existsSync(repoPlayers)) {
      fs.copyFileSync(repoPlayers, PLAYERS_FILE);
      console.log("[PLAYERS] bootstrapped players.json to", PLAYERS_FILE);
    } else {
      console.warn("[PLAYERS] missing both disk and repo players.json; DB will be empty until synced");
    }
  }
} catch (e) {
  console.error("[PLAYERS] bootstrap copy failed:", e?.message || e);
}

// -------------------------------
// LeagueStore (Phase 1: atomic + queued writes)
// -------------------------------
const BACKUPS_DIR =
  process.env.BACKUPS_DIR || path.join(path.dirname(DATA_FILE), "backups");

ensureDirSync(BACKUPS_DIR);

const leagueStore = createLeagueStore({
  dataFilePath: DATA_FILE,
  backupsDirPath: BACKUPS_DIR,
  maxBackups: Number(process.env.MAX_BACKUPS || 200) || 200,
});

// ===============================
// Phase 2A — Player DB (file-backed)
// ===============================
let playersCache = [];
let playersById = new Map();

function normalizeStr(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function buildSearchHaystack(p) {
  const full = p.fullName || `${p.firstName || ""} ${p.lastName || ""}`.trim();
  const first = p.firstName || "";
  const last = p.lastName || "";
  const lastFirst = `${last}, ${first}`.trim();
  return normalizeStr([full, first, last, lastFirst].filter(Boolean).join(" | "));
}

function loadPlayersFromDisk() {
  try {
    if (!fs.existsSync(PLAYERS_FILE)) {
      playersCache = [];
      playersById = new Map();
      return { ok: true, count: 0, source: "missing-file" };
    }

    const raw = fs.readFileSync(PLAYERS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.players)
      ? parsed.players
      : [];

    // Helper: pick first non-empty string from several possible keys
    const pickStr = (obj, keys) => {
      for (const k of keys) {
        const v = obj?.[k];
        if (v == null) continue;
        const s = String(v).trim();
        if (s) return s;
      }
      return "";
    };

    const pickNum = (obj, keys) => {
      for (const k of keys) {
        const v = obj?.[k];
        const n = Number(v);
        if (Number.isFinite(n)) return n;
      }
      return NaN;
    };

    playersCache = arr
      .filter(Boolean)
      .map((p) => {
        const id = pickNum(p, ["id", "playerId", "player_id"]);
        const fullName = pickStr(p, ["fullName", "full_name", "name", "playerName"]);
        const firstName = pickStr(p, ["firstName", "first_name", "first"]);
        const lastName = pickStr(p, ["lastName", "last_name", "last"]);
        const position = pickStr(p, ["position", "pos"]) || null;
        const teamAbbrev = pickStr(p, ["teamAbbrev", "team_abbrev", "team", "teamAbbreviation"]) || null;
        const birthDate = pickStr(p, ["birthDate", "birth_date", "dob", "dateOfBirth"]) || null;


        // active can be missing; treat missing as true
        const activeRaw = p?.active;
        const active = activeRaw === undefined ? true : activeRaw !== false;

        return {
          id,
          fullName,
          firstName,
          lastName,
          position,
          teamAbbrev,
          active,
          birthDate,
        };
      })
      .filter((p) => Number.isFinite(p.id) && p.id > 0);

    playersById = new Map(playersCache.map((p) => [p.id, p]));

    // 🔎 One very useful debug print so we can see if names loaded

    return { ok: true, count: playersCache.length, source: PLAYERS_FILE };
  } catch (e) {
    console.error("[PLAYERS] Failed to load players:", e);
    playersCache = [];
    playersById = new Map();
    return { ok: false, count: 0, error: String(e?.message || e) };
  }
}

function searchPlayers(query, limit = 25) {
  const q = normalizeStr(query);
  if (!q) return [];

  const tokens = q.split(" ").filter(Boolean);
  const out = [];

  for (const p of playersCache) {
    if (!p?.active) continue;

    const hay = buildSearchHaystack(p);

    // Match ALL tokens anywhere in the haystack
    const ok = tokens.every((t) => hay.includes(t));
    if (ok) out.push(p);

    if (out.length >= limit) break;
  }

  return out;
}


// Load players on boot
const playersLoad = loadPlayersFromDisk();
console.log("[PLAYERS] PLAYERS_FILE =", PLAYERS_FILE);

console.log(
  `[PLAYERS] loaded: ok=${playersLoad.ok} count=${playersLoad.count} source=${playersLoad.source || "?"}`
);

// -------------------------------
// Time helpers (Pacific time window checks)
// -------------------------------
function getPartsInTZ(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const out = {};
  for (const p of parts) {
    if (p.type !== "literal") out[p.type] = p.value;
  }
  return out; // { weekday, year, month, day, hour, minute }
}

// -------------------------------
// Phase 3 — Matchups helpers (PT scheduling + round robin)
// -------------------------------
const PT_TZ = "America/Los_Angeles";
const DAY_MS = 24 * 60 * 60 * 1000;

// Convert "Mon"/"Tue"/... to index where Mon=0 ... Sun=6
function weekdayIndexPT(shortWeekday) {
  const map = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return map[shortWeekday] ?? 0;
}

// Make a UTC timestamp that corresponds to a local time in a given TZ.
// Uses a tiny correction loop so it works across DST.
function makeUtcMsForTZ({ year, month, day, hour = 0, minute = 0 }, timeZone) {
  // initial guess (UTC)
  let d = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), 0));

  // correct once or twice (DST-safe)
  for (let i = 0; i < 3; i++) {
    const p = getPartsInTZ(d, timeZone);
    const gotY = Number(p.year);
    const gotM = Number(p.month);
    const gotD = Number(p.day);
    const gotH = Number(p.hour);
    const gotMin = Number(p.minute);

    const wantY = Number(year);
    const wantM = Number(month);
    const wantD = Number(day);
    const wantH = Number(hour);
    const wantMin = Number(minute);

    // compute minute delta (rough but effective)
    const got = Date.UTC(gotY, gotM - 1, gotD, gotH, gotMin, 0);
    const want = Date.UTC(wantY, wantM - 1, wantD, wantH, wantMin, 0);
    const deltaMs = want - got;

    if (Math.abs(deltaMs) < 1000) break;
    d = new Date(d.getTime() + deltaMs);
  }

  return d.getTime();
}

// Get the upcoming Monday 00:00 PT (default schedule start)
function getNextMondayStartMsPT(nowMs = Date.now()) {
  const now = new Date(nowMs);
  const parts = getPartsInTZ(now, PT_TZ);

  // Anchor at local NOON today (noon always exists, DST-safe)
  const utcNoonToday = makeUtcMsForTZ(
    { year: parts.year, month: parts.month, day: parts.day, hour: 12, minute: 0 },
    PT_TZ
  );

  const dow = weekdayIndexPT(parts.weekday); // Mon=0..Sun=6
  const utcNoonMondayThisWeek = utcNoonToday - dow * DAY_MS;

  // Get local date parts for that Monday
  const mondayParts = getPartsInTZ(new Date(utcNoonMondayThisWeek), PT_TZ);

  const mondayStartThisWeekMs = makeUtcMsForTZ(
    { year: mondayParts.year, month: mondayParts.month, day: mondayParts.day, hour: 0, minute: 0 },
    PT_TZ
  );

  // If we're already past Monday 00:00 PT this week, start NEXT Monday
  if (nowMs >= mondayStartThisWeekMs) {
    const utcNoonNextMonday = utcNoonMondayThisWeek + 7 * DAY_MS;
    const nextMondayParts = getPartsInTZ(new Date(utcNoonNextMonday), PT_TZ);
    return makeUtcMsForTZ(
      { year: nextMondayParts.year, month: nextMondayParts.month, day: nextMondayParts.day, hour: 0, minute: 0 },
      PT_TZ
    );
  }

  // Otherwise (only possible very early Monday before 00:00, rare), start this week
  return mondayStartThisWeekMs;
}

// Circle method round-robin pairing for even N (e.g., 6 teams)
function generateRoundRobinPairs(teamNames) {
  const names = [...teamNames];
  const n = names.length;

  if (n < 2) return [];
  if (n % 2 !== 0) names.push("__BYE__");

  const teams = [...names];
  const rounds = teams.length - 1;
  const half = teams.length / 2;

  const schedule = [];

  for (let r = 0; r < rounds; r++) {
    const pairs = [];

    for (let i = 0; i < half; i++) {
      const a = teams[i];
      const b = teams[teams.length - 1 - i];
      if (a !== "__BYE__" && b !== "__BYE__") pairs.push([a, b]);
    }

    schedule.push(pairs);

    // rotate all but first
    const fixed = teams[0];
    const rest = teams.slice(1);
    rest.unshift(rest.pop());
    teams.splice(0, teams.length, fixed, ...rest);
  }

  return schedule; // length = N-1 rounds
}

// Build scheduleWeeks with default timing:
// - weekStartAtMs: first day 00:00 PT
// - weekEndAtMs: last day 23:59 PT (Sunday by default)
// - lockAtMs: first day at lockHour:lockMinute PT (default 16:00)
// - rolloverAtMs: next day after week end at 01:00 PT (default Monday 01:00 PT)
// Build scheduleWeeks with default timing:
// - weekStartAtMs: Monday 00:00 PT
// - weekEndAtMs: Sunday 23:59 PT
// - lockAtMs: Monday at lockHour:lockMinute PT (default 16:00)
// - rolloverAtMs: NEXT Monday 00:00 PT (== next week start; no overlap)
function buildScheduleWeeks({
  teamNames,
  startWeekMsPT,
  numWeeks = 26,
  lockHour = 16,
  lockMinute = 0,
  seasonId = null,
}) {
  const baseRoundPairs = generateRoundRobinPairs(teamNames);
  if (baseRoundPairs.length === 0) return [];

  const out = [];

  const startNoonMs = (() => {
    // Anchor to noon on the start date (DST-safe stepping by weeks)
    const p = getPartsInTZ(new Date(startWeekMsPT), PT_TZ);
    return makeUtcMsForTZ({ year: p.year, month: p.month, day: p.day, hour: 12, minute: 0 }, PT_TZ);
  })();

  for (let weekIndex = 0; weekIndex < numWeeks; weekIndex++) {
    const weekNoonMs = startNoonMs + weekIndex * 7 * DAY_MS;
    const wParts = getPartsInTZ(new Date(weekNoonMs), PT_TZ);

    // week start 00:00 PT (Monday)
    const weekStartAtMs = makeUtcMsForTZ(
      { year: wParts.year, month: wParts.month, day: wParts.day, hour: 0, minute: 0 },
      PT_TZ
    );

    // week end = Sunday 23:59 PT (6 days after start)
    const endNoonMs = weekNoonMs + 6 * DAY_MS;
    const endParts = getPartsInTZ(new Date(endNoonMs), PT_TZ);
    const weekEndAtMs = makeUtcMsForTZ(
      { year: endParts.year, month: endParts.month, day: endParts.day, hour: 23, minute: 59 },
      PT_TZ
    );

    // lock on first day (Monday) at lock time
    const lockAtMs = makeUtcMsForTZ(
      { year: wParts.year, month: wParts.month, day: wParts.day, hour: lockHour, minute: lockMinute },
      PT_TZ
    );

    // rollover at NEXT Monday 00:00 PT (== next week's start)
    const nextWeekNoonMs = weekNoonMs + 7 * DAY_MS;
    const nextParts = getPartsInTZ(new Date(nextWeekNoonMs), PT_TZ);
    const rolloverAtMs = makeUtcMsForTZ(
      { year: nextParts.year, month: nextParts.month, day: nextParts.day, hour: 0, minute: 0 },
      PT_TZ
    );

    const weekId = `${seasonId || wParts.year}-W${String(weekIndex + 1).padStart(2, "0")}`;
    const pairs = baseRoundPairs[weekIndex % baseRoundPairs.length];
const baselineAtMs = weekStartAtMs + 60 * 60 * 1000; // default +1h

    out.push({
      weekIndex,
      weekId,
      weekStartAtMs,
      baselineAtMs,
      weekEndAtMs,
      lockAtMs,
      rolloverAtMs,
      pairs,
    });
  }

  return out;
}


// -------------------------------
// Snapshots helpers
// -------------------------------
function buildAutoSnapshotId(partsPT) {
  // Example: auto-2025-12-14-1600PT
  return `auto-${partsPT.year}-${partsPT.month}-${partsPT.day}-${partsPT.hour}${partsPT.minute}PT`;
}

function writeSnapshotFile(snapshotId, state) {
  const file = path.join(SNAPSHOT_DIR, `${snapshotId}.json`);
  fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
  return snapshotId;
}

// -------------------------------
// Auto-weekly snapshot (Sunday 4:00 PM PT)
// -------------------------------
function tryAutoWeeklySnapshot() {
  try {
    const timeZone = "America/Los_Angeles";
    const partsPT = getPartsInTZ(new Date(), timeZone);

    if (partsPT.weekday !== "Sun") return;

    const hour = Number(partsPT.hour);
    const minute = Number(partsPT.minute);
    const inWindow = hour === 16 && minute >= 0 && minute <= 10;
    if (!inWindow) return;

    const snapshotId = buildAutoSnapshotId({
      ...partsPT,
      minute: "00",
    });

    const state = leagueStore.loadLeague();
    if (state.lastAutoWeeklySnapshotId === snapshotId) return;

    writeSnapshotFile(snapshotId, state);

    state.lastAutoWeeklySnapshotId = snapshotId;
    Promise.resolve(
  leagueStore.saveLeague(state, { savedBy: "system:autoWeeklySnapshot" })
).catch((e) => console.error("[AUTO SNAPSHOT] save failed:", e));



    console.log(`[AUTO SNAPSHOT] Created weekly snapshot: ${snapshotId}`);

    const ioRef = app.get("io");
    if (ioRef) ioRef.emit("league:updated", { reason: "autoWeeklySnapshot", snapshotId });
  } catch (err) {
    console.error("[AUTO SNAPSHOT] Failed:", err);
  }
}

// -------------------------------
// Auto-auction rollover (Sunday 4:00 PM PT)
// -------------------------------
const BUYOUT_LOCK_MS = 14 * 24 * 60 * 60 * 1000;

function buildAutoAuctionRolloverId(partsPT) {
  // Example: auction-2025-12-14-1600PT
  return `auction-${partsPT.year}-${partsPT.month}-${partsPT.day}-${partsPT.hour}${partsPT.minute}PT`;
}

function resolveAuctionsServer(state, nowMs) {
  const teams = Array.isArray(state.teams) ? state.teams : [];
  const bids = Array.isArray(state.freeAgents) ? state.freeAgents : [];
  const leagueLog = Array.isArray(state.leagueLog) ? state.leagueLog : [];

  const activeBids = bids.filter((b) => !b.resolved);
  if (activeBids.length === 0) {
    return { nextTeams: teams, nextFreeAgents: bids, nextLeagueLog: leagueLog, newLogs: [] };
  }

 // Group bids by auctionKey (preferred) or normalized player name
const bidsByPlayer = new Map();
for (const bid of activeBids) {
  const key = String(
    bid?.auctionKey || String(bid?.player || "").trim().toLowerCase()
  )
    .trim()
    .toLowerCase();

  if (!key) continue;
  if (!bidsByPlayer.has(key)) bidsByPlayer.set(key, []);
  bidsByPlayer.get(key).push(bid);
}


  const nextTeams = teams.map((t) => ({
    ...t,
    roster: [...(t.roster || [])],
    buyouts: [...(t.buyouts || [])],
  }));

  const resolvedBidIds = new Set();
  const newLogs = [];

  for (const [, playerBids] of bidsByPlayer.entries()) {
    const sorted = [...playerBids].sort((a, b) => {
      const aAmt = Number(a.amount) || 0;
      const bAmt = Number(b.amount) || 0;
      if (bAmt !== aAmt) return bAmt - aAmt;
      const aTs = a.timestamp || 0;
      const bTs = b.timestamp || 0;
      return aTs - bTs; // earlier wins ties
    });

    const winner = sorted[0];
    if (!winner) continue;

    const playerName = winner.player;
    const winningTeamName = winner.team;
    const newSalary = Number(winner.amount) || 0;
    const position = winner.position || "F";

    for (const bid of playerBids) resolvedBidIds.add(bid.id);

    const teamIdx = nextTeams.findIndex((t) => t.name === winningTeamName);
    if (teamIdx === -1) continue;

   nextTeams[teamIdx].roster.push({
  name: playerName,
  salary: newSalary,
  position,
  buyoutLockedUntil: nowMs + BUYOUT_LOCK_MS,
});

// Keep roster ordering consistent after auto-rollover:
// Forwards first, then Defense; salary high -> low; tie-break name A -> Z
nextTeams[teamIdx].roster.sort((a, b) => {
  const aIsD = (a?.position || "F") === "D";
  const bIsD = (b?.position || "F") === "D";
  if (aIsD !== bIsD) return aIsD ? 1 : -1;

  const sa = Number(a?.salary) || 0;
  const sb = Number(b?.salary) || 0;
  if (sb !== sa) return sb - sa;

  return String(a?.name || "").localeCompare(String(b?.name || ""));
});


    newLogs.push({
      type: "faSigned",
      id: nowMs + Math.random(),
      team: winningTeamName,
      player: playerName,
      amount: newSalary,
      position,
      timestamp: nowMs,
    });
  }

  const nextFreeAgents = bids.filter((bid) => !resolvedBidIds.has(bid.id));
  const nextLeagueLog = [...newLogs, ...leagueLog];

  return { nextTeams, nextFreeAgents, nextLeagueLog, newLogs };
}

function tryAutoAuctionRollover() {
  try {
    const timeZone = "America/Los_Angeles";
    const partsPT = getPartsInTZ(new Date(), timeZone);

    if (partsPT.weekday !== "Sun") return;

    const hour = Number(partsPT.hour);
    const minute = Number(partsPT.minute);
    const inWindow = hour === 16 && minute >= 0 && minute <= 10;
    if (!inWindow) return;

    const rolloverId = buildAutoAuctionRolloverId({
      ...partsPT,
      minute: "00",
    });

    const state = leagueStore.loadLeague();
    if (state.lastAutoAuctionRolloverId === rolloverId) return;

    const nowMs = Date.now();
    const { nextTeams, nextFreeAgents, nextLeagueLog, newLogs } = resolveAuctionsServer(state, nowMs);

    state.teams = nextTeams;
    state.freeAgents = nextFreeAgents;
    state.leagueLog = nextLeagueLog;

    state.lastAutoAuctionRolloverId = rolloverId;
    Promise.resolve(
  leagueStore.saveLeague(state, { savedBy: "system:autoAuctionRollover" })
).catch((e) => console.error("[AUTO AUCTIONS] save failed:", e));


    console.log(`[AUTO AUCTIONS] Rollover complete: ${rolloverId} (signings: ${newLogs.length})`);

    const ioRef = app.get("io");
    if (ioRef) ioRef.emit("league:updated", { reason: "autoAuctionRollover", rolloverId });
  } catch (err) {
    console.error("[AUTO AUCTIONS] Failed:", err);
  }
}
function isArray(x) {
  return Array.isArray(x);
}

function isPlainObject(x) {
  return x != null && typeof x === "object" && !Array.isArray(x);
}

function looksLikeWipe(prev, incomingTeams) {
  const prevTeams = Array.isArray(prev?.teams) ? prev.teams : [];
  const nextTeams = Array.isArray(incomingTeams) ? incomingTeams : [];

  // If we had teams before, and the incoming save has zero teams -> classic wipe
  return prevTeams.length > 0 && nextTeams.length === 0;
}

function isManagerWriteBlockedByFreeze(prevState, meta) {
  const frozen = Boolean(prevState?.settings?.frozen);
  if (!frozen) return false;

  const role = String(meta?.actorRole || "").toLowerCase();

  // Commissioner can still write while frozen
  if (role === "commissioner") return false;

  // Everyone else blocked while frozen
  return true;
}

// ===============================
// ROUTES
// ===============================
app.get("/", (req, res) => {
  res.send("Hundo Leago backend is running.");
});

app.get("/health", (req, res) => {
  const st = leagueStore.loadLeague();
  res.json({
    ok: true,
    schemaVersion: st.schemaVersion ?? null,
    loadedFromDisk: Boolean(st?.meta?.loadedFromDisk),
    dataFilePath: st?.meta?.dataFilePath || DATA_FILE,
    lastSavedAt: st?.meta?.lastSavedAt || null,
    lastSavedBy: st?.meta?.lastSavedBy || null,
    hasLoadError: Boolean(st?.meta?.loadError),
        backupsDir: leagueStore.backupsDir || BACKUPS_DIR,
    backupsCount: (() => {
      try {
        return leagueStore.listBackups({ limit: 999999 }).length;
      } catch (_) {
        return null;
      }
    })(),

  });
  
});

// ===============================
// Phase 3 — Matchups: Read current week (read-only)
// ===============================
app.get("/api/matchups/current", (req, res) => {
  const st = leagueStore.loadLeague();
  const m = st.matchups || {};
  const weeks = Array.isArray(m.scheduleWeeks) ? m.scheduleWeeks : [];
  const idx = Number(m.currentWeekIndex || 0);

  const cur = weeks[idx] || null;

  return res.json({
    ok: true,
    seasonId: m.seasonId || null,
    currentWeekIndex: idx,
    currentWeekId: m.currentWeekId || cur?.weekId || null,
    week: cur,
    // helpful for UI:
    serverNowMs: Date.now(),
  });
});


app.get("/api/league", (req, res) => {
  const state = leagueStore.loadLeague();
  res.json(state);
});
// ===============================
// Phase 3 — Matchups: Generate schedule (commissioner-only)
// ===============================
app.post("/api/matchups/schedule/generate", async (req, res) => {
  try {
    const body = req.body || {};
    const meta = body.meta || {};

    const role = String(meta?.actorRole || "").toLowerCase();
    if (role !== "commissioner") {
      return res.status(403).json({ ok: false, error: "Commissioner only." });
    }

    const prev = leagueStore.loadLeague();

    const teamNames = (prev.teams || []).map((t) => t?.name).filter(Boolean);
    if (teamNames.length < 2) {
      return res.status(400).json({ ok: false, error: "Need at least 2 teams to generate schedule." });
    }
    if (teamNames.length % 2 !== 0) {
      return res.status(400).json({ ok: false, error: "Round robin schedule currently requires an even number of teams." });
    }

    // Allow optional overrides (commissioner-controlled)
// Defaults: next Monday 00:00 PT start, lock 16:00 PT, rollover next Monday 00:00 PT, 26 weeks
    const seasonId = body.seasonId ?? prev?.matchups?.seasonId ?? null;
    const numWeeks = Number(body.numWeeks || 26) || 26;

    const lockHour = Number(body.lockHour ?? 16);
    const lockMinute = Number(body.lockMinute ?? 0);


    const startWeekMsPT = Number(body.startWeekMsPT) || getNextMondayStartMsPT(Date.now());

   const scheduleWeeks = buildScheduleWeeks({
  teamNames,
  startWeekMsPT,
  numWeeks,
  lockHour,
  lockMinute,
  seasonId,
});


    const next = {
      ...prev,
      matchups: {
        ...(prev.matchups || {}),
        seasonId,
        scheduleWeeks,
        currentWeekIndex: 0,
        currentWeekId: scheduleWeeks?.[0]?.weekId || null,
        // Keep these for later sessions (don’t wipe if already present)
        locksByTeam: prev?.matchups?.locksByTeam || {},
        baselineByPlayerId: prev?.matchups?.baselineByPlayerId || {},
        resultsByWeek: prev?.matchups?.resultsByWeek || {},
      },
    };

    await leagueStore.saveLeague(next, { savedBy: "commissioner:generateSchedule" });

    const ioRef = req.app.get("io");
    if (ioRef) ioRef.emit("league:updated", { reason: "matchups:scheduleGenerated" });

    return res.json({
      ok: true,
      generated: {
        seasonId,
        numWeeks: scheduleWeeks.length,
        startWeekMsPT,
        currentWeekId: next.matchups.currentWeekId,
      },
    });
  } catch (err) {
    console.error("[MATCHUPS] schedule generate failed:", err);
    return res.status(500).json({ ok: false, error: "Failed to generate schedule." });
  }
});

// ===============================
// Phase 3 — Matchups: Update a single week window (commissioner-only)
// ===============================
app.post("/api/matchups/schedule/updateWeek", async (req, res) => {
  try {
    const body = req.body || {};
    const meta = body.meta || {};

    const role = String(meta?.actorRole || "").toLowerCase();
    if (role !== "commissioner") {
      return res.status(403).json({ ok: false, error: "Commissioner only." });
    }

    const weekIndex = Number(body.weekIndex);
    if (!Number.isFinite(weekIndex) || weekIndex < 0) {
      return res.status(400).json({ ok: false, error: "weekIndex is required and must be >= 0." });
    }

    const prev = leagueStore.loadLeague();
    const m = prev.matchups || {};
    const weeks = Array.isArray(m.scheduleWeeks) ? m.scheduleWeeks : [];

    if (!weeks[weekIndex]) {
      return res.status(404).json({ ok: false, error: "Week not found in scheduleWeeks." });
    }

    const force = Boolean(body.force);

    const cur = weeks[weekIndex];
    const nowMs = Date.now();
if (!force && nowMs >= cur.weekStartAtMs) {
  return res.status(400).json({
    ok: false,
    error: "Only future weeks can be edited. Use force=true only for emergency commissioner fixes.",
  });
}


   // Only apply fields if provided
const weekStartAtMs =
  body.weekStartAtMs != null ? Number(body.weekStartAtMs) : cur.weekStartAtMs;

const weekEndAtMs =
  body.weekEndAtMs != null ? Number(body.weekEndAtMs) : cur.weekEndAtMs;

const lockAtMs =
  body.lockAtMs != null ? Number(body.lockAtMs) : cur.lockAtMs;

const rolloverAtMs =
  body.rolloverAtMs != null ? Number(body.rolloverAtMs) : cur.rolloverAtMs;

// derived (canonical)
const baselineAtMs = weekStartAtMs + 60 * 60 * 1000;

const nextWeek = {
  ...cur,
  weekStartAtMs,
  baselineAtMs,
  weekEndAtMs,
  lockAtMs,
  rolloverAtMs,
};



    // Basic numeric validation
for (const k of ["weekStartAtMs", "baselineAtMs", "weekEndAtMs", "lockAtMs", "rolloverAtMs"]) {
  const v = nextWeek[k];
  if (!Number.isFinite(v) || v <= 0) {
    return res.status(400).json({ ok: false, error: `Invalid ${k}. Must be a positive number (ms).` });
  }
}

// baseline ordering validation
if (!(nextWeek.weekStartAtMs < nextWeek.baselineAtMs && nextWeek.baselineAtMs <= nextWeek.weekEndAtMs)) {
  return res.status(400).json({
    ok: false,
    error: "baselineAtMs must be after weekStartAtMs and on/before weekEndAtMs.",
  });
}


    // Ordering validation
    if (!(nextWeek.weekStartAtMs < nextWeek.weekEndAtMs)) {
      return res.status(400).json({ ok: false, error: "weekStartAtMs must be < weekEndAtMs." });
    }
    if (!(nextWeek.weekEndAtMs < nextWeek.rolloverAtMs)) {
      return res.status(400).json({ ok: false, error: "weekEndAtMs must be < rolloverAtMs." });
    }
    if (!(nextWeek.weekStartAtMs <= nextWeek.lockAtMs && nextWeek.lockAtMs <= nextWeek.weekEndAtMs)) {
      return res.status(400).json({ ok: false, error: "lockAtMs must be between weekStartAtMs and weekEndAtMs." });
    }

    // Neighbor overlap guardrails (unless forced)
    const prevWeek = weeks[weekIndex - 1];
    const nextWeekNeighbor = weeks[weekIndex + 1];

    if (!force && prevWeek) {
      // current start must be after previous rollover
      if (!(prevWeek.rolloverAtMs <= nextWeek.weekStartAtMs)) {
        return res.status(400).json({
          ok: false,
          error: "This change would overlap the previous week. Use force=true if you really intend this.",
        });
      }
    }

    if (!force && nextWeekNeighbor) {
      // current rollover must be before next start
      if (!(nextWeek.rolloverAtMs <= nextWeekNeighbor.weekStartAtMs)) {
        return res.status(400).json({
          ok: false,
          error: "This change would overlap the next week. Use force=true if you really intend this.",
        });
      }
    }

    const nextWeeks = [...weeks];
    nextWeeks[weekIndex] = nextWeek;

    const next = {
      ...prev,
      matchups: {
        ...m,
        scheduleWeeks: nextWeeks,
      },
    };

    await leagueStore.saveLeague(next, { savedBy: "commissioner:updateWeekWindow" });

    const ioRef = req.app.get("io");
    if (ioRef) ioRef.emit("league:updated", { reason: "matchups:weekUpdated", weekIndex });

    return res.json({ ok: true, weekIndex, updated: nextWeek });
  } catch (err) {
    console.error("[MATCHUPS] updateWeek failed:", err);
    return res.status(500).json({ ok: false, error: "Failed to update week." });
  }
});

// ===============================
// Phase 3 — Matchups: Shift schedule forward from a weekIndex (commissioner-only)
// Rebuilds weeks [fromWeekIndex..end] so there are no overlaps, using default week length.
// ===============================
app.post("/api/matchups/schedule/shiftFrom", async (req, res) => {
  try {
    const body = req.body || {};
    const meta = body.meta || {};

    const role = String(meta?.actorRole || "").toLowerCase();
    if (role !== "commissioner") {
      return res.status(403).json({ ok: false, error: "Commissioner only." });
    }

    const fromWeekIndex = Number(body.fromWeekIndex);
    if (!Number.isFinite(fromWeekIndex) || fromWeekIndex < 0) {
      return res.status(400).json({ ok: false, error: "fromWeekIndex is required and must be >= 0." });
    }

    const prev = leagueStore.loadLeague();
    const m = prev.matchups || {};
    const weeks = Array.isArray(m.scheduleWeeks) ? m.scheduleWeeks : [];

    if (weeks.length === 0) {
      return res.status(400).json({ ok: false, error: "No scheduleWeeks to shift." });
    }
    if (!weeks[fromWeekIndex]) {
      return res.status(404).json({ ok: false, error: "fromWeekIndex out of range." });
    }

    // Defaults (same as generate)
    const lockHour = Number(body.lockHour ?? 16);
    const lockMinute = Number(body.lockMinute ?? 0);

    // Helper: take a ms timestamp and return that local day 00:00 PT
    function dayStartMsPT(ms) {
      const p = getPartsInTZ(new Date(ms), PT_TZ);
      return makeUtcMsForTZ({ year: p.year, month: p.month, day: p.day, hour: 0, minute: 0 }, PT_TZ);
    }

    // Anchor: weekStart is based on previous week's rollover
    const nextWeeks = [...weeks];

    for (let i = fromWeekIndex; i < nextWeeks.length; i++) {
      const prevWeek = nextWeeks[i - 1];
      const curWeek = nextWeeks[i];

      // If i=0 (rare shift from 0), anchor to its existing start day
      const startAnchor = i === 0 ? curWeek.weekStartAtMs : prevWeek.rolloverAtMs;

      // Start at 00:00 PT of that day (keeps clean boundaries)
      const weekStartAtMs = dayStartMsPT(startAnchor);
const baselineAtMs = weekStartAtMs + 60 * 60 * 1000;

      // End 6 days later at 23:59 PT
      const endNoonMs = (() => {
        const p = getPartsInTZ(new Date(weekStartAtMs), PT_TZ);
        const noon = makeUtcMsForTZ({ year: p.year, month: p.month, day: p.day, hour: 12, minute: 0 }, PT_TZ);
        return noon + 6 * DAY_MS;
      })();

      const endParts = getPartsInTZ(new Date(endNoonMs), PT_TZ);
      const weekEndAtMs = makeUtcMsForTZ(
        { year: endParts.year, month: endParts.month, day: endParts.day, hour: 23, minute: 59 },
        PT_TZ
      );

      // Lock on start day at lockHour
      const startParts = getPartsInTZ(new Date(weekStartAtMs), PT_TZ);
      const lockAtMs = makeUtcMsForTZ(
        { year: startParts.year, month: startParts.month, day: startParts.day, hour: lockHour, minute: lockMinute },
        PT_TZ
      );

     // Rollover at NEXT week start (Monday 00:00 PT) — equals next week's weekStartAtMs
const nextWeekNoonMs = (() => {
  const p = getPartsInTZ(new Date(weekStartAtMs), PT_TZ);
  const noon = makeUtcMsForTZ({ year: p.year, month: p.month, day: p.day, hour: 12, minute: 0 }, PT_TZ);
  return noon + 7 * DAY_MS;
})();
const rollParts = getPartsInTZ(new Date(nextWeekNoonMs), PT_TZ);
const rolloverAtMs = makeUtcMsForTZ(
  { year: rollParts.year, month: rollParts.month, day: rollParts.day, hour: 0, minute: 0 },
  PT_TZ
);


      nextWeeks[i] = {
        ...curWeek,
        weekStartAtMs,
        baselineAtMs,
        weekEndAtMs,
        lockAtMs,
        rolloverAtMs,
      };
    }

    const next = {
      ...prev,
      matchups: {
        ...m,
        scheduleWeeks: nextWeeks,
      },
    };

    await leagueStore.saveLeague(next, { savedBy: "commissioner:shiftSchedule" });

    const ioRef = req.app.get("io");
    if (ioRef) ioRef.emit("league:updated", { reason: "matchups:scheduleShifted", fromWeekIndex });

    return res.json({ ok: true, shiftedFrom: fromWeekIndex, weeksShifted: nextWeeks.length - fromWeekIndex });
  } catch (err) {
    console.error("[MATCHUPS] shiftFrom failed:", err);
    return res.status(500).json({ ok: false, error: "Failed to shift schedule." });
  }
});


app.post("/api/league", async (req, res) => {
  const body = req.body || {};

  try {
    const prev = leagueStore.loadLeague();


    // ----------------------------
    // Phase 0 write-safety guards
    // ----------------------------
    const meta = body.meta || {};

    // Freeze enforcement: block manager writes while frozen
    if (isManagerWriteBlockedByFreeze(prev, meta)) {
      return res.status(423).json({
        ok: false,
        error: "League is frozen. Manager writes are blocked.",
      });
    }

    // Prevent accidental wipe saves (teams becomes empty)
    if (looksLikeWipe(prev, body.teams)) {
      return res.status(400).json({
        ok: false,
        error: "Refusing save: incoming teams is empty (wipe protection).",
      });
    }

    // Basic shape validation: arrays must be arrays (not null/objects)
    if (
      !isArray(body.teams) ||
      !isArray(body.freeAgents) ||
      !isArray(body.leagueLog) ||
      !isArray(body.tradeProposals) ||
      !isArray(body.tradeBlock)
    ) {
      return res.status(400).json({
        ok: false,
        error: "Refusing save: invalid payload shape (arrays expected).",
      });
    }

    // Optional: matchups must be an object if provided
if (body.matchups !== undefined && !isPlainObject(body.matchups)) {
  return res.status(400).json({
    ok: false,
    error: "Refusing save: matchups must be an object if provided.",
  });
}

    const next = {
      ...prev,
      teams: Array.isArray(body.teams) ? body.teams : [],
      freeAgents: Array.isArray(body.freeAgents) ? body.freeAgents : [],
      leagueLog: Array.isArray(body.leagueLog) ? body.leagueLog : [],
      tradeProposals: Array.isArray(body.tradeProposals) ? body.tradeProposals : [],
      tradeBlock: Array.isArray(body.tradeBlock) ? body.tradeBlock : [],
      matchups: isPlainObject(body.matchups) ? body.matchups : prev.matchups,

      settings:
        body.settings && typeof body.settings === "object"
          ? body.settings
          : prev.settings || { frozen: false },
      nextAuctionDeadline: body.nextAuctionDeadline || prev.nextAuctionDeadline || null,

      // preserve auto markers
     lastAutoWeeklySnapshotId: prev.lastAutoWeeklySnapshotId,
lastAutoAuctionRolloverId: prev.lastAutoAuctionRolloverId,
    };

    await leagueStore.saveLeague(next, {
  savedBy:
    String(meta?.actorRole || "").toLowerCase() === "commissioner"
      ? "commissioner"
      : (meta?.actorTeam || "manager"),
});


    const ioRef = req.app.get("io");
    if (ioRef) ioRef.emit("league:updated", { reason: "saveLeague" });

    res.json({ ok: true });
  } catch (err) {
    console.error("[BACKEND] Error writing league-state.json:", err);
    res.status(500).json({ ok: false, error: "Failed to save state" });
  }
});
// ===============================
// Phase 2A — Player API
// ===============================

app.get("/api/players", (req, res) => {
  const q = String(req.query?.query || "").trim();

  // If NO query (your preload case), allow a large response, but keep a safety cap.
  // 5000 is plenty (your DB is ~2k) and prevents insane payloads.
  const rawLimit = Number(req.query?.limit);
  const limitNoQuery = Math.max(1, Math.min(5000, Number.isFinite(rawLimit) ? rawLimit : 5000));

  // If query IS present (typeahead search), keep it small for speed.
  const limitQuery = Math.max(1, Math.min(100, Number(req.query?.limit || 25) || 25));

  // No query: return a large slice (PRELOAD PATH)
  if (!q) {
    return res.json({
      ok: true,
      players: playersCache.slice(0, limitNoQuery),
      count: playersCache.length,
      cacheCount: playersCache.length,
      limitUsed: limitNoQuery,
    });
  }

  // Query: return search results (SEARCH PATH)
  const results = searchPlayers(q, limitQuery);
  return res.json({
    ok: true,
    players: results,
    count: playersCache.length,
    cacheCount: playersCache.length,
    limitUsed: limitQuery,
  });
});





// TEMP DEBUG: verify players file path + existence + size (safe read-only)
// IMPORTANT: must come BEFORE /api/players/:id
app.get("/api/players/debug", (req, res) => {
  try {
    const repoPlayers = path.join(__dirname, "players.json");

    const statSafe = (p) => {
      try {
        if (!fs.existsSync(p)) return { exists: false };
        const st = fs.statSync(p);
        return { exists: true, size: st.size, mtimeMs: st.mtimeMs };
      } catch (e) {
        return { exists: false, error: String(e?.message || e) };
      }
    };

    res.json({
      ok: true,
      PLAYERS_FILE,
      disk: statSafe(PLAYERS_FILE),
      repo: statSafe(repoPlayers),
      cacheCount: playersCache.length,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// TEMP DEBUG: verify stats file path + existence + size
app.get("/api/stats/debug", (req, res) => {
  try {
    const statSafe = (p) => {
      try {
        if (!fs.existsSync(p)) return { exists: false };
        const st = fs.statSync(p);
        return { exists: true, size: st.size, mtimeMs: st.mtimeMs };
      } catch (e) {
        return { exists: false, error: String(e?.message || e) };
      }
    };

    res.json({
      ok: true,
      STATS_FILE,
      disk: statSafe(STATS_FILE),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});


// GET /api/players/8478402
app.get("/api/players/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ ok: false, error: "Invalid player id" });
  }

  const p = playersById.get(id);
  if (!p) {
    return res.status(404).json({ ok: false, error: "Player not found" });
  }

  res.json({ ok: true, player: p });
});


// POST /api/players/reload  (optional admin utility for dev)
app.post("/api/players/reload", (req, res) => {
  const r = loadPlayersFromDisk();
  res.json({
    ok: r.ok,
    count: r.count,
    source: r.source || null,
    error: r.error || null,
  });
});

// ===============================
// Phase 2B — Stats Cache API (read-only)
// ===============================

app.get("/api/stats", (req, res) => {
  try {
    if (!fs.existsSync(STATS_FILE)) {
      return res.status(200).json({ ok: true, ready: false, byPlayerId: {} });
    }

    const raw = fs.readFileSync(STATS_FILE, "utf8");
    const json = JSON.parse(raw);

    // OPTIONAL: allow fetching a single player's stats
    const playerId = String(req.query?.playerId || "").trim();
    if (playerId) {
      return res.status(200).json({
        ok: true,
        playerId,
        stats: json?.byPlayerId?.[playerId] || null,
      });
    }

    // Default: return full cache
    return res.status(200).json(json);
  } catch (e) {
    console.error("[STATS] Failed to read stats cache:", e?.message || e);
    return res.status(500).json({ ok: false, error: "Failed to load stats cache" });
  }
});

// POST /api/stats/refresh (protected)
// Triggers stats refresh + writes cache to disk.
// Does NOT touch league state.
app.post("/api/stats/refresh", async (req, res) => {
  try {
    const token = req.get("x-stats-token") || "";
    const expected = process.env.STATS_REFRESH_TOKEN || "";

    if (!expected || token !== expected) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    // We will export this function from scripts/refreshStats.js in the next step.
    const { refreshStatsNow } = require("./scripts/refreshStats");

    const result = await refreshStatsNow();
    return res.json({ ok: true, result });
  } catch (err) {
    console.error("stats refresh failed:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});


app.get("/api/snapshots", (req, res) => {
  try {
    if (!fs.existsSync(SNAPSHOT_DIR)) return res.json({ snapshots: [] });

    const files = fs.readdirSync(SNAPSHOT_DIR);
    const snapshots = files
      .filter((f) => f.endsWith(".json"))
      .map((file) => {
        const full = path.join(SNAPSHOT_DIR, file);
        const stat = fs.statSync(full);
        return {
          id: path.basename(file, ".json"),
          createdAt: stat.mtimeMs,
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);

    res.json({ snapshots });
  } catch (err) {
    console.error("[BACKEND] Error listing snapshots:", err);
    res.status(500).json({ snapshots: [], error: "Failed to load snapshots" });
  }
});

app.post("/api/snapshots/restore", async (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ ok: false, error: "Missing snapshot id in body" });

  const file = path.join(SNAPSHOT_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return res.status(404).json({ ok: false, error: "Snapshot not found" });

  try {
    const raw = fs.readFileSync(file, "utf8");
const restored = JSON.parse(raw);

// IMPORTANT: merge with defaults so new fields aren't lost
const next = { ...leagueStore.emptyState(), ...restored };


// ✅ Phase 0F: backend-owned restore log (cannot be lost)
const now = Date.now();
const prevLog = Array.isArray(next.leagueLog) ? next.leagueLog : [];
next.leagueLog = [
  {
    id: now + Math.random(),
    type: "commRestoreSnapshot",
    by: "Commissioner",
    snapshotId: id,
    timestamp: now,
  },
  ...prevLog,
];

await leagueStore.saveLeague(next, { savedBy: "commissioner:snapshotRestore" });


const ioRef = req.app.get("io");
if (ioRef) ioRef.emit("league:updated", { reason: "snapshotRestored", snapshotId: id });

res.json({ ok: true });

  } catch (err) {
    console.error("[BACKEND] Error restoring snapshot:", err);
    res.status(500).json({ ok: false, error: "Failed to restore snapshot" });
  }
});

app.post("/api/snapshots/create", (req, res) => {
  try {
    const { name } = req.body || {};
    const state = leagueStore.loadLeague();


    const ts = new Date();
    const stamp = ts
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", "_")
      .replace("Z", "");

    const rawName = (name || "").trim();
    const safeName = rawName
      ? rawName
          .toLowerCase()
          .replace(/[^a-z0-9-_ ]/g, "")
          .replace(/\s+/g, "-")
          .slice(0, 40)
      : "";

    const snapshotId = safeName ? `${stamp}__${safeName}` : stamp;
    const file = path.join(SNAPSHOT_DIR, `${snapshotId}.json`);

    fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf8");

    const ioRef = req.app.get("io");
    if (ioRef) ioRef.emit("league:updated", { reason: "snapshotCreated", snapshotId });

    res.json({ ok: true, snapshotId });
  } catch (err) {
    console.error("[BACKEND] Error creating snapshot:", err);
    res.status(500).json({ ok: false, error: "Failed to create snapshot" });
  }
});

// -------------------------------
// Backups (Phase 1: versioned backups)
// -------------------------------

// List backups (newest first)
// GET /api/backups?limit=50
app.get("/api/backups", (req, res) => {
  try {
    const limit = Number(req.query?.limit || 50) || 50;
    const backups = leagueStore.listBackups({ limit });
    res.json({ ok: true, backups, backupsDir: leagueStore.backupsDir });
  } catch (err) {
    console.error("[BACKUPS] list failed:", err);
    res.status(500).json({ ok: false, error: "Failed to list backups" });
  }
});

// Restore a backup by filename id
// POST /api/backups/restore { id, meta? }
app.post("/api/backups/restore", async (req, res) => {
  console.log("[RESTORE] content-type:", req.headers["content-type"]);
console.log("[RESTORE] body:", req.body);

 const body = req.body || {};
const meta = body.meta || {};
const id = body.id || body.backupId; // accept either key

if (!id) {
  return res.status(400).json({
    ok: false,
    error: "Missing backup id in body (expected: id or backupId)",
  });
}


  // Safety: only allow commissioner-triggered restore
  const role = String(meta?.actorRole || "").toLowerCase();
  if (role !== "commissioner") {
    return res.status(403).json({ ok: false, error: "Restore requires commissioner role." });
  }

  try {
    const restoredRaw = await leagueStore.restoreBackup(id, { restoredBy: "commissioner" });
const restored = { ...leagueStore.emptyState(), ...restoredRaw };


    // Add a backend-owned log entry so it can't be “not saved”
    const now = Date.now();
    const prevLog = Array.isArray(restored.leagueLog) ? restored.leagueLog : [];
    restored.leagueLog = [
      {
        id: now + Math.random(),
        type: "commRestoreBackup",
        by: "Commissioner",
        backupId: id,
        timestamp: now,
      },
      ...prevLog,
    ];

    await leagueStore.saveLeague(restored, { savedBy: "commissioner:backupRestore" });

    const ioRef = req.app.get("io");
    if (ioRef) ioRef.emit("league:updated", { reason: "backupRestored", backupId: id });

    res.json({ ok: true });
  } catch (err) {
    console.error("[BACKUPS] restore failed:", err);
    res.status(500).json({ ok: false, error: err?.message || "Failed to restore backup" });
  }
});

// ===============================
// BOOT: auto jobs + server listen
// ===============================
tryAutoWeeklySnapshot();
setInterval(tryAutoWeeklySnapshot, 60 * 1000);

tryAutoAuctionRollover();
setInterval(tryAutoAuctionRollover, 60 * 1000);

server.listen(PORT, () => {
  console.log(`Hundo Leago backend + WebSocket listening on port ${PORT}`);
});
