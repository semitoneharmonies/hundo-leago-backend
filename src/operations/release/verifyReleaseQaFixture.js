const crypto = require("node:crypto");
const path = require("node:path");

const {
  openReadonlyDatabase,
} = require("../../infrastructure/database/connection");
const {
  createSqliteTradeProposalRepository,
} = require("../../infrastructure/persistence/sqlite/SqliteTradeProposalRepository");
const {
  ACCOUNT_ALIASES,
  BETA_PLAYER_TEAM_NUMBERS,
  FIXTURE_BUILD_ID,
  FIXTURE_CREATED_AT,
  FIXTURE_DATABASE_ID,
  FIXTURE_ENVIRONMENT_ID,
  FIXTURE_NOW_MS,
  FIXTURE_VERSION,
  INVALID_CAP_BUYOUT_PENALTY_CENTS,
  LEAGUE_ALIASES,
  PLAYER_BLUEPRINTS,
  TEAM_NAMES_BY_LEAGUE,
  checksumManifest,
  fixtureId,
} = require("./releaseQaFixtureContract");

class ReleaseQaFixtureVerificationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ReleaseQaFixtureVerificationError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details) {
  throw new ReleaseQaFixtureVerificationError(code, message, details);
}

function assertEqual(actual, expected, description) {
  if (actual !== expected) {
    fail(
      "RELEASE_QA_FIXTURE_MISMATCH",
      `Release-QA fixture mismatch: ${description}.`,
      { actual, expected }
    );
  }
}

function count(database, sql, ...parameters) {
  return database.prepare(sql).get(...parameters).count;
}

function expectedLeagueCounts(alias) {
  const teamCount = TEAM_NAMES_BY_LEAGUE[alias]?.length;
  if (!Number.isSafeInteger(teamCount) || teamCount < 2) {
    fail(
      "RELEASE_QA_FIXTURE_MISMATCH",
      `Release-QA fixture mismatch: ${alias} expected team count.`
    );
  }
  const owned = PLAYER_BLUEPRINTS.map((blueprint, index) => {
    if (!blueprint.rosterCategory) return false;
    const betaOverride = alias === "leagueB"
      ? BETA_PLAYER_TEAM_NUMBERS[blueprint.alias]
      : undefined;
    const teamNumber = betaOverride === undefined
      ? blueprint.teamNumber || ((index % teamCount) + 1)
      : betaOverride;
    return teamNumber <= teamCount
      ? Object.freeze({ blueprint, teamNumber })
      : false;
  }).filter(Boolean);
  const rosterCategoryCount = (category) =>
    owned.filter(({ blueprint }) => blueprint.rosterCategory === category).length;
  const activeContracts = owned.filter(({ blueprint }) => blueprint.contract).length;
  const matchupCountPerWeek = teamCount / 2;
  const depthByTeam = Array.from({ length: teamCount }, (_, index) => {
    const teamNumber = index + 1;
    const teamPlayers = owned.filter((ownedPlayer) =>
      ownedPlayer.teamNumber === teamNumber
    );
    return Object.freeze(Object.fromEntries(
      ["Active", "Bench", "Injured Reserve", "Prospect"].map((category) => [
        category,
        teamPlayers.filter(({ blueprint }) =>
          blueprint.rosterCategory === category
        ).length,
      ])
    ));
  });
  return Object.freeze({
    activeContracts,
    activeRoster: rosterCategoryCount("Active"),
    awaitingDataMatchups: matchupCountPerWeek,
    bench: rosterCategoryCount("Bench"),
    contracts: activeContracts + 1,
    draftPicks: teamCount * 4 * 4,
    depthByTeam: Object.freeze(depthByTeam),
    finalMatchups: matchupCountPerWeek,
    injuredReserve: rosterCategoryCount("Injured Reserve"),
    matchupLocks: teamCount * 2,
    matchupPlayers: rosterCategoryCount("Active") * 2,
    ownerships: owned.length,
    populatedRosterTeams: teamCount,
    prospects: rosterCategoryCount("Prospect"),
    scheduledMatchups: matchupCountPerWeek * 20,
    standingsRows: teamCount,
    statSnapshots: teamCount * 2,
    teamCount,
  });
}

function deterministicTradeUuid(value) {
  const hex = crypto.createHash("sha256").update(value, "utf8").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-` +
    `8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function parseJsonObject(value, description) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail(
      "RELEASE_QA_FIXTURE_MISMATCH",
      `Release-QA fixture mismatch: ${description}.`
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(
      "RELEASE_QA_FIXTURE_MISMATCH",
      `Release-QA fixture mismatch: ${description}.`
    );
  }
  return parsed;
}

function assertExactKeys(value, expectedKeys, description) {
  assertEqual(
    Object.keys(value || {}).sort().join(","),
    [...expectedKeys].sort().join(","),
    description
  );
}

function assertOwnershipSnapshot(snapshot, expected, description) {
  assertExactKeys(
    snapshot,
    [
      "id",
      "leagueId",
      "seasonId",
      "playerId",
      "teamId",
      "ownershipKind",
      "rosterCategory",
      "positionGroup",
      "slotNumber",
      "version",
    ],
    `${description} keys`
  );
  for (const [key, expectedValue] of Object.entries(expected)) {
    assertEqual(snapshot[key], expectedValue, `${description} ${key}`);
  }
}

function resolveFixturePlayerIds(database) {
  const synthetic = Object.fromEntries(
    PLAYER_BLUEPRINTS.map(({ alias }) => [alias, fixtureId(`player:${alias}`)])
  );
  const syntheticIds = new Set(
    database
      .prepare(
        `SELECT id FROM players WHERE id IN (${PLAYER_BLUEPRINTS.map(
          () => "?"
        ).join(", ")})`
      )
      .all(...Object.values(synthetic))
      .map(({ id }) => id)
  );

  const providerPlayers = database
    .prepare(`
      SELECT
        player.id,
        player.birth_date,
        source.normalized_position,
        source.active
      FROM players AS player
      INNER JOIN player_external_ids AS external
        ON external.player_id = player.id
       AND external.provider = 'sportsdataio-discovery-lab'
      INNER JOIN player_source_state AS source
        ON source.player_id = player.id
       AND source.provider = 'sportsdataio-discovery-lab'
       AND source.ended_at_ms IS NULL
       AND source.normalized_position IN ('F', 'D')
      WHERE player.status = 'active'
      GROUP BY player.id
      ORDER BY lower(player.full_name) ASC, player.id ASC
    `)
    .all();
  const byPosition = new Map([
    ["F", providerPlayers.filter(({ normalized_position }) => normalized_position === "F")],
    ["D", providerPlayers.filter(({ normalized_position }) => normalized_position === "D")],
  ]);
  const available = new Map(
    [...byPosition].map(([position, rows]) => [position, [...rows]])
  );
  const resolved = {};
  const selectionOrder = [
    ...PLAYER_BLUEPRINTS.filter(({ requiresUnder19 }) => requiresUnder19),
    ...PLAYER_BLUEPRINTS.filter(({ requiresUnder19 }) => !requiresUnder19),
  ];
  for (const blueprint of selectionOrder) {
    if (syntheticIds.has(synthetic[blueprint.alias])) {
      resolved[blueprint.alias] = synthetic[blueprint.alias];
      continue;
    }
    const pool = available.get(blueprint.position);
    let selectedIndex = blueprint.requiresUnder19
      ? pool.findIndex(
          (player) =>
            typeof player.birth_date === "string" &&
            player.birth_date > "2007-07-26"
        )
      : pool.findIndex((player) => player.active === 1);
    if (selectedIndex < 0 && blueprint.requiresUnder19) {
      selectedIndex = pool.findIndex((player) => player.active === 1);
    }
    const [selected] = selectedIndex < 0
      ? []
      : pool.splice(selectedIndex, 1);
    assertEqual(
      Boolean(selected),
      true,
      `provider-backed ${blueprint.position} player identity`
    );
    resolved[blueprint.alias] = selected.id;
  }
  return Object.freeze(resolved);
}

