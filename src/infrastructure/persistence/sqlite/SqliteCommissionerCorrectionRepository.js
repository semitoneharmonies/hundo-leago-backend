const {
  COMMISSIONER_CORRECTION_CODES,
  CommissionerCorrectionPolicyError,
  assertCommissionerAuthority,
  assertCorrectionChanged,
  assertCurrentRecord,
  assertNoDependentTransactions,
  assertWarningsConfirmed,
  validateContractCorrection,
  validateRosterAddition,
  validateRosterCorrection,
  validateRosterRemoval,
} = require("../../../domain/leagues/commissionerCorrectionPolicy");
const {
  evaluateStructuralRosterLegality,
} = require("../../../domain/rosters/rosterMovementPolicy");
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");
const {
  createSqliteCapReadRepository,
} = require("./SqliteCapReadRepository");
const {
  createSqliteRecordRepository,
} = require("./createSqliteRecordRepository");
const {
  getRepositoryDefinition,
} = require("./repositoryCatalog");

class PreviewRollback extends Error {
  constructor(result) {
    super("Rollback read-only correction preview.");
    this.result = result;
  }
}

function freezeRow(row) {
  return row ? Object.freeze({ ...row }) : null;
}

function freezeRows(rows) {
  return Object.freeze(rows.map(freezeRow));
}

function freezeWarnings(warnings) {
  return Object.freeze(
    warnings.map((warning) => Object.freeze({ ...warning }))
  );
}

function rosterValues(row) {
  return Object.freeze({
    teamId: row.team_id,
    ownershipKind: row.ownership_kind,
    rosterCategory: row.roster_category,
    positionGroup: row.position_group,
    slotNumber: row.slot_number,
  });
}

function requestedRosterValues(correction) {
  return Object.freeze({
    teamId: correction.correctedTeamId,
    ownershipKind: correction.correctedOwnershipKind,
    rosterCategory: correction.correctedRosterCategory,
    positionGroup: correction.correctedPositionGroup,
    slotNumber: correction.correctedSlotNumber,
  });
}

function rosterSnapshot(row) {
  return Object.freeze({
    id: row.id,
    leagueId: row.league_id,
    seasonId: row.season_id,
    playerId: row.player_id,
    ...rosterValues(row),
    version: row.version,
  });
}

function contractValues(row, years) {
  return Object.freeze({
    teamId: row.current_team_id,
    contractType: row.contract_type,
    originalTotalValueCents: row.original_total_value_cents,
    originalTermYears: row.original_term_years,
    aavCents: row.aav_cents,
    startSeasonId: row.start_season_id,
    status: row.status,
    auctionBuyoutLockExpiresAtMs:
      row.auction_buyout_lock_expires_at_ms,
    years: Object.freeze(
      years.map((year) =>
        Object.freeze({
          id: year.id,
          seasonId: year.season_id,
          yearNumber: year.year_number,
          aavCents: year.aav_cents,
          status: year.status,
          rolloverAtMs: year.rollover_at_ms,
        })
      )
    ),
  });
}

function requestedContractValues(correction) {
  return Object.freeze({
    teamId: correction.correctedTeamId,
    contractType: correction.correctedContractType,
    originalTotalValueCents:
      correction.correctedOriginalTotalValueCents,
    originalTermYears: correction.correctedOriginalTermYears,
    aavCents: correction.correctedAavCents,
    startSeasonId: correction.correctedStartSeasonId,
    status: correction.correctedStatus,
    auctionBuyoutLockExpiresAtMs:
      correction.correctedAuctionBuyoutLockExpiresAtMs,
    years: Object.freeze(
      correction.correctedYears.map((year) =>
        Object.freeze({
          id: year.id,
          seasonId: year.seasonId,
          yearNumber: year.yearNumber,
          aavCents: correction.correctedAavCents,
          status: year.status,
          rolloverAtMs: year.rolloverAtMs,
        })
      )
    ),
  });
}

function contractSnapshot(row, years) {
  return Object.freeze({
    id: row.id,
    leagueId: row.league_id,
    playerId: row.player_id,
    ...contractValues(row, years),
    version: row.version,
  });
}

function correctionSnapshot({
  actorMembershipId,
  actorAuthority,
  requested,
  authoritative,
  warnings,
  teamEvaluations,
  confirmed,
}) {
  return JSON.stringify({
    actionType: "correction",
    actor: {
      authority: actorAuthority,
      membershipId: actorMembershipId,
    },
    requested,
    authoritative,
    warnings,
    teamEvaluations,
    confirmations: { warningsAccepted: confirmed },
    outcome: "applied",
  });
}

