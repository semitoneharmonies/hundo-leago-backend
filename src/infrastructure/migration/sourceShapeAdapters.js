const fs = require("node:fs");
const path = require("node:path");

const {
  createDeterministicMapping,
} = require("./deterministicIds");
const {
  verifySourceBundle,
} = require("./sourceInventory");
const {
  normalizePlayerPosition,
  toIntegerCents,
} = require("./transformValues");

const LEAGUE_STATE_SHAPE_VERSION =
  "hundo-leago-league-state-v1-reset-adapter-v1";
const PLAYERS_SHAPE_VERSION =
  "hundo-leago-players-array-v1";
const NHL_PROVIDER = "nhl";

const IMPORT_ADAPTER_ERROR_CODES = Object.freeze({
  sourceInvalid: "IMPORT_SOURCE_INVALID",
  sourceShapeUnsupported:
    "IMPORT_SOURCE_SHAPE_UNSUPPORTED",
  protectedDataAtRisk: "IMPORT_PROTECTED_DATA_AT_RISK",
});

class SourceShapeAdapterError extends Error {
  constructor(code, message, { cause } = {}) {
    super(
      message,
      cause === undefined ? undefined : { cause }
    );
    this.name = "SourceShapeAdapterError";
    this.code = code;
  }
}

function adapterError(code, message, options) {
  return new SourceShapeAdapterError(code, message, options);
}

function isPlainObject(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expectedKeys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isCanonicalSourceText(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 500 &&
    value.trim() === value
  );
}

function pathInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function readBundleManifest(bundleDirectory, fsModule) {
  const manifestPath = path.join(
    bundleDirectory,
    "source-bundle.json"
  );
  try {
    return JSON.parse(fsModule.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw adapterError(
      IMPORT_ADAPTER_ERROR_CODES.sourceInvalid,
      "The source-bundle manifest could not be read.",
      { cause: error }
    );
  }
}

function selectSingleCopiedFile(
  bundleDirectory,
  manifest,
  label,
  fsModule
) {
  const matches = manifest.sources.filter(
    (source) => source.label === label
  );
  if (
    matches.length !== 1 ||
    matches[0].kind !== "file" ||
    matches[0].files.length !== 1
  ) {
    throw adapterError(
      IMPORT_ADAPTER_ERROR_CODES.sourceInvalid,
      `The verified bundle requires one ${label} file source.`
    );
  }
  const file = matches[0].files[0];
  const copiedPath = path.resolve(
    bundleDirectory,
    file.copiedPath
  );
  if (!pathInside(bundleDirectory, copiedPath)) {
    throw adapterError(
      IMPORT_ADAPTER_ERROR_CODES.sourceInvalid,
      "A copied source path escaped the verified bundle."
    );
  }

  let value;
  try {
    value = JSON.parse(fsModule.readFileSync(copiedPath, "utf8"));
  } catch (error) {
    throw adapterError(
      IMPORT_ADAPTER_ERROR_CODES.sourceInvalid,
      `The copied ${label} source could not be parsed.`,
      { cause: error }
    );
  }
  return {
    file,
    value,
  };
}

function assertLeagueStateShape(leagueState) {
  const rootKeys = [
    "schemaVersion",
    "meta",
    "teams",
    "freeAgents",
    "leagueLog",
    "tradeProposals",
    "tradeBlock",
    "matchups",
    "settings",
    "nextAuctionDeadline",
    "lastAutoWeeklySnapshotId",
    "lastAutoAuctionRolloverId",
  ];
  const matchupKeys = [
    "seasonId",
    "scheduleWeeks",
    "currentWeekIndex",
    "currentWeekId",
    "locksByTeam",
    "baselineByPlayerId",
    "baselineByWeekId",
    "resultsByWeek",
    "lastRolloverWeekId",
  ];
  const settingsKeys = [
    "frozen",
    "managerLoginHistory",
    "managerLastLogin",
  ];

  if (
    !hasExactKeys(leagueState, rootKeys) ||
    leagueState.schemaVersion !== 1 ||
    !isPlainObject(leagueState.meta) ||
    !Array.isArray(leagueState.teams) ||
    !Array.isArray(leagueState.freeAgents) ||
    !Array.isArray(leagueState.leagueLog) ||
    !Array.isArray(leagueState.tradeProposals) ||
    !Array.isArray(leagueState.tradeBlock) ||
    !hasExactKeys(leagueState.matchups, matchupKeys) ||
    !Array.isArray(leagueState.matchups.scheduleWeeks) ||
    !isPlainObject(leagueState.matchups.locksByTeam) ||
    !isPlainObject(leagueState.matchups.baselineByPlayerId) ||
    !isPlainObject(leagueState.matchups.baselineByWeekId) ||
    !isPlainObject(leagueState.matchups.resultsByWeek) ||
    !hasExactKeys(leagueState.settings, settingsKeys) ||
    typeof leagueState.settings.frozen !== "boolean" ||
    !Array.isArray(
      leagueState.settings.managerLoginHistory
    ) ||
    !isPlainObject(leagueState.settings.managerLastLogin)
  ) {
    throw adapterError(
      IMPORT_ADAPTER_ERROR_CODES.sourceShapeUnsupported,
      "The copied league-state source shape is unsupported."
    );
  }

  for (const team of leagueState.teams) {
    if (
      !isPlainObject(team) ||
      !isCanonicalSourceText(team.name) ||
      !Array.isArray(team.roster) ||
      !Array.isArray(team.buyouts)
    ) {
      throw adapterError(
        IMPORT_ADAPTER_ERROR_CODES.sourceShapeUnsupported,
        "A copied Season 1 team shape is unsupported."
      );
    }
  }
  for (const week of leagueState.matchups.scheduleWeeks) {
    if (
      !isPlainObject(week) ||
      !Array.isArray(week.pairs) ||
      week.pairs.some(
        (pair) =>
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          !pair.every(isCanonicalSourceText)
      )
    ) {
      throw adapterError(
        IMPORT_ADAPTER_ERROR_CODES.sourceShapeUnsupported,
        "A copied Season 1 matchup-week shape is unsupported."
      );
    }
  }
}

function playerSourceKey(player) {
  if (
    typeof player.id === "number" &&
    Number.isSafeInteger(player.id) &&
    player.id > 0
  ) {
    return String(player.id);
  }
  if (
    typeof player.id === "string" &&
    /^[1-9]\d*$/.test(player.id)
  ) {
    return player.id;
  }
  throw adapterError(
    IMPORT_ADAPTER_ERROR_CODES.sourceShapeUnsupported,
    "A copied player has an invalid stable provider ID."
  );
}

function assertPlayerShape(player) {
  const keys = [
    "id",
    "fullName",
    "firstName",
    "lastName",
    "position",
    "teamAbbrev",
    "birthDate",
    "active",
  ];
  if (
    !hasExactKeys(player, keys) ||
    !isCanonicalSourceText(player.fullName) ||
    !isCanonicalSourceText(player.firstName) ||
    !isCanonicalSourceText(player.lastName) ||
    !["F", "D", "G"].includes(player.position) ||
    (player.teamAbbrev !== null &&
      !isCanonicalSourceText(player.teamAbbrev)) ||
    (player.birthDate !== null &&
      (typeof player.birthDate !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(player.birthDate))) ||
    typeof player.active !== "boolean"
  ) {
    throw adapterError(
      IMPORT_ADAPTER_ERROR_CODES.sourceShapeUnsupported,
      "A copied player source record has an unsupported shape."
    );
  }
  return playerSourceKey(player);
}

function countObjectEntries(value) {
  return Object.keys(value).length;
}

function countNestedArray(items, propertyName) {
  return items.reduce(
    (total, item) => total + item[propertyName].length,
    0
  );
}

function countTradeRetention(tradeProposals) {
  return tradeProposals.reduce((total, proposal) => {
    const fields = ["retentionFrom", "retentionTo"];
    return (
      total +
      fields.reduce((fieldTotal, fieldName) => {
        const value = proposal[fieldName];
        if (isPlainObject(value)) {
          return (
            fieldTotal +
            Object.values(value).filter(
              (amount) => amount !== null
            ).length
          );
        }
        return (
          fieldTotal +
          (Array.isArray(value)
            ? value.length
            : value === null || value === undefined
              ? 0
              : 1)
        );
      }, 0)
    );
  }, 0);
}

function buildOmissionCounts(leagueState) {
  const rosterCount = countNestedArray(
    leagueState.teams,
    "roster"
  );
  const buyoutCount = countNestedArray(
    leagueState.teams,
    "buyouts"
  );
  const matchup = leagueState.matchups;
  const matchupPairCount =
    matchup.scheduleWeeks.reduce(
      (total, week) => total + week.pairs.length,
      0
    );
  const resultCount = countObjectEntries(
    matchup.resultsByWeek
  );
  const operationalMarkerCount = [
    leagueState.settings.frozen,
    leagueState.lastAutoWeeklySnapshotId,
    leagueState.lastAutoAuctionRolloverId,
    matchup.lastRolloverWeekId,
  ].filter((value) => value !== null).length;

  return Object.freeze({
    season_1_season_containers:
      isCanonicalSourceText(matchup.seasonId) ? 1 : 0,
    season_1_teams: leagueState.teams.length,
    season_1_rosters:
      rosterCount + leagueState.freeAgents.length,
    season_1_contracts: rosterCount,
    season_1_retention: countTradeRetention(
      leagueState.tradeProposals
    ),
    season_1_buyouts: buyoutCount,
    season_1_trades:
      leagueState.tradeProposals.length +
      leagueState.tradeBlock.length,
    season_1_auctions:
      leagueState.freeAgents.length +
      (leagueState.nextAuctionDeadline === null ? 0 : 1),
    season_1_matchups:
      matchup.scheduleWeeks.length +
      matchupPairCount +
      countObjectEntries(matchup.locksByTeam) +
      countObjectEntries(matchup.baselineByPlayerId) +
      countObjectEntries(matchup.baselineByWeekId) +
      resultCount,
    season_1_standings: resultCount,
    season_1_competition_activity:
      leagueState.leagueLog.length,
    season_1_competition_operations:
      operationalMarkerCount,
  });
}

function buildPlayerRows(players, {
  capturedAtMs,
  sourceSha256,
}) {
  const sourceKeys = new Set();
  const rows = {
    players: [],
    player_external_ids: [],
    player_source_state: [],
  };
  const mappings = [];
  let goalieCount = 0;

  const orderedPlayers = players
    .map((player) => {
      const sourceKey = assertPlayerShape(player);
      if (sourceKeys.has(sourceKey)) {
        throw adapterError(
          IMPORT_ADAPTER_ERROR_CODES.protectedDataAtRisk,
          "Stable provider player IDs must be unique."
        );
      }
      sourceKeys.add(sourceKey);
      return { player, sourceKey };
    })
    .sort((left, right) =>
      left.sourceKey < right.sourceKey
        ? -1
        : left.sourceKey > right.sourceKey
          ? 1
          : 0
    );

  for (const { player, sourceKey } of orderedPlayers) {
    const identity = {
      sourceBundleType: PLAYERS_SHAPE_VERSION,
      sourceCollection: "players",
      sourceKey,
      targetTable: "players",
    };
    const playerMapping =
      createDeterministicMapping(identity);
    const externalIdMapping = createDeterministicMapping({
      ...identity,
      targetTable: "player_external_ids",
    });
    const sourceStateMapping = createDeterministicMapping({
      ...identity,
      targetTable: "player_source_state",
    });

    rows.players.push({
      id: playerMapping.targetId,
      first_name: player.firstName,
      last_name: player.lastName,
      full_name: player.fullName,
      birth_date: player.birthDate,
      status: player.active ? "active" : "historical",
      created_at_ms: capturedAtMs,
      updated_at_ms: capturedAtMs,
      version: 1,
    });
    rows.player_external_ids.push({
      id: externalIdMapping.targetId,
      player_id: playerMapping.targetId,
      provider: NHL_PROVIDER,
      external_value: sourceKey,
      created_at_ms: capturedAtMs,
    });
    const normalizedPosition =
      normalizePlayerPosition(player.position);
    if (normalizedPosition === "G") goalieCount += 1;
    rows.player_source_state.push({
      id: sourceStateMapping.targetId,
      player_id: playerMapping.targetId,
      provider: NHL_PROVIDER,
      source_position: player.position,
      normalized_position:
        normalizedPosition === "G"
          ? null
          : normalizedPosition,
      nhl_team_abbreviation: player.teamAbbrev,
      active: player.active ? 1 : 0,
      source_version: `sha256:${sourceSha256}`,
      source_payload_json: null,
      effective_at_ms: capturedAtMs,
      ended_at_ms: null,
      created_at_ms: capturedAtMs,
    });
    mappings.push(
      playerMapping,
      externalIdMapping,
      sourceStateMapping
    );
  }

  return {
    rows: Object.freeze(
      Object.fromEntries(
        Object.entries(rows).map(([tableName, tableRows]) => [
          tableName,
          Object.freeze(tableRows),
        ])
      )
    ),
    mappings: Object.freeze(mappings),
    defaults: Object.freeze([
      Object.freeze({
        code: "PLAYER_STATUS_FROM_ACTIVE_FLAG",
        count: orderedPlayers.length,
      }),
      Object.freeze({
        code:
          "GOALIE_POSITION_PRESERVED_WITHOUT_SKATER_GROUP",
        count: goalieCount,
      }),
    ]),
  };
}

function recoveryEvidenceCount(manifest) {
  const evidenceLabels = new Set([
    "legacy_league",
    "legacy_dump",
    "legacy_with_meta",
    "backups",
    "snapshots",
    "snapshots_local",
  ]);
  return manifest.sources.reduce(
    (total, source) =>
      total +
      (evidenceLabels.has(source.label)
        ? source.files.length
        : 0),
    0
  );
}

function nonNullMoneyValues(values) {
  return values.filter(
    (value) => value !== null && value !== undefined
  );
}

function retentionMoneyValues(tradeProposals) {
  const values = [];
  for (const proposal of tradeProposals) {
    for (const fieldName of [
      "retentionFrom",
      "retentionTo",
    ]) {
      const value = proposal[fieldName];
      if (isPlainObject(value)) {
        values.push(
          ...Object.values(value).filter(
            (amount) => amount !== null
          )
        );
      } else if (Array.isArray(value)) {
        values.push(...nonNullMoneyValues(value));
      } else if (value !== null && value !== undefined) {
        values.push(value);
      }
    }
  }
  return values;
}

function moneyEvidence(leagueState) {
  const contractValues = leagueState.teams.flatMap((team) =>
    team.roster.map((rosterEntry) => rosterEntry.salary)
  );
  const buyoutValues = leagueState.teams.flatMap((team) =>
    team.buyouts.map((buyout) => buyout.penalty)
  );
  const tradePenaltyValues = nonNullMoneyValues(
    leagueState.tradeProposals.flatMap((proposal) => [
      proposal.penaltyFrom,
      proposal.penaltyTo,
    ])
  );
  const tradeRetentionValues = retentionMoneyValues(
    leagueState.tradeProposals
  );

  function summarize(familyId, values) {
    const sourceSumCents = values.reduce(
      (sum, value) => {
        const cents = toIntegerCents(value);
        const next = sum + cents;
        if (!Number.isSafeInteger(next)) {
          throw adapterError(
            IMPORT_ADAPTER_ERROR_CODES.protectedDataAtRisk,
            "A source money aggregate exceeds the safe integer range."
          );
        }
        return next;
      },
      0
    );
    return Object.freeze({
      familyId,
      sourceCount: values.length,
      sourceSumCents,
      importedCount: 0,
      importedSumCents: 0,
      omittedCount: values.length,
      omittedSumCents: sourceSumCents,
      reconciled: true,
    });
  }

  return Object.freeze([
    summarize("season_1_contracts", contractValues),
    summarize("season_1_buyouts", buyoutValues),
    summarize(
      "season_1_trades",
      tradePenaltyValues
    ),
    summarize(
      "season_1_retention",
      tradeRetentionValues
    ),
  ]);
}

function adaptVerifiedSourceBundle({
  bundleDirectory,
  fsModule = fs,
} = {}) {
  if (
    typeof bundleDirectory !== "string" ||
    bundleDirectory.trim() === ""
  ) {
    throw adapterError(
      IMPORT_ADAPTER_ERROR_CODES.sourceInvalid,
      "An explicit verified source-bundle path is required."
    );
  }
  const root = path.resolve(bundleDirectory);
  const verification = verifySourceBundle({
    bundleDirectory: root,
    fsModule,
  });
  const manifest = readBundleManifest(root, fsModule);
  const allowedLabels = new Set([
    "league_state",
    "players",
    "legacy_league",
    "legacy_dump",
    "legacy_with_meta",
    "backups",
    "snapshots",
    "snapshots_local",
  ]);
  if (
    manifest.sources.some(
      (source) => !allowedLabels.has(source.label)
    )
  ) {
    throw adapterError(
      IMPORT_ADAPTER_ERROR_CODES.protectedDataAtRisk,
      "The source bundle contains an unlisted source label."
    );
  }

  const leagueSource = selectSingleCopiedFile(
    root,
    manifest,
    "league_state",
    fsModule
  );
  const playerSource = selectSingleCopiedFile(
    root,
    manifest,
    "players",
    fsModule
  );
  assertLeagueStateShape(leagueSource.value);
  if (!Array.isArray(playerSource.value)) {
    throw adapterError(
      IMPORT_ADAPTER_ERROR_CODES.sourceShapeUnsupported,
      "The copied players source must be an array."
    );
  }

  const playerResult = buildPlayerRows(
    playerSource.value,
    {
      capturedAtMs: manifest.capturedAtMs,
      sourceSha256: playerSource.file.sha256,
    }
  );
  const managerLoginHistoryCount =
    leagueSource.value.settings.managerLoginHistory.length +
    countObjectEntries(
      leagueSource.value.settings.managerLastLogin
    );
  const recoveryCount = recoveryEvidenceCount(manifest);

  return Object.freeze({
    sourceBundle: Object.freeze({
      id: verification.sourceBundleId,
      checksum: verification.bundleChecksum,
      manifestVersion: manifest.manifestVersion,
      capturedAtMs: manifest.capturedAtMs,
      sourceCount: verification.sourceCount,
      fileCount: verification.fileCount,
      byteSize: verification.byteSize,
    }),
    sourceShapes: Object.freeze({
      league_state: LEAGUE_STATE_SHAPE_VERSION,
      players: PLAYERS_SHAPE_VERSION,
    }),
    sourceCollectionCounts: Object.freeze({
      players: playerSource.value.length,
      teams: leagueSource.value.teams.length,
      roster_entries: countNestedArray(
        leagueSource.value.teams,
        "roster"
      ),
      buyout_entries: countNestedArray(
        leagueSource.value.teams,
        "buyouts"
      ),
      league_activity: leagueSource.value.leagueLog.length,
      trade_proposals:
        leagueSource.value.tradeProposals.length,
      matchup_weeks:
        leagueSource.value.matchups.scheduleWeeks.length,
      recovery_evidence_files: recoveryCount,
      ignored_metadata_records: 2,
      never_import_credential_records:
        managerLoginHistoryCount,
    }),
    rows: playerResult.rows,
    mappings: playerResult.mappings,
    omissionCounts: buildOmissionCounts(
      leagueSource.value
    ),
    moneyEvidence: moneyEvidence(leagueSource.value),
    protectedEvidence: Object.freeze({
      player_identity: Object.freeze({
        observedSourceCount: playerSource.value.length,
        plannedTargetRowCount:
          playerResult.rows.players.length +
          playerResult.rows.player_external_ids.length +
          playerResult.rows.player_source_state.length,
        treatment: "preserve_or_stop",
        preserved: true,
      }),
      league_identity_and_configuration: Object.freeze({
        observedSourceCount: 0,
        plannedTargetRowCount: 0,
        treatment: "preserve_or_stop",
        preserved: true,
      }),
      recovery_and_migration_evidence: Object.freeze({
        observedSourceCount: recoveryCount,
        plannedTargetRowCount: 0,
        treatment: "preserve_or_stop",
        externalEvidencePreserved: true,
        preserved: true,
      }),
      unlisted_data: Object.freeze({
        observedSourceCount: 0,
        plannedTargetRowCount: 0,
        treatment: "preserve_or_stop",
        preserved: true,
      }),
    }),
    neverImportEvidence: Object.freeze({
      hard_coded_frontend_credentials: Object.freeze({
        observedSourceCount: managerLoginHistoryCount,
        importedTargetRowCount: 0,
        treatment: "never_import",
      }),
    }),
    defaults: playerResult.defaults,
    repairs: Object.freeze([]),
    warnings: Object.freeze([]),
    rejects: Object.freeze([]),
    quarantine: Object.freeze([]),
  });
}

module.exports = {
  IMPORT_ADAPTER_ERROR_CODES,
  LEAGUE_STATE_SHAPE_VERSION,
  NHL_PROVIDER,
  PLAYERS_SHAPE_VERSION,
  SourceShapeAdapterError,
  adaptVerifiedSourceBundle,
};
