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
app.use(express.json());

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

/**
 * POST /api/league
 * Frontend uses this to SAVE league changes (buyouts, trades, bids, etc.)
 */
app.post("/api/league", (req, res) => {
  const body = req.body || {};

    const state = {
    teams: Array.isArray(body.teams) ? body.teams : [],
    freeAgents: Array.isArray(body.freeAgents) ? body.freeAgents : [],
    leagueLog: Array.isArray(body.leagueLog) ? body.leagueLog : [],
    tradeProposals: Array.isArray(body.tradeProposals) ? body.tradeProposals : [],
    tradeBlock: Array.isArray(body.tradeBlock) ? body.tradeBlock : [],
    settings: body.settings && typeof body.settings === "object" ? body.settings : { frozen: false },
    nextAuctionDeadline: body.nextAuctionDeadline || null,
  };


  try {
    saveLeagueState(state);

    // 🔔 Notify all connected clients that the league changed
    const io = req.app.get("io");
    if (io) {
      io.emit("league:updated", { reason: "saveLeague" });
    }

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

// 🔁 IMPORTANT: use server.listen instead of app.listen now
server.listen(PORT, () => {
  console.log(`Hundo Leago backend + WebSocket listening on port ${PORT}`);
});