function createSqliteCommissionerCorrectionRepository({ database } = {}) {
  const ownerships = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("player_ownerships"),
  });
  const ownershipEvents = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("ownership_events"),
  });
  const contracts = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("contracts"),
  });
  const contractYears = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("contract_years"),
  });
  const contractEvents = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("contract_events"),
  });
  const corrections = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("commissioner_corrections"),
  });
  const activity = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("league_activity"),
  });
  const capRepository = createSqliteCapReadRepository({ database });

  let authorityStatement;
  let ownershipStatement;
  let contractStatement;
  let contractYearsStatement;
  let deleteContractYearsStatement;
  let rosterRowsStatement;
  let benchViolationStatement;
  let rosterDependencyStatement;
  let contractDependencyStatement;
  let workspaceLeagueStatement;
  let workspaceTeamsStatement;
  let workspaceRosterStatement;
  let workspaceContractYearsStatement;
  let workspaceFreeAgentsStatement;
  let providerCatalogCountStatement;
  let providerLatestAttemptStatement;
  let providerLatestSuccessStatement;
  let playerForAddStatement;
  let ownershipByPlayerStatement;
  let activeContractByPlayerStatement;
  let teamForAdjustmentStatement;
  let seasonScheduleStatement;
  let removeDependencyStatement;
  let deleteOwnershipStatement;
  let eliminateContractYearsStatement;
  let findIdempotencyStatement;
  let insertIdempotencyStatement;
  let completeIdempotencyStatement;
  let replayCorrectionStatement;
  let replayActivityStatement;
  let addTransaction;
  let removeTransaction;
  let rosterTransaction;
  let contractTransaction;
  try {
    authorityStatement = database.prepare(`
      SELECT membership.*
      FROM league_memberships AS membership
      INNER JOIN leagues AS league
        ON league.id = membership.league_id
      LEFT JOIN platform_roles AS platform_role
        ON platform_role.user_id = membership.user_id
        AND platform_role.role = 'platform_administrator'
        AND platform_role.status = 'active'
        AND platform_role.ended_at_ms IS NULL
      WHERE membership.league_id = @leagueId
        AND membership.id = @actorMembershipId
        AND membership.user_id = @actorUserId
        AND membership.status = 'active'
        AND league.status <> 'deleted'
        AND (
          (
            @actorAuthority = 'commissioner'
            AND membership.permission_category = 'commissioner'
            AND league.commissioner_membership_id = membership.id
          )
          OR (
            @actorAuthority = 'platform_administrator'
            AND platform_role.id IS NOT NULL
          )
        )
      LIMIT 2
    `);
    ownershipStatement = database.prepare(
      "SELECT * FROM player_ownerships " +
        "WHERE league_id = @leagueId AND id = @ownershipId LIMIT 2"
    );
    contractStatement = database.prepare(
      "SELECT * FROM contracts " +
        "WHERE league_id = @leagueId AND id = @contractId LIMIT 2"
    );
    contractYearsStatement = database.prepare(
      "SELECT * FROM contract_years " +
        "WHERE league_id = @leagueId AND contract_id = @contractId " +
        "ORDER BY year_number ASC"
    );
    deleteContractYearsStatement = database.prepare(
      "DELETE FROM contract_years " +
        "WHERE league_id = @leagueId AND contract_id = @contractId"
    );
    rosterRowsStatement = database.prepare(`
      SELECT
        ownership.league_id,
        ownership.season_id,
        ownership.team_id,
        ownership.player_id,
        ownership.roster_category,
        ownership.position_group,
        COALESCE(
          (
            SELECT correction.position_group
            FROM league_player_positions AS correction
            WHERE correction.league_id = ownership.league_id
              AND correction.player_id = ownership.player_id
              AND correction.ended_at_ms IS NULL
            LIMIT 1
          ),
          (
            SELECT source.normalized_position
            FROM player_source_state AS source
            WHERE source.player_id = ownership.player_id
              AND source.ended_at_ms IS NULL
            ORDER BY source.provider ASC
            LIMIT 1
          )
        ) AS effective_position
      FROM player_ownerships AS ownership
      WHERE ownership.league_id = @leagueId
        AND ownership.season_id = @seasonId
        AND ownership.team_id = @teamId
      ORDER BY ownership.player_id ASC
    `);
    benchViolationStatement = database.prepare(`
      SELECT ownership.player_id
      FROM player_ownerships AS ownership
      INNER JOIN contracts AS contract
        ON contract.league_id = ownership.league_id
        AND contract.player_id = ownership.player_id
        AND contract.current_team_id = ownership.team_id
        AND contract.status = 'active'
      INNER JOIN league_settings AS settings
        ON settings.league_id = ownership.league_id
      WHERE ownership.league_id = @leagueId
        AND ownership.season_id = @seasonId
        AND ownership.team_id = @teamId
        AND ownership.ownership_kind = 'Rostered'
        AND ownership.roster_category = 'Bench'
        AND contract.aav_cents > settings.maximum_bench_aav_cents
      ORDER BY ownership.player_id ASC
    `);
    rosterDependencyStatement = database.prepare(`
      SELECT COUNT(*) AS count
      FROM trade_assets AS asset
      INNER JOIN trades AS trade
        ON trade.league_id = asset.league_id
        AND trade.id = asset.trade_id
      WHERE asset.league_id = @leagueId
        AND asset.asset_type = 'prospect_right'
        AND asset.player_id = @playerId
        AND trade.status IN ('proposed', 'accepted')
    `);
    contractDependencyStatement = database.prepare(`
      SELECT
        (
          SELECT COUNT(*)
          FROM trade_assets AS asset
          INNER JOIN trades AS trade
            ON trade.league_id = asset.league_id
            AND trade.id = asset.trade_id
          WHERE asset.league_id = @leagueId
            AND asset.asset_type = 'contract'
            AND asset.contract_id = @contractId
            AND trade.status IN ('proposed', 'accepted')
        )
        + (
          SELECT COUNT(*)
          FROM retention_obligations AS retention
          WHERE retention.league_id = @leagueId
            AND retention.contract_id = @contractId
            AND retention.status = 'active'
        )
        + (
          SELECT COUNT(*)
          FROM buyout_obligations AS buyout
          WHERE buyout.league_id = @leagueId
            AND buyout.contract_id = @contractId
            AND buyout.status = 'active'
        ) AS count
    `);
    workspaceLeagueStatement = database.prepare(`
      SELECT
        league.id,
        league.name,
        league.current_season_id,
        season.label AS current_season_label,
        settings.salary_cap_cents
      FROM leagues AS league
      INNER JOIN seasons AS season
        ON season.league_id = league.id
        AND season.id = league.current_season_id
      INNER JOIN league_settings AS settings
        ON settings.league_id = league.id
      WHERE league.id = @leagueId
        AND league.status <> 'deleted'
      LIMIT 2
    `);
    workspaceTeamsStatement = database.prepare(`
      SELECT id, name, status, version
      FROM teams
      WHERE league_id = @leagueId
        AND status = 'active'
      ORDER BY name_normalized ASC, id ASC
    `);
    workspaceRosterStatement = database.prepare(`
      SELECT
        ownership.id AS ownership_id,
        ownership.season_id,
        ownership.player_id,
        ownership.team_id,
        ownership.ownership_kind,
        ownership.roster_category,
        ownership.position_group,
        ownership.slot_number,
        ownership.version AS ownership_version,
        player.full_name,
        player.birth_date,
        player.status AS player_status,
        COALESCE(
          (
            SELECT position.position_group
            FROM league_player_positions AS position
            WHERE position.league_id = ownership.league_id
              AND position.player_id = ownership.player_id
              AND position.ended_at_ms IS NULL
            LIMIT 1
          ),
          (
            SELECT source.normalized_position
            FROM player_source_state AS source
            WHERE source.player_id = ownership.player_id
              AND source.ended_at_ms IS NULL
            ORDER BY
              CASE source.provider
                WHEN 'sportsdataio-discovery-lab' THEN 0
                WHEN 'release_qa' THEN 1
                ELSE 2
              END,
              source.effective_at_ms DESC
            LIMIT 1
          )
        ) AS effective_position,
        (
          SELECT source.provider
          FROM player_source_state AS source
          WHERE source.player_id = ownership.player_id
            AND source.ended_at_ms IS NULL
          ORDER BY
            CASE source.provider
              WHEN 'sportsdataio-discovery-lab' THEN 0
              WHEN 'release_qa' THEN 1
              ELSE 2
            END,
            source.effective_at_ms DESC
          LIMIT 1
        ) AS provider,
        (
          SELECT source.nhl_team_abbreviation
          FROM player_source_state AS source
          WHERE source.player_id = ownership.player_id
            AND source.ended_at_ms IS NULL
          ORDER BY
            CASE source.provider
              WHEN 'sportsdataio-discovery-lab' THEN 0
              WHEN 'release_qa' THEN 1
              ELSE 2
            END,
            source.effective_at_ms DESC
          LIMIT 1
        ) AS nhl_team_abbreviation,
        contract.id AS contract_id,
        contract.current_team_id AS contract_team_id,
        contract.contract_type,
        contract.original_total_value_cents,
        contract.original_term_years,
        contract.aav_cents,
        contract.start_season_id,
        contract.status AS contract_status,
        contract.auction_buyout_lock_expires_at_ms,
        contract.version AS contract_version
      FROM player_ownerships AS ownership
      INNER JOIN players AS player
        ON player.id = ownership.player_id
      LEFT JOIN contracts AS contract
        ON contract.league_id = ownership.league_id
        AND contract.player_id = ownership.player_id
        AND contract.status = 'active'
      WHERE ownership.league_id = @leagueId
        AND ownership.season_id = @seasonId
      ORDER BY ownership.team_id ASC, ownership.roster_category ASC,
        ownership.position_group ASC, ownership.slot_number ASC,
        player.full_name ASC
    `);
    workspaceContractYearsStatement = database.prepare(`
      SELECT
        year.id,
        year.contract_id,
        year.season_id,
        year.year_number,
        year.aav_cents,
        year.status,
        year.rollover_at_ms
      FROM contract_years AS year
      INNER JOIN contracts AS contract
        ON contract.league_id = year.league_id
        AND contract.id = year.contract_id
      WHERE year.league_id = @leagueId
        AND contract.status = 'active'
      ORDER BY year.contract_id ASC, year.year_number ASC
    `);
    workspaceFreeAgentsStatement = database.prepare(`
      SELECT
        player.id AS player_id,
        player.full_name,
        player.birth_date,
        COALESCE(
          (
            SELECT position.position_group
            FROM league_player_positions AS position
            WHERE position.league_id = @leagueId
              AND position.player_id = player.id
              AND position.ended_at_ms IS NULL
            LIMIT 1
          ),
          (
            SELECT source.normalized_position
            FROM player_source_state AS source
            WHERE source.player_id = player.id
              AND source.ended_at_ms IS NULL
            ORDER BY
              CASE source.provider
                WHEN 'sportsdataio-discovery-lab' THEN 0
                WHEN 'release_qa' THEN 1
                ELSE 2
              END,
              source.effective_at_ms DESC
            LIMIT 1
          )
        ) AS effective_position,
        (
          SELECT source.provider
          FROM player_source_state AS source
          WHERE source.player_id = player.id
            AND source.ended_at_ms IS NULL
          ORDER BY
            CASE source.provider
              WHEN 'sportsdataio-discovery-lab' THEN 0
              WHEN 'release_qa' THEN 1
              ELSE 2
            END,
            source.effective_at_ms DESC
          LIMIT 1
        ) AS provider,
        (
          SELECT source.nhl_team_abbreviation
          FROM player_source_state AS source
          WHERE source.player_id = player.id
            AND source.ended_at_ms IS NULL
          ORDER BY
            CASE source.provider
              WHEN 'sportsdataio-discovery-lab' THEN 0
              WHEN 'release_qa' THEN 1
              ELSE 2
            END,
            source.effective_at_ms DESC
          LIMIT 1
        ) AS nhl_team_abbreviation
      FROM players AS player
      WHERE player.status = 'active'
        AND NOT EXISTS (
          SELECT 1
          FROM player_ownerships AS ownership
          WHERE ownership.league_id = @leagueId
            AND ownership.player_id = player.id
        )
      ORDER BY player.full_name ASC, player.id ASC
    `);
    providerCatalogCountStatement = database.prepare(`
      SELECT COUNT(*) AS count
      FROM player_external_ids
      WHERE provider = 'sportsdataio-discovery-lab'
    `);
    providerLatestAttemptStatement = database.prepare(`
      SELECT
        refresh.id,
        refresh.nhl_season_key,
        refresh.status,
        refresh.started_at_ms,
        refresh.completed_at_ms,
        refresh.player_count,
        refresh.error_code
      FROM stat_refreshes AS refresh
      INNER JOIN stat_sources AS source
        ON source.id = refresh.stat_source_id
      WHERE source.provider = 'sportsdataio-discovery-lab'
      ORDER BY refresh.started_at_ms DESC, refresh.id DESC
      LIMIT 1
    `);
    providerLatestSuccessStatement = database.prepare(`
      SELECT
        refresh.id,
        refresh.nhl_season_key,
        refresh.status,
        refresh.started_at_ms,
        refresh.completed_at_ms,
        refresh.player_count
      FROM stat_refreshes AS refresh
      INNER JOIN stat_sources AS source
        ON source.id = refresh.stat_source_id
      WHERE source.provider = 'sportsdataio-discovery-lab'
        AND refresh.status = 'succeeded'
      ORDER BY refresh.completed_at_ms DESC, refresh.id DESC
      LIMIT 1
    `);
    playerForAddStatement = database.prepare(`
      SELECT
        player.*,
        COALESCE(
          (
            SELECT position.position_group
            FROM league_player_positions AS position
            WHERE position.league_id = @leagueId
              AND position.player_id = player.id
              AND position.ended_at_ms IS NULL
            LIMIT 1
          ),
          (
            SELECT source.normalized_position
            FROM player_source_state AS source
            WHERE source.player_id = player.id
              AND source.ended_at_ms IS NULL
              AND source.active = 1
            ORDER BY
              CASE source.provider
                WHEN 'sportsdataio-discovery-lab' THEN 0
                WHEN 'release_qa' THEN 1
                ELSE 2
              END,
              source.effective_at_ms DESC
            LIMIT 1
          )
        ) AS effective_position
      FROM players AS player
      WHERE player.id = @playerId
        AND player.status = 'active'
      LIMIT 2
    `);
    ownershipByPlayerStatement = database.prepare(`
      SELECT *
      FROM player_ownerships
      WHERE league_id = @leagueId
        AND player_id = @playerId
      LIMIT 2
    `);
    activeContractByPlayerStatement = database.prepare(`
      SELECT *
      FROM contracts
      WHERE league_id = @leagueId
        AND player_id = @playerId
        AND status = 'active'
      LIMIT 2
    `);
    teamForAdjustmentStatement = database.prepare(`
      SELECT id, status
      FROM teams
      WHERE league_id = @leagueId
        AND id = @teamId
        AND status = 'active'
      LIMIT 2
    `);
    seasonScheduleStatement = database.prepare(`
      SELECT id, label, nhl_season_key, status
      FROM seasons
      WHERE league_id = @leagueId
        AND status IN ('active', 'planned')
      ORDER BY
        CASE WHEN id = @seasonId THEN 0 ELSE 1 END,
        COALESCE(regular_season_starts_at_ms, 9223372036854775807) ASC,
        label ASC,
        id ASC
      LIMIT 3
    `);
    removeDependencyStatement = database.prepare(`
      SELECT
        (
          SELECT COUNT(*)
          FROM trade_assets AS asset
          INNER JOIN trades AS trade
            ON trade.league_id = asset.league_id
            AND trade.id = asset.trade_id
          WHERE asset.league_id = @leagueId
            AND trade.status IN ('proposed', 'accepted')
            AND (
              asset.player_id = @playerId
              OR (
                @contractId IS NOT NULL
                AND asset.contract_id = @contractId
              )
            )
        )
        + (
          SELECT COUNT(*)
          FROM retention_obligations AS retention
          WHERE retention.league_id = @leagueId
            AND @contractId IS NOT NULL
            AND retention.contract_id = @contractId
            AND retention.status = 'active'
        )
        + (
          SELECT COUNT(*)
          FROM buyout_obligations AS buyout
          WHERE buyout.league_id = @leagueId
            AND @contractId IS NOT NULL
            AND buyout.contract_id = @contractId
            AND buyout.status = 'active'
        ) AS count
    `);
    deleteOwnershipStatement = database.prepare(`
      DELETE FROM player_ownerships
      WHERE league_id = @leagueId
        AND id = @ownershipId
        AND version = @expectedVersion
    `);
    eliminateContractYearsStatement = database.prepare(`
      UPDATE contract_years
      SET status = 'eliminated', rollover_at_ms = @occurredAtMs
      WHERE league_id = @leagueId
        AND contract_id = @contractId
        AND status IN ('current', 'future')
    `);
    findIdempotencyStatement = database.prepare(`
      SELECT *
      FROM idempotency_requests
      WHERE league_id = @leagueId
        AND actor_user_id = @actorUserId
        AND operation = @operation
        AND client_key = @key
      LIMIT 2
    `);
    insertIdempotencyStatement = database.prepare(`
      INSERT INTO idempotency_requests (
        id, league_id, actor_user_id, operation, client_key,
        request_hash, status, result_type, result_id,
        created_at_ms, completed_at_ms, expires_at_ms
      ) VALUES (
        @id, @leagueId, @actorUserId, @operation, @key,
        @requestHash, 'started', NULL, NULL,
        @occurredAtMs, NULL, @expiresAtMs
      )
    `);
    completeIdempotencyStatement = database.prepare(`
      UPDATE idempotency_requests
      SET status = 'completed',
        result_type = 'commissioner_correction',
        result_id = @correctionId,
        completed_at_ms = @occurredAtMs
      WHERE league_id = @leagueId
        AND id = @id
        AND status = 'started'
    `);
    replayCorrectionStatement = database.prepare(`
      SELECT *
      FROM commissioner_corrections
      WHERE league_id = @leagueId
        AND id = @correctionId
      LIMIT 2
    `);
    replayActivityStatement = database.prepare(`
      SELECT *
      FROM league_activity
      WHERE league_id = @leagueId
        AND json_extract(metadata_json, '$.correctionId') = @correctionId
      LIMIT 2
    `);

    addTransaction = database.transaction((request) =>
      executeRequest(request, executeRosterAddition)
    );
    removeTransaction = database.transaction((request) =>
      executeRequest(request, executeRosterRemoval)
    );
    rosterTransaction = database.transaction((request) =>
      executeRequest(request, executeRosterCorrection)
    );
    contractTransaction = database.transaction((request) =>
      executeRequest(request, executeContractCorrection)
    );
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareCommissionerCorrectionRepository",
      tableName: "commissioner_corrections",
    });
  }

  function requireUnique(rows, message) {
    if (rows.length > 1) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        message
      );
    }
    if (!rows[0]) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.recordNotFound,
        message
      );
    }
    return freezeRow(rows[0]);
  }

  function optionalUnique(rows, message) {
    if (rows.length > 1) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        message
      );
    }
    return freezeRow(rows[0]);
  }

  function policyFailure(reasonCode) {
    throw new CommissionerCorrectionPolicyError(reasonCode);
  }

  function requireAuthority(correction) {
    const rows = authorityStatement.all(correction);
    if (rows.length > 1) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "A league has multiple active commissioner authorities."
      );
    }
    return assertCommissionerAuthority(
      freezeRow(rows[0]),
      correction
    );
  }

  function readWorkspace(input) {
    try {
      requireAuthority(input);
      if (
        !Number.isSafeInteger(input.observedAtMs) ||
        input.observedAtMs < 0
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.argumentInvalid,
          "A safe provider-health observation time is required."
        );
      }
      const league = requireUnique(
        workspaceLeagueStatement.all(input),
        "The commissioner roster workspace league does not exist."
      );
      const scope = {
        ...input,
        seasonId: league.current_season_id,
      };
      const teams = workspaceTeamsStatement.all(scope);
      const seasons = seasonScheduleStatement.all(scope).map(
        (season, index) =>
          Object.freeze({
            id: season.id,
            label: season.label,
            nhlSeasonKey: season.nhl_season_key,
            status: season.status,
            sequence: index + 1,
          })
      );
      const yearsByContract = new Map();
      for (const year of workspaceContractYearsStatement.all(scope)) {
        const years = yearsByContract.get(year.contract_id) || [];
        years.push(Object.freeze({
          id: year.id,
          seasonId: year.season_id,
          yearNumber: year.year_number,
          aavCents: year.aav_cents,
          status: year.status,
          rolloverAtMs: year.rollover_at_ms,
        }));
        yearsByContract.set(year.contract_id, years);
      }
      const roster = workspaceRosterStatement.all(scope).map((row) =>
        Object.freeze({
          ownershipId: row.ownership_id,
          ownershipVersion: row.ownership_version,
          seasonId: row.season_id,
          playerId: row.player_id,
          teamId: row.team_id,
          ownershipKind: row.ownership_kind,
          rosterCategory: row.roster_category,
          positionGroup: row.position_group,
          slotNumber: row.slot_number,
          player: Object.freeze({
            id: row.player_id,
            fullName: row.full_name,
            birthDate: row.birth_date,
            status: row.player_status,
            effectivePosition: row.effective_position,
            provider: row.provider,
            nhlTeamAbbreviation: row.nhl_team_abbreviation,
          }),
          contract: row.contract_id === null
            ? null
            : Object.freeze({
                id: row.contract_id,
                version: row.contract_version,
                teamId: row.contract_team_id,
                type: row.contract_type,
                originalTotalValueCents:
                  row.original_total_value_cents,
                originalTermYears: row.original_term_years,
                aavCents: row.aav_cents,
                startSeasonId: row.start_season_id,
                status: row.contract_status,
                auctionBuyoutLockExpiresAtMs:
                  row.auction_buyout_lock_expires_at_ms,
                years: Object.freeze(
                  yearsByContract.get(row.contract_id) || []
                ),
              }),
        })
      );
      const freeAgents = workspaceFreeAgentsStatement
        .all(scope)
        .filter((row) => ["F", "D"].includes(row.effective_position))
        .map((row) =>
          Object.freeze({
            playerId: row.player_id,
            fullName: row.full_name,
            birthDate: row.birth_date,
            effectivePosition: row.effective_position,
            provider: row.provider,
            nhlTeamAbbreviation: row.nhl_team_abbreviation,
          })
        );
      const latestAttempt = providerLatestAttemptStatement.get() || null;
      const latestSuccess = providerLatestSuccessStatement.get() || null;
      const catalogPlayerCount =
        providerCatalogCountStatement.get()?.count || 0;
      return Object.freeze({
        league: Object.freeze({
          id: league.id,
          name: league.name,
          currentSeasonId: league.current_season_id,
          currentSeasonLabel: league.current_season_label,
          salaryCapCents: league.salary_cap_cents,
        }),
        teams: Object.freeze(
          teams.map((team) =>
            Object.freeze({
              id: team.id,
              name: team.name,
              status: team.status,
              version: team.version,
              cap: capRepository.calculate({
                leagueId: league.id,
                seasonId: league.current_season_id,
                teamId: team.id,
              }),
            })
          )
        ),
        seasons: Object.freeze(seasons),
        roster: Object.freeze(roster),
        freeAgents: Object.freeze(freeAgents),
        providerHealth: Object.freeze({
          provider: "sportsdataio-discovery-lab",
          dataScope: "last-season-only",
          staleAfterMs: 72 * 60 * 60 * 1000,
          catalogPlayerCount,
          lastAttempt: latestAttempt
            ? Object.freeze({
                id: latestAttempt.id,
                nhlSeasonKey: latestAttempt.nhl_season_key,
                status: latestAttempt.status,
                startedAtMs: latestAttempt.started_at_ms,
                completedAtMs: latestAttempt.completed_at_ms,
                playerCount: latestAttempt.player_count,
                errorCode: latestAttempt.error_code,
              })
            : null,
          lastSuccessfulImport: latestSuccess
            ? Object.freeze({
                id: latestSuccess.id,
                nhlSeasonKey: latestSuccess.nhl_season_key,
                status: latestSuccess.status,
                startedAtMs: latestSuccess.started_at_ms,
                completedAtMs: latestSuccess.completed_at_ms,
                playerCount: latestSuccess.player_count,
              })
            : null,
          stale:
            latestSuccess === null ||
            latestSuccess.completed_at_ms === null ||
            input.observedAtMs - latestSuccess.completed_at_ms >
              72 * 60 * 60 * 1000,
        }),
      });
    } catch (error) {
      if (error instanceof CommissionerCorrectionPolicyError) throw error;
      throw mapRepositoryError(error, {
        operation: "readCommissionerRosterWorkspace",
        tableName: "player_ownerships",
      });
    }
  }

  function teamEvaluation(correction, teamId) {
    const rows = rosterRowsStatement.all({
      leagueId: correction.leagueId,
      seasonId: correction.seasonId,
      teamId,
    });
    const legality = evaluateStructuralRosterLegality({
      leagueId: correction.leagueId,
      seasonId: correction.seasonId,
      teamId,
      assignments: rows.map((row) => ({
        leagueId: row.league_id,
        seasonId: row.season_id,
        teamId: row.team_id,
        playerId: row.player_id,
        rosterCategory: row.roster_category,
        assignedPositionGroup: row.position_group,
      })),
      effectivePositions: rows.map((row) => ({
        playerId: row.player_id,
        positionGroup: row.effective_position,
      })),
    });
    const cap = capRepository.calculate({
      leagueId: correction.leagueId,
      seasonId: correction.seasonId,
      teamId,
    });
    const warnings = [
      ...legality.reasons.map((reason) => ({
        ...reason,
        teamId,
      })),
      ...benchViolationStatement.all({
        leagueId: correction.leagueId,
        seasonId: correction.seasonId,
        teamId,
      }).map((row) => ({
        code: "BENCH_AAV_LIMIT_EXCEEDED",
        teamId,
        playerId: row.player_id,
      })),
      ...cap.issues.map((issue) => ({ ...issue, teamId })),
      ...(cap.overCap ? [{ code: "TEAM_OVER_CAP", teamId }] : []),
    ];
    return Object.freeze({
      teamId,
      legality,
      cap,
      warnings: freezeWarnings(warnings),
    });
  }

  function evaluateTeams(correction, teamIds) {
    const evaluations = Object.freeze(
      [...new Set(teamIds)].sort().map((teamId) =>
        teamEvaluation(correction, teamId)
      )
    );
    return Object.freeze({
      evaluations,
      warnings: freezeWarnings(
        evaluations.flatMap((evaluation) => evaluation.warnings)
      ),
    });
  }

  function insertCorrectionEvidence({
    correction,
    feature,
    featureRecordId,
    before,
    requested,
    authoritative,
    warnings,
    teamEvaluations,
  }) {
    return freezeRow(
      corrections.insert({
        id: correction.correctionId,
        league_id: correction.leagueId,
        season_id: correction.seasonId,
        feature,
        feature_record_id: featureRecordId,
        actor_user_id: correction.actorUserId,
        reason: correction.reason,
        before_snapshot_json: JSON.stringify(before),
        after_snapshot_json: correctionSnapshot({
          actorMembershipId: correction.actorMembershipId,
          actorAuthority: correction.actorAuthority,
          requested,
          authoritative,
          warnings,
          teamEvaluations,
          confirmed: correction.confirmWarnings,
        }),
        corrected_at_ms: correction.occurredAtMs,
      })
    );
  }

  function executeRosterAddition(correction, persist) {
    requireAuthority(correction);
    const league = requireUnique(
      workspaceLeagueStatement.all(correction),
      "The roster-add league does not exist."
    );
    if (league.current_season_id !== correction.seasonId) {
      policyFailure(COMMISSIONER_CORRECTION_CODES.scopeMismatch);
    }
    requireUnique(
      teamForAdjustmentStatement.all(correction),
      "The roster-add team does not exist."
    );
    const player = requireUnique(
      playerForAddStatement.all(correction),
      "The roster-add player does not exist."
    );
    if (!["F", "D"].includes(player.effective_position)) {
      policyFailure(COMMISSIONER_CORRECTION_CODES.rosterInvalid);
    }
    if (
      optionalUnique(
        ownershipByPlayerStatement.all(correction),
        "A player has multiple league ownerships."
      ) ||
      optionalUnique(
        activeContractByPlayerStatement.all(correction),
        "A player has multiple active league contracts."
      )
    ) {
      policyFailure(COMMISSIONER_CORRECTION_CODES.dependencyConflict);
    }
    const schedule = seasonScheduleStatement.all(correction);
    if (
      schedule[0]?.id !== correction.seasonId ||
      (
        correction.contractId !== null &&
        schedule.length < correction.termYears
      )
    ) {
      policyFailure(COMMISSIONER_CORRECTION_CODES.scheduleInvalid);
    }

    const ownership = freezeRow(
      ownerships.insert({
        id: correction.ownershipId,
        league_id: correction.leagueId,
        season_id: correction.seasonId,
        player_id: correction.playerId,
        team_id: correction.teamId,
        ownership_kind: correction.ownershipKind,
        roster_category: correction.rosterCategory,
        position_group: correction.positionGroup,
        slot_number: correction.slotNumber,
        acquired_transaction_type: "commissioner_correction",
        acquired_transaction_id: correction.correctionId,
        created_at_ms: correction.occurredAtMs,
        updated_at_ms: correction.occurredAtMs,
        version: 1,
      })
    );
    let contract = null;
    let years = Object.freeze([]);
    if (correction.contractId !== null) {
      contract = freezeRow(
        contracts.insert({
          id: correction.contractId,
          league_id: correction.leagueId,
          player_id: correction.playerId,
          current_team_id: correction.teamId,
          contract_type: correction.contractType,
          original_total_value_cents:
            correction.originalTotalValueCents,
          original_term_years: correction.termYears,
          aav_cents: correction.aavCents,
          start_season_id: correction.seasonId,
          status: "active",
          acquisition_source_type: "commissioner_correction",
          acquisition_source_id: correction.correctionId,
          auction_buyout_lock_expires_at_ms: null,
          created_at_ms: correction.occurredAtMs,
          updated_at_ms: correction.occurredAtMs,
          version: 1,
        })
      );
      years = freezeRows(
        correction.contractYearIds.map((id, index) =>
          contractYears.insert({
            id,
            league_id: correction.leagueId,
            contract_id: correction.contractId,
            season_id: schedule[index].id,
            year_number: index + 1,
            aav_cents: correction.aavCents,
            status: index === 0 ? "current" : "future",
            rollover_at_ms: null,
            created_at_ms: correction.occurredAtMs,
          })
        )
      );
    }
    const requested = Object.freeze({
      playerId: correction.playerId,
      teamId: correction.teamId,
      rosterCategory: correction.rosterCategory,
      positionGroup: correction.positionGroup,
      slotNumber: correction.slotNumber,
      contractType: correction.contractType,
      originalTotalValueCents: correction.originalTotalValueCents,
      termYears: correction.termYears,
      aavCents: correction.aavCents,
    });
    const authoritative = Object.freeze({
      ownership: rosterSnapshot(ownership),
      contract: contract === null
        ? null
        : contractSnapshot(contract, years),
    });
    const evaluation = evaluateTeams(correction, [correction.teamId]);
    const extraWarnings = [
      ...(
        player.effective_position &&
        player.effective_position !== correction.positionGroup
          ? [{
              code: "PLAYER_POSITION_MISMATCH",
              teamId: correction.teamId,
              playerId: correction.playerId,
            }]
          : []
      ),
      ...(
        correction.rosterCategory === "Injured Reserve"
          ? [{
              code: "IR_ELIGIBILITY_REQUIRES_CONFIRMATION",
              teamId: correction.teamId,
              playerId: correction.playerId,
            }]
          : []
      ),
    ];
    const warnings = freezeWarnings([
      ...evaluation.warnings,
      ...extraWarnings,
    ]);
    if (persist) {
      assertWarningsConfirmed(warnings, correction.confirmWarnings);
    }

    let correctionRow = null;
    let ownershipEvent = null;
    let contractEvent = null;
    let activityRow = null;
    if (persist) {
      correctionRow = insertCorrectionEvidence({
        correction,
        feature: "roster_add",
        featureRecordId: ownership.id,
        before: null,
        requested,
        authoritative,
        warnings,
        teamEvaluations: evaluation.evaluations,
      });
      ownershipEvent = freezeRow(
        ownershipEvents.insert({
          id: correction.ownershipEventId,
          league_id: correction.leagueId,
          season_id: correction.seasonId,
          player_id: correction.playerId,
          team_id: correction.teamId,
          ownership_id: ownership.id,
          event_type: "commissioner_player_added",
          actor_user_id: correction.actorUserId,
          source_type: "commissioner_correction",
          source_id: correction.correctionId,
          before_metadata_json: null,
          after_metadata_json: JSON.stringify(authoritative),
          reason: correction.reason,
          occurred_at_ms: correction.occurredAtMs,
        })
      );
      if (contract !== null) {
        contractEvent = freezeRow(
          contractEvents.insert({
            id: correction.contractEventId,
            league_id: correction.leagueId,
            contract_id: contract.id,
            player_id: correction.playerId,
            team_id: correction.teamId,
            actor_user_id: correction.actorUserId,
            event_type: "commissioner_contract_created",
            source_type: "commissioner_correction",
            source_id: correction.correctionId,
            metadata_json: JSON.stringify(authoritative.contract),
            reason: correction.reason,
            occurred_at_ms: correction.occurredAtMs,
          })
        );
      }
      activityRow = freezeRow(
        activity.insert({
          id: correction.activityId,
          league_id: correction.leagueId,
          season_id: correction.seasonId,
          event_type: "commissioner_player_added",
          actor_user_id: correction.actorUserId,
          actor_authority: correction.actorAuthority,
          team_id: correction.teamId,
          player_id: correction.playerId,
          related_type: "player_ownership",
          related_id: ownership.id,
          display_summary: "Commissioner added a player to a team.",
          reason: correction.reason,
          metadata_json: JSON.stringify({
            correctionId: correction.correctionId,
            actorMembershipId: correction.actorMembershipId,
            authoritative,
            warnings,
          }),
          occurred_at_ms: correction.occurredAtMs,
        })
      );
    }
    return Object.freeze({
      preview: !persist,
      before: null,
      requested,
      authoritative,
      warnings,
      teamEvaluations: evaluation.evaluations,
      correction: correctionRow,
      ownershipEvent,
      contractEvent,
      activity: activityRow,
    });
  }

  function executeRosterRemoval(correction, persist) {
    requireAuthority(correction);
    const current = requireUnique(
      ownershipStatement.all(correction),
      "The removed roster ownership does not exist."
    );
    assertCurrentRecord(current, correction, "roster");
    const activeContract = optionalUnique(
      activeContractByPlayerStatement.all(correction),
      "A player has multiple active league contracts."
    );
    if (
      (activeContract === null) !== (correction.contractId === null) ||
      (
        activeContract !== null &&
        (
          activeContract.id !== correction.contractId ||
          activeContract.player_id !== correction.playerId ||
          activeContract.current_team_id !== current.team_id
        )
      )
    ) {
      policyFailure(COMMISSIONER_CORRECTION_CODES.scopeMismatch);
    }
    if (
      activeContract !== null &&
      activeContract.version !== correction.expectedContractVersion
    ) {
      policyFailure(COMMISSIONER_CORRECTION_CODES.sourceChanged);
    }
    assertNoDependentTransactions(
      removeDependencyStatement.get(correction).count
    );

    const currentYears = activeContract === null
      ? Object.freeze([])
      : freezeRows(contractYearsStatement.all(correction));
    const before = Object.freeze({
      ownership: rosterSnapshot(current),
      contract: activeContract === null
        ? null
        : contractSnapshot(activeContract, currentYears),
    });
    let correctedContract = null;
    let correctedYears = Object.freeze([]);
    if (activeContract !== null) {
      correctedContract = freezeRow(
        contracts.updateVersioned({
          key: activeContract.id,
          leagueId: correction.leagueId,
          expectedVersion: correction.expectedContractVersion,
          changes: {
            status: "cancelled",
            updated_at_ms: correction.occurredAtMs,
          },
        })
      );
      eliminateContractYearsStatement.run(correction);
      correctedYears = freezeRows(
        contractYearsStatement.all(correction)
      );
    }
    const deleted = deleteOwnershipStatement.run(correction);
    if (deleted.changes !== 1) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.versionConflict,
        "The roster ownership changed before removal."
      );
    }
    const requested = Object.freeze({
      playerId: correction.playerId,
      owned: false,
      cancelActiveContract: activeContract !== null,
    });
    const authoritative = Object.freeze({
      ownership: null,
      contract: correctedContract === null
        ? null
        : contractSnapshot(correctedContract, correctedYears),
    });
    const evaluation = evaluateTeams(correction, [current.team_id]);
    if (persist) {
      assertWarningsConfirmed(
        evaluation.warnings,
        correction.confirmWarnings
      );
    }

    let correctionRow = null;
    let ownershipEvent = null;
    let contractEvent = null;
    let activityRow = null;
    if (persist) {
      correctionRow = insertCorrectionEvidence({
        correction,
        feature: "roster_remove",
        featureRecordId: current.id,
        before,
        requested,
        authoritative,
        warnings: evaluation.warnings,
        teamEvaluations: evaluation.evaluations,
      });
      ownershipEvent = freezeRow(
        ownershipEvents.insert({
          id: correction.ownershipEventId,
          league_id: correction.leagueId,
          season_id: correction.seasonId,
          player_id: correction.playerId,
          team_id: current.team_id,
          ownership_id: current.id,
          event_type: "commissioner_player_removed",
          actor_user_id: correction.actorUserId,
          source_type: "commissioner_correction",
          source_id: correction.correctionId,
          before_metadata_json: JSON.stringify(before),
          after_metadata_json: JSON.stringify(authoritative),
          reason: correction.reason,
          occurred_at_ms: correction.occurredAtMs,
        })
      );
      if (correctedContract !== null) {
        contractEvent = freezeRow(
          contractEvents.insert({
            id: correction.contractEventId,
            league_id: correction.leagueId,
            contract_id: correctedContract.id,
            player_id: correction.playerId,
            team_id: current.team_id,
            actor_user_id: correction.actorUserId,
            event_type: "commissioner_contract_cancelled",
            source_type: "commissioner_correction",
            source_id: correction.correctionId,
            metadata_json: JSON.stringify({
              before: before.contract,
              after: authoritative.contract,
            }),
            reason: correction.reason,
            occurred_at_ms: correction.occurredAtMs,
          })
        );
      }
      activityRow = freezeRow(
        activity.insert({
          id: correction.activityId,
          league_id: correction.leagueId,
          season_id: correction.seasonId,
          event_type: "commissioner_player_removed",
          actor_user_id: correction.actorUserId,
          actor_authority: correction.actorAuthority,
          team_id: current.team_id,
          player_id: correction.playerId,
          related_type: "player_ownership",
          related_id: current.id,
          display_summary: "Commissioner removed a player from a team.",
          reason: correction.reason,
          metadata_json: JSON.stringify({
            correctionId: correction.correctionId,
            actorMembershipId: correction.actorMembershipId,
            before,
            authoritative,
            warnings: evaluation.warnings,
          }),
          occurred_at_ms: correction.occurredAtMs,
        })
      );
    }
    return Object.freeze({
      preview: !persist,
      before,
      requested,
      authoritative,
      warnings: evaluation.warnings,
      teamEvaluations: evaluation.evaluations,
      correction: correctionRow,
      ownershipEvent,
      contractEvent,
      activity: activityRow,
    });
  }

  function executeRosterCorrection(correction, persist) {
    requireAuthority(correction);
    assertNoDependentTransactions(
      rosterDependencyStatement.get(correction).count
    );
    const current = requireUnique(
      ownershipStatement.all(correction),
      "The corrected roster ownership does not exist."
    );
    assertCurrentRecord(current, correction, "roster");
    if (correction.correctedTeamId !== current.team_id) {
      policyFailure(COMMISSIONER_CORRECTION_CODES.scopeMismatch);
    }
    const activeContract = optionalUnique(
      activeContractByPlayerStatement.all(correction),
      "A player has multiple active league contracts."
    );
    if (
      activeContract !== null &&
      activeContract.current_team_id !== current.team_id
    ) {
      policyFailure(COMMISSIONER_CORRECTION_CODES.scopeMismatch);
    }
    const correctedOwnershipKind =
      activeContract === null ? "Prospect Right" : "Rostered";
    if (
      correction.correctedOwnershipKind !== correctedOwnershipKind ||
      (
        activeContract === null &&
        correction.correctedRosterCategory !== "Prospect"
      )
    ) {
      policyFailure(COMMISSIONER_CORRECTION_CODES.rosterInvalid);
    }
    const before = rosterSnapshot(current);
    const requested = requestedRosterValues(correction);
    assertCorrectionChanged(rosterValues(current), requested);
    const updated = freezeRow(
      ownerships.updateVersioned({
        key: current.id,
        leagueId: correction.leagueId,
        expectedVersion: correction.expectedVersion,
        changes: {
          team_id: correction.correctedTeamId,
          ownership_kind: correction.correctedOwnershipKind,
          roster_category: correction.correctedRosterCategory,
          position_group: correction.correctedPositionGroup,
          slot_number: correction.correctedSlotNumber,
          updated_at_ms: correction.occurredAtMs,
        },
      })
    );
    const after = rosterSnapshot(updated);
    const evaluation = evaluateTeams(correction, [
      current.team_id,
      updated.team_id,
    ]);
    const warnings = freezeWarnings([
      ...evaluation.warnings,
      ...(
        current.roster_category !== "Injured Reserve" &&
        updated.roster_category === "Injured Reserve"
          ? [{
              code: "IR_ELIGIBILITY_REQUIRES_CONFIRMATION",
              teamId: updated.team_id,
              playerId: updated.player_id,
            }]
          : []
      ),
      ...(
        ["Bench", "Injured Reserve"].includes(
          current.roster_category
        ) &&
        ["Bench", "Injured Reserve"].includes(
          updated.roster_category
        ) &&
        current.roster_category !== updated.roster_category
          ? [{
              code: "NON_STANDARD_ROSTER_SEQUENCE",
              teamId: updated.team_id,
              playerId: updated.player_id,
            }]
          : []
      ),
      ...(
        current.roster_category !== "Prospect" &&
        updated.roster_category === "Prospect"
          ? [{
              code: "PROSPECT_STATUS_REQUIRES_CORRECTION_CONFIRMATION",
              teamId: updated.team_id,
              playerId: updated.player_id,
            }]
          : []
      ),
    ]);
    if (persist) {
      assertWarningsConfirmed(
        warnings,
        correction.confirmWarnings
      );
    }

    let correctionRow = null;
    let ownershipEvent = null;
    let activityRow = null;
    if (persist) {
      correctionRow = insertCorrectionEvidence({
        correction,
        feature: "roster",
        featureRecordId: current.id,
        before,
        requested,
        authoritative: after,
        warnings,
        teamEvaluations: evaluation.evaluations,
      });
      ownershipEvent = freezeRow(
        ownershipEvents.insert({
          id: correction.ownershipEventId,
          league_id: correction.leagueId,
          season_id: correction.seasonId,
          player_id: correction.playerId,
          team_id: updated.team_id,
          ownership_id: current.id,
          event_type: "commissioner_roster_corrected",
          actor_user_id: correction.actorUserId,
          source_type: "commissioner_correction",
          source_id: correction.correctionId,
          before_metadata_json: JSON.stringify(before),
          after_metadata_json: JSON.stringify(after),
          reason: correction.reason,
          occurred_at_ms: correction.occurredAtMs,
        })
      );
      activityRow = freezeRow(
        activity.insert({
          id: correction.activityId,
          league_id: correction.leagueId,
          season_id: correction.seasonId,
          event_type: "commissioner_roster_corrected",
          actor_user_id: correction.actorUserId,
          actor_authority: correction.actorAuthority,
          team_id: updated.team_id,
          player_id: correction.playerId,
          related_type: "player_ownership",
          related_id: current.id,
          display_summary: "Commissioner corrected a roster assignment.",
          reason: correction.reason,
          metadata_json: JSON.stringify({
            correctionId: correction.correctionId,
            actorMembershipId: correction.actorMembershipId,
            before,
            after,
            warnings,
          }),
          occurred_at_ms: correction.occurredAtMs,
        })
      );
    }
    return Object.freeze({
      preview: !persist,
      before,
      requested,
      authoritative: after,
      warnings,
      teamEvaluations: evaluation.evaluations,
      correction: correctionRow,
      ownershipEvent,
      activity: activityRow,
    });
  }

  function replaceContractYears(correction, currentYears) {
    const correctedIds = new Set(
      correction.correctedYears.map((year) => year.id)
    );
    for (const current of currentYears) {
      if (
        current.year_number <= correction.correctedOriginalTermYears &&
        correction.correctedYears[current.year_number - 1].id !== current.id
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.argumentInvalid,
          "A contract correction must preserve each existing contract-year ID."
        );
      }
    }
    deleteContractYearsStatement.run(correction);
    const omittedYears = currentYears.filter(
      (year) => !correctedIds.has(year.id)
    );
    return freezeRows(
      [
        ...correction.correctedYears.map((year) => ({
          id: year.id,
          league_id: correction.leagueId,
          contract_id: correction.contractId,
          season_id: year.seasonId,
          year_number: year.yearNumber,
          aav_cents: correction.correctedAavCents,
          status: year.status,
          rollover_at_ms: year.rolloverAtMs,
          created_at_ms:
            currentYears.find((current) => current.id === year.id)
              ?.created_at_ms ?? correction.occurredAtMs,
        })),
        ...omittedYears.map((year) => ({
          ...year,
          aav_cents: correction.correctedAavCents,
          status: "eliminated",
          rollover_at_ms: correction.occurredAtMs,
        })),
      ]
        .sort((left, right) => left.year_number - right.year_number)
        .map((year) => contractYears.insert(year))
    );
  }

  function executeContractCorrection(correction, persist) {
    requireAuthority(correction);
    assertNoDependentTransactions(
      contractDependencyStatement.get(correction).count
    );
    const current = requireUnique(
      contractStatement.all(correction),
      "The corrected contract does not exist."
    );
    assertCurrentRecord(current, correction, "contract");
    if (
      correction.correctedTeamId !== current.current_team_id ||
      correction.correctedContractType !== current.contract_type ||
      correction.correctedStartSeasonId !== current.start_season_id ||
      correction.correctedStatus !== current.status ||
      correction.correctedAuctionBuyoutLockExpiresAtMs !==
        current.auction_buyout_lock_expires_at_ms
    ) {
      policyFailure(COMMISSIONER_CORRECTION_CODES.scopeMismatch);
    }
    const currentYears = freezeRows(
      contractYearsStatement.all(correction)
    );
    const before = contractSnapshot(current, currentYears);
    const requested = requestedContractValues(correction);
    assertCorrectionChanged(contractValues(current, currentYears), requested);
    const updated = freezeRow(
      contracts.updateVersioned({
        key: current.id,
        leagueId: correction.leagueId,
        expectedVersion: correction.expectedVersion,
        changes: {
          current_team_id: correction.correctedTeamId,
          contract_type: correction.correctedContractType,
          original_total_value_cents:
            correction.correctedOriginalTotalValueCents,
          original_term_years: correction.correctedOriginalTermYears,
          aav_cents: correction.correctedAavCents,
          start_season_id: correction.correctedStartSeasonId,
          status: correction.correctedStatus,
          auction_buyout_lock_expires_at_ms:
            correction.correctedAuctionBuyoutLockExpiresAtMs,
          updated_at_ms: correction.occurredAtMs,
        },
      })
    );
    const updatedYears = replaceContractYears(correction, currentYears);
    const after = contractSnapshot(updated, updatedYears);
    const evaluation = evaluateTeams(correction, [
      current.current_team_id,
      updated.current_team_id,
    ]);
    if (persist) {
      assertWarningsConfirmed(
        evaluation.warnings,
        correction.confirmWarnings
      );
    }

    let correctionRow = null;
    let contractEvent = null;
    let activityRow = null;
    if (persist) {
      correctionRow = insertCorrectionEvidence({
        correction,
        feature: "contract",
        featureRecordId: current.id,
        before,
        requested,
        authoritative: after,
        warnings: evaluation.warnings,
        teamEvaluations: evaluation.evaluations,
      });
      contractEvent = freezeRow(
        contractEvents.insert({
          id: correction.contractEventId,
          league_id: correction.leagueId,
          contract_id: current.id,
          player_id: correction.playerId,
          team_id: updated.current_team_id,
          actor_user_id: correction.actorUserId,
          event_type: "commissioner_contract_corrected",
          source_type: "commissioner_correction",
          source_id: correction.correctionId,
          metadata_json: JSON.stringify({ before, after }),
          reason: correction.reason,
          occurred_at_ms: correction.occurredAtMs,
        })
      );
      activityRow = freezeRow(
        activity.insert({
          id: correction.activityId,
          league_id: correction.leagueId,
          season_id: correction.seasonId,
          event_type: "commissioner_contract_corrected",
          actor_user_id: correction.actorUserId,
          actor_authority: correction.actorAuthority,
          team_id: updated.current_team_id,
          player_id: correction.playerId,
          related_type: "contract",
          related_id: current.id,
          display_summary: "Commissioner corrected a contract.",
          reason: correction.reason,
          metadata_json: JSON.stringify({
            correctionId: correction.correctionId,
            actorMembershipId: correction.actorMembershipId,
            before,
            after,
            warnings: evaluation.warnings,
          }),
          occurred_at_ms: correction.occurredAtMs,
        })
      );
    }
    return Object.freeze({
      preview: !persist,
      before,
      requested,
      authoritative: after,
      warnings: evaluation.warnings,
      teamEvaluations: evaluation.evaluations,
      correction: correctionRow,
      contractEvent,
      activity: activityRow,
    });
  }

  function validateIdempotency(idempotency, correction, operation) {
    if (
      !idempotency ||
      typeof idempotency !== "object" ||
      Array.isArray(idempotency) ||
      !/^[a-f0-9-]{36}$/.test(idempotency.id || "") ||
      typeof idempotency.key !== "string" ||
      idempotency.key.length < 1 ||
      idempotency.key.length > 200 ||
      !/^[\x21-\x7e]+$/.test(idempotency.key) ||
      !/^[a-f0-9]{64}$/.test(idempotency.requestHash || "") ||
      !Number.isSafeInteger(idempotency.expiresAtMs) ||
      idempotency.expiresAtMs <= correction.occurredAtMs
    ) {
      policyFailure(COMMISSIONER_CORRECTION_CODES.inputInvalid);
    }
    return Object.freeze({
      ...idempotency,
      operation,
      leagueId: correction.leagueId,
      actorUserId: correction.actorUserId,
      occurredAtMs: correction.occurredAtMs,
      correctionId: correction.correctionId,
    });
  }

  function replayIdempotentResult(correction, idempotencyRow) {
    const correctionRow = requireUnique(
      replayCorrectionStatement.all({
        leagueId: correction.leagueId,
        correctionId: idempotencyRow.result_id,
      }),
      "The idempotent correction result does not exist."
    );
    const activityRow = requireUnique(
      replayActivityStatement.all({
        leagueId: correction.leagueId,
        correctionId: idempotencyRow.result_id,
      }),
      "The idempotent correction activity does not exist."
    );
    let snapshot;
    let before;
    try {
      snapshot = JSON.parse(correctionRow.after_snapshot_json);
      before = JSON.parse(correctionRow.before_snapshot_json);
    } catch {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The idempotent correction snapshot is invalid."
      );
    }
    return Object.freeze({
      preview: false,
      replayed: true,
      before,
      requested: snapshot.requested,
      authoritative: snapshot.authoritative,
      warnings: freezeWarnings(snapshot.warnings || []),
      teamEvaluations: Object.freeze(
        (snapshot.teamEvaluations || []).map((evaluation) =>
          Object.freeze(evaluation)
        )
      ),
      correction: correctionRow,
      activity: activityRow,
    });
  }

  function executeRequest(request, executor) {
    if (!request.persist) {
      throw new PreviewRollback(
        executor(request.correction, false)
      );
    }
    const idempotency = validateIdempotency(
      request.idempotency,
      request.correction,
      request.operation
    );
    const rows = findIdempotencyStatement.all(idempotency);
    if (rows.length > 1) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "Commissioner-correction idempotency is not unique."
      );
    }
    if (rows[0]) {
      const current = rows[0];
      if (
        current.request_hash !== idempotency.requestHash ||
        current.status !== "completed" ||
        current.result_type !== "commissioner_correction" ||
        !current.result_id
      ) {
        policyFailure(
          COMMISSIONER_CORRECTION_CODES.idempotencyConflict
        );
      }
      return replayIdempotentResult(request.correction, current);
    }
    insertIdempotencyStatement.run(idempotency);
    const result = executor(request.correction, true);
    if (completeIdempotencyStatement.run(idempotency).changes !== 1) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.versionConflict,
        "Commissioner-correction idempotency could not be completed."
      );
    }
    return result;
  }

  function run(
    transaction,
    correction,
    persist,
    operation,
    idempotency = null
  ) {
    try {
      return transaction.immediate({
        correction,
        persist,
        operation,
        idempotency,
      });
    } catch (error) {
      if (error instanceof PreviewRollback) return error.result;
      if (error instanceof CommissionerCorrectionPolicyError) throw error;
      throw mapRepositoryError(error, {
        operation,
        tableName: "commissioner_corrections",
      });
    }
  }

  return Object.freeze({
    readWorkspace,
    previewAdd(input) {
      return run(
        addTransaction,
        validateRosterAddition(input),
        false,
        "previewCommissionerRosterAdd"
      );
    },
    applyAdd(input, idempotency) {
      return run(
        addTransaction,
        validateRosterAddition(input),
        true,
        "commissioner_roster_add",
        idempotency
      );
    },
    previewRemove(input) {
      return run(
        removeTransaction,
        validateRosterRemoval(input),
        false,
        "previewCommissionerRosterRemove"
      );
    },
    applyRemove(input, idempotency) {
      return run(
        removeTransaction,
        validateRosterRemoval(input),
        true,
        "commissioner_roster_remove",
        idempotency
      );
    },
    previewRoster(input) {
      return run(
        rosterTransaction,
        validateRosterCorrection(input),
        false,
        "previewRosterCorrection"
      );
    },
    applyRoster(input, idempotency) {
      return run(
        rosterTransaction,
        validateRosterCorrection(input),
        true,
        "commissioner_roster_correction",
        idempotency
      );
    },
    previewContract(input) {
      return run(
        contractTransaction,
        validateContractCorrection(input),
        false,
        "previewContractCorrection"
      );
    },
    applyContract(input, idempotency) {
      return run(
        contractTransaction,
        validateContractCorrection(input),
        true,
        "commissioner_contract_correction",
        idempotency
      );
    },
  });
}

module.exports = { createSqliteCommissionerCorrectionRepository };