function verifyTradeScenarios(database, alias, leagueId, playerIds) {
  const scenarioId = (scenarioAlias) =>
    fixtureId(`trade-scenario:${alias}:${scenarioAlias}:1`);
  const completedTradeId = scenarioId("accepted");
  const rejectedTradeId = scenarioId("rejected");
  const invalidCapTradeId = scenarioId("invalid-cap");
  const completed = database.prepare(`
    SELECT season_id, proposing_team_id, receiving_team_id,
      status, responded_at_ms, completed_at_ms,
      commissioner_completion_reference
    FROM trades
    WHERE league_id=? AND id=?
  `).get(leagueId, completedTradeId);
  const expectedSeasonId = fixtureId(`season:${alias}:current`);
  const expectedParticipantTeamIds = [
    fixtureId(`team:${alias}:1`),
    fixtureId(`team:${alias}:2`),
  ].sort();
  assertEqual(completed?.status, "completed", `${alias} accepted storage status`);
  assertEqual(completed?.season_id, expectedSeasonId, `${alias} accepted season`);
  assertEqual(
    [completed?.proposing_team_id, completed?.receiving_team_id]
      .sort()
      .join(","),
    expectedParticipantTeamIds.join(","),
    `${alias} accepted participant scope`
  );
  const receivingManager = database.prepare(`
    SELECT user_id, membership_id
    FROM team_manager_assignments
    WHERE league_id = ? AND team_id = ? AND status = 'accepted'
      AND ended_at_ms IS NULL
    LIMIT 2
  `).get(leagueId, completed.receiving_team_id);
  assertEqual(
    Number.isSafeInteger(completed?.responded_at_ms),
    true,
    `${alias} accepted response timestamp`
  );
  assertEqual(
    Number.isSafeInteger(completed?.completed_at_ms),
    true,
    `${alias} accepted completion timestamp`
  );
  assertEqual(
    completed?.commissioner_completion_reference,
    null,
    `${alias} completion reference`
  );
  const acceptedEvents = database.prepare(`
    SELECT id, actor_user_id, metadata_json, occurred_at_ms
    FROM trade_events
    WHERE league_id=? AND trade_id=? AND event_type='proposal_accepted'
  `).all(leagueId, completedTradeId);
  assertEqual(
    acceptedEvents.length,
    1,
    `${alias} accepted lifecycle evidence`
  );
  const acceptedEvent = acceptedEvents[0];
  assertEqual(
    acceptedEvent.actor_user_id,
    receivingManager?.user_id,
    `${alias} receiving-manager completion actor`
  );
  assertEqual(
    acceptedEvent.occurred_at_ms,
    completed.completed_at_ms,
    `${alias} completion event timestamp`
  );
  assertEqual(
    completed.responded_at_ms,
    completed.completed_at_ms,
    `${alias} accepted response and completion timestamp`
  );
  const acceptedMetadata = parseJsonObject(
    acceptedEvent.metadata_json,
    `${alias} accepted trade metadata`
  );
  assertExactKeys(
    acceptedMetadata,
    [
      "schemaVersion",
      "action",
      "actorAuthority",
      "fromStatus",
      "toStatus",
      "generallyIllegal",
      "teams",
      "transfers",
      "ownershipTransfers",
      "automaticallyCancelledTradeIds",
    ],
    `${alias} accepted trade metadata keys`
  );
  assertEqual(acceptedMetadata.schemaVersion, 1, `${alias} accepted schema`);
  assertEqual(acceptedMetadata.action, "accept", `${alias} accepted action`);
  assertEqual(
    acceptedMetadata.actorAuthority,
    "manager",
    `${alias} accepted manager authority`
  );
  assertEqual(
    acceptedMetadata.fromStatus,
    "proposed",
    `${alias} accepted prior status`
  );
  assertEqual(
    acceptedMetadata.toStatus,
    "completed",
    `${alias} accepted next status`
  );
  assertEqual(
    acceptedMetadata.generallyIllegal,
    false,
    `${alias} accepted legal result`
  );
  assertEqual(
    JSON.stringify(acceptedMetadata.automaticallyCancelledTradeIds),
    "[]",
    `${alias} accepted automatic-cancellation scope`
  );

  const acceptedAssets = database.prepare(`
    SELECT id, player_id, asset_type, source_team_id,
      destination_team_id, proposal_snapshot_json
    FROM trade_assets
    WHERE league_id=? AND trade_id=?
    ORDER BY id ASC
  `).all(leagueId, completedTradeId);
  assertEqual(acceptedAssets.length, 2, `${alias} accepted asset count`);
  assertEqual(
    acceptedAssets.every(({ asset_type }) => asset_type === "prospect_right"),
    true,
    `${alias} accepted prospect-right asset coverage`
  );
  assertEqual(
    acceptedAssets.map(({ player_id }) => player_id).sort().join(","),
    [playerIds.team1Prospect1, playerIds.team2Prospect2].sort().join(","),
    `${alias} accepted player scope`
  );

  const publicTransfers = acceptedMetadata.transfers;
  assertEqual(
    Array.isArray(publicTransfers),
    true,
    `${alias} accepted public-transfer shape`
  );
  assertEqual(publicTransfers.length, 2, `${alias} accepted public-transfer count`);
  const publicTransferByAssetId = new Map();
  for (const transfer of publicTransfers) {
    assertExactKeys(
      transfer,
      [
        "assetId",
        "assetType",
        "sourceTeamId",
        "destinationTeamId",
        "plannedRosterSlotNumber",
      ],
      `${alias} accepted public-transfer keys`
    );
    assertEqual(
      publicTransferByAssetId.has(transfer.assetId),
      false,
      `${alias} accepted public-transfer uniqueness`
    );
    publicTransferByAssetId.set(transfer.assetId, transfer);
  }

  const ownershipTransfers = acceptedMetadata.ownershipTransfers;
  assertEqual(
    Array.isArray(ownershipTransfers),
    true,
    `${alias} accepted ownership-transfer mapping shape`
  );
  assertEqual(
    ownershipTransfers.length,
    2,
    `${alias} accepted ownership-transfer mapping count`
  );
  assertEqual(
    ownershipTransfers.map(({ sourceOwnershipId }) => sourceOwnershipId)
      .join(","),
    ownershipTransfers.map(({ sourceOwnershipId }) => sourceOwnershipId)
      .sort()
      .join(","),
    `${alias} accepted ownership-transfer stable order`
  );

  const assetsBySourceOwnershipId = new Map();
  for (const asset of acceptedAssets) {
    const snapshot = parseJsonObject(
      asset.proposal_snapshot_json,
      `${alias} accepted asset snapshot`
    );
    assertEqual(
      snapshot.player?.id,
      asset.player_id,
      `${alias} accepted asset player snapshot`
    );
    assertEqual(
      snapshot.ownership?.teamId,
      asset.source_team_id,
      `${alias} accepted asset source-team snapshot`
    );
    assertEqual(
      typeof snapshot.ownership?.id,
      "string",
      `${alias} accepted asset ownership snapshot`
    );
    assertEqual(
      assetsBySourceOwnershipId.has(snapshot.ownership.id),
      false,
      `${alias} accepted source-tenure uniqueness`
    );
    assetsBySourceOwnershipId.set(snapshot.ownership.id, { asset, snapshot });
    const publicTransfer = publicTransferByAssetId.get(asset.id);
    assertEqual(
      Boolean(publicTransfer),
      true,
      `${alias} accepted asset public receipt`
    );
    assertEqual(
      publicTransfer.assetType,
      asset.asset_type,
      `${alias} accepted public asset type`
    );
    assertEqual(
      publicTransfer.sourceTeamId,
      asset.source_team_id,
      `${alias} accepted public source team`
    );
    assertEqual(
      publicTransfer.destinationTeamId,
      asset.destination_team_id,
      `${alias} accepted public destination team`
    );
    assertEqual(
      publicTransfer.plannedRosterSlotNumber,
      null,
      `${alias} accepted prospect roster slot`
    );
  }

  const ownershipEvents = database.prepare(`
    SELECT id, season_id, player_id, team_id, ownership_id,
      event_type, actor_user_id, source_type, source_id,
      before_metadata_json, after_metadata_json, reason, occurred_at_ms
    FROM ownership_events
    WHERE league_id=? AND source_type='trade' AND source_id=?
      AND event_type IN ('trade_transfer_out', 'trade_transfer_in')
    ORDER BY ownership_id ASC, event_type ASC, id ASC
  `).all(leagueId, completedTradeId);
  assertEqual(
    ownershipEvents.length,
    4,
    `${alias} accepted paired ownership history`
  );
  const mappedOwnershipIds = new Set();
  for (const transfer of ownershipTransfers) {
    assertExactKeys(
      transfer,
      [
        "sourceTeamId",
        "destinationTeamId",
        "sourceOwnershipId",
        "sourceOwnershipVersion",
        "destinationOwnershipId",
        "destinationOwnershipVersion",
      ],
      `${alias} accepted ownership-transfer mapping keys`
    );
    const assetRecord = assetsBySourceOwnershipId.get(
      transfer.sourceOwnershipId
    );
    assertEqual(Boolean(assetRecord), true, `${alias} mapped accepted asset`);
    const { asset, snapshot } = assetRecord;
    assertEqual(
      transfer.sourceTeamId,
      asset.source_team_id,
      `${alias} mapped source team`
    );
    assertEqual(
      transfer.destinationTeamId,
      asset.destination_team_id,
      `${alias} mapped destination team`
    );
    assertEqual(
      transfer.sourceOwnershipVersion,
      snapshot.ownership.version,
      `${alias} mapped source version`
    );
    assertEqual(
      transfer.destinationOwnershipVersion,
      1,
      `${alias} destination ownership starts at version one`
    );
    assertEqual(
      transfer.destinationOwnershipId,
      deterministicTradeUuid(
        `${completedTradeId}:ownership-tenure:` +
          `${transfer.sourceOwnershipId}:destination`
      ),
      `${alias} deterministic destination tenure identity`
    );
    assertEqual(
      transfer.sourceOwnershipId !== transfer.destinationOwnershipId,
      true,
      `${alias} trade creates a distinct destination tenure`
    );
    for (const ownershipId of [
      transfer.sourceOwnershipId,
      transfer.destinationOwnershipId,
    ]) {
      assertEqual(
        mappedOwnershipIds.has(ownershipId),
        false,
        `${alias} trade ownership mapping is globally unique`
      );
      mappedOwnershipIds.add(ownershipId);
    }
    const sourceEvents = ownershipEvents.filter(
      (event) => event.event_type === "trade_transfer_out" &&
        event.ownership_id === transfer.sourceOwnershipId
    );
    const destinationEvents = ownershipEvents.filter(
      (event) => event.event_type === "trade_transfer_in" &&
        event.ownership_id === transfer.destinationOwnershipId
    );
    assertEqual(sourceEvents.length, 1, `${alias} source closing event count`);
    assertEqual(
      destinationEvents.length,
      1,
      `${alias} destination opening event count`
    );
    const sourceEvent = sourceEvents[0];
    const destinationEvent = destinationEvents[0];
    const expectedEventFields = [
      ["season_id", expectedSeasonId],
      ["player_id", asset.player_id],
      ["actor_user_id", receivingManager.user_id],
      ["source_type", "trade"],
      ["source_id", completedTradeId],
      ["reason", null],
      ["occurred_at_ms", completed.completed_at_ms],
    ];
    for (const [field, expectedValue] of expectedEventFields) {
      assertEqual(
        sourceEvent[field],
        expectedValue,
        `${alias} source history ${field}`
      );
      assertEqual(
        destinationEvent[field],
        expectedValue,
        `${alias} destination history ${field}`
      );
    }
    assertEqual(
      sourceEvent.id,
      deterministicTradeUuid(
        `${completedTradeId}:ownership:${transfer.sourceOwnershipId}:out`
      ),
      `${alias} source history identity`
    );
    assertEqual(
      destinationEvent.id,
      deterministicTradeUuid(
        `${completedTradeId}:ownership:${transfer.destinationOwnershipId}:in`
      ),
      `${alias} destination history identity`
    );
    assertEqual(
      sourceEvent.team_id,
      transfer.sourceTeamId,
      `${alias} source history team`
    );
    assertEqual(
      destinationEvent.team_id,
      transfer.destinationTeamId,
      `${alias} destination history team`
    );

    const sourceBefore = parseJsonObject(
      sourceEvent.before_metadata_json,
      `${alias} source ownership before metadata`
    );
    const sourceAfter = parseJsonObject(
      sourceEvent.after_metadata_json,
      `${alias} source ownership after metadata`
    );
    const destinationBefore = parseJsonObject(
      destinationEvent.before_metadata_json,
      `${alias} destination ownership before metadata`
    );
    const destinationAfter = parseJsonObject(
      destinationEvent.after_metadata_json,
      `${alias} destination ownership after metadata`
    );
    assertExactKeys(
      sourceBefore,
      ["schemaVersion", "exists", "ownership"],
      `${alias} source before keys`
    );
    assertEqual(sourceBefore.schemaVersion, 2, `${alias} source before schema`);
    assertEqual(sourceBefore.exists, true, `${alias} source existed before`);
    const expectedSourceOwnership = {
      id: transfer.sourceOwnershipId,
      leagueId,
      seasonId: expectedSeasonId,
      playerId: asset.player_id,
      teamId: transfer.sourceTeamId,
      ownershipKind: "Prospect Right",
      rosterCategory: "Prospect",
      positionGroup: snapshot.ownership.positionGroup,
      slotNumber: snapshot.ownership.slotNumber ?? null,
      version: transfer.sourceOwnershipVersion,
    };
    assertOwnershipSnapshot(
      sourceBefore.ownership,
      expectedSourceOwnership,
      `${alias} source before ownership`
    );
    assertExactKeys(
      sourceAfter,
      ["schemaVersion", "exists", "destinationOwnershipId"],
      `${alias} source after keys`
    );
    assertEqual(sourceAfter.schemaVersion, 2, `${alias} source after schema`);
    assertEqual(sourceAfter.exists, false, `${alias} source closed after`);
    assertEqual(
      sourceAfter.destinationOwnershipId,
      transfer.destinationOwnershipId,
      `${alias} source after destination link`
    );
    assertExactKeys(
      destinationBefore,
      ["schemaVersion", "exists", "sourceOwnershipId"],
      `${alias} destination before keys`
    );
    assertEqual(
      destinationBefore.schemaVersion,
      2,
      `${alias} destination before schema`
    );
    assertEqual(
      destinationBefore.exists,
      false,
      `${alias} destination absent before`
    );
    assertEqual(
      destinationBefore.sourceOwnershipId,
      transfer.sourceOwnershipId,
      `${alias} destination before source link`
    );
    assertExactKeys(
      destinationAfter,
      ["schemaVersion", "exists", "ownership"],
      `${alias} destination after keys`
    );
    assertEqual(
      destinationAfter.schemaVersion,
      2,
      `${alias} destination after schema`
    );
    assertEqual(
      destinationAfter.exists,
      true,
      `${alias} destination exists after`
    );
    const expectedDestinationOwnership = {
      ...expectedSourceOwnership,
      id: transfer.destinationOwnershipId,
      teamId: transfer.destinationTeamId,
      slotNumber: null,
      version: 1,
    };
    assertOwnershipSnapshot(
      destinationAfter.ownership,
      expectedDestinationOwnership,
      `${alias} destination after ownership`
    );

    assertEqual(
      count(
        database,
        "SELECT COUNT(*) AS count FROM player_ownerships " +
          "WHERE league_id=? AND id=?",
        leagueId,
        transfer.sourceOwnershipId
      ),
      0,
      `${alias} source ownership tenure is closed`
    );
    const destinationOwnership = database.prepare(`
      SELECT season_id, player_id, team_id, ownership_kind,
        roster_category, position_group, slot_number,
        acquired_transaction_type, acquired_transaction_id,
        created_at_ms, updated_at_ms, version, trade_blocked
      FROM player_ownerships
      WHERE league_id=? AND id=?
    `).get(leagueId, transfer.destinationOwnershipId);
    assertEqual(
      Boolean(destinationOwnership),
      true,
      `${alias} destination ownership tenure is current`
    );
    for (const [field, expectedValue] of [
      ["season_id", expectedDestinationOwnership.seasonId],
      ["player_id", expectedDestinationOwnership.playerId],
      ["team_id", expectedDestinationOwnership.teamId],
      ["ownership_kind", expectedDestinationOwnership.ownershipKind],
      ["roster_category", expectedDestinationOwnership.rosterCategory],
      ["position_group", expectedDestinationOwnership.positionGroup],
      ["slot_number", expectedDestinationOwnership.slotNumber],
      ["acquired_transaction_type", "trade_execution"],
      ["acquired_transaction_id", completedTradeId],
      ["created_at_ms", completed.completed_at_ms],
      ["updated_at_ms", completed.completed_at_ms],
      ["version", 1],
      ["trade_blocked", 0],
    ]) {
      assertEqual(
        destinationOwnership[field],
        expectedValue,
        `${alias} destination tenure ${field}`
      );
    }
  }

  const contractEvents = database.prepare(`
    SELECT player_id, team_id, actor_user_id, metadata_json,
      reason, occurred_at_ms
    FROM contract_events
    WHERE league_id=? AND source_type='trade' AND source_id=?
      AND event_type='trade_transfer'
    ORDER BY player_id ASC, id ASC
  `).all(leagueId, completedTradeId);
  assertEqual(contractEvents.length, 2, `${alias} accepted contract history`);
  const assetByPlayerId = new Map(
    acceptedAssets.map((asset) => [asset.player_id, asset])
  );
  for (const event of contractEvents) {
    const asset = assetByPlayerId.get(event.player_id);
    assertEqual(Boolean(asset), true, `${alias} contract history player scope`);
    assertEqual(
      event.team_id,
      asset.destination_team_id,
      `${alias} contract history destination`
    );
    assertEqual(
      event.actor_user_id,
      receivingManager.user_id,
      `${alias} contract history manager actor`
    );
    assertEqual(event.reason, null, `${alias} contract history reason`);
    assertEqual(
      event.occurred_at_ms,
      completed.completed_at_ms,
      `${alias} contract history timestamp`
    );
    const metadata = parseJsonObject(
      event.metadata_json,
      `${alias} contract history metadata`
    );
    assertExactKeys(
      metadata,
      [
        "schemaVersion",
        "fromTeamId",
        "toTeamId",
        "termsUnchanged",
        "prospectStatusPreserved",
      ],
      `${alias} contract history metadata keys`
    );
    assertEqual(metadata.schemaVersion, 1, `${alias} contract history schema`);
    assertEqual(
      metadata.fromTeamId,
      asset.source_team_id,
      `${alias} contract history source`
    );
    assertEqual(
      metadata.toTeamId,
      asset.destination_team_id,
      `${alias} contract history target`
    );
    assertEqual(metadata.termsUnchanged, true, `${alias} unchanged contract terms`);
    assertEqual(
      metadata.prospectStatusPreserved,
      true,
      `${alias} preserved prospect status`
    );
  }

  const completedActivities = database.prepare(`
    SELECT actor_user_id, actor_authority, team_id, related_type,
      related_id, metadata_json, occurred_at_ms
    FROM league_activity
    WHERE league_id=? AND related_type='trade' AND related_id=?
      AND event_type='trade_completed'
  `).all(leagueId, completedTradeId);
  assertEqual(
    completedActivities.length,
    1,
    `${alias} manager completion activity count`
  );
  const completedActivity = completedActivities[0];
  assertEqual(
    completedActivity.actor_user_id,
    receivingManager.user_id,
    `${alias} completion activity actor`
  );
  assertEqual(
    completedActivity.actor_authority,
    "manager",
    `${alias} completion activity authority`
  );
  assertEqual(completedActivity.team_id, null, `${alias} completion activity team`);
  assertEqual(
    completedActivity.occurred_at_ms,
    completed.completed_at_ms,
    `${alias} completion activity timestamp`
  );
  const activityMetadata = parseJsonObject(
    completedActivity.metadata_json,
    `${alias} completion activity metadata`
  );
  assertEqual(
    activityMetadata.actorAuthority,
    "manager",
    `${alias} completion activity metadata authority`
  );
  assertEqual(
    activityMetadata.commissionerCompletionReference,
    null,
    `${alias} completion activity commissioner reference`
  );
  assertEqual(
    activityMetadata.transactionId,
    completedTradeId,
    `${alias} completion activity transaction identity`
  );
  for (const [playerAlias, destinationTeamNumber] of [
    ["team1Prospect1", 2],
    ["team2Prospect2", 1],
  ]) {
    const executedAsset = database.prepare(`
      SELECT contracts.current_team_id AS contractTeamId,
        player_ownerships.team_id AS ownershipTeamId,
        player_ownerships.acquired_transaction_type AS acquisitionType,
        player_ownerships.acquired_transaction_id AS acquisitionId
      FROM contracts
      JOIN player_ownerships
        ON player_ownerships.league_id=contracts.league_id
       AND player_ownerships.player_id=contracts.player_id
      WHERE contracts.league_id=? AND contracts.player_id=?
    `).get(leagueId, playerIds[playerAlias]);
    const destinationTeamId = fixtureId(`team:${alias}:${destinationTeamNumber}`);
    assertEqual(
      executedAsset?.contractTeamId,
      destinationTeamId,
      `${alias} ${playerAlias} executed contract destination`
    );
    assertEqual(
      executedAsset?.ownershipTeamId,
      destinationTeamId,
      `${alias} ${playerAlias} executed ownership destination`
    );
    assertEqual(
      executedAsset?.acquisitionType,
      "trade_execution",
      `${alias} ${playerAlias} executed acquisition type`
    );
    assertEqual(
      executedAsset?.acquisitionId,
      completedTradeId,
      `${alias} ${playerAlias} executed transaction identity`
    );
  }

  const rejected = database.prepare(`
    SELECT status, responded_at_ms, completed_at_ms
    FROM trades
    WHERE league_id=? AND id=?
  `).get(leagueId, rejectedTradeId);
  assertEqual(rejected?.status, "declined", `${alias} rejected storage status`);
  assertEqual(
    Number.isSafeInteger(rejected?.responded_at_ms),
    true,
    `${alias} rejected response timestamp`
  );
  assertEqual(rejected?.completed_at_ms, null, `${alias} rejected completion absence`);
  assertEqual(
    count(database, `
      SELECT COUNT(*) AS count
      FROM trade_events
      WHERE league_id=? AND trade_id=? AND event_type='proposal_rejected'
    `, leagueId, rejectedTradeId),
    1,
    `${alias} rejected lifecycle evidence`
  );

  assertEqual(
    count(database, `
      SELECT COUNT(*) AS count
      FROM (
        SELECT trades.id
        FROM trades
        JOIN trade_assets
          ON trade_assets.league_id=trades.league_id
         AND trade_assets.trade_id=trades.id
        WHERE trades.league_id=?
        GROUP BY trades.id
        HAVING COUNT(*) >= 2 AND COUNT(DISTINCT trade_assets.direction)=2
      )
    `, leagueId),
    5,
    `${alias} two-sided trade scenario count`
  );
  assertEqual(
    count(database, `
      SELECT COUNT(*) AS count
      FROM buyout_years
      WHERE league_id=? AND buyout_obligation_id=? AND season_id=?
        AND status='current' AND penalty_cents=?
    `, leagueId, fixtureId(`buyout:${alias}`),
    fixtureId(`season:${alias}:current`),
    INVALID_CAP_BUYOUT_PENALTY_CENTS),
    1,
    `${alias} invalid-cap obligation amount`
  );

  const invalidCapTrade = database.prepare(`
    SELECT id, season_id, proposing_team_id, receiving_team_id,
      effective_deadline_at_ms, version
    FROM trades
    WHERE league_id=? AND id=?
  `).get(leagueId, invalidCapTradeId);
  assertEqual(invalidCapTrade?.id, invalidCapTradeId, `${alias} invalid-cap trade`);
  const invalidCapReceivingManager = database.prepare(`
    SELECT user_id, membership_id
    FROM team_manager_assignments
    WHERE league_id = ? AND team_id = ? AND status = 'accepted'
      AND ended_at_ms IS NULL
    LIMIT 2
  `).get(leagueId, invalidCapTrade.receiving_team_id);
  const invalidCapPreview = createSqliteTradeProposalRepository({
    database,
    candidateCardSummerSynchronizer: {
      synchronize() {
        throw new Error(
          "A read-only release QA trade preview attempted summer synchronization."
        );
      },
    },
  }).previewAcceptance({
    tradeId: invalidCapTrade.id,
    leagueId,
    seasonId: invalidCapTrade.season_id,
    proposingTeamId: invalidCapTrade.proposing_team_id,
    receivingTeamId: invalidCapTrade.receiving_team_id,
    expectedVersion: invalidCapTrade.version,
    actorUserId: invalidCapReceivingManager.user_id,
    actorMembershipId: invalidCapReceivingManager.membership_id,
    actorAuthority: "manager",
    occurredAtMs: FIXTURE_NOW_MS + 60_000,
    effectiveDeadlineAtMs: invalidCapTrade.effective_deadline_at_ms,
  });
  const receivingTeam = invalidCapPreview.teams.find(
    ({ teamId }) => teamId === invalidCapTrade.receiving_team_id
  );
  assertEqual(
    invalidCapPreview.generallyIllegal,
    true,
    `${alias} invalid-cap real preflight result`
  );
  assertEqual(
    receivingTeam?.issues.some(({ code }) => code === "SALARY_CAP_EXCEEDED"),
    true,
    `${alias} invalid-cap salary issue`
  );
  assertEqual(
    receivingTeam?.cap.usageCents > receivingTeam?.cap.salaryCapCents,
    true,
    `${alias} invalid-cap projected usage`
  );
}

