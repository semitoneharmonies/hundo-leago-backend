const fs = require("node:fs");
const path = require("node:path");

const {
  createJsonBackupRepository,
} = require("./JsonBackupRepository");

const SCHEMA_VERSION = 1;

function ensureDirSync(dirPath) {
  if (!dirPath) return;
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
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

function toStr(value, fallback = "") {
  if (value == null) return fallback;
  return String(value);
}

function toNum(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toBool(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function toObj(value, fallback = {}) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? value
    : fallback;
}

function toArr(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeMatchups(matchups) {
  const object = toObj(matchups, {});
  return {
    seasonId:
      object.seasonId == null
        ? null
        : toStr(object.seasonId, "").trim(),
    scheduleWeeks: toArr(object.scheduleWeeks),
    currentWeekIndex: toNum(object.currentWeekIndex, 0),
    currentWeekId:
      object.currentWeekId == null
        ? null
        : toStr(object.currentWeekId, "").trim(),
    locksByTeam: toObj(object.locksByTeam, {}),
    baselineByPlayerId: toObj(
      object.baselineByPlayerId,
      {}
    ),
    baselineByWeekId: toObj(object.baselineByWeekId, {}),
    resultsByWeek: toObj(object.resultsByWeek, {}),
    lastRolloverWeekId:
      object.lastRolloverWeekId == null
        ? null
        : toStr(object.lastRolloverWeekId, "").trim(),
  };
}

function normalizeNameKey(value) {
  return toStr(value, "").trim().toLowerCase();
}

function normalizePlayer(player) {
  const object = toObj(player, {});
  const name = toStr(object.name, "").trim();
  const positionRaw = toStr(
    object.position,
    "F"
  )
    .trim()
    .toUpperCase();
  const position = positionRaw === "D" ? "D" : "F";

  return {
    ...object,
    name,
    salary: toNum(object.salary, 0),
    position,
    onIR: toBool(object.onIR, false),
    buyoutLockedUntil:
      object.buyoutLockedUntil == null
        ? object.buyoutLockedUntil
        : toNum(object.buyoutLockedUntil, 0),
  };
}

function normalizeBuyout(buyout) {
  const object = toObj(buyout, {});
  return {
    ...object,
    player: toStr(object.player, "").trim(),
    penalty: toNum(object.penalty, 0),
    retained: toBool(object.retained, false),
  };
}

function normalizeTeam(team) {
  const object = toObj(team, {});
  const roster = toArr(object.roster).map(normalizePlayer);
  const buyouts = toArr(object.buyouts).map(normalizeBuyout);

  return {
    ...object,
    name: toStr(object.name, "").trim(),
    roster,
    buyouts,
  };
}

function normalizeBid(bid) {
  const object = toObj(bid, {});
  const player = toStr(object.player, "").trim();
  const auctionKey =
    toStr(object.auctionKey, "").trim() ||
    normalizeNameKey(player);
  const positionRaw = toStr(
    object.position,
    "F"
  )
    .trim()
    .toUpperCase();
  const position = positionRaw === "D" ? "D" : "F";

  return {
    ...object,
    id: toStr(object.id, "").trim(),
    auctionKey,
    player,
    team: toStr(object.team, "").trim(),
    amount: toNum(object.amount, 0),
    minAmount:
      object.minAmount == null
        ? object.minAmount
        : toNum(object.minAmount, 0),
    firstTimestamp:
      object.firstTimestamp == null
        ? object.firstTimestamp
        : toNum(object.firstTimestamp, 0),
    auctionStartedBy:
      object.auctionStartedBy == null
        ? object.auctionStartedBy
        : toStr(object.auctionStartedBy, ""),
    auctionStartedAt:
      object.auctionStartedAt == null
        ? object.auctionStartedAt
        : toNum(object.auctionStartedAt, 0),
    editCount:
      object.editCount == null
        ? object.editCount
        : toNum(object.editCount, 0),
    lastEditAt:
      object.lastEditAt == null
        ? object.lastEditAt
        : toNum(object.lastEditAt, 0),
    position,
    resolved: toBool(object.resolved, false),
    timestamp:
      object.timestamp == null
        ? object.timestamp
        : toNum(object.timestamp, 0),
  };
}

function normalizeTrade(trade) {
  const object = toObj(trade, {});
  return {
    ...object,
    id: toStr(object.id, "").trim(),
    fromTeam: toStr(object.fromTeam, "").trim(),
    toTeam: toStr(object.toTeam, "").trim(),
    status: toStr(object.status, "pending").trim(),
    offeredPlayers: toArr(object.offeredPlayers)
      .map((value) => toStr(value, "").trim())
      .filter(Boolean),
    requestedPlayers: toArr(object.requestedPlayers)
      .map((value) => toStr(value, "").trim())
      .filter(Boolean),
    penaltyFrom: toNum(object.penaltyFrom, 0),
    penaltyTo: toNum(object.penaltyTo, 0),
    retentionFrom: toObj(
      object.retentionFrom || object.retention || {},
      {}
    ),
    retentionTo: toObj(object.retentionTo || {}, {}),
    createdAt: toNum(object.createdAt, Date.now()),
    expiresAt:
      object.expiresAt == null
        ? object.expiresAt
        : toNum(object.expiresAt, 0),
  };
}

function normalizeLeagueState(
  input,
  { dataFilePath, loadedFromDisk } = {}
) {
  const base = emptyState();
  const raw =
    input && typeof input === "object" ? input : {};
  const metaIn = toObj(raw.meta, {});
  const settingsIn = toObj(raw.settings, {});

  return {
    ...base,
    ...raw,
    schemaVersion:
      toNum(raw.schemaVersion, SCHEMA_VERSION) ||
      SCHEMA_VERSION,
    meta: {
      ...base.meta,
      ...metaIn,
      loadedFromDisk:
        loadedFromDisk == null
          ? toBool(metaIn.loadedFromDisk, false)
          : Boolean(loadedFromDisk),
      dataFilePath:
        dataFilePath ||
        metaIn.dataFilePath ||
        base.meta.dataFilePath,
    },
    teams: toArr(raw.teams).map(normalizeTeam),
    freeAgents: toArr(raw.freeAgents).map(normalizeBid),
    leagueLog: toArr(raw.leagueLog),
    tradeProposals: toArr(raw.tradeProposals).map(
      normalizeTrade
    ),
    tradeBlock: toArr(raw.tradeBlock),
    matchups: normalizeMatchups(raw.matchups),
    settings: {
      ...base.settings,
      ...settingsIn,
      frozen: toBool(settingsIn.frozen, false),
    },
    nextAuctionDeadline:
      raw.nextAuctionDeadline == null
        ? null
        : raw.nextAuctionDeadline,
    lastAutoWeeklySnapshotId:
      raw.lastAutoWeeklySnapshotId ?? null,
    lastAutoAuctionRolloverId:
      raw.lastAutoAuctionRolloverId ?? null,
  };
}

function createJsonLeagueRepository({
  dataFilePath,
  backupsDirPath,
  maxBackups = 200,
  createBackupRepositoryFactory =
    createJsonBackupRepository,
} = {}) {
  if (!dataFilePath) {
    throw new Error(
      "createJsonLeagueRepository requires dataFilePath"
    );
  }

  let writeChain = Promise.resolve();

  ensureDirSync(path.dirname(dataFilePath));

  const backupsDir =
    backupsDirPath ||
    path.join(path.dirname(dataFilePath), "backups");
  ensureDirSync(backupsDir);

  const backupRepository =
    createBackupRepositoryFactory({
      backupsDir,
      dataFilePath,
      maxBackups,
    });

  function readLeagueState() {
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
    } catch (error) {
      console.error(
        "[BACKEND] Failed to load league state:",
        error
      );

      const state = normalizeLeagueState(emptyState(), {
        dataFilePath,
        loadedFromDisk: false,
      });
      state.meta.loadError = String(
        error?.message || error
      );
      return state;
    }
  }

  function saveLeagueState(
    state,
    { savedBy = "system" } = {}
  ) {
    writeChain = writeChain.then(() => {
      const next = normalizeLeagueState(state, {
        dataFilePath,
      });

      next.schemaVersion =
        Number(next.schemaVersion || SCHEMA_VERSION) ||
        SCHEMA_VERSION;
      next.meta = {
        ...(next.meta || {}),
        createdAt: next.meta?.createdAt || Date.now(),
        lastSavedAt: Date.now(),
        lastSavedBy: savedBy,
        dataFilePath,
      };

      try {
        if (fs.existsSync(dataFilePath)) {
          const previous = safeReadJsonSync(dataFilePath);
          backupRepository.writeBackupSync(previous, {
            savedBy: "prewrite_live",
          });
        }
      } catch (error) {
        console.error(
          "[BACKEND] Failed to backup current live state:",
          error
        );
      }

      backupRepository.pruneBackupsBestEffort();

      const temporaryPath = `${dataFilePath}.tmp`;
      const json = JSON.stringify(next, null, 2);
      fs.writeFileSync(temporaryPath, json, "utf8");
      fs.renameSync(temporaryPath, dataFilePath);

      return null;
    });

    return writeChain;
  }

  function replaceCompatibilityLeagueState(
    state,
    options
  ) {
    return saveLeagueState(state, options);
  }

  function listBackups(options) {
    return backupRepository.listBackups(options);
  }

  function restoreBackup(
    backupId,
    { restoredBy = "system" } = {}
  ) {
    if (!backupId) {
      throw new Error("restoreBackup requires backupId");
    }

    const restorePromise = (writeChain = writeChain.then(
      () => {
        const restoredRaw =
          backupRepository.readBackup(backupId);
        const state = normalizeLeagueState(restoredRaw, {
          dataFilePath,
          loadedFromDisk: true,
        });

        state.schemaVersion =
          Number(
            state.schemaVersion || SCHEMA_VERSION
          ) || SCHEMA_VERSION;
        state.meta = {
          ...(state.meta || {}),
          lastRestoredAt: Date.now(),
          lastRestoredBy: restoredBy,
          dataFilePath,
        };

        backupRepository.writeLiveStateAtomicSync(state);
        backupRepository.writeBackupSync(state, {
          savedBy: `restore_${restoredBy}`,
        });
        backupRepository.pruneBackupsBestEffort();

        return state;
      }
    ));

    return restorePromise;
  }

  return {
    backupsDir,
    emptyState,
    listBackups,
    loadLeague: readLeagueState,
    readLeagueState,
    replaceCompatibilityLeagueState,
    restoreBackup,
    saveLeague: saveLeagueState,
    saveLeagueState,
    SCHEMA_VERSION,
  };
}

module.exports = {
  createJsonLeagueRepository,
};
