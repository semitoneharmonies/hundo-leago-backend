// server.js (CommonJS)
// -------------------------------
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const { createLeagueStore } = require("./leagueStore");
const { registerHealthRoutes } = require("./routes/healthRoutes");
const { registerLeagueReadRoutes } = require("./routes/leagueReadRoutes");



const app = express();
console.log("SERVER ENTRY LOADED: server.js", new Date().toISOString());

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
//
// Production (Render disk): /opt/render/project/data/hundo/stats-cache.json
// Local dev (Windows/macOS): fall back to ./stats-cache.json next to server.js
const DEFAULT_STATS_FILE = "/opt/render/project/data/hundo/stats-cache.json";

const LOCAL_STATS_FILE = path.join(__dirname, "stats-cache.json");
const isLocalDev = process.env.NODE_ENV !== "production";

const STATS_FILE =
  process.env.STATS_FILE ||
  (isLocalDev && fs.existsSync(LOCAL_STATS_FILE)
    ? LOCAL_STATS_FILE
    : (String(process.env.LEAGUE_FILE || "").includes("/opt/render/project/data/")
        ? path.join(path.dirname(process.env.LEAGUE_FILE), "stats-cache.json")
        : DEFAULT_STATS_FILE));


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

registerHealthRoutes({ app, leagueStore, DATA_FILE, BACKUPS_DIR });
registerLeagueReadRoutes({ app, leagueStore });


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

// -------------------------------
// Phase 3 — Session 3: legality check (read-only helper)
// -------------------------------
function isTeamLegalNow(team) {
  // SAFETY: strict, predictable rules.
  // If anything looks missing/invalid, treat as illegal (prevents accidental locks).
  if (!team || typeof team !== "object") return false;

  const roster = Array.isArray(team.roster) ? team.roster : [];
  // Basic “has players” check (adjust later if your cap/IR rules need to be included)
  if (roster.length === 0) return false;

  // If you already have an authoritative legality check, we will swap to that.
  // For now we keep this minimal and conservative.
  return true;
}

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
    const afterDeadline = hour > 16 || (hour === 16 && minute >= 0);
    if (!afterDeadline) return;

    const snapshotId = buildAutoSnapshotId({ ...partsPT, hour: "16", minute: "00" });

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
const afterDeadline = hour > 16 || (hour === 16 && minute >= 0);
if (!afterDeadline) return;


    const rolloverId = buildAutoAuctionRolloverId({ ...partsPT, hour: "16", minute: "00" });

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


// -------------------------------
// Phase 3 — Session 6: Standings (Read-Only)
// Canonical inputs: resultsByWeek + scheduleWeeks (+ teams list for names)
// -------------------------------
function computeStandingsFromResults(state) {
  const matchups = state?.matchups || {};
  const resultsByWeek = matchups.resultsByWeek || {};
  const scheduleWeeks = Array.isArray(matchups.scheduleWeeks) ? matchups.scheduleWeeks : [];
  const teamsArr = Array.isArray(state?.teams) ? state.teams : [];

  // Build schedule lookup so we only count weeks that have known pairs
  const scheduleByWeekId = new Map();
  scheduleWeeks.forEach((w, idx) => {
    const weekId = w?.weekId ?? w?.id ?? `week_${idx}`;
    scheduleByWeekId.set(weekId, w);
  });

  // Initialize table with known team names (safe if teams[] missing/odd)
  const table = new Map();
  const ensureRow = (teamName) => {
    const name = String(teamName || "").trim();
    if (!name) return null;
    if (!table.has(name)) {
      table.set(name, {
        teamName: name,
        GP: 0,
        W: 0,
        L: 0,
        T: 0,
        PTS: 0,
        PF: 0,
        PA: 0,
        DIFF: 0,
      });
    }
    return table.get(name);
  };

  teamsArr.forEach((t) => {
    const name = t?.name ?? t?.teamName ?? t?.id;
    ensureRow(name);
  });

  // Only count a week if:
  // - it exists in resultsByWeek
  // - scheduleWeeks has known pairs for that weekId
  const countedWeekIds = [];
  for (const weekId of Object.keys(resultsByWeek)) {
    const sched = scheduleByWeekId.get(weekId);
    const pairs = Array.isArray(sched?.pairs) ? sched.pairs : null;
    if (!pairs || pairs.length === 0) continue;

    const weekRes = resultsByWeek[weekId] || {};
    const perTeam = weekRes.perTeam || {};

    countedWeekIds.push(weekId);

    for (const pair of pairs) {
      const A = Array.isArray(pair) ? pair[0] : null;
      const B = Array.isArray(pair) ? pair[1] : null;
      if (!A || !B) continue;

      const rowA = ensureRow(A);
      const rowB = ensureRow(B);
      if (!rowA || !rowB) continue;

      const fpA = Number(perTeam?.[A]?.weeklyFP ?? 0) || 0;
      const fpB = Number(perTeam?.[B]?.weeklyFP ?? 0) || 0;

      // Everyone in a scheduled pair has "played" a game for standings purposes
      rowA.GP += 1;
      rowB.GP += 1;

      rowA.PF += fpA;
      rowA.PA += fpB;

      rowB.PF += fpB;
      rowB.PA += fpA;

      if (fpA > fpB) {
        rowA.W += 1;
        rowA.PTS += 2;
        rowB.L += 1;
      } else if (fpB > fpA) {
        rowB.W += 1;
        rowB.PTS += 2;
        rowA.L += 1;
      } else {
        rowA.T += 1;
        rowB.T += 1;
        rowA.PTS += 1;
        rowB.PTS += 1;
      }
    }
  }

  // finalize DIFF
  for (const row of table.values()) {
    row.DIFF = row.PF - row.PA;
  }

  const standings = Array.from(table.values()).sort((a, b) => {
    // PTS desc
    if (b.PTS !== a.PTS) return b.PTS - a.PTS;
    // DIFF desc
    if (b.DIFF !== a.DIFF) return b.DIFF - a.DIFF;
    // PF desc
    if (b.PF !== a.PF) return b.PF - a.PF;
    // teamName asc (stable)
    return String(a.teamName).localeCompare(String(b.teamName));
  });

  return {
    ok: true,
    computedAtMs: Date.now(),
    weeksCounted: countedWeekIds.length,
    countedWeekIds,
    standings,
  };
}