function verifyAccounts(database) {
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM users"), 9, "account count");
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM user_credentials"), 9, "credential count");
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM platform_roles WHERE status='active'"), 1, "active platform role count");

  const expectedStatuses = {
    platformAdmin: "active",
    leagueACommissioner: "active",
    leagueBCommissioner: "active",
    leagueAManagerOne: "active",
    leagueAManagerTwo: "active",
    leagueBManagerOne: "active",
    verifiedWithoutMembership: "active",
    pendingVerification: "pending_verification",
    deactivated: "deactivated",
  };
  for (const alias of ACCOUNT_ALIASES) {
    const row = database.prepare("SELECT status FROM users WHERE id=?").get(
      fixtureId(`account:${alias}`)
    );
    assertEqual(row?.status, expectedStatuses[alias], `${alias} status`);
  }
  assertEqual(
    count(
      database,
      "SELECT COUNT(*) AS count FROM league_memberships WHERE user_id=?",
      fixtureId("account:verifiedWithoutMembership")
    ),
    0,
    "verified account membership isolation"
  );
  assertEqual(
    count(
      database,
      `SELECT COUNT(*) AS count FROM league_memberships
       WHERE user_id=? AND permission_category='member' AND status='active'`,
      fixtureId("account:platformAdmin")
    ),
    2,
    "platform administrator explicit membership coverage"
  );
  return Object.freeze({
    aliases: ACCOUNT_ALIASES,
    statusCounts: Object.freeze({
      active: 7,
      pendingVerification: 1,
      deactivated: 1,
    }),
  });
}

