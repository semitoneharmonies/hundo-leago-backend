// server.js
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const http = require("http");             // For Socket.IO integration
const { Server } = require("socket.io");  // Socket.IO server

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));


// Create HTTP server and wrap Express (for Socket.IO)
const server = http.createServer(app);

// Create Socket.IO server
const io = new Server(server, {
  cors: {
    origin: "*", // you can restrict this later if you want
    methods: ["GET", "POST"],
  },
});

// Optional: log connections for debugging
io.on("connection", (socket) => {
  console.log("🔌 WebSocket client connected:", socket.id);

  socket.on("disconnect", () => {
    console.log("❌ WebSocket client disconnected:", socket.id);
  });
});

// Make io available inside route handlers via req.app.get("io")
app.set("io", io);

// ===============================
//   PERSISTENT STORAGE PATHS
// ===============================
//
// On Render you set:
//   LEAGUE_FILE  = /opt/render/project/data/hundo/league-state.json
//   SNAPSHOT_DIR = /opt/render/project/data/hundo/snapshots
//
// Locally (on your PC), it will fall back to files next to server.js.

const DATA_FILE =
  process.env.LEAGUE_FILE || path.join(__dirname, "league-state.json");

const SNAPSHOT_DIR =
  process.env.SNAPSHOT_DIR || path.join(__dirname, "snapshots");

// Make sure snapshot folder exists
if (!fs.existsSync(SNAPSHOT_DIR)) {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
}

function emptyState() {
  return {
    teams: [],
    freeAgents: [],
    leagueLog: [],
    tradeProposals: [],
    tradeBlock: [],
    settings: { frozen: false },
    nextAuctionDeadline: null,
    lastAutoWeeklySnapshotId: null,
    lastAutoAuctionRolloverId: null,
  };
}


function loadLeagueState() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      console.warn("[BACKEND] league-state.json not found, using empty state");
      return emptyState();
    }
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("[BACKEND] Failed to read league-state.json:", err);
    return emptyState();
  }
}

function saveLeagueState(state) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), "utf8");
}

/**
 * GET /api/league
 * Frontend uses this to LOAD the league on startup
 */
app.get("/api/league", (req, res) => {
  const state = loadLeagueState();
  res.json(state);
});

// -------------------------------
// Auto-weekly snapshot (Sunday 4:00 PM Pacific)
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
  // out: { weekday, year, month, day, hour, minute }
  return out;
}

function buildAutoSnapshotId(partsPT) {
  // Example: auto-2025-12-14-1600PT
  return `auto-${partsPT.year}-${partsPT.month}-${partsPT.day}-${partsPT.hour}${partsPT.minute}PT`;
}

function writeSnapshotFile(snapshotId, state) {
  const file = path.join(SNAPSHOT_DIR, `${snapshotId}.json`);
  fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
  return snapshotId;
}

function tryAutoWeeklySnapshot() {
  try {
    const timeZone = "America/Los_Angeles";
    const partsPT = getPartsInTZ(new Date(), timeZone);

    // Only on Sunday
    if (partsPT.weekday !== "Sun") return;

    // 4:00 PM Pacific = 16:00
    // Give a 10-minute window so we don't miss it if the check isn't exact.
    const hour = Number(partsPT.hour);
    const minute = Number(partsPT.minute);
    const inWindow = hour === 16 && minute >= 0 && minute <= 10;
    if (!inWindow) return;

    const snapshotId = buildAutoSnapshotId({
      ...partsPT,
      minute: "00", // normalize to 1600 for the id
    });

    const state = loadLeagueState();

    // Persist “already created this week” on disk so restarts don’t double-create
    if (state.lastAutoWeeklySnapshotId === snapshotId) return;

    writeSnapshotFile(snapshotId, state);

    state.lastAutoWeeklySnapshotId = snapshotId;
    saveLeagueState(state);

    console.log(`[AUTO SNAPSHOT] Created weekly snapshot: ${snapshotId}`);

    const io = app.get("io");
    if (io) io.emit("league:updated", { reason: "autoWeeklySnapshot", snapshotId });
  } catch (err) {
    console.error("[AUTO SNAPSHOT] Failed:", err);
  }
}

