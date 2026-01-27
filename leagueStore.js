// leagueStore.js
const fs = require("fs");
const path = require("path");

const SCHEMA_VERSION = 1;

function ensureDirSync(dirPath) {
  if (!dirPath) return;
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function safeReadJsonSync(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    meta: {
      createdAt: Date.now(),
      lastSavedAt: null,
      lastSavedBy: null,
      loadedFromDisk: false,
      dataFilePath: null,
    },
    teams: [],
    freeAgents: [],
    leagueLog: [],
    tradeProposals: [],
    tradeBlock: [],

    // Phase 3 — Matchups (state only for now)
   matchups: {
  seasonId: null,
  scheduleWeeks: [],
  currentWeekIndex: 0,
  currentWeekId: null,
  locksByTeam: {},
  baselineByPlayerId: {},
  baselineByWeekId: {}, 
  resultsByWeek: {},
   lastRolloverWeekId: null,
},


    settings: { frozen: false },
    nextAuctionDeadline: null,
    lastAutoWeeklySnapshotId: null,
    lastAutoAuctionRolloverId: null,
  };
}

function toStr(x, fallback = "") {
  if (x == null) return fallback;
  return String(x);
}

function toNum(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function toBool(x, fallback = false) {
  if (typeof x === "boolean") return x;
  if (x === "true") return true;
  if (x === "false") return false;
  return fallback;
}

function toObj(x, fallback = {}) {
  return x && typeof x === "object" && !Array.isArray(x) ? x : fallback;
}

function toArr(x) {
  return Array.isArray(x) ? x : [];
}

function normalizeMatchups(m) {
  const obj = toObj(m, {});
  return {
    seasonId: obj.seasonId == null ? null : toStr(obj.seasonId, "").trim(),
    scheduleWeeks: toArr(obj.scheduleWeeks),
    currentWeekIndex: toNum(obj.currentWeekIndex, 0),
    currentWeekId: obj.currentWeekId == null ? null : toStr(obj.currentWeekId, "").trim(),
    locksByTeam: toObj(obj.locksByTeam, {}),
    baselineByPlayerId: toObj(obj.baselineByPlayerId, {}),
    baselineByWeekId: toObj(obj.baselineByWeekId, {}),
    resultsByWeek: toObj(obj.resultsByWeek, {}),
    lastRolloverWeekId:
    obj.lastRolloverWeekId == null ? null : toStr(obj.lastRolloverWeekId, "").trim(),
  };
}

function normalizeNameKey(s) {
  return toStr(s, "").trim().toLowerCase();
}

function normalizePlayer(p) {
  const obj = toObj(p, {});
  const name = toStr(obj.name, "").trim();
  const positionRaw = toStr(obj.position, "F").trim().toUpperCase();
  const position = positionRaw === "D" ? "D" : "F";

  return {
    ...obj,
    name,
    salary: toNum(obj.salary, 0),
    position,
    onIR: toBool(obj.onIR, false),
    buyoutLockedUntil: obj.buyoutLockedUntil == null ? obj.buyoutLockedUntil : toNum(obj.buyoutLockedUntil, 0),
  };
}

function normalizeBuyout(b) {
  const obj = toObj(b, {});
  return {
    ...obj,
    player: toStr(obj.player, "").trim(),
    penalty: toNum(obj.penalty, 0),
    retained: toBool(obj.retained, false),
  };
}

function normalizeTeam(t) {
  const obj = toObj(t, {});
  const roster = toArr(obj.roster).map(normalizePlayer);
  const buyouts = toArr(obj.buyouts).map(normalizeBuyout);

  return {
    ...obj,
    name: toStr(obj.name, "").trim(),
    roster,
    buyouts,
  };
}

function normalizeBid(b) {
  const obj = toObj(b, {});
  const player = toStr(obj.player, "").trim();
  const auctionKey = toStr(obj.auctionKey, "").trim() || normalizeNameKey(player);

  const positionRaw = toStr(obj.position, "F").trim().toUpperCase();
  const position = positionRaw === "D" ? "D" : "F";

  return {
    ...obj,
    id: toStr(obj.id, "").trim(),
    auctionKey,
    player,
    team: toStr(obj.team, "").trim(),
    amount: toNum(obj.amount, 0),
    minAmount: obj.minAmount == null ? obj.minAmount : toNum(obj.minAmount, 0),
    firstTimestamp: obj.firstTimestamp == null ? obj.firstTimestamp : toNum(obj.firstTimestamp, 0),
    auctionStartedBy: obj.auctionStartedBy == null ? obj.auctionStartedBy : toStr(obj.auctionStartedBy, ""),
    auctionStartedAt: obj.auctionStartedAt == null ? obj.auctionStartedAt : toNum(obj.auctionStartedAt, 0),
    editCount: obj.editCount == null ? obj.editCount : toNum(obj.editCount, 0),
    lastEditAt: obj.lastEditAt == null ? obj.lastEditAt : toNum(obj.lastEditAt, 0),
    position,
    resolved: toBool(obj.resolved, false),
    timestamp: obj.timestamp == null ? obj.timestamp : toNum(obj.timestamp, 0),
  };
}

function normalizeTrade(tr) {
  const obj = toObj(tr, {});
  return {
    ...obj,
    id: toStr(obj.id, "").trim(),
    fromTeam: toStr(obj.fromTeam, "").trim(),
    toTeam: toStr(obj.toTeam, "").trim(),
    status: toStr(obj.status, "pending").trim(),
    offeredPlayers: toArr(obj.offeredPlayers).map((x) => toStr(x, "").trim()).filter(Boolean),
    requestedPlayers: toArr(obj.requestedPlayers).map((x) => toStr(x, "").trim()).filter(Boolean),
    penaltyFrom: toNum(obj.penaltyFrom, 0),
    penaltyTo: toNum(obj.penaltyTo, 0),
    retentionFrom: toObj(obj.retentionFrom || obj.retention || {}, {}),
    retentionTo: toObj(obj.retentionTo || {}, {}),
    createdAt: toNum(obj.createdAt, Date.now()),
    expiresAt: obj.expiresAt == null ? obj.expiresAt : toNum(obj.expiresAt, 0),
  };
}

function normalizeLeagueState(input, { dataFilePath, loadedFromDisk } = {}) {
  const base = emptyState();
  const raw = input && typeof input === "object" ? input : {};

  const metaIn = toObj(raw.meta, {});
  const settingsIn = toObj(raw.settings, {});

  const next = {
    ...base,
    ...raw,

    schemaVersion: toNum(raw.schemaVersion, SCHEMA_VERSION) || SCHEMA_VERSION,

    meta: {
      ...base.meta,
      ...metaIn,
      loadedFromDisk: loadedFromDisk == null ? toBool(metaIn.loadedFromDisk, false) : Boolean(loadedFromDisk),
      dataFilePath: dataFilePath || metaIn.dataFilePath || base.meta.dataFilePath,
    },

    teams: toArr(raw.teams).map(normalizeTeam),
    freeAgents: toArr(raw.freeAgents).map(normalizeBid),
    leagueLog: toArr(raw.leagueLog),
    tradeProposals: toArr(raw.tradeProposals).map(normalizeTrade),
    tradeBlock: toArr(raw.tradeBlock),
matchups: normalizeMatchups(raw.matchups),

    settings: {
      ...base.settings,
      ...settingsIn,
      frozen: toBool(settingsIn.frozen, false),
    },

    nextAuctionDeadline: raw.nextAuctionDeadline == null ? null : raw.nextAuctionDeadline,
    lastAutoWeeklySnapshotId: raw.lastAutoWeeklySnapshotId ?? null,
    lastAutoAuctionRolloverId: raw.lastAutoAuctionRolloverId ?? null,
  };

  return next;
}

// single-writer queue (prevents overlapping writes)
let writeChain = Promise.resolve();

function createLeagueStore({
  dataFilePath,
  // NEW (optional): where to write backups
  backupsDirPath,
  // NEW (optional): set to 0 for unlimited
  maxBackups = 200,
} = {}) {
  if (!dataFilePath) throw new Error("createLeagueStore requires dataFilePath");

  ensureDirSync(path.dirname(dataFilePath));

  // NEW: default backups folder next to league-state.json
  const backupsDir =
    backupsDirPath ||
    path.join(path.dirname(dataFilePath), "backups");

  ensureDirSync(backupsDir);

  function loadLeague() {
  try {
    if (!fs.existsSync(dataFilePath)) {
      return normalizeLeagueState(emptyState(), {
        dataFilePath,
        loadedFromDisk: false,
      });
    }

    const parsed = safeReadJsonSync(dataFilePath);

    return normalizeLeagueState(parsed, {
      dataFilePath,
      loadedFromDisk: true,
    });
  } catch (e) {
    console.error("[BACKEND] Failed to load league state:", e);

    const st = normalizeLeagueState(emptyState(), {
      dataFilePath,
      loadedFromDisk: false,
    });

    st.meta.loadError = String(e?.message || e);
    return st;
  }
}


  // NEW: timestamp → filename-safe
  function isoSafe(ts = Date.now()) {
    // 2026-01-12T20-31-45-123Z
    return new Date(ts).toISOString().replace(/[:.]/g, "-");
  }

  // NEW: write a versioned backup (atomic)
  function writeBackupSync(stateObj, { savedBy = "system" } = {}) {
    try {
      const stamp = isoSafe(Date.now());
      const filename = `${stamp}__by_${String(savedBy || "system")
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "_")
        .slice(0, 32)}.json`;

      const backupPath = path.join(backupsDir, filename);
      const tmpPath = `${backupPath}.tmp`;

      fs.writeFileSync(tmpPath, JSON.stringify(stateObj, null, 2), "utf8");
      fs.renameSync(tmpPath, backupPath);

      return backupPath;
    } catch (e) {
      // IMPORTANT: backup failure should NOT block saving the live state
      console.error("[BACKEND] Failed to write backup:", e);
      return null;
    }
  }

  // NEW: prune oldest backups (best-effort)
  function pruneBackupsBestEffort() {
    try {
      if (!maxBackups || maxBackups <= 0) return;

      const files = fs
        .readdirSync(backupsDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
          const p = path.join(backupsDir, f);
          const stat = fs.statSync(p);
          return { file: f, path: p, mtimeMs: stat.mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first

      if (files.length <= maxBackups) return;

      const toDelete = files.slice(maxBackups);
      for (const x of toDelete) {
        try {
          fs.unlinkSync(x.path);
        } catch (_) {}
      }
    } catch (e) {
      console.error("[BACKEND] Failed pruning backups:", e);
    }
  }

  function saveLeague(state, { savedBy = "system" } = {}) {
    // queue writes
    writeChain = writeChain.then(() => {
      let next = normalizeLeagueState(state, { dataFilePath });


      next.schemaVersion = Number(next.schemaVersion || SCHEMA_VERSION) || SCHEMA_VERSION;
      next.meta = {
        ...(next.meta || {}),
        createdAt: next.meta?.createdAt || Date.now(),
        lastSavedAt: Date.now(),
        lastSavedBy: savedBy,
        dataFilePath,
        
      };
      // Backup the current live file (best rollback point)
try {
  if (fs.existsSync(dataFilePath)) {
    const prevOnDisk = safeReadJsonSync(dataFilePath);
    writeBackupSync(prevOnDisk, { savedBy: "prewrite_live" });
  }
} catch (e) {
  console.error("[BACKEND] Failed to backup current live state:", e);
}

// ❌ NO writeBackupSync(next, { savedBy }) here

pruneBackupsBestEffort();

const tmpPath = `${dataFilePath}.tmp`;
const json = JSON.stringify(next, null, 2);

// atomic write: write tmp then rename
fs.writeFileSync(tmpPath, json, "utf8");
fs.renameSync(tmpPath, dataFilePath);


      return null;
    });

    return writeChain;
  }

  // NEW: list backups
  function listBackups({ limit = 50 } = {}) {
    ensureDirSync(backupsDir);

    const files = fs
      .readdirSync(backupsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const p = path.join(backupsDir, f);
        const stat = fs.statSync(p);
        return {
          id: f, // use filename as id
          createdAt: stat.mtimeMs,
          size: stat.size,
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);

    return files.slice(0, Math.max(1, Number(limit) || 50));
  }

 // NEW: restore from backup file (queued + atomic)
function restoreBackup(backupId, { restoredBy = "system" } = {}) {
  if (!backupId) throw new Error("restoreBackup requires backupId");

  // serialize restore with saves and RETURN the restored state
  const restorePromise = (writeChain = writeChain.then(() => {
    const backupPath = path.join(backupsDir, backupId);
    if (!fs.existsSync(backupPath)) {
      throw new Error(`Backup not found: ${backupId}`);
    }

    const restoredRaw = safeReadJsonSync(backupPath);
    const st = normalizeLeagueState(restoredRaw, {
      dataFilePath,
      loadedFromDisk: true,
    });

    st.schemaVersion = Number(st.schemaVersion || SCHEMA_VERSION) || SCHEMA_VERSION;
    st.meta = {
      ...(st.meta || {}),
      lastRestoredAt: Date.now(),
      lastRestoredBy: restoredBy,
      dataFilePath,
    };

    // Write restored state as the live file (atomic)
    const tmpPath = `${dataFilePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(st, null, 2), "utf8");
    fs.renameSync(tmpPath, dataFilePath);

    // Keep a “restore event” backup entry (optional)
    writeBackupSync(st, { savedBy: `restore_${restoredBy}` });
    pruneBackupsBestEffort();

    return st;
  }));

  return restorePromise;
}



  return {
    loadLeague,
    saveLeague,
    emptyState,
    SCHEMA_VERSION,

    // NEW exports
    listBackups,
    restoreBackup,
    backupsDir,
  };
}

module.exports = { createLeagueStore };