function verifyLeague(database, alias, playerIds) {
  const leagueId = fixtureId(`league:${alias}`);
  const expectedMembershipCount = alias === "leagueA" ? 4 : 3;
  const expected = expectedLeagueCounts(alias);
  const row = database.prepare(`
    SELECT l.status, l.timezone,
      s.salary_cap_cents AS salaryCapCents,
      s.maximum_bench_aav_cents AS maximumBenchAavCents,
      s.maximum_teams AS maximumTeams
    FROM leagues l
    JOIN league_settings s ON s.league_id=l.id
    WHERE l.id=?
  `).get(leagueId);
  assertEqual(row?.status, "active", `${alias} status`);
  assertEqual(row?.timezone, "America/Vancouver", `${alias} timezone`);
  assertEqual(row?.salaryCapCents, 10_000, `${alias} salary cap`);
  assertEqual(row?.maximumBenchAavCents, 400, `${alias} bench AAV limit`);
  assertEqual(row?.maximumTeams, expected.teamCount, `${alias} maximum teams`);

  const teamNames = database.prepare(
    "SELECT name FROM teams WHERE league_id=? ORDER BY name"
  ).all(leagueId).map(({ name }) => name);
  assertEqual(teamNames.length, expected.teamCount, `${alias} team count`);
  assertEqual(
    JSON.stringify(teamNames),
    JSON.stringify([...TEAM_NAMES_BY_LEAGUE[alias]].sort()),
    `${alias} team names`
  );
  assertEqual(
    count(
      database,
      `SELECT COUNT(*) AS count FROM teams
       WHERE league_id=?
         AND (
           primary_colour <> lower(primary_colour)
           OR secondary_colour <> lower(secondary_colour)
         )`,
      leagueId
    ),
    0,
    `${alias} canonical lowercase team-colour count`
  );
  assertEqual(
    count(database, "SELECT COUNT(*) AS count FROM league_memberships WHERE league_id=?", leagueId),
    expectedMembershipCount,
    `${alias} membership count`
  );
  const commissionerAlias =
    alias === "leagueA" ? "leagueACommissioner" : "leagueBCommissioner";
  const expectedCommissionerAssignments = alias === "leagueB" ? 1 : 0;
  assertEqual(
    count(
      database,
      `SELECT COUNT(*) AS count FROM team_manager_assignments
       WHERE league_id=? AND user_id=? AND status='accepted'
         AND ended_at_ms IS NULL`,
      leagueId,
      fixtureId(`account:${commissionerAlias}`)
    ),
    expectedCommissionerAssignments,
    alias === "leagueB"
      ? `${alias} explicit dual-role commissioner-manager assignment count`
      : `${alias} commissioner has no implicit team assignment`
  );
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM seasons WHERE league_id=?", leagueId), 4, `${alias} season count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM draft_picks WHERE league_id=? AND status='unused'", leagueId), expected.draftPicks, `${alias} four-season draft-pick count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM league_player_positions WHERE league_id=?", leagueId), PLAYER_BLUEPRINTS.length, `${alias} player-position count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM player_ownerships WHERE league_id=?", leagueId), expected.ownerships, `${alias} ownership count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM contracts WHERE league_id=?", leagueId), expected.contracts, `${alias} contract count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM contracts WHERE league_id=? AND status='active'", leagueId), expected.activeContracts, `${alias} active contract count`);
  assertEqual(count(database, "SELECT COUNT(DISTINCT original_term_years) AS count FROM contracts WHERE league_id=? AND status='active'", leagueId), 3, `${alias} contract term coverage`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM retention_obligations WHERE league_id=? AND status='active'", leagueId), 1, `${alias} retention count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM buyout_obligations WHERE league_id=? AND status='active'", leagueId), 1, `${alias} buyout count`);

  const categories = Object.fromEntries(database.prepare(`
    SELECT roster_category AS category, COUNT(*) AS count
    FROM player_ownerships WHERE league_id=? GROUP BY roster_category
  `).all(leagueId).map(({ category, count: categoryCount }) => [category, categoryCount]));
  assertEqual(categories.Active, expected.activeRoster, `${alias} active roster count`);
  assertEqual(categories.Bench, expected.bench, `${alias} bench count`);
  assertEqual(categories["Injured Reserve"], expected.injuredReserve, `${alias} injured-reserve count`);
  assertEqual(categories.Prospect, expected.prospects, `${alias} prospect count`);
  assertEqual(
    count(database, `
      SELECT COUNT(*) AS count
      FROM player_ownerships o
      JOIN contracts c ON c.league_id=o.league_id AND c.player_id=o.player_id
      WHERE o.league_id=? AND o.roster_category='Bench'
        AND c.status='active' AND c.aav_cents <= 400
    `, leagueId),
    expected.bench,
    `${alias} bench contract limit coverage`
  );
  const under19ProspectPlayerIds = PLAYER_BLUEPRINTS
    .filter(
      ({ rosterCategory, teamNumber }) =>
        rosterCategory === "Prospect" && teamNumber <= expected.teamCount
    )
    .map(({ alias: playerAlias }) => playerIds[playerAlias]);
  const expectedUnder19ProspectCount = count(
    database,
    `SELECT COUNT(*) AS count
     FROM players
     WHERE id IN (${under19ProspectPlayerIds.map(() => "?").join(", ")})
       AND birth_date > '2007-07-26'`,
    ...under19ProspectPlayerIds
  );
  assertEqual(
    count(database, `
      SELECT COUNT(*) AS count
      FROM player_ownerships AS ownership
      JOIN players AS player ON player.id=ownership.player_id
      WHERE ownership.league_id=?
        AND ownership.roster_category='Prospect'
        AND player.birth_date > '2007-07-26'
    `, leagueId),
    expectedUnder19ProspectCount,
    `${alias} available under-19 prospect identity coverage`
  );
  for (let teamNumber = 1; teamNumber <= expected.teamCount; teamNumber += 1) {
    const teamId = fixtureId(`team:${alias}:${teamNumber}`);
    for (const [category, expectedDepth] of [
      ["Active", expected.depthByTeam[teamNumber - 1].Active],
      ["Bench", expected.depthByTeam[teamNumber - 1].Bench],
      ["Injured Reserve", expected.depthByTeam[teamNumber - 1]["Injured Reserve"]],
      ["Prospect", expected.depthByTeam[teamNumber - 1].Prospect],
    ]) {
      assertEqual(
        count(
          database,
          `SELECT COUNT(*) AS count FROM player_ownerships
           WHERE league_id=? AND team_id=? AND roster_category=?`,
          leagueId,
          teamId,
          category
        ),
        expectedDepth,
        `${alias} team ${teamNumber} ${category} depth`
      );
    }
  }
  assertEqual(
    count(database, `
      SELECT COUNT(*) AS count FROM player_ownerships o
      WHERE o.league_id=? AND o.player_id=? AND o.roster_category='Prospect'
        AND NOT EXISTS (
          SELECT 1 FROM contracts c
          WHERE c.league_id=o.league_id AND c.player_id=o.player_id
        )
    `, leagueId, playerIds.unsignedProspect),
    1,
    `${alias} unsigned prospect coverage`
  );
  assertEqual(
    count(database, `
      SELECT COUNT(*) AS count FROM player_ownerships o
      JOIN contracts c ON c.league_id=o.league_id AND c.player_id=o.player_id
      WHERE o.league_id=? AND o.player_id=? AND o.roster_category='Prospect'
        AND c.contract_type='fantasy_elc' AND c.status='active'
        AND c.original_total_value_cents=300
        AND c.original_term_years=3
        AND c.aav_cents=100
        AND (
          SELECT COUNT(*) FROM contract_years cy
          WHERE cy.league_id=c.league_id AND cy.contract_id=c.id
            AND cy.aav_cents=100
            AND cy.year_number BETWEEN 1 AND 3
        )=3
    `, leagueId, playerIds.signedProspect),
    1,
    `${alias} signed prospect coverage`
  );
  assertEqual(
    count(database, `
      SELECT COUNT(DISTINCT team_id) AS count
      FROM player_ownerships
      WHERE league_id=?
    `, leagueId),
    expected.populatedRosterTeams,
    `${alias} populated-roster team coverage`
  );
  for (const playerAlias of ["freeAgentForward", "freeAgentDefence"]) {
    assertEqual(
      count(database, "SELECT COUNT(*) AS count FROM player_ownerships WHERE league_id=? AND player_id=?", leagueId, playerIds[playerAlias]),
      0,
      `${alias} ${playerAlias} remains free`
    );
  }

  assertEqual(count(database, "SELECT COUNT(*) AS count FROM auctions WHERE league_id=? AND status='open'", leagueId), 1, `${alias} open auction count`);
  assertEqual(
    count(database, `
      SELECT COUNT(*) AS count
      FROM auction_contexts
      JOIN auctions
        ON auctions.league_id = auction_contexts.league_id
       AND auctions.season_id = auction_contexts.season_id
       AND auctions.id = auction_contexts.auction_id
      WHERE auction_contexts.league_id=?
        AND auction_contexts.source_kind='ordinary_weekly'
        AND auction_contexts.fad_id IS NULL
        AND auction_contexts.fad_rollover_id IS NULL
        AND auction_contexts.fad_allocation_id IS NULL
        AND auction_contexts.created_at_ms=auctions.created_at_ms
    `, leagueId),
    1,
    `${alias} ordinary auction context count`
  );
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM auction_bids WHERE league_id=? AND status='active'", leagueId), 1, `${alias} own-bid scenario count`);
  assertEqual(
    count(
      database,
      "SELECT COUNT(*) AS count FROM free_agent_draft_auction_participants WHERE league_id=?",
      leagueId
    ),
    0,
    `${alias} FAD auction participant count`
  );
  assertEqual(
    count(
      database,
      "SELECT COUNT(*) AS count FROM free_agent_draft_draws WHERE league_id=?",
      leagueId
    ),
    0,
    `${alias} FAD draw count`
  );
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM trades WHERE league_id=? AND status='proposed'", leagueId), 3, `${alias} pending trade count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM trades WHERE league_id=? AND status='completed'", leagueId), 1, `${alias} completed trade count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM trades WHERE league_id=? AND status='accepted'", leagueId), 0, `${alias} legacy accepted storage count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM trades WHERE league_id=? AND status='declined'", leagueId), 1, `${alias} declined trade count`);
  verifyTradeScenarios(database, alias, leagueId, playerIds);
  assertEqual(count(database, `
    SELECT COUNT(*) AS count
    FROM trade_assets
    WHERE league_id=? AND contract_id=?
  `, leagueId, fixtureId(`contract:${alias}:activeForward2`)), 2, `${alias} simultaneous shared-asset coverage`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM matchup_weeks WHERE league_id=?", leagueId), 22, `${alias} matchup-week count`);
  assertEqual(
    count(
      database,
      "SELECT COUNT(*) AS count FROM matchup_weeks WHERE league_id=? AND status='scheduled'",
      leagueId
    ),
    21,
    `${alias} scheduled matchup-week count`
  );
  assertEqual(
    count(
      database,
      "SELECT COUNT(*) AS count FROM matchup_weeks WHERE league_id=? AND status IN ('live', 'correction_required')",
      leagueId
    ),
    0,
    `${alias} maintenance-blocking matchup-week count`
  );
  assertEqual(
    count(
      database,
      `
        SELECT COUNT(*) AS count
        FROM season_matchup_schedule_generations AS generation
        JOIN matchup_operations AS operation
          ON operation.league_id = generation.league_id
         AND operation.season_id = generation.season_id
         AND operation.id = generation.schedule_operation_id
        JOIN matchup_weeks AS week_one
          ON week_one.league_id = generation.league_id
         AND week_one.season_id = generation.season_id
         AND week_one.id = generation.week_one_matchup_week_id
        WHERE generation.league_id = ?
          AND generation.schedule_version = 1
          AND generation.schedule_operation_id = ?
          AND generation.status = 'current'
          AND generation.superseded_at_ms IS NULL
          AND generation.version = 1
          AND operation.operation_type = 'schedule_generate'
          AND operation.status = 'succeeded'
          AND operation.matchup_week_id IS NULL
          AND operation.matchup_id IS NULL
          AND operation.completed_at_ms =
                generation.created_at_ms
          AND week_one.sequence = 1
          AND week_one.starts_at_ms =
                generation.week_one_starts_at_ms
      `,
      leagueId,
      fixtureId(`matchup-schedule-operation:${alias}`)
    ),
    1,
    `${alias} current schedule-generation evidence`
  );
  for (const tableName of [
    "auction_administration_command_results",
    "entry_draft_on_clock_trades",
    "entry_draft_rollover_bindings",
    "entry_draft_schedule_operations",
    "free_agent_draft_schedule_recoveries",
    "free_agent_draft_schedule_recovery_jobs",
    "free_agent_draft_schedule_recovery_matchups",
    "free_agent_draft_schedule_recovery_weeks",
    "free_agent_draft_readiness_corrective_requeues",
    "matchup_roster_game_exclusion_sets",
    "matchup_schedule_command_results",
    "matchup_schedule_job_bindings",
    "nhl_game_state_observation_snapshots",
    "nhl_game_state_observations",
    "season_rollover_occurrences",
  ]) {
    assertEqual(
      count(
        database,
        `SELECT COUNT(*) AS count
         FROM ${tableName}
         WHERE league_id = ?`,
        leagueId
      ),
      0,
      `${alias} ${tableName} fixture-history count`
    );
  }
  assertEqual(
    count(
      database,
      "SELECT COUNT(*) AS count FROM matchups WHERE league_id=? AND status IN ('live', 'correction_required')",
      leagueId
    ),
    0,
    `${alias} maintenance-blocking matchup count`
  );
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM matchups WHERE league_id=? AND status='final'", leagueId), expected.finalMatchups, `${alias} final matchup count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM matchups WHERE league_id=? AND status='scheduled'", leagueId), expected.scheduledMatchups, `${alias} scheduled matchup count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM matchups WHERE league_id=? AND status='awaiting_data'", leagueId), expected.awaitingDataMatchups, `${alias} score-readable matchup count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM matchup_results WHERE league_id=? AND status='official'", leagueId), 1, `${alias} official result count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM player_stat_totals WHERE refresh_id=?", fixtureId(`stat-refresh:${alias}`)), PLAYER_BLUEPRINTS.length, `${alias} synthetic player-stat total count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM stat_snapshots WHERE league_id=?", leagueId), expected.statSnapshots, `${alias} matchup snapshot count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM matchup_roster_locks WHERE league_id=?", leagueId), expected.matchupLocks, `${alias} matchup lock count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM matchup_roster_players WHERE league_id=?", leagueId), expected.matchupPlayers, `${alias} locked-player row count`);
  const syntheticRefresh = database.prepare(`
    SELECT stat_sources.provider, stat_refreshes.metadata_json
    FROM stat_refreshes
    JOIN stat_sources ON stat_sources.id=stat_refreshes.stat_source_id
    WHERE stat_refreshes.id=?
  `).get(fixtureId(`stat-refresh:${alias}`));
  assertEqual(syntheticRefresh?.provider, "release_qa_fixture", `${alias} synthetic statistics provider`);
  let metadata;
  try {
    metadata = JSON.parse(syntheticRefresh?.metadata_json || "");
  } catch {
    fail("RELEASE_QA_FIXTURE_MISMATCH", `Release-QA fixture mismatch: ${alias} synthetic statistics metadata.`);
  }
  assertEqual(metadata?.sourceKind, "synthetic_release_qa", `${alias} synthetic statistics label`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM standings_rows WHERE league_id=?", leagueId), expected.standingsRows, `${alias} standings row count`);
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM league_activity WHERE league_id=?", leagueId), 8, `${alias} activity count`);
  const notificationCount = count(
    database,
    "SELECT COUNT(*) AS count FROM notifications WHERE league_id=?",
    leagueId
  );
  assertEqual(
    count(
      database,
      `SELECT COUNT(*) AS count
       FROM notifications
       WHERE league_id = ?
         AND deduplication_key IS NOT NULL`,
      leagueId
    ),
    0,
    `${alias} legacy notification deduplication-key count`
  );
  const tradeNotificationCount = count(
    database,
    `SELECT COUNT(*) AS count FROM notifications
     WHERE league_id=? AND event_type='trade_proposal_received'
       AND related_feature='trade'`,
    leagueId
  );
  if (tradeNotificationCount < 1) {
    fail(
      "RELEASE_QA_FIXTURE_MISMATCH",
      `Release-QA fixture mismatch: ${alias} trade notification coverage.`,
      { actual: tradeNotificationCount, expectedMinimum: 1 }
    );
  }
  assertEqual(count(database, "SELECT COUNT(*) AS count FROM outbox_events WHERE league_id=? AND event_type='release_qa.email_captured' AND status='published'", leagueId), 1, `${alias} captured-email envelope count`);
  assertEqual(
    count(
      database,
      `SELECT COUNT(*) AS count
       FROM (
         SELECT outbox_events.id
         FROM outbox_events
         LEFT JOIN outbox_event_audiences
           ON outbox_event_audiences.league_id =
                outbox_events.league_id
          AND outbox_event_audiences.outbox_event_id =
                outbox_events.id
          AND outbox_event_audiences.audience_kind = 'league'
          AND outbox_event_audiences.team_id IS NULL
          AND outbox_event_audiences.user_id IS NULL
         WHERE outbox_events.league_id = ?
         GROUP BY outbox_events.id
         HAVING COUNT(outbox_event_audiences.id) <> 1
       ) AS invalid_audience_coverage`,
      leagueId
    ),
    0,
    `${alias} exact league outbox audience coverage`
  );
  assertEqual(
    count(
      database,
      `SELECT COUNT(*) AS count
       FROM outbox_event_audiences
       WHERE league_id = ?
         AND (
           audience_kind <> 'league'
           OR team_id IS NOT NULL
           OR user_id IS NOT NULL
         )`,
      leagueId
    ),
    0,
    `${alias} unexpected private outbox audience count`
  );

  const activeContractAavCents = database.prepare(
    "SELECT SUM(aav_cents) AS total FROM contracts WHERE league_id=? AND status='active'"
  ).get(leagueId).total;
  return Object.freeze({
    alias,
    activeContractAavCents,
    maximumBenchAavCents: 400,
    salaryCapCents: 10_000,
    counts: Object.freeze({
      activity: 8,
      activeContracts: expected.activeContracts,
      activeRoster: expected.activeRoster,
      auctions: 1,
      bench: expected.bench,
      buyouts: 1,
      draftPicks: expected.draftPicks,
      injuredReserve: expected.injuredReserve,
      memberships: expectedMembershipCount,
      notifications: notificationCount,
      ownerships: expected.ownerships,
      prospects: expected.prospects,
      retentions: 1,
      scheduleGenerations: 1,
      standingsRows: expected.standingsRows,
      statSnapshots: expected.statSnapshots,
      syntheticPlayerTotals: PLAYER_BLUEPRINTS.length,
      matchupLocks: expected.matchupLocks,
      matchupPlayers: expected.matchupPlayers,
      teams: expected.teamCount,
      populatedRosterTeams: expected.populatedRosterTeams,
      trades: 5,
    }),
  });
}