/**
 * POST /api/league
 * Frontend uses this to SAVE league changes (buyouts, trades, bids, etc.)
 */
app.post("/api/league", (req, res) => {
  const body = req.body || {};

  try {
    // ✅ Load existing so we don't wipe fields we don't explicitly send from frontend
    const prev = loadLeagueState();

    const next = {
      ...prev,

      // Overwrite the fields the frontend actually owns
      teams: Array.isArray(body.teams) ? body.teams : [],
      freeAgents: Array.isArray(body.freeAgents) ? body.freeAgents : [],
      leagueLog: Array.isArray(body.leagueLog) ? body.leagueLog : [],
      tradeProposals: Array.isArray(body.tradeProposals) ? body.tradeProposals : [],
      tradeBlock: Array.isArray(body.tradeBlock) ? body.tradeBlock : [],
      settings:
        body.settings && typeof body.settings === "object"
          ? body.settings
          : prev.settings || { frozen: false },
      nextAuctionDeadline: body.nextAuctionDeadline || prev.nextAuctionDeadline || null,

      // ✅ Explicitly preserve auto-run markers
      lastAutoWeeklySnapshotId: prev.lastAutoWeeklySnapshotId || null,
      lastAutoAuctionRolloverId: prev.lastAutoAuctionRolloverId || null,
    };

    saveLeagueState(next);

    const io = req.app.get("io");
    if (io) io.emit("league:updated", { reason: "saveLeague" });

    res.json({ ok: true });
  } catch (err) {
    console.error("[BACKEND] Error writing league-state.json:", err);
    res.status(500).json({ ok: false, error: "Failed to save state" });
  }
});


/**
 * GET /api/snapshots
 * Frontend uses this to list snapshots.
 * For now, it’s safe if this returns an empty list.
 */
app.get("/api/snapshots", (req, res) => {
  try {
    if (!fs.existsSync(SNAPSHOT_DIR)) {
      return res.json({ snapshots: [] });
    }

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
    res
      .status(500)
      .json({ snapshots: [], error: "Failed to load snapshots" });
  }
});

/**
 * POST /api/snapshots/restore
 * Your frontend already calls this when you click “Restore snapshot”.
 * This will overwrite league-state.json with the snapshot content.
 */
app.post("/api/snapshots/restore", (req, res) => {
  const { id } = req.body || {};
  if (!id) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing snapshot id in body" });
  }

  const file = path.join(SNAPSHOT_DIR, `${id}.json`);
  if (!fs.existsSync(file)) {
    return res.status(404).json({ ok: false, error: "Snapshot not found" });
  }

  try {
    const raw = fs.readFileSync(file, "utf8");
    const state = JSON.parse(raw);
    saveLeagueState(state);

    // 🔔 Notify all clients that a snapshot restore changed the league state
    const io = req.app.get("io");
    if (io) {
      io.emit("league:updated", {
        reason: "snapshotRestored",
        snapshotId: id,
      });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("[BACKEND] Error restoring snapshot:", err);
    res.status(500).json({ ok: false, error: "Failed to restore snapshot" });
  }
});
/**
 * POST /api/snapshots/create
 * Creates a snapshot file in SNAPSHOT_DIR based on the CURRENT league-state.json
 * Body: { name?: string | null }
 */
app.post("/api/snapshots/create", (req, res) => {
  try {
    const { name } = req.body || {};

    // Load current league state (what's currently in league-state.json)
    const state = loadLeagueState();

    // Build a snapshot id
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

    // Notify clients so commissioner dropdown can refresh (optional but nice)
    const io = req.app.get("io");
    if (io) {
      io.emit("league:updated", { reason: "snapshotCreated", snapshotId });
    }

    return res.json({ ok: true, snapshotId });
  } catch (err) {
    console.error("[BACKEND] Error creating snapshot:", err);
    return res.status(500).json({ ok: false, error: "Failed to create snapshot" });
  }
});

