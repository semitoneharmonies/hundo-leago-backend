// server.js
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Where we store the league data on the server
const DATA_FILE = path.join(__dirname, "league-state.json");
const SNAPSHOT_DIR = path.join(__dirname, "snapshots");

// Make sure snapshot folder exists
if (!fs.existsSync(SNAPSHOT_DIR)) {
  fs.mkdirSync(SNAPSHOT_DIR);
}

function emptyState() {
  return {
    teams: [],
    freeAgents: [],
    leagueLog: [],
    tradeProposals: [],
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
    tradeProposals: Array.isArray(body.tradeProposals)
      ? body.tradeProposals
      : [],
    nextAuctionDeadline: body.nextAuctionDeadline || null,
  };

  try {
    saveLeagueState(state);
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
    res.json({ ok: true });
  } catch (err) {
    console.error("[BACKEND] Error restoring snapshot:", err);
    res.status(500).json({ ok: false, error: "Failed to restore snapshot" });
  }
});

/**
 * Simple root route – useful to see if backend is alive
 */
app.get("/", (req, res) => {
  res.send("Hundo Leago backend is running.");
});
app.get("/", (req, res) => {
  res.send("Hundo Leago backend is running.");
});

app.listen(PORT, () => {
  console.log(`Hundo Leago backend listening on port ${PORT}`);
});