function verifyReleaseQaFixture({ databasePath } = {}) {
  if (!path.isAbsolute(databasePath || "")) {
    fail(
      "RELEASE_QA_DATABASE_PATH_REQUIRED",
      "An absolute release-QA database path is required."
    );
  }
  const database = openReadonlyDatabase({ databasePath });
  try {
    assertEqual(database.pragma("integrity_check", { simple: true }), "ok", "SQLite integrity");
    assertEqual(database.pragma("foreign_key_check").length, 0, "foreign-key violation count");
    assertEqual(database.pragma("user_version", { simple: true }), 54, "schema version");

    const metadata = Object.fromEntries(database.prepare(`
      SELECT metadata_key, metadata_value FROM application_metadata
      WHERE metadata_key IN ('database_created_at', 'database_id', 'environment_id')
    `).all().map(({ metadata_key: key, metadata_value: value }) => [key, value]));
    assertEqual(metadata.database_created_at, FIXTURE_CREATED_AT, "database created-at identity");
    assertEqual(metadata.database_id, FIXTURE_DATABASE_ID, "database identity");
    assertEqual(metadata.environment_id, FIXTURE_ENVIRONMENT_ID, "environment identity");

    assertEqual(count(database, "SELECT COUNT(*) AS count FROM leagues"), 2, "league count");
    const playerIds = resolveFixturePlayerIds(database);
    assertEqual(
      count(database, "SELECT COUNT(*) AS count FROM players") >=
        PLAYER_BLUEPRINTS.length,
      true,
      "minimum global player count"
    );
    const accounts = verifyAccounts(database);
    const leagues = LEAGUE_ALIASES.map((alias) =>
      verifyLeague(database, alias, playerIds)
    );
    const overlappingPlayers = count(database, `
      SELECT COUNT(*) AS count FROM (
        SELECT player_id FROM league_player_positions
        GROUP BY player_id HAVING COUNT(DISTINCT league_id)=2
      )
    `);
    assertEqual(overlappingPlayers, PLAYER_BLUEPRINTS.length, "overlapping global player identity count");
    const overlappingTeamNames = count(database, `
      SELECT COUNT(*) AS count FROM (
        SELECT name_normalized FROM teams
        GROUP BY name_normalized HAVING COUNT(DISTINCT league_id)=2
      )
    `);
    assertEqual(overlappingTeamNames, 0, "overlapping team-name count");
    assertEqual(
      count(database, `
        SELECT COUNT(*) AS count
        FROM player_ownerships a
        JOIN player_ownerships b ON b.player_id=a.player_id
        WHERE a.league_id=? AND b.league_id=? AND a.id=b.id
      `, fixtureId("league:leagueA"), fixtureId("league:leagueB")),
      0,
      "league-scoped ownership identity separation"
    );
    for (
      const [playerAlias, betaTeamNumber]
      of Object.entries(BETA_PLAYER_TEAM_NUMBERS)
    ) {
      const alphaTeamNumber = PLAYER_BLUEPRINTS.find(
        (blueprint) => blueprint.alias === playerAlias
      ).teamNumber;
      assertEqual(
        database.prepare(`
          SELECT team_id AS teamId
          FROM player_ownerships
          WHERE league_id=? AND player_id=?
        `).get(
          fixtureId("league:leagueA"),
          playerIds[playerAlias]
        )?.teamId,
        fixtureId(`team:leagueA:${alphaTeamNumber}`),
        `leagueA ${playerAlias} deliberate roster assignment`
      );
      assertEqual(
        database.prepare(`
          SELECT team_id AS teamId
          FROM player_ownerships
          WHERE league_id=? AND player_id=?
        `).get(
          fixtureId("league:leagueB"),
          playerIds[playerAlias]
        )?.teamId,
        fixtureId(`team:leagueB:${betaTeamNumber}`),
        `leagueB ${playerAlias} deliberate roster assignment`
      );
      assertEqual(
        alphaTeamNumber === betaTeamNumber,
        false,
        `${playerAlias} must differ across Alpha and Beta rosters`
      );
    }

    const manifestWithoutChecksum = Object.freeze({
      manifestVersion: FIXTURE_VERSION,
      fixtureBuildId: FIXTURE_BUILD_ID,
      fixtureCreatedAt: FIXTURE_CREATED_AT,
      environmentId: FIXTURE_ENVIRONMENT_ID,
      schemaVersion: 54,
      accounts,
      leagues: Object.freeze(leagues),
      global: Object.freeze({
        leagueCount: 2,
        overlappingPlayerCount: overlappingPlayers,
        overlappingTeamNameCount: overlappingTeamNames,
        playerCount: PLAYER_BLUEPRINTS.length,
      }),
      scenarios: Object.freeze({
        capturedEmailEnvelope: true,
        finalizedPriorResult: true,
        matchupPlayerStatistics: true,
        openAuctionWithOwnBid: true,
        scheduleGenerationEvidence: true,
        distinctLeagueRosters: true,
        distinctLeagueTeamNames: true,
        simultaneousTradesForOneAsset: true,
        twoLeagueIdentityIsolation: true,
      }),
      integrity: Object.freeze({
        foreignKeyViolationCount: 0,
        sqliteIntegrity: "ok",
      }),
    });
    return Object.freeze({
      ...manifestWithoutChecksum,
      manifestChecksum: checksumManifest(manifestWithoutChecksum),
    });
  } finally {
    database.close();
  }
}

module.exports = {
  ReleaseQaFixtureVerificationError,
  verifyReleaseQaFixture,
};