// -------------------------------
// Phase 3 — Session 6: Standings (Read-Only)
// GET /api/matchups/standings
// -------------------------------
app.get("/api/matchups/standings", (req, res) => {
  try {
    const state = leagueStore.loadLeague();
    const payload = computeStandingsFromResults(state);
    return res.json(payload);
  } catch (err) {
    console.error("[matchups/standings] error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
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

// ===============================
// Phase 3 — Matchups: Lock status (read-only, Session 3)
// ===============================
app.get("/api/matchups/locks", (req, res) => {
  const st = leagueStore.loadLeague();
  const m = st.matchups || {};
  const weeks = Array.isArray(m.scheduleWeeks) ? m.scheduleWeeks : [];
  const idx = Number(m.currentWeekIndex || 0);
  const week = weeks[idx] || null;

  return res.json({
    ok: true,
    currentWeekIndex: idx,
    currentWeekId: m.currentWeekId || week?.weekId || null,
    lockAtMs: week?.lockAtMs || null,
    serverNowMs: Date.now(),
    locksByTeam: m.locksByTeam || {},
  });
});

// ===============================
// Phase 3 — Matchups: Preview who would lock now (read-only)
// ===============================
app.get("/api/matchups/locks/preview", (req, res) => {
  const st = leagueStore.loadLeague();
  const m = st.matchups || {};
  const weeks = Array.isArray(m.scheduleWeeks) ? m.scheduleWeeks : [];
  const idx = Number(m.currentWeekIndex || 0);
  const week = weeks[idx] || null;

  const teams = Array.isArray(st.teams) ? st.teams : [];
  const locksByTeam = m.locksByTeam || {};

  const nowMs = Date.now();
  const lockAtMs = week?.lockAtMs ?? null;

  // If we don't have a week or lock time, nothing can lock.
  if (!week || !Number.isFinite(lockAtMs)) {
    return res.json({
      ok: true,
      reason: "missingWeekOrLockTime",
      serverNowMs: nowMs,
      currentWeekIndex: idx,
      currentWeekId: m.currentWeekId || week?.weekId || null,
      wouldLock: [],
    });
  }

  // Before lock time, we do nothing.
  if (nowMs < lockAtMs) {
    return res.json({
      ok: true,
      reason: "beforeLockTime",
      serverNowMs: nowMs,
      lockAtMs,
      currentWeekIndex: idx,
      currentWeekId: m.currentWeekId || week?.weekId || null,
      wouldLock: [],
    });
  }

  // After lock time: any team that is legal AND not already locked would lock now.
  const wouldLock = [];
  for (const t of teams) {
    const name = t?.name;
    if (!name) continue;
    if (locksByTeam[name]) continue; // already locked
    if (!isTeamLegalNow(t)) continue;
    wouldLock.push(name);
  }

  return res.json({
    ok: true,
    reason: "afterLockTime",
    serverNowMs: nowMs,
    lockAtMs,
    currentWeekIndex: idx,
    currentWeekId: m.currentWeekId || week?.weekId || null,
    alreadyLocked: Object.keys(locksByTeam),
    wouldLock,
  });
});

// ===============================
// Phase 3 — Session 4: Baseline preview (read-only, NO WRITES)
// Shows what would be captured for baselineByWeekId[weekId] if we captured now.
// ===============================
app.get("/api/matchups/baseline/preview", (req, res) => {
  try {
    const st = leagueStore.loadLeague();
    const m = st.matchups || {};
    const weeks = Array.isArray(m.scheduleWeeks) ? m.scheduleWeeks : [];
    const idx = Number(m.currentWeekIndex || 0);
    const week = weeks[idx] || null;

    const nowMs = Date.now();

    if (!week || !week.weekId || !Number.isFinite(week.baselineAtMs)) {
      return res.json({
        ok: true,
        reason: "missingWeekOrBaselineTime",
        serverNowMs: nowMs,
        currentWeekIndex: idx,
        currentWeekId: m.currentWeekId || week?.weekId || null,
      });
    }

    const weekId = week.weekId;

    const baselineByWeekId = m.baselineByWeekId || {};
    const alreadyCaptured = Boolean(baselineByWeekId[weekId]);

    // Read stats cache directly (same as /api/stats)
    if (!fs.existsSync(STATS_FILE)) {
      return res.json({
        ok: true,
        reason: "statsCacheMissing",
        serverNowMs: nowMs,
        weekId,
        baselineAtMs: week.baselineAtMs,
        alreadyCaptured,
      });
    }

    const raw = fs.readFileSync(STATS_FILE, "utf8");
    const statsJson = JSON.parse(raw);

    const byPlayerId = statsJson?.byPlayerId && typeof statsJson.byPlayerId === "object"
      ? statsJson.byPlayerId
      : {};

    // Compute cumulative fantasy points (FP) using your canonical rule:
    // FP = goals * 1.25 + assists
    const snapshotByPlayerId = {};
    let count = 0;

    for (const [playerId, s] of Object.entries(byPlayerId)) {
      const goals = Number(s?.goals) || 0;
      const assists = Number(s?.assists) || 0;
      const gamesPlayed = Number(s?.gamesPlayed) || 0;

      const fp = goals * 1.25 + assists;

      snapshotByPlayerId[playerId] = {
        goals,
        assists,
        gamesPlayed,
        fp,
      };
      count++;
    }

    // Small sample so the response isn't enormous
    const sample = Object.entries(snapshotByPlayerId).slice(0, 5).map(([playerId, v]) => ({
      playerId,
      ...v,
    }));

    return res.json({
      ok: true,
      serverNowMs: nowMs,
      currentWeekIndex: idx,
      weekId,
      weekWindow: {
        weekStartAtMs: week.weekStartAtMs,
        baselineAtMs: week.baselineAtMs,
        lockAtMs: week.lockAtMs,
        weekEndAtMs: week.weekEndAtMs,
        rolloverAtMs: week.rolloverAtMs,
      },
      alreadyCaptured,
      statsMeta: {
        seasonId: statsJson?.seasonId ?? null,
        lastUpdatedAt: statsJson?.lastUpdatedAt ?? null,
        playerCount: count,
      },
      preview: {
        playerCount: count,
        sample,
      },
      // NOTE: We are NOT returning the full snapshotByPlayerId
      // because it's large. This endpoint is just a preview.
    });
  } catch (err) {
    console.error("[BASELINE PREVIEW] failed:", err);
    return res.status(500).json({ ok: false, error: "Baseline preview failed." });
  }
});

// ===============================
// Phase 3 — Session 4: Baseline capture gate status (read-only, NO WRITES)
// Tells you exactly why capture would or would not run right now.
// ===============================
app.get("/api/matchups/baseline/status", (req, res) => {
  try {
    const st = leagueStore.loadLeague();
    const m = st.matchups || {};
    const weeks = Array.isArray(m.scheduleWeeks) ? m.scheduleWeeks : [];
    const idx = Number(m.currentWeekIndex || 0);
    const week = weeks[idx] || null;

    const nowMs = Date.now();

    if (!week) {
      return res.json({ ok: true, canCapture: false, reason: "noCurrentWeek", nowMs, currentWeekIndex: idx });
    }
    if (!week.weekId) {
      return res.json({ ok: true, canCapture: false, reason: "missingWeekId", nowMs, currentWeekIndex: idx });
    }
    if (!Number.isFinite(week.baselineAtMs)) {
      return res.json({
        ok: true,
        canCapture: false,
        reason: "missingBaselineAtMs",
        nowMs,
        currentWeekIndex: idx,
        weekId: week.weekId,
        baselineAtMs: week.baselineAtMs ?? null,
      });
    }

    const weekId = week.weekId;
    const baselineByWeekId = m.baselineByWeekId || {};
    const alreadyCaptured = Boolean(baselineByWeekId[weekId]);

    if (alreadyCaptured) {
      const entry = baselineByWeekId[weekId];
      return res.json({
        ok: true,
        canCapture: false,
        reason: "alreadyCaptured",
        nowMs,
        currentWeekIndex: idx,
        weekId,
        baselineAtMs: week.baselineAtMs,
        capturedAtMs: entry?.capturedAtMs ?? null,
        playerCount: entry?.byPlayerId ? Object.keys(entry.byPlayerId).length : 0,
      });
    }

    if (nowMs < week.baselineAtMs) {
      return res.json({
        ok: true,
        canCapture: false,
        reason: "beforeBaselineTime",
        nowMs,
        currentWeekIndex: idx,
        weekId,
        baselineAtMs: week.baselineAtMs,
        msUntilBaseline: week.baselineAtMs - nowMs,
      });
    }

    const statsExists = fs.existsSync(STATS_FILE);
    if (!statsExists) {
      return res.json({
        ok: true,
        canCapture: false,
        reason: "statsCacheMissing",
        nowMs,
        currentWeekIndex: idx,
        weekId,
        baselineAtMs: week.baselineAtMs,
        STATS_FILE,
      });
    }

    // If we reached here, capture SHOULD run.
    return res.json({
      ok: true,
      canCapture: true,
      reason: "readyToCapture",
      nowMs,
      currentWeekIndex: idx,
      weekId,
      baselineAtMs: week.baselineAtMs,
      STATS_FILE,
    });
  } catch (err) {
    console.error("[BASELINE STATUS] failed:", err);
    return res.status(500).json({ ok: false, error: "Baseline status failed." });
  }
});

// --- Phase 3 Session 5: Weekly scoring preview (read-only, no writes) ---
// GET /api/matchups/scoring/preview
// Read-only: computes current-week weekly FP per team using baseline delta + lock rule.
app.get("/api/matchups/scoring/preview", async (req, res) => {
  try {
    const nowMs = Date.now();

    // ✅ IMPORTANT: Use the SAME "get state" call that the baseline endpoints use.
    // Replace the next line with whatever you already do above (baseline/status).
    const state = leagueStore.loadLeague();

    if (!state || !state.matchups) {
      return res.status(500).json({ ok: false, error: "Matchups state not available." });
    }

    const m = state.matchups;
    const idx = Number(m.currentWeekIndex ?? -1);
    const weeks = Array.isArray(m.scheduleWeeks) ? m.scheduleWeeks : [];
    const week = weeks[idx];

    if (!week || !week.weekId) {
      return res.json({
        ok: true,
        nowMs,
        weekId: null,
        baselineCaptured: false,
        teams: [],
        note: "No current week configured.",
      });
    }

    const weekId = String(week.weekId);
    const baseline = m.baselineByWeekId?.[weekId] || null;
    const baselineCaptured = !!baseline;
    const baselineCapturedAtMs = baseline?.capturedAtMs ?? null;
const baselineStatsLastUpdatedAt = baseline?.statsLastUpdatedAt ?? null;


    // Read current cumulative stats from disk (same data source as /api/stats)
    let statsJson = null;
    try {
      const raw = await fs.promises.readFile(STATS_FILE, "utf8");
      statsJson = JSON.parse(raw);
    } catch (e) {
      statsJson = null;
    }

    const currentStatsLastUpdatedAt = statsJson?.lastUpdatedAt ?? null;

    const currentByPlayerId = statsJson?.byPlayerId || {};
    const fpNow = (pid) => {
      const row = currentByPlayerId?.[pid];
      if (!row) return 0;
      const g = Number(row.goals || 0);
      const a = Number(row.assists || 0);
      return g * 1.25 + a;
    };

    // Baseline FP getter (supports a couple shapes, safely)
    const fpBase = (pid) => {
      if (!baseline) return 0;

      // Option A: baseline.fpByPlayerId
      if (baseline.fpByPlayerId && baseline.fpByPlayerId[pid] != null) {
        return Number(baseline.fpByPlayerId[pid] || 0);
      }

      // Option B: baseline.byPlayerId (your real shape)
const row = baseline.byPlayerId?.[pid];
if (!row) return 0;

// Prefer stored fp if present (it is in your capture job)
if (row.fp != null) return Number(row.fp || 0);

// Fallback: compute from goals/assists
const g = Number(row.goals || 0);
const a = Number(row.assists || 0);
return g * 1.25 + a;

    };

    // Extract playerId from whatever roster entry shape we have (defensive)
    const getPlayerId = (p) => {
  if (!p) return null;

  // 1) direct numeric ids
  if (p.playerId != null) return String(p.playerId);
  if (p.id != null) return String(p.id);
  if (p.pid != null) return String(p.pid);

  // 2) nested player object
  if (p.player && p.player.playerId != null) return String(p.player.playerId);
  if (p.player && p.player.id != null) return String(p.player.id);

  // 3) tokens like "id:8478402" (your canonical auctionKey format)
  const token =
    p.auctionKey != null ? String(p.auctionKey) :
    p.player != null ? String(p.player) :
    p.key != null ? String(p.key) :
    null;

  if (token) {
    const m = token.match(/^id:(\d+)$/i);
    if (m) return m[1];
  }

  return null;
};


    const locksByTeam = m.locksByTeam || {};
    const teams = Array.isArray(state.teams) ? state.teams : [];

    const perTeam = teams.map((t) => {
  const teamName = String(t?.name || "");
  const lock = locksByTeam?.[teamName] || {};

  // ✅ define roster FIRST so you can safely use roster.length anywhere below
  const roster = Array.isArray(t?.roster) ? t.roster : [];

  const locked =
    Number.isFinite(Number(lock.lockedAtMs)) &&
    Number(lock.weekIndex) === idx;

  // Unlocked teams score 0
  if (!locked) {
    return {
      teamName,
      locked: false,
      lockedAtMs: lock.lockedAtMs ?? null,
      baselineCaptured,
      weeklyFP: 0,
      playersCount: roster.length,
    };
  }

  // Locked but baseline missing: weeklyFP = null (can't compute deltas yet)
  if (!baselineCaptured) {
    return {
      teamName,
      locked: true,
      lockedAtMs: lock.lockedAtMs ?? null,
      baselineCaptured: false,
      weeklyFP: null,
      playersCount: roster.length,
    };
  }

  // Locked + baseline captured: sum deltas
  let sum = 0;
  let countedPlayers = 0;
  let missingIdCount = 0;

  for (const p of roster) {
    const pid = getPlayerId(p);
    if (!pid) {
      missingIdCount++;
      continue;
    }

    let delta = fpNow(pid) - fpBase(pid);
    if (delta < 0) delta = 0; // safety clamp
    sum += delta;

    countedPlayers++;
  }

  const weeklyFP = Math.round(sum * 100) / 100;

  return {
    teamName,
    locked: true,
    lockedAtMs: lock.lockedAtMs ?? null,
    baselineCaptured: true,
    weeklyFP,
    playersCount: roster.length,

    // DEBUG
    countedPlayers,
    missingIdCount,
  };
});


    // DEBUG: compare baseline vs now for 1 player from the first non-empty roster
let sample = null;
for (const t of teams) {
  const roster = Array.isArray(t?.roster) ? t.roster : [];
  const first = roster.find((p) => getPlayerId(p));
  if (!first) continue;
  const pid = getPlayerId(first);
  sample = {
    playerId: pid,
    fpBaseline: fpBase(pid),
    fpNow: fpNow(pid),
delta: (() => {
  let d = fpNow(pid) - fpBase(pid);
  if (d < 0) d = 0;
  return Math.round(d * 100) / 100;
})(),
  };
  break;
}

    return res.json({
      ok: true,
      nowMs,
      weekId,
      weekWindow: {
        weekStartAtMs: week.weekStartAtMs,
        baselineAtMs: week.baselineAtMs,
        lockAtMs: week.lockAtMs,
        weekEndAtMs: week.weekEndAtMs,
        rolloverAtMs: week.rolloverAtMs,
      },
      sample,
      baselineMeta: {
  baselineCapturedAtMs,
  baselineStatsLastUpdatedAt,
  currentStatsLastUpdatedAt,
  statsChangedSinceBaseline:
    baselineStatsLastUpdatedAt != null &&
    currentStatsLastUpdatedAt != null &&
    Number(currentStatsLastUpdatedAt) !== Number(baselineStatsLastUpdatedAt),
},

      baselineCaptured,
      statsReady: !!statsJson?.ok && statsJson?.ready !== false,
      teams: perTeam,
      note: !baselineCaptured
  ? "Baseline not captured yet; locked teams return weeklyFP=null until captured."
  : undefined,

    });
  } catch (err) {
    console.error("[SCORING PREVIEW] failed:", err);
    return res.status(500).json({ ok: false, error: "Scoring preview failed." });
  }
});

// ===============================
// Phase 3 — Session 5: Rollover status (read-only)
// ===============================
app.get("/api/matchups/rollover/status", (req, res) => {
  const st = leagueStore.loadLeague();
  const m = st.matchups || {};
  const weeks = Array.isArray(m.scheduleWeeks) ? m.scheduleWeeks : [];
  const idx = Number(m.currentWeekIndex ?? -1);
  const week = weeks[idx] || null;

  const nowMs = Date.now();
  const weekId = week?.weekId ?? null;

  const resultsExists =
    weekId != null && Boolean(m.resultsByWeek?.[String(weekId)]);

  const canRollover =
    !!week &&
    Number.isFinite(Number(week.rolloverAtMs)) &&
    nowMs >= Number(week.rolloverAtMs) &&
    !resultsExists &&
    String(m.lastRolloverWeekId || "") !== String(weekId);

  res.json({
    ok: true,
    nowMs,
    currentWeekIndex: idx,
    currentWeekId: weekId,
    rolloverAtMs: week?.rolloverAtMs ?? null,
    lastRolloverWeekId: m.lastRolloverWeekId ?? null,
    resultsExists,
    canRollover,
  });
});


const DEBUG_MATCHUPS = process.env.MATCHUPS_DEBUG === "true";

// ✅ separate switches
const MATCHUPS_ENABLED = process.env.MATCHUPS_ENABLED === "true";

// ✅ default ON if not set (safer for live league ops)
const SNAPSHOTS_ENABLED = process.env.SNAPSHOTS_ENABLED !== "false";
const AUCTIONS_ENABLED = process.env.AUCTIONS_ENABLED !== "false";


if (DEBUG_MATCHUPS) {
app.get("/api/matchups/debug/stateSummary", (req, res) => {
  const st = leagueStore.loadLeague();
  const m = st.matchups || {};
  res.json({
    ok: true,
    currentWeekIndex: m.currentWeekIndex ?? null,
    currentWeekId: m.currentWeekId ?? null,
    resultsKeys: Object.keys(m.resultsByWeek || {}),
    lastRolloverWeekId: m.lastRolloverWeekId ?? null,
  
  });
});


// ===============================
// Phase 3 — Session 3 DEBUG: Reset locks (commissioner-only, local testing)
// ===============================
app.post("/api/matchups/debug/resetLocks", async (req, res) => {
  try {
    const body = req.body || {};
    const meta = body.meta || {};

    const role = String(meta?.actorRole || "").toLowerCase();
    if (role !== "commissioner") {
      return res.status(403).json({ ok: false, error: "Commissioner only." });
    }

    const prev = leagueStore.loadLeague();
    const m = prev.matchups || {};

    const next = {
      ...prev,
      matchups: {
        ...m,
        locksByTeam: {},
      },
    };

    await leagueStore.saveLeague(next, { savedBy: "commissioner:debugResetLocks" });

    const ioRef = req.app.get("io");
    if (ioRef) ioRef.emit("league:updated", { reason: "matchups:debugResetLocks" });

    return res.json({ ok: true });
  } catch (err) {
    console.error("[DEBUG] resetLocks failed:", err);
    return res.status(500).json({ ok: false, error: "Failed to reset locks." });
  }
});

// ===============================
// Phase 3 — DEBUG: Reset baseline for current weekId (commissioner-only)
// Local testing only.
// ===============================
app.post("/api/matchups/debug/resetBaselineForWeek", async (req, res) => {
  try {
    const body = req.body || {};
    const meta = body.meta || {};

    const role = String(meta?.actorRole || "").toLowerCase();
    if (role !== "commissioner") {
      return res.status(403).json({ ok: false, error: "Commissioner only." });
    }

    const prev = leagueStore.loadLeague();
    const m = prev.matchups || {};
    const weeks = Array.isArray(m.scheduleWeeks) ? m.scheduleWeeks : [];
    const idx = Number(m.currentWeekIndex || 0);
    const week = weeks[idx] || null;
    const weekId = week?.weekId || null;

    if (!weekId) {
      return res.status(400).json({ ok: false, error: "No current weekId." });
    }

    const baselineByWeekId = { ...(m.baselineByWeekId || {}) };
    const existed = Boolean(baselineByWeekId[weekId]);
    delete baselineByWeekId[weekId];

    const next = {
      ...prev,
      matchups: {
        ...m,
        baselineByWeekId,
      },
    };

    await leagueStore.saveLeague(next, { savedBy: "commissioner:debugResetBaselineForWeek" });

    const ioRef = req.app.get("io");
    if (ioRef) ioRef.emit("league:updated", { reason: "matchups:debugResetBaselineForWeek", weekId });

    return res.json({ ok: true, weekId, existed });
  } catch (err) {
    console.error("[DEBUG] resetBaselineForWeek failed:", err);
    return res.status(500).json({ ok: false, error: "Failed to reset baseline." });
  }
});

// ===============================
// Phase 3 — Session 4 DEBUG: Run baseline capture once (commissioner-only)
// Local/testing only.
// ===============================
console.log("REGISTERING MATCHUPS DEBUG ROUTES");

app.post("/api/matchups/debug/captureBaselineNow", async (req, res) => {
  try {
    const body = req.body || {};
    const meta = body.meta || {};

    const role = String(meta?.actorRole || "").toLowerCase();
    if (role !== "commissioner") {
      return res.status(403).json({ ok: false, error: "Commissioner only." });
    }

    // Run capture (idempotent; will no-op if already captured or before baseline time)
    await Promise.resolve(tryCaptureWeeklyBaseline());


    // Reload to show result
    const st = leagueStore.loadLeague();
    const m = st.matchups || {};
    const weeks = Array.isArray(m.scheduleWeeks) ? m.scheduleWeeks : [];
    const idx = Number(m.currentWeekIndex || 0);
    const week = weeks[idx] || null;
    const weekId = week?.weekId || null;

    const entry = weekId ? (m.baselineByWeekId || {})[weekId] : null;

    return res.json({
      ok: true,
      currentWeekIndex: idx,
      weekId,
      captured: Boolean(entry),
      capturedAtMs: entry?.capturedAtMs ?? null,
      statsLastUpdatedAt: entry?.statsLastUpdatedAt ?? null,
      playerCount: entry?.byPlayerId ? Object.keys(entry.byPlayerId).length : 0,
    });
  } catch (err) {
    console.error("[DEBUG] captureBaselineNow failed:", err);
    return res.status(500).json({ ok: false, error: "Failed to capture baseline." });
  }
});

// ===============================
// Phase 3 — Step 1 DEBUG: Run roster lock once (commissioner-only)
// Local/testing only.
// ===============================
app.post("/api/matchups/debug/runLockNow", async (req, res) => {
  try {
    const body = req.body || {};
    const meta = body.meta || {};

    const role = String(meta?.actorRole || "").toLowerCase();
    if (role !== "commissioner") {
      return res.status(403).json({ ok: false, error: "Commissioner only." });
    }

    // Run lock attempt (idempotent; will no-op if before lock time or already locked)
await Promise.resolve(tryApplyRosterLocks());

    // Reload to show result
    const st = leagueStore.loadLeague();
    const m = st.matchups || {};
    const weeks = Array.isArray(m.scheduleWeeks) ? m.scheduleWeeks : [];
    const idx = Number(m.currentWeekIndex || 0);
    const week = weeks[idx] || null;
    const weekId = week?.weekId || null;

    const locksByTeam = m.locksByTeam || {};
    const lockKeys = Object.keys(locksByTeam);

    return res.json({
      ok: true,
      currentWeekIndex: idx,
      weekId,
      serverNowMs: Date.now(),
      lockAtMs: week?.lockAtMs ?? null,
      lockedTeams: lockKeys,
      lockedCount: lockKeys.length,
    });
  } catch (err) {
    console.error("[DEBUG] runLockNow failed:", err);
    return res.status(500).json({ ok: false, error: "Failed to run lock." });
  }
});

// ===============================
// Phase 3 — Session 3 DEBUG: Set a team's roster empty/non-empty (commissioner-only)
// Local testing only.
// ===============================
app.post("/api/matchups/debug/setTeamRosterEmpty", async (req, res) => {
  try {
    const body = req.body || {};
    const meta = body.meta || {};

    const role = String(meta?.actorRole || "").toLowerCase();
    if (role !== "commissioner") {
      return res.status(403).json({ ok: false, error: "Commissioner only." });
    }

    const teamName = String(body.teamName || "").trim();
    if (!teamName) {
      return res.status(400).json({ ok: false, error: "teamName is required." });
    }

    const empty = Boolean(body.empty);

    const prev = leagueStore.loadLeague();
    const teams = Array.isArray(prev.teams) ? prev.teams : [];

    const idx = teams.findIndex((t) => t?.name === teamName);
    if (idx === -1) {
      return res.status(404).json({ ok: false, error: "Team not found." });
    }

    const nextTeams = [...teams];
    const t = { ...nextTeams[idx] };

    if (empty) {
      // Make illegal: empty roster
      t.roster = [];
    } else {
      // Make legal again: restore ONE placeholder player if empty
      // (keeps it minimal; we only need roster.length > 0 for current legality check)
      const roster = Array.isArray(t.roster) ? t.roster : [];
      if (roster.length === 0) {
        t.roster = [{ name: "__TEST_PLAYER__", salary: 1, position: "F" }];
      }
    }

    nextTeams[idx] = t;

    const next = { ...prev, teams: nextTeams };

    await leagueStore.saveLeague(next, { savedBy: "commissioner:debugSetTeamRosterEmpty" });

    const ioRef = req.app.get("io");
    if (ioRef) ioRef.emit("league:updated", { reason: "matchups:debugSetTeamRosterEmpty", teamName, empty });

    return res.json({ ok: true, teamName, empty, rosterCount: (nextTeams[idx].roster || []).length });
  } catch (err) {
    console.error("[DEBUG] setTeamRosterEmpty failed:", err);
    return res.status(500).json({ ok: false, error: "Failed to update team roster." });
  }
});
}


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

  // ✅ Fresh start when generating a new schedule (prevents “testing ghosts”)
  locksByTeam: {},
  baselineByWeekId: {},
  resultsByWeek: {},
  lastRolloverWeekId: null,

  // (Optional) keep if you still use it elsewhere; otherwise you can remove later
  baselineByPlayerId: prev?.matchups?.baselineByPlayerId || {},
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

    const forceRequested = Boolean(body.force);
const force = process.env.NODE_ENV !== "production" && forceRequested;


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

    // ✅ Matchups are backend-owned: only commissioner can overwrite matchups,
    // and only if they actually include a matchups object in the request.
    const role = String(meta?.actorRole || "").toLowerCase();
    const nextMatchups =
      role === "commissioner" && isPlainObject(body.matchups)
        ? body.matchups
        : prev.matchups;

    const next = {
      ...prev,
      teams: Array.isArray(body.teams) ? body.teams : [],
      freeAgents: Array.isArray(body.freeAgents) ? body.freeAgents : [],
      leagueLog: Array.isArray(body.leagueLog) ? body.leagueLog : [],
      tradeProposals: Array.isArray(body.tradeProposals) ? body.tradeProposals : [],
      tradeBlock: Array.isArray(body.tradeBlock) ? body.tradeBlock : [],

      // ✅ crucial line
      matchups: nextMatchups,

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
        role === "commissioner"
          ? "commissioner"
          : (meta?.actorTeam || "manager"),
    });

    const ioRef = req.app.get("io");
    if (ioRef) ioRef.emit("league:updated", { reason: "saveLeague" });

    return res.json({ ok: true });
  } catch (err) {
    console.error("[BACKEND] Error writing league-state.json:", err);
    return res.status(500).json({ ok: false, error: "Failed to save state" });
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

// DEV DEBUG: show where server.js thinks it is, and whether local stats-cache.json exists
app.get("/api/stats/debug-localpath", (req, res) => {
  try {
    const localPath = path.join(__dirname, "stats-cache.json");
    return res.json({
      ok: true,
      __dirname,
      localPath,
      localExists: fs.existsSync(localPath),
      STATS_FILE,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
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

function getCurrentWeekSafe(st) {
  const m = st?.matchups || {};
  const weeks = Array.isArray(m.scheduleWeeks) ? m.scheduleWeeks : [];
  const idx = Number(m.currentWeekIndex || 0);
  const week = weeks[idx] || null;
  if (!week) return { m, weeks, idx, week: null, reason: "noWeek" };

  const nowMs = Date.now();
  // ✅ don’t run any Phase 3 jobs before the week actually starts
  if (Number.isFinite(week.weekStartAtMs) && nowMs < Number(week.weekStartAtMs)) {
    return { m, weeks, idx, week, reason: "beforeWeekStart" };
  }

  return { m, weeks, idx, week, reason: "ok" };
}

// -------------------------------
// Phase 3 — Session 3: Apply roster locks (idempotent)
// -------------------------------
function tryApplyRosterLocks() {
  try {
    const st = leagueStore.loadLeague();
const { m, weeks, idx, week, reason } = getCurrentWeekSafe(st);
if (!week || reason !== "ok") return;
if (!Number.isFinite(week.lockAtMs)) return;

const nowMs = Date.now();

    if (nowMs < week.lockAtMs) return;

    const teams = Array.isArray(st.teams) ? st.teams : [];
    const locksByTeam = { ...(m.locksByTeam || {}) };

    let changed = false;

    for (const t of teams) {
      const name = t?.name;
      if (!name) continue;

      // already locked → skip
      const existing = locksByTeam[name];
if (existing && Number(existing.weekIndex) === idx) continue; // already locked for THIS week
// else allow overwrite for new week


      // illegal → skip (grace period)
      if (!isTeamLegalNow(t)) continue;

      // ✅ lock immediately
      locksByTeam[name] = {
        lockedAtMs: nowMs,
        weekIndex: idx,
      };
      changed = true;
    }

    if (!changed) return;

    const next = {
      ...st,
      matchups: {
        ...m,
        locksByTeam,
      },
    };

    leagueStore
      .saveLeague(next, { savedBy: "system:rosterLock" })
      .catch((e) => console.error("[LOCKS] save failed:", e));

    const ioRef = app.get("io");
    if (ioRef) ioRef.emit("league:updated", { reason: "matchups:rosterLocked" });
  } catch (err) {
    console.error("[LOCKS] Failed to apply roster locks:", err);
  }
}

// -------------------------------
// Phase 3 — Session 4: Capture baseline (idempotent, per-week, never overwrite)
// -------------------------------
function tryCaptureWeeklyBaseline() {
  try {
    const st = leagueStore.loadLeague();
const { m, weeks, idx, week, reason } = getCurrentWeekSafe(st);
if (!week || reason !== "ok") return null; // (or just return; depending on the function)


    if (!week || !week.weekId || !Number.isFinite(week.baselineAtMs)) return null;

    const nowMs = Date.now();

    if (nowMs < week.baselineAtMs) return null;

    const weekId = week.weekId;

    const baselineByWeekId = { ...(m.baselineByWeekId || {}) };

    if (baselineByWeekId[weekId]) return null;

    if (!fs.existsSync(STATS_FILE)) return null;

    const raw = fs.readFileSync(STATS_FILE, "utf8");
    const statsJson = JSON.parse(raw);

    const byPlayerId =
      statsJson?.byPlayerId && typeof statsJson.byPlayerId === "object"
        ? statsJson.byPlayerId
        : null;

    if (!byPlayerId) return null;

    const snap = {};
    for (const [playerId, s] of Object.entries(byPlayerId)) {
      const goals = Number(s?.goals) || 0;
      const assists = Number(s?.assists) || 0;
      const gamesPlayed = Number(s?.gamesPlayed) || 0;
      const fp = goals * 1.25 + assists;
      snap[playerId] = { goals, assists, gamesPlayed, fp };
    }

    baselineByWeekId[weekId] = {
      weekId,
      capturedAtMs: nowMs,
      statsSeasonId: statsJson?.seasonId ?? null,
      statsLastUpdatedAt: statsJson?.lastUpdatedAt ?? null,
      byPlayerId: snap,
    };

    const next = {
      ...st,
      matchups: {
        ...m,
        baselineByWeekId,
      },
    };

    leagueStore
      .saveLeague(next, { savedBy: "system:baselineCapture" })
      .catch((e) => console.error("[BASELINE] save failed:", e));

    const ioRef = app.get("io");
    if (ioRef) ioRef.emit("league:updated", { reason: "matchups:baselineCaptured", weekId });

    return null;
  } catch (err) {
    console.error("[BASELINE] Failed to capture baseline:", err);
    return null;
  }
}

// -------------------------------
// Phase 3 — Session 5: Rollover (idempotent)
// - finalize current week results (if not already)
// - advance currentWeekIndex
// - set currentWeekId
// - capture baseline for NEXT week (if time is >= next baselineAtMs)
// - record lastRolloverWeekId so we never double-advance
// -------------------------------
function tryRolloverMatchupWeek() {
  try {
    const st = leagueStore.loadLeague();
const { m, weeks, idx, week, reason } = getCurrentWeekSafe(st);
if (!week || reason !== "ok") return;


    if (!week || !week.weekId || !Number.isFinite(week.rolloverAtMs)) return;

    const nowMs = Date.now();

    // Only run at/after rollover time
    if (nowMs < week.rolloverAtMs) return;

    const weekId = String(week.weekId);

    // ✅ Idempotent: never roll over the same week twice
    if (m.lastRolloverWeekId && String(m.lastRolloverWeekId) === weekId) return;

    // We should have finalized results already (Session 5). If not, we can attempt it:
    // (safe: tryFinalizeWeeklyResults is idempotent)
    tryFinalizeWeeklyResults();

    // Reload so we see any results that just got written
    const st2 = leagueStore.loadLeague();
    const m2 = st2.matchups || {};
    const resultsByWeek = m2.resultsByWeek || {};

    // Safety: only advance if results exist for this week
    if (!resultsByWeek[weekId]) {
      // If results didn't get written yet, do not advance.
      return;
    }

    const nextIndex = idx + 1;
    const nextWeek = weeks[nextIndex];

    // If there is no next week, we can still mark rollover as done (prevents loops),
    // but we cannot advance further.
    if (!nextWeek || !nextWeek.weekId) {
      const nextState = {
        ...st2,
        matchups: {
          ...m2,
          lastRolloverWeekId: weekId,
        },
      };

      leagueStore
        .saveLeague(nextState, { savedBy: "system:matchupRollover:endOfSchedule" })
        .catch((e) => console.error("[ROLLOVER] save failed:", e));

      const ioRef = app.get("io");
      if (ioRef) ioRef.emit("league:updated", { reason: "matchups:rollover:endOfSchedule", weekId });

      return;
    }

    // Advance week pointer
    const advancedMatchups = {
      ...m2,
      currentWeekIndex: nextIndex,
      currentWeekId: String(nextWeek.weekId),
      lastRolloverWeekId: weekId,
      // NOTE: locksByTeam is NOT cleared here yet (Session 5/7 decision).
      // We will keep it (it’s per-team history). Our "locked for current week" check already uses weekIndex.
    };

    // Optional: capture baseline for NEXT week if we are at/after its baselineAtMs
    // (This matches the roadmap “Capture new baseline for next week at rollover”.)
    const baselineByWeekId = { ...(advancedMatchups.baselineByWeekId || {}) };

    if (
      nextWeek.baselineAtMs != null &&
      Number.isFinite(Number(nextWeek.baselineAtMs)) &&
      nowMs >= Number(nextWeek.baselineAtMs) &&
      !baselineByWeekId[String(nextWeek.weekId)]
    ) {
      if (fs.existsSync(STATS_FILE)) {
        const raw = fs.readFileSync(STATS_FILE, "utf8");
        const statsJson = JSON.parse(raw);

        const byPlayerId =
          statsJson?.byPlayerId && typeof statsJson.byPlayerId === "object"
            ? statsJson.byPlayerId
            : null;

        if (byPlayerId) {
          const snap = {};
          for (const [playerId, s] of Object.entries(byPlayerId)) {
            const goals = Number(s?.goals) || 0;
            const assists = Number(s?.assists) || 0;
            const gamesPlayed = Number(s?.gamesPlayed) || 0;
            const fp = goals * 1.25 + assists;
            snap[playerId] = { goals, assists, gamesPlayed, fp };
          }

          baselineByWeekId[String(nextWeek.weekId)] = {
            weekId: String(nextWeek.weekId),
            capturedAtMs: nowMs,
            statsSeasonId: statsJson?.seasonId ?? null,
            statsLastUpdatedAt: statsJson?.lastUpdatedAt ?? null,
            byPlayerId: snap,
          };

          advancedMatchups.baselineByWeekId = baselineByWeekId;
        }
      }
    }

    const nextState = {
      ...st2,
      matchups: advancedMatchups,
    };

    leagueStore
      .saveLeague(nextState, { savedBy: "system:matchupRollover" })
      .catch((e) => console.error("[ROLLOVER] save failed:", e));

    const ioRef = app.get("io");
    if (ioRef) {
      ioRef.emit("league:updated", {
        reason: "matchups:rollover",
        fromWeekId: weekId,
        toWeekId: String(nextWeek.weekId),
        fromWeekIndex: idx,
        toWeekIndex: nextIndex,
      });
    }
  } catch (err) {
    console.error("[ROLLOVER] Failed:", err);
  }
}

// -------------------------------
// Phase 3 — Session 5: Finalize weekly results (idempotent, never overwrite)
// Stores matchups.resultsByWeek[weekId] after weekEndAtMs
// -------------------------------
function tryFinalizeWeeklyResults() {
  try {
    const st = leagueStore.loadLeague();
const { m, weeks, idx, week, reason } = getCurrentWeekSafe(st);
if (!week || reason !== "ok") return;


    if (!week || !week.weekId || !Number.isFinite(week.weekEndAtMs)) return;

    const nowMs = Date.now();

    // Only finalize at/after week end
    if (nowMs < week.weekEndAtMs) return;

    const weekId = String(week.weekId);

    const resultsByWeek = { ...(m.resultsByWeek || {}) };

    // Idempotent: never overwrite
    if (resultsByWeek[weekId]) return;

    // Need baseline for deltas (safety)
    const baseline = m.baselineByWeekId?.[weekId] || null;
    if (!baseline || !baseline.byPlayerId) return;

    // Need current stats cache
    if (!fs.existsSync(STATS_FILE)) return;

    const raw = fs.readFileSync(STATS_FILE, "utf8");
    const statsJson = JSON.parse(raw);
    const currentByPlayerId =
      statsJson?.byPlayerId && typeof statsJson.byPlayerId === "object"
        ? statsJson.byPlayerId
        : {};

    const fpNow = (pid) => {
      const row = currentByPlayerId?.[pid];
      if (!row) return 0;
      const g = Number(row.goals || 0);
      const a = Number(row.assists || 0);
      return g * 1.25 + a;
    };

    const fpBase = (pid) => {
      const row = baseline.byPlayerId?.[pid];
      if (!row) return 0;
      if (row.fp != null) return Number(row.fp || 0);
      const g = Number(row.goals || 0);
      const a = Number(row.assists || 0);
      return g * 1.25 + a;
    };

    const getPlayerId = (p) => {
      if (!p) return null;
      if (p.playerId != null) return String(p.playerId);
      if (p.id != null) return String(p.id);
      if (p.pid != null) return String(p.pid);

      if (p.player && p.player.playerId != null) return String(p.player.playerId);
      if (p.player && p.player.id != null) return String(p.player.id);

      const token =
        p.auctionKey != null ? String(p.auctionKey) :
        p.player != null ? String(p.player) :
        p.key != null ? String(p.key) :
        null;

      if (token) {
        const mm = token.match(/^id:(\d+)$/i);
        if (mm) return mm[1];
      }
      return null;
    };

    const locksByTeam = m.locksByTeam || {};
    const teams = Array.isArray(st.teams) ? st.teams : [];

    const perTeam = {};
    for (const t of teams) {
      const teamName = String(t?.name || "");
      if (!teamName) continue;

      const lock = locksByTeam?.[teamName] || {};
      const locked =
        Number.isFinite(Number(lock.lockedAtMs)) &&
        Number(lock.weekIndex) === idx;

      // Rule: unlocked teams score 0
      if (!locked) {
        perTeam[teamName] = { weeklyFP: 0, locked: false, lockedAtMs: lock.lockedAtMs ?? null };
        continue;
      }

      const roster = Array.isArray(t?.roster) ? t.roster : [];
      let sum = 0;

      for (const p of roster) {
        const pid = getPlayerId(p);
        if (!pid) continue;

        let delta = fpNow(pid) - fpBase(pid);
        if (delta < 0) delta = 0; // safety clamp
        sum += delta;
      }

      perTeam[teamName] = {
        weeklyFP: Math.round(sum * 100) / 100,
        locked: true,
        lockedAtMs: lock.lockedAtMs ?? null,
      };
    }

    // Store a compact, auditable result object
    resultsByWeek[weekId] = {
      weekId,
      finalizedAtMs: nowMs,
      weekIndex: idx,
      weekEndAtMs: week.weekEndAtMs,
      baselineCapturedAtMs: baseline?.capturedAtMs ?? null,
      baselineStatsLastUpdatedAt: baseline?.statsLastUpdatedAt ?? null,
      statsLastUpdatedAt: statsJson?.lastUpdatedAt ?? null,
      perTeam,
    };

    const next = {
      ...st,
      matchups: {
        ...m,
        resultsByWeek,
      },
    };

    leagueStore
      .saveLeague(next, { savedBy: "system:finalizeWeeklyResults" })
      .catch((e) => console.error("[RESULTS] save failed:", e));

    const ioRef = app.get("io");
    if (ioRef) ioRef.emit("league:updated", { reason: "matchups:weekFinalized", weekId });
  } catch (err) {
    console.error("[RESULTS] Failed to finalize weekly results:", err);
  }
}

// ===============================
// BOOT: auto jobs + server listen
// ===============================

// ===============================
// BOOT: auto jobs + server listen
// ===============================

// ✅ Always-on league ops (unless explicitly disabled)
if (SNAPSHOTS_ENABLED) {
  console.log("[SNAPSHOTS] enabled: auto-weekly snapshots ON");
  tryAutoWeeklySnapshot();
  setInterval(tryAutoWeeklySnapshot, 60 * 1000);
} else {
  console.log("[SNAPSHOTS] disabled");
}

if (AUCTIONS_ENABLED) {
  console.log("[AUCTIONS] enabled: auto auction rollover ON");
  tryAutoAuctionRollover();
  setInterval(tryAutoAuctionRollover, 60 * 1000);
} else {
  console.log("[AUCTIONS] disabled");
}

// ✅ Matchups jobs are separate + optional
if (MATCHUPS_ENABLED) {
  console.log("[MATCHUPS] enabled: matchup auto-jobs ON");

  tryApplyRosterLocks();
  setInterval(tryApplyRosterLocks, 60 * 1000);

  tryCaptureWeeklyBaseline();
  setInterval(tryCaptureWeeklyBaseline, 60 * 1000);

  tryFinalizeWeeklyResults();
  setInterval(tryFinalizeWeeklyResults, 60 * 1000);

  tryRolloverMatchupWeek();
  setInterval(tryRolloverMatchupWeek, 60 * 1000);
} else {
  console.log("[MATCHUPS] disabled: matchup auto-jobs OFF");
}




server.listen(PORT, () => {
  console.log(`Hundo Leago backend + WebSocket listening on port ${PORT}`);
});