/**
 * Simple root route – useful to see if backend is alive
 */
app.get("/", (req, res) => {
  res.send("Hundo Leago backend is running.");
});

// Run once on boot, then every minute
tryAutoWeeklySnapshot();
setInterval(tryAutoWeeklySnapshot, 60 * 1000);
tryAutoAuctionRollover();
setInterval(tryAutoAuctionRollover, 60 * 1000);


// 🔁 IMPORTANT: use server.listen instead of app.listen now
server.listen(PORT, () => {
  console.log(`Hundo Leago backend + WebSocket listening on port ${PORT}`);
});

// -------------------------------
// Auto-auction rollover (Sunday 4:00 PM Pacific)
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

  // Active bids = unresolved bids
  const activeBids = bids.filter((b) => !b.resolved);
  if (activeBids.length === 0) {
    return { nextTeams: teams, nextFreeAgents: bids, nextLeagueLog: leagueLog, newLogs: [] };
  }

  // Group bids by player key
  const bidsByPlayer = new Map();
  for (const bid of activeBids) {
    const key = String(bid.player || "").toLowerCase();
    if (!key) continue;
    if (!bidsByPlayer.has(key)) bidsByPlayer.set(key, []);
    bidsByPlayer.get(key).push(bid);
  }

  // Copy teams shallowly
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
      return aTs - bTs;
    });

    const winner = sorted[0];
    if (!winner) continue;

    const playerName = winner.player;
    const winningTeamName = winner.team;
    const newSalary = Number(winner.amount) || 0;
    const position = winner.position || "F";

    // Mark all bids for this player as resolved (we'll delete them after)
    for (const bid of playerBids) resolvedBidIds.add(bid.id);

    const teamIdx = nextTeams.findIndex((t) => t.name === winningTeamName);
    if (teamIdx === -1) continue;

    // Add player to roster (no fancy sorting needed server-side)
    nextTeams[teamIdx].roster.push({
      name: playerName,
      salary: newSalary,
      position,
      buyoutLockedUntil: nowMs + BUYOUT_LOCK_MS,
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

  // ✅ Delete all bids for resolved auctions (same as your frontend resolveAuctions)
  const nextFreeAgents = bids.filter((bid) => !resolvedBidIds.has(bid.id));

  // Prepend logs
  const nextLeagueLog = [...newLogs, ...leagueLog];

  return { nextTeams, nextFreeAgents, nextLeagueLog, newLogs };
}

function tryAutoAuctionRollover() {
  try {
    const timeZone = "America/Los_Angeles";
    const partsPT = getPartsInTZ(new Date(), timeZone);

    // Only on Sunday
    if (partsPT.weekday !== "Sun") return;

    // 4:00 PM Pacific = 16:00
    // Give a 10-minute window
    const hour = Number(partsPT.hour);
    const minute = Number(partsPT.minute);
    const inWindow = hour === 16 && minute >= 0 && minute <= 10;
    if (!inWindow) return;

    const rolloverId = buildAutoAuctionRolloverId({
      ...partsPT,
      minute: "00", // normalize id to 1600
    });

    const state = loadLeagueState();

    // Run once per week (persisted)
    if (state.lastAutoAuctionRolloverId === rolloverId) return;

    const nowMs = Date.now();
    const { nextTeams, nextFreeAgents, nextLeagueLog, newLogs } = resolveAuctionsServer(state, nowMs);

    // If there were no active auctions, still mark it as "ran" so it doesn't spam
    state.teams = nextTeams;
    state.freeAgents = nextFreeAgents;
    state.leagueLog = nextLeagueLog;

    state.lastAutoAuctionRolloverId = rolloverId;
    saveLeagueState(state);

    console.log(`[AUTO AUCTIONS] Rollover complete: ${rolloverId} (signings: ${newLogs.length})`);

    const io = app.get("io");
    if (io) io.emit("league:updated", { reason: "autoAuctionRollover", rolloverId });
  } catch (err) {
    console.error("[AUTO AUCTIONS] Failed:", err);
  }
}
