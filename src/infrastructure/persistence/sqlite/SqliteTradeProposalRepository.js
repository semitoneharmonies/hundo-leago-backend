const crypto = require("node:crypto");

const {
  TRADE_ASSET_CODES,
  TradeAssetPolicyError,
  assertSnapshot,
  validateTradeProposalCreationCommand,
} = require("../../../domain/trades/tradeAssetPolicy");
const {
  TradeProposalFoundationPolicyError,
  assertTradeProposalFoundationState,
  projectTradeProposalRow,
} = require("../../../domain/trades/tradeProposalPolicy");
const {
  TRADE_LIFECYCLE_CODES,
  TradeLifecyclePolicyError,
  assertTradeAcceptancePreviewState,
  assertTradeLifecycleState,
  expectedManagerTeamId,
  validateTradeAcceptancePreviewCommand,
  validateTradeLifecycleCommand,
} = require("../../../domain/trades/tradeLifecyclePolicy");
const {
  TRADE_EXECUTION_CODES,
  TradeExecutionPolicyError,
  assertTradeExecutionState,
  validateTradeExecutionCommand,
} = require("../../../domain/trades/tradeExecutionPolicy");
const {
  createSocketInvalidation,
} = require("../../../domain/leagues/socketInvalidation");
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");
const {
  createSqliteRecordRepository,
} = require("./createSqliteRecordRepository");
const {
  getRepositoryDefinition,
} = require("./repositoryCatalog");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPERATION = "trade.propose";

function stableId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A canonical stable identifier is required."
    );
  }
  return value;
}

function freezeRow(row) {
  return row ? Object.freeze({ ...row }) : null;
}

function policyFail(reasonCode) {
  throw new TradeAssetPolicyError(reasonCode);
}

function createRequestHash(command) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        leagueId: command.leagueId,
        seasonId: command.seasonId,
        proposingTeamId: command.proposingTeamId,
        receivingTeamId: command.receivingTeamId,
        actorUserId: command.actorUserId,
        actorMembershipId: command.actorMembershipId,
        actorAuthority: command.actorAuthority,
        assets: command.assets.map(({ id, createdAtMs, ...asset }) => asset),
      }),
      "utf8"
    )
    .digest("hex");
}

function createLifecycleRequestHash(command) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        leagueId: command.leagueId,
        tradeId: command.tradeId,
        action: command.action,
        actorUserId: command.actorUserId,
        actorMembershipId: command.actorMembershipId,
        actorAuthority: command.actorAuthority,
      }),
      "utf8"
    )
    .digest("hex");
}

function createExecutionRequestHash(command) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        leagueId: command.leagueId,
        tradeId: command.tradeId,
        actorUserId: command.actorUserId,
        actorMembershipId: command.actorMembershipId,
        actorAuthority: command.actorAuthority,
      }),
      "utf8"
    )
    .digest("hex");
}

function deterministicUuid(value) {
  const hex = crypto.createHash("sha256").update(value, "utf8").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-` +
    `8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function lifecycleStorageStatus(action) {
  return action === "reject" ? "declined" : "cancelled";
}

function lifecycleEventType(action) {
  return action === "reject" ? "proposal_rejected" : "proposal_cancelled";
}

function createSqliteTradeProposalRepository({ database } = {}) {
  let activityRepository;
  let notificationsRepository;
  let outboxRepository;
  let listReceivingManagersStatement;
  let loadFoundationStateStatement;
  let listVisibleStatement;
  let findVisibleDetailStatement;
  let findIdempotencyStatement;
  let insertIdempotencyStatement;
  let completeIdempotencyStatement;
  let insertTradeStatement;
  let insertAssetStatement;
  let insertEventStatement;
  let findTradeStatement;
  let listTradeAssetsStatement;
  let listTradeEventsStatement;
  let findTradeEventStatement;
  let findContractStatement;
  let listContractYearsStatement;
  let findProspectStatement;
  let findDraftPickStatement;
  let findRetentionStatement;
  let listRetentionYearsStatement;
  let findBuyoutStatement;
  let listBuyoutYearsStatement;
  let findFutureConsiderationStatement;
  let summarizeContractRetentionStatement;
  let countTeamRetentionSlotsStatement;
  let findTeamContractRetentionStatement;
  let findLifecycleParticipantsStatement;
  let loadLifecycleStateStatement;
  let findLifecycleIdempotencyStatement;
  let insertLifecycleIdempotencyStatement;
  let updateLifecycleTradeStatement;
  let insertLifecycleEventStatement;
  let findLifecycleEventStatement;
  let loadAcceptanceSettingsStatement;
  let listAcceptanceRosterStatement;
  let listAcceptanceRetentionsStatement;
  let listAcceptanceBuyoutsStatement;
  let updateExecutionTradeStatement;
  let updateExecutionOwnershipStatement;
  let updateExecutionContractStatement;
  let insertExecutionOwnershipEventStatement;
  let insertExecutionContractEventStatement;
  let updateExecutionDraftPickStatement;
  let insertExecutionDraftPickEventStatement;
  let updateExecutionRetentionStatement;
  let updateExecutionBuyoutStatement;
  let insertExecutionRetentionStatement;
  let insertExecutionRetentionYearStatement;
  let insertExecutionFutureConsiderationStatement;
  let updateExecutionFutureConsiderationStatement;
  let resolveExecutionFutureConsiderationStatement;
  let listConflictingTradesStatement;
  let updateConflictingTradeStatement;
  let insertAutomaticCancellationEventStatement;
  let findExecutionEventStatement;
  try {
    activityRepository = createSqliteRecordRepository({
      database,
      definition: getRepositoryDefinition("league_activity"),
    });
    notificationsRepository = createSqliteRecordRepository({
      database,
      definition: getRepositoryDefinition("notifications"),
    });
    outboxRepository = createSqliteRecordRepository({
      database,
      definition: getRepositoryDefinition("outbox_events"),
    });
    listReceivingManagersStatement = database.prepare(`
      SELECT DISTINCT
        assignment.user_id,
        proposing_team.name AS proposing_team_name,
        receiving_team.name AS receiving_team_name
      FROM teams AS receiving_team
      INNER JOIN teams AS proposing_team
        ON proposing_team.league_id = receiving_team.league_id
       AND proposing_team.id = @proposingTeamId
      INNER JOIN team_manager_assignments AS assignment
        ON assignment.league_id = receiving_team.league_id
       AND assignment.team_id = receiving_team.id
       AND assignment.status = 'accepted'
       AND assignment.ended_at_ms IS NULL
      INNER JOIN league_memberships AS membership
        ON membership.id = assignment.membership_id
       AND membership.league_id = receiving_team.league_id
       AND membership.user_id = assignment.user_id
       AND membership.status = 'active'
       AND membership.ended_at_ms IS NULL
      INNER JOIN users
        ON users.id = assignment.user_id
       AND users.status = 'active'
      WHERE receiving_team.league_id = @leagueId
        AND receiving_team.id = @receivingTeamId
        AND receiving_team.status <> 'erased'
        AND assignment.user_id <> @actorUserId
      ORDER BY assignment.user_id ASC
    `);
    loadFoundationStateStatement = database.prepare(`
      SELECT
        leagues.status AS league_status,
        leagues.commissioner_membership_id AS commissioner_membership_id,
        leagues.current_season_id AS current_season_id,
        seasons.status AS season_status,
        league_settings.trade_deadline_at_ms AS trade_deadline_at_ms,
        proposing_team.status AS proposing_team_status,
        receiving_team.status AS receiving_team_status,
        league_memberships.permission_category AS membership_permission,
        league_memberships.status AS membership_status,
        team_manager_assignments.status AS assignment_status,
        team_manager_assignments.ended_at_ms AS assignment_ended_at_ms,
        entry_drafts.status AS entry_draft_status,
        entry_drafts.starts_at_ms AS trading_opens_at_ms
      FROM leagues
      LEFT JOIN seasons
        ON seasons.league_id = leagues.id
       AND seasons.id = leagues.current_season_id
      LEFT JOIN league_settings
        ON league_settings.league_id = leagues.id
      JOIN teams AS proposing_team
        ON proposing_team.league_id = leagues.id
       AND proposing_team.id = @proposingTeamId
      JOIN teams AS receiving_team
        ON receiving_team.league_id = leagues.id
       AND receiving_team.id = @receivingTeamId
      LEFT JOIN league_memberships
        ON league_memberships.league_id = leagues.id
       AND league_memberships.id = @actorMembershipId
       AND league_memberships.user_id = @actorUserId
      LEFT JOIN team_manager_assignments
        ON team_manager_assignments.league_id = leagues.id
       AND team_manager_assignments.team_id = proposing_team.id
       AND team_manager_assignments.user_id = @actorUserId
       AND team_manager_assignments.membership_id = @actorMembershipId
       AND team_manager_assignments.status = 'accepted'
       AND team_manager_assignments.accepted_at_ms IS NOT NULL
       AND team_manager_assignments.ended_at_ms IS NULL
      LEFT JOIN entry_drafts
        ON entry_drafts.league_id = leagues.id
       AND entry_drafts.season_id = leagues.current_season_id
      WHERE leagues.id = @leagueId
      LIMIT 2
    `);
    listVisibleStatement = database.prepare(`
      SELECT
        trades.id AS trade_id,
        trades.league_id AS league_id,
        trades.season_id AS season_id,
        trades.proposing_team_id AS proposing_team_id,
        proposing_team.name AS proposing_team_name,
        trades.receiving_team_id AS receiving_team_id,
        receiving_team.name AS receiving_team_name,
        trades.proposing_user_id AS proposing_user_id,
        trades.status AS storage_status,
        trades.created_at_ms AS created_at_ms,
        trades.expires_at_ms AS expires_at_ms,
        trades.effective_deadline_at_ms AS persisted_effective_deadline_at_ms,
        league_settings.trade_deadline_at_ms AS trade_deadline_at_ms,
        trades.responded_at_ms AS responded_at_ms,
        trades.completed_at_ms AS completed_at_ms,
        trades.commissioner_completion_reference
          AS commissioner_completion_reference,
        trades.version AS version
      FROM trades
      JOIN teams AS proposing_team
        ON proposing_team.league_id = trades.league_id
       AND proposing_team.id = trades.proposing_team_id
      JOIN teams AS receiving_team
        ON receiving_team.league_id = trades.league_id
       AND receiving_team.id = trades.receiving_team_id
      LEFT JOIN league_settings
        ON league_settings.league_id = trades.league_id
      WHERE trades.league_id = @leagueId
        AND EXISTS (
          SELECT 1
          FROM league_memberships
          JOIN users ON users.id = league_memberships.user_id
          JOIN leagues ON leagues.id = league_memberships.league_id
          WHERE league_memberships.league_id = trades.league_id
            AND league_memberships.id = @viewerMembershipId
            AND league_memberships.user_id = @viewerUserId
            AND league_memberships.status = 'active'
            AND users.status = 'active'
            AND leagues.status <> 'deleted'
        )
      ORDER BY trades.created_at_ms DESC, trades.id ASC
    `);
    findVisibleDetailStatement = database.prepare(`
      SELECT
        trades.id AS trade_id,
        trades.league_id AS league_id,
        trades.season_id AS season_id,
        trades.proposing_team_id AS proposing_team_id,
        proposing_team.name AS proposing_team_name,
        trades.receiving_team_id AS receiving_team_id,
        receiving_team.name AS receiving_team_name,
        trades.proposing_user_id AS proposing_user_id,
        trades.status AS storage_status,
        trades.created_at_ms AS created_at_ms,
        trades.expires_at_ms AS expires_at_ms,
        trades.effective_deadline_at_ms AS persisted_effective_deadline_at_ms,
        league_settings.trade_deadline_at_ms AS trade_deadline_at_ms,
        trades.responded_at_ms AS responded_at_ms,
        trades.completed_at_ms AS completed_at_ms,
        trades.commissioner_completion_reference
          AS commissioner_completion_reference,
        trades.version AS version
      FROM trades
      JOIN teams AS proposing_team
        ON proposing_team.league_id = trades.league_id
       AND proposing_team.id = trades.proposing_team_id
      JOIN teams AS receiving_team
        ON receiving_team.league_id = trades.league_id
       AND receiving_team.id = trades.receiving_team_id
      LEFT JOIN league_settings
        ON league_settings.league_id = trades.league_id
      WHERE trades.league_id = @leagueId
        AND trades.id = @tradeId
      LIMIT 2
    `);
    findIdempotencyStatement = database.prepare(`
      SELECT *
      FROM idempotency_requests
      WHERE league_id = @leagueId
        AND actor_user_id = @actorUserId
        AND operation = '${OPERATION}'
        AND client_key = @idempotencyKey
      LIMIT 2
    `);
    insertIdempotencyStatement = database.prepare(`
      INSERT INTO idempotency_requests (
        id, league_id, actor_user_id, operation, client_key,
        request_hash, status, result_type, result_id,
        created_at_ms, completed_at_ms, expires_at_ms
      ) VALUES (
        @idempotencyRequestId, @leagueId, @actorUserId, '${OPERATION}',
        @idempotencyKey, @requestHash, 'started', NULL, NULL,
        @createdAtMs, NULL, @idempotencyExpiresAtMs
      )
    `);
    completeIdempotencyStatement = database.prepare(`
      UPDATE idempotency_requests
      SET status = 'completed', result_type = 'trade', result_id = @tradeId,
        completed_at_ms = @createdAtMs
      WHERE id = @idempotencyRequestId
        AND league_id = @leagueId
        AND status = 'started'
    `);
    insertTradeStatement = database.prepare(`
      INSERT INTO trades (
        id, league_id, season_id, proposing_team_id, receiving_team_id,
        proposing_user_id, creating_membership_id, creating_authority,
        status, created_at_ms, expires_at_ms, effective_deadline_at_ms,
        responded_at_ms, completed_at_ms, commissioner_completion_reference,
        proposal_model_version, updated_at_ms, version
      ) VALUES (
        @tradeId, @leagueId, @seasonId, @proposingTeamId, @receivingTeamId,
        @actorUserId, @actorMembershipId, @actorAuthority,
        'proposed', @createdAtMs, @expiresAtMs, @effectiveDeadlineAtMs,
        NULL, NULL, NULL, 2, @createdAtMs, 1
      )
    `);
    insertAssetStatement = database.prepare(`
      INSERT INTO trade_assets (
        id, league_id, trade_id, direction, source_team_id,
        destination_team_id, asset_type, contract_id, player_id,
        draft_pick_id, retention_obligation_id, buyout_obligation_id,
        future_consideration_id, requested_retention_contract_id,
        requested_retention_cents, future_consideration_description,
        proposal_snapshot_json, asset_model_version, sequence, created_at_ms
      ) VALUES (
        @id, @leagueId, @tradeId, @direction, @sourceTeamId,
        @destinationTeamId, @assetType, @contractId, @playerId,
        @draftPickId, @retentionObligationId, @buyoutObligationId,
        @futureConsiderationId, @requestedRetentionContractId,
        @requestedRetentionCents, @futureConsiderationDescription,
        @proposalSnapshotJson, 2, @sequence, @createdAtMs
      )
    `);
    insertEventStatement = database.prepare(`
      INSERT INTO trade_events (
        id, league_id, season_id, trade_id, actor_user_id,
        event_type, reason, metadata_json, occurred_at_ms
      ) VALUES (
        @eventId, @leagueId, @seasonId, @tradeId, @actorUserId,
        'proposal_created', NULL, @eventMetadataJson, @createdAtMs
      )
    `);
    findTradeStatement = database.prepare(`
      SELECT * FROM trades
      WHERE league_id = @leagueId AND id = @tradeId
      LIMIT 2
    `);
    listTradeAssetsStatement = database.prepare(`
      SELECT * FROM trade_assets
      WHERE league_id = @leagueId AND trade_id = @tradeId
      ORDER BY sequence ASC
    `);
    listTradeEventsStatement = database.prepare(`
      SELECT
        id,
        actor_user_id,
        event_type,
        reason,
        metadata_json,
        occurred_at_ms
      FROM trade_events
      WHERE league_id = @leagueId AND trade_id = @tradeId
      ORDER BY occurred_at_ms ASC, id ASC
    `);
    findTradeEventStatement = database.prepare(`
      SELECT * FROM trade_events
      WHERE league_id = @leagueId
        AND trade_id = @tradeId
        AND event_type = 'proposal_created'
      LIMIT 2
    `);
    findContractStatement = database.prepare(`
      SELECT
        contracts.id AS contract_id,
        contracts.player_id AS player_id,
        contracts.current_team_id AS contract_team_id,
        contracts.contract_type AS contract_type,
        contracts.original_total_value_cents AS original_total_value_cents,
        contracts.original_term_years AS original_term_years,
        contracts.aav_cents AS aav_cents,
        contracts.start_season_id AS start_season_id,
        contracts.status AS contract_status,
        contracts.auction_buyout_lock_expires_at_ms
          AS auction_buyout_lock_expires_at_ms,
        contracts.version AS contract_version,
        players.full_name AS player_name,
        player_ownerships.id AS ownership_id,
        player_ownerships.season_id AS ownership_season_id,
        player_ownerships.team_id AS ownership_team_id,
        player_ownerships.ownership_kind AS ownership_kind,
        player_ownerships.roster_category AS roster_category,
        player_ownerships.position_group AS position_group,
        player_ownerships.slot_number AS slot_number,
        player_ownerships.version AS ownership_version
      FROM contracts
      JOIN players ON players.id = contracts.player_id
      LEFT JOIN player_ownerships
        ON player_ownerships.league_id = contracts.league_id
       AND player_ownerships.player_id = contracts.player_id
      WHERE contracts.league_id = @leagueId
        AND contracts.id = @contractId
      LIMIT 2
    `);
    listContractYearsStatement = database.prepare(`
      SELECT season_id, year_number, aav_cents, status
      FROM contract_years
      WHERE league_id = @leagueId AND contract_id = @contractId
      ORDER BY year_number ASC
    `);
    findProspectStatement = database.prepare(`
      SELECT
        player_ownerships.id AS ownership_id,
        player_ownerships.player_id AS player_id,
        player_ownerships.season_id AS ownership_season_id,
        player_ownerships.team_id AS ownership_team_id,
        player_ownerships.ownership_kind AS ownership_kind,
        player_ownerships.roster_category AS roster_category,
        player_ownerships.position_group AS position_group,
        player_ownerships.version AS ownership_version,
        players.full_name AS player_name,
        contracts.id AS contract_id,
        contracts.contract_type AS contract_type,
        contracts.current_team_id AS contract_team_id,
        contracts.aav_cents AS aav_cents,
        contracts.status AS contract_status,
        contracts.version AS contract_version
      FROM player_ownerships
      JOIN players ON players.id = player_ownerships.player_id
      LEFT JOIN contracts
        ON contracts.league_id = player_ownerships.league_id
       AND contracts.player_id = player_ownerships.player_id
       AND contracts.status = 'active'
      WHERE player_ownerships.league_id = @leagueId
        AND player_ownerships.player_id = @playerId
      LIMIT 2
    `);
    findDraftPickStatement = database.prepare(`
      SELECT
        draft_picks.*,
        entry_drafts.status AS draft_status,
        seasons.label AS target_season_label
      FROM draft_picks
      JOIN entry_drafts
        ON entry_drafts.league_id = draft_picks.league_id
       AND entry_drafts.id = draft_picks.draft_id
      JOIN seasons
        ON seasons.league_id = draft_picks.league_id
       AND seasons.id = draft_picks.target_season_id
      WHERE draft_picks.league_id = @leagueId
        AND draft_picks.id = @draftPickId
      LIMIT 2
    `);
    findRetentionStatement = database.prepare(`
      SELECT
        retention_obligations.*,
        contracts.original_total_value_cents,
        contracts.original_term_years,
        contracts.aav_cents,
        contracts.status AS contract_status,
        players.full_name AS player_name
      FROM retention_obligations
      JOIN contracts
        ON contracts.league_id = retention_obligations.league_id
       AND contracts.id = retention_obligations.contract_id
      JOIN players ON players.id = retention_obligations.player_id
      WHERE retention_obligations.league_id = @leagueId
        AND retention_obligations.id = @retentionObligationId
      LIMIT 2
    `);
    listRetentionYearsStatement = database.prepare(`
      SELECT season_id, retained_aav_cents, status
      FROM retention_years
      WHERE league_id = @leagueId
        AND retention_obligation_id = @retentionObligationId
      ORDER BY season_id ASC
    `);
    findBuyoutStatement = database.prepare(`
      SELECT
        buyout_obligations.*,
        players.full_name AS player_name
      FROM buyout_obligations
      JOIN players ON players.id = buyout_obligations.player_id
      WHERE buyout_obligations.league_id = @leagueId
        AND buyout_obligations.id = @buyoutObligationId
      LIMIT 2
    `);
    listBuyoutYearsStatement = database.prepare(`
      SELECT season_id, penalty_cents, status
      FROM buyout_years
      WHERE league_id = @leagueId
        AND buyout_obligation_id = @buyoutObligationId
      ORDER BY season_id ASC
    `);
    findFutureConsiderationStatement = database.prepare(`
      SELECT * FROM future_considerations
      WHERE league_id = @leagueId AND id = @futureConsiderationId
      LIMIT 2
    `);
    summarizeContractRetentionStatement = database.prepare(`
      SELECT COALESCE(SUM(retained_aav_cents), 0) AS retained_aav_cents
      FROM retention_obligations
      WHERE league_id = @leagueId
        AND contract_id = @contractId
        AND status = 'active'
    `);
    countTeamRetentionSlotsStatement = database.prepare(`
      SELECT COUNT(*) AS slot_count
      FROM retention_obligations
      WHERE league_id = @leagueId
        AND responsible_team_id = @teamId
        AND status = 'active'
    `);
    findTeamContractRetentionStatement = database.prepare(`
      SELECT id
      FROM retention_obligations
      WHERE league_id = @leagueId
        AND contract_id = @contractId
        AND responsible_team_id = @teamId
        AND status = 'active'
      LIMIT 2
    `);
    findLifecycleParticipantsStatement = database.prepare(`
      SELECT
        id AS trade_id,
        league_id,
        season_id,
        proposing_team_id,
        receiving_team_id,
        status AS trade_status,
        effective_deadline_at_ms,
        version
      FROM trades
      WHERE league_id = @leagueId
        AND id = @tradeId
      LIMIT 2
    `);
    loadLifecycleStateStatement = database.prepare(`
      SELECT
        trades.id AS trade_id,
        trades.league_id AS league_id,
        trades.season_id AS season_id,
        trades.proposing_team_id AS proposing_team_id,
        trades.receiving_team_id AS receiving_team_id,
        trades.status AS trade_status,
        trades.effective_deadline_at_ms AS effective_deadline_at_ms,
        trades.version AS trade_version,
        trades.proposal_model_version AS proposal_model_version,
        leagues.status AS league_status,
        leagues.commissioner_membership_id AS commissioner_membership_id,
        seasons.status AS season_status,
        league_memberships.user_id AS membership_user_id,
        league_memberships.permission_category AS membership_permission,
        league_memberships.status AS membership_status,
        team_manager_assignments.team_id AS assignment_team_id,
        team_manager_assignments.status AS assignment_status,
        team_manager_assignments.accepted_at_ms AS assignment_accepted_at_ms,
        team_manager_assignments.ended_at_ms AS assignment_ended_at_ms
      FROM trades
      JOIN leagues ON leagues.id = trades.league_id
      JOIN seasons
        ON seasons.league_id = trades.league_id
       AND seasons.id = trades.season_id
      LEFT JOIN league_memberships
        ON league_memberships.league_id = trades.league_id
       AND league_memberships.id = @actorMembershipId
       AND league_memberships.user_id = @actorUserId
      LEFT JOIN team_manager_assignments
        ON team_manager_assignments.league_id = trades.league_id
       AND team_manager_assignments.team_id = @participantTeamId
       AND team_manager_assignments.user_id = @actorUserId
       AND team_manager_assignments.membership_id = @actorMembershipId
       AND team_manager_assignments.status = 'accepted'
      WHERE trades.league_id = @leagueId
        AND trades.id = @tradeId
      LIMIT 2
    `);
    findLifecycleIdempotencyStatement = database.prepare(`
      SELECT *
      FROM idempotency_requests
      WHERE league_id = @leagueId
        AND actor_user_id = @actorUserId
        AND operation = @operation
        AND client_key = @idempotencyKey
      LIMIT 2
    `);
    insertLifecycleIdempotencyStatement = database.prepare(`
      INSERT INTO idempotency_requests (
        id, league_id, actor_user_id, operation, client_key,
        request_hash, status, result_type, result_id,
        created_at_ms, completed_at_ms, expires_at_ms
      ) VALUES (
        @idempotencyRequestId, @leagueId, @actorUserId, @operation,
        @idempotencyKey, @requestHash, 'started', NULL, NULL,
        @occurredAtMs, NULL, @idempotencyExpiresAtMs
      )
    `);
    updateLifecycleTradeStatement = database.prepare(`
      UPDATE trades
      SET status = @nextStatus,
        responded_at_ms = @occurredAtMs,
        updated_at_ms = @occurredAtMs,
        version = version + 1
      WHERE league_id = @leagueId
        AND id = @tradeId
        AND status = 'proposed'
        AND version = @expectedVersion
    `);
    insertLifecycleEventStatement = database.prepare(`
      INSERT INTO trade_events (
        id, league_id, season_id, trade_id, actor_user_id,
        event_type, reason, metadata_json, occurred_at_ms
      ) VALUES (
        @eventId, @leagueId, @seasonId, @tradeId, @actorUserId,
        @eventType, NULL, @eventMetadataJson, @occurredAtMs
      )
    `);
    findLifecycleEventStatement = database.prepare(`
      SELECT * FROM trade_events
      WHERE league_id = @leagueId
        AND trade_id = @tradeId
        AND event_type = @eventType
      LIMIT 2
    `);
    loadAcceptanceSettingsStatement = database.prepare(`
      SELECT
        salary_cap_cents,
        active_forward_slots,
        active_defence_slots,
        bench_slots,
        maximum_bench_aav_cents,
        injured_reserve_slots
      FROM league_settings
      WHERE league_id = @leagueId
      LIMIT 2
    `);
    listAcceptanceRosterStatement = database.prepare(`
      SELECT
        ownership.id AS ownership_id,
        ownership.player_id,
        ownership.team_id,
        ownership.ownership_kind,
        ownership.roster_category,
        ownership.position_group,
        ownership.slot_number,
        contract.id AS contract_id,
        contract.current_team_id AS contract_team_id,
        contract.aav_cents,
        contract.status AS contract_status,
        COALESCE((
          SELECT SUM(retention_year.retained_aav_cents)
          FROM retention_obligations AS retention
          JOIN retention_years AS retention_year
            ON retention_year.league_id = retention.league_id
           AND retention_year.retention_obligation_id = retention.id
          WHERE retention.league_id = ownership.league_id
            AND retention.contract_id = contract.id
            AND retention.status = 'active'
            AND retention_year.season_id = @seasonId
            AND retention_year.status = 'current'
        ), 0) AS retained_aav_cents
      FROM player_ownerships AS ownership
      LEFT JOIN contracts AS contract
        ON contract.league_id = ownership.league_id
       AND contract.player_id = ownership.player_id
       AND contract.status = 'active'
      WHERE ownership.league_id = @leagueId
        AND ownership.season_id = @seasonId
        AND ownership.team_id IN (@proposingTeamId, @receivingTeamId)
      ORDER BY ownership.team_id, ownership.player_id
    `);
    listAcceptanceRetentionsStatement = database.prepare(`
      SELECT
        retention.id,
        retention.contract_id,
        retention.player_id,
        retention.responsible_team_id,
        COALESCE((
          SELECT retention_year.retained_aav_cents
          FROM retention_years AS retention_year
          WHERE retention_year.league_id = retention.league_id
            AND retention_year.retention_obligation_id = retention.id
            AND retention_year.season_id = @seasonId
            AND retention_year.status = 'current'
          LIMIT 1
        ), 0) AS amount_cents
      FROM retention_obligations AS retention
      WHERE retention.league_id = @leagueId
        AND retention.responsible_team_id IN (
          @proposingTeamId, @receivingTeamId
        )
        AND retention.status = 'active'
      ORDER BY retention.id
    `);
    listAcceptanceBuyoutsStatement = database.prepare(`
      SELECT
        buyout.id,
        buyout.contract_id,
        buyout.player_id,
        buyout.responsible_team_id,
        buyout_year.penalty_cents AS amount_cents
      FROM buyout_obligations AS buyout
      JOIN buyout_years AS buyout_year
        ON buyout_year.league_id = buyout.league_id
       AND buyout_year.buyout_obligation_id = buyout.id
      WHERE buyout.league_id = @leagueId
        AND buyout.responsible_team_id IN (
          @proposingTeamId, @receivingTeamId
        )
        AND buyout.status = 'active'
        AND buyout_year.season_id = @seasonId
        AND buyout_year.status = 'current'
      ORDER BY buyout.id
    `);
    updateExecutionTradeStatement = database.prepare(`
      UPDATE trades
      SET status = 'completed',
        responded_at_ms = @occurredAtMs,
        completed_at_ms = @occurredAtMs,
        commissioner_completion_reference = CASE
          WHEN @actorAuthority = 'commissioner' THEN @eventId
          ELSE NULL
        END,
        updated_at_ms = @occurredAtMs,
        version = version + 1
      WHERE league_id = @leagueId
        AND id = @tradeId
        AND status = 'proposed'
        AND version = @expectedVersion
    `);
    updateExecutionOwnershipStatement = database.prepare(`
      UPDATE player_ownerships
      SET team_id = @destinationTeamId,
        slot_number = @plannedRosterSlotNumber,
        acquired_transaction_type = 'trade_execution',
        acquired_transaction_id = @tradeId,
        updated_at_ms = @occurredAtMs,
        version = version + 1
      WHERE league_id = @leagueId
        AND id = @ownershipId
        AND team_id = @sourceTeamId
        AND version = @ownershipVersion
    `);
    updateExecutionContractStatement = database.prepare(`
      UPDATE contracts
      SET current_team_id = @destinationTeamId,
        updated_at_ms = @occurredAtMs,
        version = version + 1
      WHERE league_id = @leagueId
        AND id = @contractId
        AND current_team_id = @sourceTeamId
        AND status = 'active'
        AND version = @contractVersion
    `);
    insertExecutionOwnershipEventStatement = database.prepare(`
      INSERT INTO ownership_events (
        id, league_id, season_id, player_id, team_id, ownership_id,
        event_type, actor_user_id, source_type, source_id,
        before_metadata_json, after_metadata_json, reason, occurred_at_ms
      ) VALUES (
        @historyId, @leagueId, @seasonId, @playerId,
        @destinationTeamId, @ownershipId, 'trade_transfer', @actorUserId,
        'trade', @tradeId, @beforeMetadataJson, @afterMetadataJson,
        NULL, @occurredAtMs
      )
    `);
    insertExecutionContractEventStatement = database.prepare(`
      INSERT INTO contract_events (
        id, league_id, contract_id, player_id, team_id, actor_user_id,
        event_type, source_type, source_id, metadata_json, reason,
        occurred_at_ms
      ) VALUES (
        @historyId, @leagueId, @contractId, @playerId,
        @destinationTeamId, @actorUserId, 'trade_transfer', 'trade',
        @tradeId, @metadataJson, NULL, @occurredAtMs
      )
    `);
    updateExecutionDraftPickStatement = database.prepare(`
      UPDATE draft_picks
      SET current_owner_team_id = @destinationTeamId,
        updated_at_ms = @occurredAtMs,
        version = version + 1
      WHERE league_id = @leagueId
        AND id = @draftPickId
        AND current_owner_team_id = @sourceTeamId
        AND status = 'unused'
        AND version = @assetVersion
    `);
    insertExecutionDraftPickEventStatement = database.prepare(`
      INSERT INTO draft_pick_ownership_events (
        id, league_id, draft_pick_id, from_team_id, to_team_id,
        trade_id, actor_user_id, event_type, occurred_at_ms
      ) VALUES (
        @historyId, @leagueId, @draftPickId, @sourceTeamId,
        @destinationTeamId, @tradeId, @actorUserId,
        'trade_transfer', @occurredAtMs
      )
    `);
    updateExecutionRetentionStatement = database.prepare(`
      UPDATE retention_obligations
      SET responsible_team_id = @destinationTeamId,
        updated_at_ms = @occurredAtMs,
        version = version + 1
      WHERE league_id = @leagueId
        AND id = @retentionObligationId
        AND responsible_team_id = @sourceTeamId
        AND status = 'active'
        AND version = @assetVersion
    `);
    updateExecutionBuyoutStatement = database.prepare(`
      UPDATE buyout_obligations
      SET responsible_team_id = @destinationTeamId,
        updated_at_ms = @occurredAtMs,
        version = version + 1
      WHERE league_id = @leagueId
        AND id = @buyoutObligationId
        AND responsible_team_id = @sourceTeamId
        AND status = 'active'
        AND version = @assetVersion
    `);
    insertExecutionRetentionStatement = database.prepare(`
      INSERT INTO retention_obligations (
        id, league_id, contract_id, player_id, originating_team_id,
        responsible_team_id, retained_aav_cents, creation_trade_id,
        status, created_at_ms, updated_at_ms, version
      ) VALUES (
        @retentionObligationId, @leagueId, @contractId, @playerId,
        @sourceTeamId, @sourceTeamId, @retainedAavCents, @tradeId,
        'active', @occurredAtMs, @occurredAtMs, 1
      )
    `);
    insertExecutionRetentionYearStatement = database.prepare(`
      INSERT INTO retention_years (
        id, league_id, retention_obligation_id, season_id,
        retained_aav_cents, status, created_at_ms
      ) VALUES (
        @retentionYearId, @leagueId, @retentionObligationId,
        @retentionSeasonId, @retainedAavCents, @retentionYearStatus,
        @occurredAtMs
      )
    `);
    insertExecutionFutureConsiderationStatement = database.prepare(`
      INSERT INTO future_considerations (
        id, league_id, season_id, originating_trade_id, owing_team_id,
        receiving_team_id, description, status, created_at_ms,
        resolved_at_ms, updated_at_ms, version
      ) VALUES (
        @futureConsiderationId, @leagueId, @seasonId, @tradeId,
        @sourceTeamId, @destinationTeamId,
        @futureConsiderationDescription, 'outstanding', @occurredAtMs,
        NULL, @occurredAtMs, 1
      )
    `);
    updateExecutionFutureConsiderationStatement = database.prepare(`
      UPDATE future_considerations
      SET receiving_team_id = @destinationTeamId,
        updated_at_ms = @occurredAtMs,
        version = version + 1
      WHERE league_id = @leagueId
        AND id = @futureConsiderationId
        AND receiving_team_id = @sourceTeamId
        AND status = 'outstanding'
        AND version = @assetVersion
    `);
    resolveExecutionFutureConsiderationStatement = database.prepare(`
      UPDATE future_considerations
      SET status = 'cancelled', resolved_at_ms = @occurredAtMs,
        updated_at_ms = @occurredAtMs, version = version + 1
      WHERE league_id = @leagueId
        AND id = @futureConsiderationId
        AND owing_team_id = @destinationTeamId
        AND receiving_team_id = @sourceTeamId
        AND status = 'outstanding'
        AND version = @assetVersion
    `);
    listConflictingTradesStatement = database.prepare(`
      SELECT DISTINCT
        other_trade.id AS trade_id,
        other_trade.season_id AS season_id,
        other_trade.version AS version
      FROM trades AS other_trade
      JOIN trade_assets AS other_asset
        ON other_asset.league_id = other_trade.league_id
       AND other_asset.trade_id = other_trade.id
      WHERE other_trade.league_id = @leagueId
        AND other_trade.id <> @tradeId
        AND other_trade.status = 'proposed'
        AND EXISTS (
          SELECT 1
          FROM trade_assets AS executed_asset
          WHERE executed_asset.league_id = @leagueId
            AND executed_asset.trade_id = @tradeId
            AND (
              (
                COALESCE(
                  executed_asset.contract_id,
                  executed_asset.requested_retention_contract_id
                ) IS NOT NULL
                AND COALESCE(
                  executed_asset.contract_id,
                  executed_asset.requested_retention_contract_id
                ) IN (
                  other_asset.contract_id,
                  other_asset.requested_retention_contract_id
                )
              )
              OR (
                executed_asset.player_id IS NOT NULL
                AND executed_asset.player_id = other_asset.player_id
              )
              OR (
                executed_asset.draft_pick_id IS NOT NULL
                AND executed_asset.draft_pick_id = other_asset.draft_pick_id
              )
              OR (
                executed_asset.retention_obligation_id IS NOT NULL
                AND executed_asset.retention_obligation_id =
                  other_asset.retention_obligation_id
              )
              OR (
                executed_asset.buyout_obligation_id IS NOT NULL
                AND executed_asset.buyout_obligation_id =
                  other_asset.buyout_obligation_id
              )
              OR (
                executed_asset.future_consideration_id IS NOT NULL
                AND executed_asset.future_consideration_id =
                  other_asset.future_consideration_id
              )
            )
        )
      ORDER BY other_trade.id
    `);
    updateConflictingTradeStatement = database.prepare(`
      UPDATE trades
      SET status = 'cancelled', responded_at_ms = @occurredAtMs,
        updated_at_ms = @occurredAtMs, version = version + 1
      WHERE league_id = @leagueId
        AND id = @conflictingTradeId
        AND status = 'proposed'
    `);
    insertAutomaticCancellationEventStatement = database.prepare(`
      INSERT INTO trade_events (
        id, league_id, season_id, trade_id, actor_user_id,
        event_type, reason, metadata_json, occurred_at_ms
      ) VALUES (
        @automaticEventId, @leagueId, @seasonId, @conflictingTradeId,
        NULL, 'proposal_auto_cancelled', 'asset_transferred',
        @automaticMetadataJson, @occurredAtMs
      )
    `);
    findExecutionEventStatement = database.prepare(`
      SELECT * FROM trade_events
      WHERE league_id = @leagueId
        AND trade_id = @tradeId
        AND event_type = 'proposal_accepted'
      LIMIT 2
    `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareTradeProposalRepository",
    });
  }

  function unique(statement, parameters, message) {
    const rows = statement.all(parameters);
    if (rows.length > 1) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        message
      );
    }
    return rows[0] || null;
  }

  function insertTradePublication({
    eventId,
    leagueId,
    seasonId,
    tradeId,
    actorUserId,
    actorAuthority,
    teamId,
    eventType,
    displaySummary,
    reason,
    metadata,
    occurredAtMs,
    tradeVersion,
  }) {
    activityRepository.insert({
      id: deterministicUuid(`activity:${eventId}`),
      league_id: leagueId,
      season_id: seasonId,
      event_type: eventType,
      actor_user_id: actorUserId,
      actor_authority: actorAuthority,
      team_id: teamId,
      player_id: null,
      related_type: "trade",
      related_id: tradeId,
      display_summary: displaySummary,
      reason,
      metadata_json: JSON.stringify(metadata),
      occurred_at_ms: occurredAtMs,
    });
    const payload = createSocketInvalidation({
      eventType: "trade.changed",
      scope: "league",
      scopeId: leagueId,
      version: tradeVersion,
      changedAtMs: occurredAtMs,
    });
    outboxRepository.insert({
      id: deterministicUuid(`outbox:${eventId}:trade.changed`),
      league_id: leagueId,
      event_type: "trade.changed",
      aggregate_type: "trade",
      aggregate_id: tradeId,
      payload_json: JSON.stringify(payload),
      status: "pending",
      attempt_count: 0,
      available_at_ms: occurredAtMs,
      published_at_ms: null,
      last_error_code: null,
      created_at_ms: occurredAtMs,
      updated_at_ms: occurredAtMs,
      version: 1,
    });
  }

  function loadFoundationState(parameters) {
    return unique(
      loadFoundationStateStatement,
      parameters,
      "The trade proposal foundation query was not unique."
    );
  }

  function contractSnapshot(command, asset) {
    const row = unique(
      findContractStatement,
      { leagueId: command.leagueId, contractId: asset.contractId },
      "A contract asset was not unique."
    );
    if (!row) policyFail(TRADE_ASSET_CODES.staleOwnership);
    if (
      row.contract_status !== "active" ||
      row.contract_team_id !== asset.sourceTeamId ||
      row.ownership_team_id !== asset.sourceTeamId ||
      row.ownership_season_id !== command.seasonId ||
      row.ownership_kind !== "Rostered" ||
      !["Active", "Bench", "Injured Reserve"].includes(row.roster_category)
    ) {
      policyFail(TRADE_ASSET_CODES.ineligible);
    }
    const years = listContractYearsStatement.all({
      leagueId: command.leagueId,
      contractId: asset.contractId,
    });
    if (
      years.length < 1 ||
      years.some((year) => !["current", "future"].includes(year.status))
    ) {
      policyFail(TRADE_ASSET_CODES.ineligible);
    }
    return assertSnapshot({
      schemaVersion: 1,
      type: "contract",
      player: { id: row.player_id, name: row.player_name },
      contract: {
        id: row.contract_id,
        type: row.contract_type,
        originalTotalValueCents: row.original_total_value_cents,
        originalTermYears: row.original_term_years,
        aavCents: row.aav_cents,
        startSeasonId: row.start_season_id,
        auctionBuyoutLockExpiresAtMs: row.auction_buyout_lock_expires_at_ms,
        version: row.contract_version,
        years: years.map((year) => ({ ...year })),
      },
      ownership: {
        id: row.ownership_id,
        teamId: row.ownership_team_id,
        rosterCategory: row.roster_category,
        positionGroup: row.position_group,
        slotNumber: row.slot_number,
        version: row.ownership_version,
      },
    });
  }

  function prospectSnapshot(command, asset) {
    const row = unique(
      findProspectStatement,
      { leagueId: command.leagueId, playerId: asset.playerId },
      "A prospect-right asset was not unique."
    );
    if (!row) policyFail(TRADE_ASSET_CODES.staleOwnership);
    if (
      row.ownership_team_id !== asset.sourceTeamId ||
      row.ownership_season_id !== command.seasonId ||
      row.ownership_kind !== "Prospect Right" ||
      row.roster_category !== "Prospect" ||
      (row.contract_id !== null &&
        (row.contract_type !== "fantasy_elc" ||
          row.contract_status !== "active" ||
          row.contract_team_id !== asset.sourceTeamId))
    ) {
      policyFail(TRADE_ASSET_CODES.ineligible);
    }
    return assertSnapshot({
      schemaVersion: 1,
      type: "prospect_right",
      player: { id: row.player_id, name: row.player_name },
      ownership: {
        id: row.ownership_id,
        teamId: row.ownership_team_id,
        rosterCategory: row.roster_category,
        positionGroup: row.position_group,
        version: row.ownership_version,
      },
      fantasyElc:
        row.contract_id === null
          ? null
          : {
              contractId: row.contract_id,
              aavCents: row.aav_cents,
              version: row.contract_version,
            },
    });
  }

  function draftPickSnapshot(command, asset) {
    const row = unique(
      findDraftPickStatement,
      { leagueId: command.leagueId, draftPickId: asset.draftPickId },
      "A draft-pick asset was not unique."
    );
    if (!row) policyFail(TRADE_ASSET_CODES.staleOwnership);
    if (
      row.current_owner_team_id !== asset.sourceTeamId ||
      row.status !== "unused" ||
      row.selection_id !== null ||
      row.draft_status === "cancelled"
    ) {
      policyFail(TRADE_ASSET_CODES.ineligible);
    }
    return assertSnapshot({
      schemaVersion: 1,
      type: "draft_pick",
      id: row.id,
      draftId: row.draft_id,
      targetSeasonId: row.target_season_id,
      targetSeasonLabel: row.target_season_label,
      roundNumber: row.round_number,
      positionNumber: row.position_number,
      originalTeamId: row.original_team_id,
      currentOwnerTeamId: row.current_owner_team_id,
      version: row.version,
    });
  }

  function retentionSnapshot(command, asset) {
    const row = unique(
      findRetentionStatement,
      {
        leagueId: command.leagueId,
        retentionObligationId: asset.retentionObligationId,
      },
      "A retention-obligation asset was not unique."
    );
    if (!row) policyFail(TRADE_ASSET_CODES.staleOwnership);
    const years = listRetentionYearsStatement.all({
      leagueId: command.leagueId,
      retentionObligationId: asset.retentionObligationId,
    });
    if (
      row.responsible_team_id !== asset.sourceTeamId ||
      row.status !== "active" ||
      years.length < 1 ||
      years.some((year) => !["current", "future"].includes(year.status))
    ) {
      policyFail(TRADE_ASSET_CODES.ineligible);
    }
    return assertSnapshot({
      schemaVersion: 1,
      type: "retention_obligation",
      id: row.id,
      contractId: row.contract_id,
      player: { id: row.player_id, name: row.player_name },
      originatingTeamId: row.originating_team_id,
      responsibleTeamId: row.responsible_team_id,
      retainedAavCents: row.retained_aav_cents,
      originalContractAavCents: row.aav_cents,
      creationTradeId: row.creation_trade_id,
      version: row.version,
      years: years.map((year) => ({ ...year })),
    });
  }

  function buyoutSnapshot(command, asset) {
    const row = unique(
      findBuyoutStatement,
      {
        leagueId: command.leagueId,
        buyoutObligationId: asset.buyoutObligationId,
      },
      "A buyout-obligation asset was not unique."
    );
    if (!row) policyFail(TRADE_ASSET_CODES.staleOwnership);
    const years = listBuyoutYearsStatement.all({
      leagueId: command.leagueId,
      buyoutObligationId: asset.buyoutObligationId,
    });
    if (
      row.responsible_team_id !== asset.sourceTeamId ||
      row.status !== "active" ||
      years.length < 1 ||
      years.some((year) => !["current", "future"].includes(year.status))
    ) {
      policyFail(TRADE_ASSET_CODES.ineligible);
    }
    return assertSnapshot({
      schemaVersion: 1,
      type: "buyout_obligation",
      id: row.id,
      contractId: row.contract_id,
      player: { id: row.player_id, name: row.player_name },
      originatingTeamId: row.originating_team_id,
      responsibleTeamId: row.responsible_team_id,
      annualPenaltyBasisCents: row.annual_penalty_basis_cents,
      buyoutTransactionId: row.buyout_transaction_id,
      version: row.version,
      years: years.map((year) => ({ ...year })),
    });
  }

  function futureConsiderationSnapshot(command, asset) {
    if (asset.futureConsiderationDescription !== null) {
      return assertSnapshot({
        schemaVersion: 1,
        type: "future_consideration_instruction",
        owingTeamId: asset.sourceTeamId,
        entitledTeamId: asset.destinationTeamId,
        description: asset.futureConsiderationDescription,
        createsObligationAtAcceptance: true,
      });
    }
    const row = unique(
      findFutureConsiderationStatement,
      {
        leagueId: command.leagueId,
        futureConsiderationId: asset.futureConsiderationId,
      },
      "A Future Considerations asset was not unique."
    );
    if (!row) policyFail(TRADE_ASSET_CODES.staleOwnership);
    if (
      row.receiving_team_id !== asset.sourceTeamId ||
      row.status !== "outstanding"
    ) {
      policyFail(TRADE_ASSET_CODES.ineligible);
    }
    return assertSnapshot({
      schemaVersion: 1,
      type: "future_consideration",
      id: row.id,
      originatingTradeId: row.originating_trade_id,
      owingTeamId: row.owing_team_id,
      entitledTeamId: row.receiving_team_id,
      description: row.description,
      version: row.version,
    });
  }

  function snapshotAssets(command) {
    const snapshots = [];
    const contractSnapshots = new Map();
    const selectedPlayerIds = new Set();
    for (const asset of command.assets) {
      let snapshot;
      switch (asset.inputType) {
        case "contract":
          snapshot = contractSnapshot(command, asset);
          contractSnapshots.set(
            `${asset.sourceTeamId}:${asset.contractId}`,
            snapshot
          );
          if (selectedPlayerIds.has(snapshot.player.id)) {
            policyFail(TRADE_ASSET_CODES.conflict);
          }
          selectedPlayerIds.add(snapshot.player.id);
          break;
        case "prospect_right":
          snapshot = prospectSnapshot(command, asset);
          if (selectedPlayerIds.has(snapshot.player.id)) {
            policyFail(TRADE_ASSET_CODES.conflict);
          }
          selectedPlayerIds.add(snapshot.player.id);
          break;
        case "draft_pick":
          snapshot = draftPickSnapshot(command, asset);
          break;
        case "retention_obligation":
          snapshot = retentionSnapshot(command, asset);
          break;
        case "buyout_obligation":
          snapshot = buyoutSnapshot(command, asset);
          break;
        case "future_consideration":
        case "future_consideration_instruction":
          snapshot = futureConsiderationSnapshot(command, asset);
          break;
        case "requested_retention":
          snapshot = null;
          break;
        default:
          policyFail(TRADE_ASSET_CODES.ineligible);
      }
      snapshots.push(snapshot);
    }

    const retentionSlotDeltaByTeam = new Map();
    const outgoingRetentionIds = new Set(
      command.assets
        .filter((asset) => asset.inputType === "retention_obligation")
        .map((asset) => asset.retentionObligationId)
    );
    const finalTeamContractRetentions = new Set();
    for (let index = 0; index < command.assets.length; index += 1) {
      const asset = command.assets[index];
      let teamId;
      let contractId;
      if (asset.inputType === "retention_obligation") {
        teamId = asset.destinationTeamId;
        contractId = snapshots[index].contractId;
      } else if (asset.inputType === "requested_retention") {
        teamId = asset.sourceTeamId;
        contractId = asset.requestedRetentionContractId;
      } else {
        continue;
      }
      const finalKey = `${teamId}:${contractId}`;
      if (finalTeamContractRetentions.has(finalKey)) {
        policyFail(TRADE_ASSET_CODES.retentionInvalid);
      }
      finalTeamContractRetentions.add(finalKey);
      const current = unique(
        findTeamContractRetentionStatement,
        { leagueId: command.leagueId, contractId, teamId },
        "A team has duplicate active retention on one contract."
      );
      if (current && !outgoingRetentionIds.has(current.id)) {
        policyFail(TRADE_ASSET_CODES.retentionInvalid);
      }
    }
    function addRetentionSlotDelta(teamId, delta) {
      retentionSlotDeltaByTeam.set(
        teamId,
        (retentionSlotDeltaByTeam.get(teamId) || 0) + delta
      );
    }
    for (const asset of command.assets) {
      if (asset.inputType === "retention_obligation") {
        addRetentionSlotDelta(asset.sourceTeamId, -1);
        addRetentionSlotDelta(asset.destinationTeamId, 1);
      } else if (asset.inputType === "requested_retention") {
        addRetentionSlotDelta(asset.sourceTeamId, 1);
      }
    }
    for (const [teamId, slotDelta] of retentionSlotDeltaByTeam) {
      const { slot_count: slotCount } = countTeamRetentionSlotsStatement.get({
        leagueId: command.leagueId,
        teamId,
      });
      if (slotCount + slotDelta < 0 || slotCount + slotDelta > 3) {
        policyFail(TRADE_ASSET_CODES.retentionInvalid);
      }
    }

    return command.assets.map((asset, index) => {
      if (asset.inputType !== "requested_retention") {
        return Object.freeze({
          ...asset,
          proposalSnapshotJson: JSON.stringify(snapshots[index]),
        });
      }
      const contract = contractSnapshots.get(
        `${asset.sourceTeamId}:${asset.requestedRetentionContractId}`
      );
      if (!contract) policyFail(TRADE_ASSET_CODES.retentionInvalid);
      const existingTeamRetention = unique(
        findTeamContractRetentionStatement,
        {
          leagueId: command.leagueId,
          contractId: asset.requestedRetentionContractId,
          teamId: asset.sourceTeamId,
        },
        "A team has duplicate active retention on one contract."
      );
      const { retained_aav_cents: cumulativeRetainedAavCents } =
        summarizeContractRetentionStatement.get({
          leagueId: command.leagueId,
          contractId: asset.requestedRetentionContractId,
        });
      const retentionCeilingCents = Math.floor(contract.contract.aavCents / 2);
      if (
        (existingTeamRetention &&
          !outgoingRetentionIds.has(existingTeamRetention.id)) ||
        cumulativeRetainedAavCents + asset.requestedRetentionCents >
          retentionCeilingCents
      ) {
        policyFail(TRADE_ASSET_CODES.retentionInvalid);
      }
      return Object.freeze({
        ...asset,
        proposalSnapshotJson: JSON.stringify({
          schemaVersion: 1,
          type: "requested_retention",
          contractId: asset.requestedRetentionContractId,
          playerId: contract.player.id,
          retainingTeamId: asset.sourceTeamId,
          retainedAavCents: asset.requestedRetentionCents,
          originalAavCents: contract.contract.aavCents,
          cumulativeRetainedAavCents,
          retentionCeilingCents,
          consumesSlotAtAcceptance: true,
        }),
      });
    });
  }

  function persistedAssetCommand(row) {
    return Object.freeze({
      id: row.id,
      direction: row.direction,
      sourceTeamId: row.source_team_id,
      destinationTeamId: row.destination_team_id,
      inputType:
        row.asset_type === "future_consideration" &&
        row.future_consideration_description !== null
          ? "future_consideration_instruction"
          : row.asset_type,
      assetType: row.asset_type,
      contractId: row.contract_id,
      playerId: row.player_id,
      draftPickId: row.draft_pick_id,
      retentionObligationId: row.retention_obligation_id,
      buyoutObligationId: row.buyout_obligation_id,
      futureConsiderationId: row.future_consideration_id,
      requestedRetentionContractId: row.requested_retention_contract_id,
      requestedRetentionCents: row.requested_retention_cents,
      futureConsiderationDescription: row.future_consideration_description,
      sequence: row.sequence,
      createdAtMs: row.created_at_ms,
    });
  }

  function previewIssue(code, details = {}) {
    return Object.freeze({ code, ...details });
  }

  function projectTeamAcceptancePreview({
    teamId,
    settings,
    roster,
    retentions,
    buyouts,
  }) {
    const teamRoster = roster.filter((row) => row.team_id === teamId);
    const counts = {
      activeForwards: teamRoster.filter(
        (row) => row.roster_category === "Active" && row.position_group === "F"
      ).length,
      activeDefence: teamRoster.filter(
        (row) => row.roster_category === "Active" && row.position_group === "D"
      ).length,
      bench: teamRoster.filter((row) => row.roster_category === "Bench").length,
      injuredReserve: teamRoster.filter(
        (row) => row.roster_category === "Injured Reserve"
      ).length,
      prospects: teamRoster.filter(
        (row) => row.roster_category === "Prospect"
      ).length,
    };
    const issues = [];
    for (const [countKey, limitKey, code] of [
      ["activeForwards", "active_forward_slots", "ACTIVE_FORWARD_LIMIT_EXCEEDED"],
      ["activeDefence", "active_defence_slots", "ACTIVE_DEFENCE_LIMIT_EXCEEDED"],
      ["bench", "bench_slots", "BENCH_LIMIT_EXCEEDED"],
      ["injuredReserve", "injured_reserve_slots", "INJURED_RESERVE_LIMIT_EXCEEDED"],
    ]) {
      if (counts[countKey] > settings[limitKey]) {
        issues.push(
          previewIssue(code, {
            count: counts[countKey],
            limit: settings[limitKey],
          })
        );
      }
    }

    const occupiedSlots = new Set();
    for (const row of teamRoster) {
      if (row.ownership_kind === "Rostered") {
        if (
          row.contract_id === null ||
          row.contract_status !== "active" ||
          row.contract_team_id !== teamId
        ) {
          issues.push(
            previewIssue("ROSTERED_CONTRACT_INVALID", {
              ownershipId: row.ownership_id,
              playerId: row.player_id,
            })
          );
        }
        if (row.slot_number === null) {
          issues.push(
            previewIssue("NORMAL_ROSTER_SLOT_UNPLACED", {
              ownershipId: row.ownership_id,
              playerId: row.player_id,
              rosterCategory: row.roster_category,
              positionGroup: row.position_group,
            })
          );
        }
        if (
          row.roster_category === "Bench" &&
          row.aav_cents > settings.maximum_bench_aav_cents
        ) {
          issues.push(
            previewIssue("BENCH_AAV_LIMIT_EXCEEDED", {
              ownershipId: row.ownership_id,
              playerId: row.player_id,
              aavCents: row.aav_cents,
              limitCents: settings.maximum_bench_aav_cents,
            })
          );
        }
      }
      if (row.slot_number !== null) {
        const slotKey =
          row.roster_category === "Active"
            ? `${row.roster_category}:${row.position_group}:${row.slot_number}`
            : `${row.roster_category}:${row.slot_number}`;
        if (occupiedSlots.has(slotKey)) {
          issues.push(
            previewIssue("ROSTER_SLOT_COLLISION", {
              ownershipId: row.ownership_id,
              slotKey,
            })
          );
        }
        occupiedSlots.add(slotKey);
      }
    }

    const requestedRetentionByContract = new Map();
    for (const retention of retentions.filter((row) => row.requested)) {
      requestedRetentionByContract.set(
        retention.contract_id,
        (requestedRetentionByContract.get(retention.contract_id) || 0) +
          retention.amount_cents
      );
    }
    const activePlayerCapCents = teamRoster
      .filter(
        (row) =>
          row.ownership_kind === "Rostered" &&
          row.roster_category === "Active" &&
          row.contract_id !== null &&
          row.contract_status === "active" &&
          row.contract_team_id === teamId
      )
      .reduce(
        (sum, row) =>
          sum +
          Math.max(
            0,
            row.aav_cents -
              row.retained_aav_cents -
              (requestedRetentionByContract.get(row.contract_id) || 0)
          ),
        0
      );
    const retentionCapCents = retentions
      .filter((row) => row.responsible_team_id === teamId)
      .reduce((sum, row) => sum + row.amount_cents, 0);
    const buyoutCapCents = buyouts
      .filter((row) => row.responsible_team_id === teamId)
      .reduce((sum, row) => sum + row.amount_cents, 0);
    const capUsageCents =
      activePlayerCapCents + retentionCapCents + buyoutCapCents;
    if (capUsageCents > settings.salary_cap_cents) {
      issues.push(
        previewIssue("SALARY_CAP_EXCEEDED", {
          usageCents: capUsageCents,
          limitCents: settings.salary_cap_cents,
        })
      );
    }
    const retentionSlots = retentions.filter(
      (row) => row.responsible_team_id === teamId
    ).length;
    if (retentionSlots > 3) {
      issues.push(
        previewIssue("RETENTION_SLOT_LIMIT_EXCEEDED", {
          count: retentionSlots,
          limit: 3,
        })
      );
    }
    return Object.freeze({
      teamId,
      rosterCounts: Object.freeze(counts),
      cap: Object.freeze({
        salaryCapCents: settings.salary_cap_cents,
        activePlayerCapCents,
        retentionCapCents,
        buyoutCapCents,
        usageCents: capUsageCents,
        spaceCents: settings.salary_cap_cents - capUsageCents,
      }),
      retentionSlots,
      issues: Object.freeze(issues),
      generallyIllegal: issues.length > 0,
    });
  }

  function acceptancePreview(rawCommand) {
    const command = validateTradeAcceptancePreviewCommand(rawCommand);
    const context = unique(
      loadLifecycleStateStatement,
      { ...command, participantTeamId: command.receivingTeamId },
      "A trade acceptance-preview state was not unique."
    );
    assertTradeAcceptancePreviewState({ command, context });
    const persistedAssets = listTradeAssetsStatement.all(command);
    if (persistedAssets.length < 2) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The trade acceptance preview has incomplete assets."
      );
    }
    const assets = Object.freeze(persistedAssets.map(persistedAssetCommand));
    const currentAssets = snapshotAssets({ ...command, assets });
    const settings = unique(
      loadAcceptanceSettingsStatement,
      command,
      "Trade acceptance settings were not unique."
    );
    if (!settings) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.recordNotFound,
        "Trade acceptance settings do not exist."
      );
    }
    const roster = listAcceptanceRosterStatement
      .all(command)
      .map((row) => ({ ...row }));
    const retentions = listAcceptanceRetentionsStatement
      .all(command)
      .map((row) => ({ ...row }));
    const buyouts = listAcceptanceBuyoutsStatement
      .all(command)
      .map((row) => ({ ...row }));
    const movingOwnershipIds = new Set();
    for (let index = 0; index < assets.length; index += 1) {
      if (!["contract", "prospect_right"].includes(assets[index].inputType)) {
        continue;
      }
      const snapshot = JSON.parse(currentAssets[index].proposalSnapshotJson);
      movingOwnershipIds.add(snapshot.ownership.id);
    }
    const occupiedSlots = new Set();
    for (const row of roster) {
      if (movingOwnershipIds.has(row.ownership_id) || row.slot_number === null) {
        continue;
      }
      occupiedSlots.add(
        row.roster_category === "Active"
          ? `${row.team_id}:Active:${row.position_group}:${row.slot_number}`
          : `${row.team_id}:${row.roster_category}:${row.slot_number}`
      );
    }
    const plannedRosterSlotByAssetId = new Map();
    function assignDestinationSlot(row, destinationTeamId) {
      if (row.roster_category === "Prospect") return null;
      const limit =
        row.roster_category === "Active"
          ? row.position_group === "F"
            ? settings.active_forward_slots
            : settings.active_defence_slots
          : row.roster_category === "Bench"
            ? settings.bench_slots
            : settings.injured_reserve_slots;
      for (let slotNumber = 1; slotNumber <= limit; slotNumber += 1) {
        const key =
          row.roster_category === "Active"
            ? `${destinationTeamId}:Active:${row.position_group}:${slotNumber}`
            : `${destinationTeamId}:${row.roster_category}:${slotNumber}`;
        if (!occupiedSlots.has(key)) {
          occupiedSlots.add(key);
          return slotNumber;
        }
      }
      return null;
    }
    for (let index = 0; index < assets.length; index += 1) {
      const asset = assets[index];
      const currentSnapshot = JSON.parse(
        currentAssets[index].proposalSnapshotJson
      );
      switch (asset.inputType) {
        case "contract": {
          const row = roster.find(
            (candidate) => candidate.contract_id === asset.contractId
          );
          row.team_id = asset.destinationTeamId;
          row.contract_team_id = asset.destinationTeamId;
          row.slot_number = assignDestinationSlot(
            row,
            asset.destinationTeamId
          );
          plannedRosterSlotByAssetId.set(asset.id, row.slot_number);
          break;
        }
        case "prospect_right": {
          const row = roster.find(
            (candidate) => candidate.player_id === asset.playerId
          );
          row.team_id = asset.destinationTeamId;
          row.slot_number = null;
          plannedRosterSlotByAssetId.set(asset.id, null);
          if (row.contract_id !== null) {
            row.contract_team_id = asset.destinationTeamId;
          }
          break;
        }
        case "retention_obligation":
          retentions.find(
            (candidate) => candidate.id === asset.retentionObligationId
          ).responsible_team_id = asset.destinationTeamId;
          break;
        case "buyout_obligation":
          buyouts.find(
            (candidate) => candidate.id === asset.buyoutObligationId
          ).responsible_team_id = asset.destinationTeamId;
          break;
        case "requested_retention":
          retentions.push({
            id: asset.id,
            contract_id: asset.requestedRetentionContractId,
            player_id: currentSnapshot.playerId,
            responsible_team_id: asset.sourceTeamId,
            amount_cents: asset.requestedRetentionCents,
            requested: true,
          });
          break;
        default:
          break;
      }
    }
    const teams = Object.freeze(
      [command.proposingTeamId, command.receivingTeamId].map((teamId) =>
        projectTeamAcceptancePreview({
          teamId,
          settings,
          roster,
          retentions,
          buyouts,
        })
      )
    );
    return Object.freeze({
      trade: Object.freeze({ ...context }),
      assets: Object.freeze(
        persistedAssets.map((asset, index) =>
          Object.freeze({
            ...asset,
            proposalSnapshot: Object.freeze(
              JSON.parse(asset.proposal_snapshot_json)
            ),
            currentSnapshot: Object.freeze(
              JSON.parse(currentAssets[index].proposalSnapshotJson)
            ),
            plannedRosterSlotNumber:
              plannedRosterSlotByAssetId.get(asset.id) ?? null,
          })
        )
      ),
      teams,
      generallyIllegal: teams.some((team) => team.generallyIllegal),
    });
  }

  function aggregate({ leagueId, tradeId, replayed }) {
    const trade = unique(
      findTradeStatement,
      { leagueId, tradeId },
      "A created trade was not unique."
    );
    const event = unique(
      findTradeEventStatement,
      { leagueId, tradeId },
      "A proposal-creation event was not unique."
    );
    if (!trade || !event) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The created trade aggregate is incomplete."
      );
    }
    const assets = listTradeAssetsStatement.all({ leagueId, tradeId });
    if (assets.length < 2) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The created trade has incomplete assets."
      );
    }
    return Object.freeze({
      replayed,
      trade: Object.freeze({ ...trade }),
      assets: Object.freeze(
        assets.map((asset) =>
          Object.freeze({
            ...asset,
            proposal_snapshot: Object.freeze(
              JSON.parse(asset.proposal_snapshot_json)
            ),
          })
        )
      ),
      event: Object.freeze({
        ...event,
        metadata: Object.freeze(JSON.parse(event.metadata_json)),
      }),
    });
  }

  const createTransaction = database.transaction((rawCommand) => {
    const command = validateTradeProposalCreationCommand(rawCommand);
    const requestHash = createRequestHash(command);
    const existing = unique(
      findIdempotencyStatement,
      command,
      "A trade proposal idempotency key was not unique."
    );
    if (existing) {
      if (
        existing.request_hash !== requestHash ||
        existing.status !== "completed" ||
        existing.result_type !== "trade" ||
        !existing.result_id
      ) {
        policyFail(TRADE_ASSET_CODES.idempotencyConflict);
      }
      return aggregate({
        leagueId: command.leagueId,
        tradeId: existing.result_id,
        replayed: true,
      });
    }

    insertIdempotencyStatement.run({ ...command, requestHash });
    const context = loadFoundationState(command);
    assertTradeProposalFoundationState({ command, context });
    if (command.effectiveDeadlineAtMs !== Math.min(
      command.expiresAtMs,
      context.trade_deadline_at_ms
    )) {
      policyFail(TRADE_ASSET_CODES.timestampInvalid);
    }
    const assets = snapshotAssets(command);
    insertTradeStatement.run(command);
    for (const asset of assets) {
      insertAssetStatement.run({
        ...asset,
        leagueId: command.leagueId,
        tradeId: command.tradeId,
      });
    }
    const eventMetadataJson = JSON.stringify({
      schemaVersion: 1,
      actorAuthority: command.actorAuthority,
      assetIds: assets.map((asset) => asset.id),
      assetCount: assets.length,
    });
    insertEventStatement.run({ ...command, eventMetadataJson });
    insertTradePublication({
      eventId: command.eventId,
      leagueId: command.leagueId,
      seasonId: command.seasonId,
      tradeId: command.tradeId,
      actorUserId: command.actorUserId,
      actorAuthority: command.actorAuthority,
      teamId: command.proposingTeamId,
      eventType: "trade_proposal_created",
      displaySummary: "Trade proposal created.",
      reason: null,
      metadata: {
        schemaVersion: 1,
        proposalId: command.tradeId,
        proposingTeamId: command.proposingTeamId,
        receivingTeamId: command.receivingTeamId,
        status: "Pending",
        assets: assets.map((asset) => ({
          id: asset.id,
          assetType: asset.assetType,
          direction: asset.direction,
          sourceTeamId: asset.sourceTeamId,
          destinationTeamId: asset.destinationTeamId,
          snapshot: JSON.parse(asset.proposalSnapshotJson),
        })),
      },
      occurredAtMs: command.createdAtMs,
      tradeVersion: 1,
    });
    for (const recipient of listReceivingManagersStatement.all(command)) {
      notificationsRepository.insert({
        id: deterministicUuid(
          `trade-proposal-notification:${command.eventId}:${recipient.user_id}`
        ),
        user_id: recipient.user_id,
        league_id: command.leagueId,
        event_type: "trade_proposal_received",
        message_data_json: JSON.stringify({
          message:
            `Trade proposal received from ${recipient.proposing_team_name}.`,
          tradeId: command.tradeId,
          leagueId: command.leagueId,
          proposingTeamId: command.proposingTeamId,
          proposingTeamName: recipient.proposing_team_name,
          receivingTeamId: command.receivingTeamId,
          receivingTeamName: recipient.receiving_team_name,
        }),
        related_feature: "trade",
        related_record_id: command.tradeId,
        delivery_status: "delivered",
        created_at_ms: command.createdAtMs,
        read_at_ms: null,
        delivered_at_ms: command.createdAtMs,
        version: 1,
      });
    }
    if (completeIdempotencyStatement.run(command).changes !== 1) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.versionConflict,
        "The trade proposal idempotency result changed concurrently."
      );
    }
    return aggregate({
      leagueId: command.leagueId,
      tradeId: command.tradeId,
      replayed: false,
    });
  });

  function lifecycleAggregate({ command, replayed }) {
    const trade = unique(
      findTradeStatement,
      { leagueId: command.leagueId, tradeId: command.tradeId },
      "A transitioned trade was not unique."
    );
    const eventType = lifecycleEventType(command.action);
    const event = unique(
      findLifecycleEventStatement,
      {
        leagueId: command.leagueId,
        tradeId: command.tradeId,
        eventType,
      },
      "A trade lifecycle event was not unique."
    );
    if (
      !trade ||
      !event ||
      trade.status !== lifecycleStorageStatus(command.action)
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The transitioned trade aggregate is incomplete."
      );
    }
    return Object.freeze({
      replayed,
      trade: Object.freeze({ ...trade }),
      event: Object.freeze({
        ...event,
        metadata: Object.freeze(JSON.parse(event.metadata_json)),
      }),
    });
  }

  const lifecycleTransaction = database.transaction((rawCommand) => {
    const command = validateTradeLifecycleCommand(rawCommand);
    const operation = `trade.${command.action}`;
    const requestHash = createLifecycleRequestHash(command);
    const existing = unique(
      findLifecycleIdempotencyStatement,
      { ...command, operation },
      "A trade lifecycle idempotency key was not unique."
    );
    if (existing) {
      if (
        existing.request_hash !== requestHash ||
        existing.status !== "completed" ||
        existing.result_type !== "trade" ||
        existing.result_id !== command.tradeId
      ) {
        throw new TradeLifecyclePolicyError(
          TRADE_LIFECYCLE_CODES.idempotencyConflict
        );
      }
      return lifecycleAggregate({ command, replayed: true });
    }

    insertLifecycleIdempotencyStatement.run({
      ...command,
      operation,
      requestHash,
    });
    const participantTeamId = expectedManagerTeamId(command);
    const context = unique(
      loadLifecycleStateStatement,
      { ...command, participantTeamId },
      "A trade lifecycle state was not unique."
    );
    assertTradeLifecycleState({ command, context });
    if (context.trade_version !== command.expectedVersion) {
      throw new TradeLifecyclePolicyError(
        TRADE_LIFECYCLE_CODES.versionConflict
      );
    }
    const nextStatus = lifecycleStorageStatus(command.action);
    if (
      updateLifecycleTradeStatement.run({ ...command, nextStatus }).changes !== 1
    ) {
      throw new TradeLifecyclePolicyError(
        TRADE_LIFECYCLE_CODES.versionConflict
      );
    }
    const eventType = lifecycleEventType(command.action);
    const eventMetadataJson = JSON.stringify({
      schemaVersion: 1,
      action: command.action,
      actorAuthority: command.actorAuthority,
      fromStatus: "proposed",
      toStatus: nextStatus,
    });
    insertLifecycleEventStatement.run({
      ...command,
      eventType,
      eventMetadataJson,
    });
    insertTradePublication({
      eventId: command.eventId,
      leagueId: command.leagueId,
      seasonId: command.seasonId,
      tradeId: command.tradeId,
      actorUserId: command.actorUserId,
      actorAuthority: command.actorAuthority,
      teamId: participantTeamId,
      eventType:
        command.action === "reject"
          ? "trade_proposal_rejected"
          : "trade_proposal_cancelled",
      displaySummary:
        command.action === "reject"
          ? "Trade proposal rejected."
          : "Trade proposal cancelled.",
      reason: null,
      metadata: {
        schemaVersion: 1,
        proposalId: command.tradeId,
        proposingTeamId: command.proposingTeamId,
        receivingTeamId: command.receivingTeamId,
        action: command.action,
        actorAuthority: command.actorAuthority,
        fromStatus: "Pending",
        toStatus: command.action === "reject" ? "Rejected" : "Cancelled",
      },
      occurredAtMs: command.occurredAtMs,
      tradeVersion: command.expectedVersion + 1,
    });
    if (
      completeIdempotencyStatement.run({
        ...command,
        createdAtMs: command.occurredAtMs,
      }).changes !== 1
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.versionConflict,
        "The trade lifecycle idempotency result changed concurrently."
      );
    }
    return lifecycleAggregate({ command, replayed: false });
  });

  function executionAggregate({ command, replayed }) {
    const trade = unique(
      findTradeStatement,
      command,
      "An accepted trade was not unique."
    );
    const event = unique(
      findExecutionEventStatement,
      command,
      "A trade-acceptance event was not unique."
    );
    if (!trade || trade.status !== "completed" || !event) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "The accepted trade aggregate is incomplete."
      );
    }
    return Object.freeze({
      replayed,
      trade: Object.freeze({ ...trade }),
      event: Object.freeze({
        ...event,
        metadata: Object.freeze(JSON.parse(event.metadata_json)),
      }),
    });
  }

  function requireExecutionChange(result) {
    if (result.changes !== 1) {
      throw new TradeExecutionPolicyError(
        TRADE_EXECUTION_CODES.versionConflict
      );
    }
  }

  const executionTransaction = database.transaction((rawCommand) => {
    const command = validateTradeExecutionCommand(rawCommand);
    const operation = "trade.accept";
    const requestHash = createExecutionRequestHash(command);
    const existing = unique(
      findLifecycleIdempotencyStatement,
      { ...command, operation },
      "A trade-acceptance idempotency key was not unique."
    );
    if (existing) {
      if (
        existing.request_hash !== requestHash ||
        existing.status !== "completed" ||
        existing.result_type !== "trade" ||
        existing.result_id !== command.tradeId
      ) {
        throw new TradeExecutionPolicyError(
          TRADE_EXECUTION_CODES.idempotencyConflict
        );
      }
      return executionAggregate({ command, replayed: true });
    }

    insertLifecycleIdempotencyStatement.run({
      ...command,
      operation,
      requestHash,
    });
    const context = unique(
      loadLifecycleStateStatement,
      { ...command, participantTeamId: command.receivingTeamId },
      "A trade-execution state was not unique."
    );
    assertTradeExecutionState({ command, context });
    const preview = acceptancePreview({
      tradeId: command.tradeId,
      leagueId: command.leagueId,
      seasonId: command.seasonId,
      proposingTeamId: command.proposingTeamId,
      receivingTeamId: command.receivingTeamId,
      expectedVersion: command.expectedVersion,
      actorUserId: command.actorUserId,
      actorMembershipId: command.actorMembershipId,
      actorAuthority: command.actorAuthority,
      occurredAtMs: command.occurredAtMs,
      effectiveDeadlineAtMs: command.effectiveDeadlineAtMs,
    });
    requireExecutionChange(updateExecutionTradeStatement.run(command));

    const transfers = [];
    for (const asset of preview.assets) {
      const current = asset.currentSnapshot;
      const base = {
        ...command,
        sourceTeamId: asset.source_team_id,
        destinationTeamId: asset.destination_team_id,
      };
      switch (asset.asset_type) {
        case "contract": {
          requireExecutionChange(
            updateExecutionOwnershipStatement.run({
              ...base,
              ownershipId: current.ownership.id,
              ownershipVersion: current.ownership.version,
              plannedRosterSlotNumber: asset.plannedRosterSlotNumber,
            })
          );
          requireExecutionChange(
            updateExecutionContractStatement.run({
              ...base,
              contractId: current.contract.id,
              contractVersion: current.contract.version,
            })
          );
          insertExecutionOwnershipEventStatement.run({
            ...base,
            historyId: deterministicUuid(
              `${command.tradeId}:ownership:${current.ownership.id}`
            ),
            playerId: current.player.id,
            ownershipId: current.ownership.id,
            beforeMetadataJson: JSON.stringify({
              schemaVersion: 1,
              teamId: asset.source_team_id,
              rosterCategory: current.ownership.rosterCategory,
              slotNumber: current.ownership.slotNumber,
            }),
            afterMetadataJson: JSON.stringify({
              schemaVersion: 1,
              teamId: asset.destination_team_id,
              rosterCategory: current.ownership.rosterCategory,
              slotNumber: asset.plannedRosterSlotNumber,
            }),
          });
          insertExecutionContractEventStatement.run({
            ...base,
            historyId: deterministicUuid(
              `${command.tradeId}:contract:${current.contract.id}`
            ),
            contractId: current.contract.id,
            playerId: current.player.id,
            metadataJson: JSON.stringify({
              schemaVersion: 1,
              fromTeamId: asset.source_team_id,
              toTeamId: asset.destination_team_id,
              termsUnchanged: true,
            }),
          });
          break;
        }
        case "prospect_right": {
          requireExecutionChange(
            updateExecutionOwnershipStatement.run({
              ...base,
              ownershipId: current.ownership.id,
              ownershipVersion: current.ownership.version,
              plannedRosterSlotNumber: null,
            })
          );
          insertExecutionOwnershipEventStatement.run({
            ...base,
            historyId: deterministicUuid(
              `${command.tradeId}:ownership:${current.ownership.id}`
            ),
            playerId: current.player.id,
            ownershipId: current.ownership.id,
            beforeMetadataJson: JSON.stringify({
              schemaVersion: 1,
              teamId: asset.source_team_id,
              rosterCategory: "Prospect",
              slotNumber: null,
            }),
            afterMetadataJson: JSON.stringify({
              schemaVersion: 1,
              teamId: asset.destination_team_id,
              rosterCategory: "Prospect",
              slotNumber: null,
            }),
          });
          if (current.fantasyElc !== null) {
            requireExecutionChange(
              updateExecutionContractStatement.run({
                ...base,
                contractId: current.fantasyElc.contractId,
                contractVersion: current.fantasyElc.version,
              })
            );
            insertExecutionContractEventStatement.run({
              ...base,
              historyId: deterministicUuid(
                `${command.tradeId}:contract:${current.fantasyElc.contractId}`
              ),
              contractId: current.fantasyElc.contractId,
              playerId: current.player.id,
              metadataJson: JSON.stringify({
                schemaVersion: 1,
                fromTeamId: asset.source_team_id,
                toTeamId: asset.destination_team_id,
                termsUnchanged: true,
                prospectStatusPreserved: true,
              }),
            });
          }
          break;
        }
        case "draft_pick":
          requireExecutionChange(
            updateExecutionDraftPickStatement.run({
              ...base,
              draftPickId: current.id,
              assetVersion: current.version,
            })
          );
          insertExecutionDraftPickEventStatement.run({
            ...base,
            historyId: deterministicUuid(
              `${command.tradeId}:draft-pick:${current.id}`
            ),
            draftPickId: current.id,
          });
          break;
        case "retention_obligation":
          requireExecutionChange(
            updateExecutionRetentionStatement.run({
              ...base,
              retentionObligationId: current.id,
              assetVersion: current.version,
            })
          );
          break;
        case "buyout_obligation":
          requireExecutionChange(
            updateExecutionBuyoutStatement.run({
              ...base,
              buyoutObligationId: current.id,
              assetVersion: current.version,
            })
          );
          break;
        case "requested_retention": {
          const retentionObligationId = asset.id;
          insertExecutionRetentionStatement.run({
            ...base,
            retentionObligationId,
            contractId: current.contractId,
            playerId: current.playerId,
            retainedAavCents: current.retainedAavCents,
          });
          const years = listContractYearsStatement.all({
            leagueId: command.leagueId,
            contractId: current.contractId,
          });
          for (const year of years.filter((row) =>
            ["current", "future"].includes(row.status)
          )) {
            insertExecutionRetentionYearStatement.run({
              ...base,
              retentionObligationId,
              retentionYearId: deterministicUuid(
                `${command.tradeId}:retention-year:${asset.id}:${year.season_id}`
              ),
              retentionSeasonId: year.season_id,
              retainedAavCents: current.retainedAavCents,
              retentionYearStatus: year.status,
            });
          }
          break;
        }
        case "future_consideration":
          if (asset.future_consideration_description !== null) {
            insertExecutionFutureConsiderationStatement.run({
              ...base,
              futureConsiderationId: asset.id,
              futureConsiderationDescription:
                asset.future_consideration_description,
            });
          } else {
            requireExecutionChange(
              (current.owingTeamId === asset.destination_team_id
                ? resolveExecutionFutureConsiderationStatement
                : updateExecutionFutureConsiderationStatement
              ).run({
                ...base,
                futureConsiderationId: current.id,
                assetVersion: current.version,
              })
            );
          }
          break;
        default:
          throw new TradeExecutionPolicyError(
            TRADE_EXECUTION_CODES.stateInvalid
          );
      }
      transfers.push(
        Object.freeze({
          assetId: asset.id,
          assetType:
            asset.asset_type === "future_consideration" &&
            asset.future_consideration_description !== null
              ? "future_consideration_instruction"
              : asset.asset_type,
          sourceTeamId: asset.source_team_id,
          destinationTeamId: asset.destination_team_id,
          plannedRosterSlotNumber: asset.plannedRosterSlotNumber,
        })
      );
    }

    const automaticallyCancelledTradeIds = [];
    for (const conflict of listConflictingTradesStatement.all(command)) {
      if (
        updateConflictingTradeStatement.run({
          ...command,
          conflictingTradeId: conflict.trade_id,
        }).changes !== 1
      ) {
        continue;
      }
      const automaticEventId = deterministicUuid(
        `${command.tradeId}:auto-cancel:${conflict.trade_id}`
      );
      insertAutomaticCancellationEventStatement.run({
        ...command,
        seasonId: conflict.season_id,
        conflictingTradeId: conflict.trade_id,
        automaticEventId,
        automaticMetadataJson: JSON.stringify({
          schemaVersion: 1,
          acceptedTradeId: command.tradeId,
          reasonCode: "asset_transferred",
        }),
      });
      insertTradePublication({
        eventId: automaticEventId,
        leagueId: command.leagueId,
        seasonId: conflict.season_id,
        tradeId: conflict.trade_id,
        actorUserId: null,
        actorAuthority: "system",
        teamId: null,
        eventType: "trade_proposal_automatically_cancelled",
        displaySummary: "Trade proposal automatically cancelled.",
        reason: "asset_transferred",
        metadata: {
          schemaVersion: 1,
          proposalId: conflict.trade_id,
          acceptedTradeId: command.tradeId,
          fromStatus: "Pending",
          toStatus: "Automatically Cancelled",
          reasonCode: "asset_transferred",
        },
        occurredAtMs: command.occurredAtMs,
        tradeVersion: conflict.version + 1,
      });
      automaticallyCancelledTradeIds.push(conflict.trade_id);
    }

    const eventMetadataJson = JSON.stringify({
      schemaVersion: 1,
      action: "accept",
      actorAuthority: command.actorAuthority,
      fromStatus: "proposed",
      toStatus: "completed",
      generallyIllegal: preview.generallyIllegal,
      teams: preview.teams,
      transfers,
      automaticallyCancelledTradeIds,
    });
    insertLifecycleEventStatement.run({
      ...command,
      eventType: "proposal_accepted",
      eventMetadataJson,
    });
    insertTradePublication({
      eventId: command.eventId,
      leagueId: command.leagueId,
      seasonId: command.seasonId,
      tradeId: command.tradeId,
      actorUserId: command.actorUserId,
      actorAuthority: command.actorAuthority,
      teamId: null,
      eventType: "trade_completed",
      displaySummary: "Trade completed.",
      reason: null,
      metadata: {
        schemaVersion: 1,
        proposalId: command.tradeId,
        transactionId: command.tradeId,
        proposingTeamId: command.proposingTeamId,
        receivingTeamId: command.receivingTeamId,
        actorAuthority: command.actorAuthority,
        commissionerCompletionReference:
          command.actorAuthority === "commissioner" ? command.eventId : null,
        generallyIllegal: preview.generallyIllegal,
        teams: preview.teams,
        assets: preview.assets.map((asset) => ({
          id: asset.id,
          assetType:
            asset.asset_type === "future_consideration" &&
            asset.future_consideration_description !== null
              ? "future_consideration_instruction"
              : asset.asset_type,
          sourceTeamId: asset.source_team_id,
          destinationTeamId: asset.destination_team_id,
          proposalSnapshot: asset.proposalSnapshot,
          executionSnapshot: asset.currentSnapshot,
          plannedRosterSlotNumber: asset.plannedRosterSlotNumber,
        })),
        automaticallyCancelledTradeIds,
      },
      occurredAtMs: command.occurredAtMs,
      tradeVersion: command.expectedVersion + 1,
    });
    if (
      completeIdempotencyStatement.run({
        ...command,
        createdAtMs: command.occurredAtMs,
      }).changes !== 1
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.versionConflict,
        "The trade-acceptance idempotency result changed concurrently."
      );
    }
    return executionAggregate({ command, replayed: false });
  });

  return Object.freeze({
    createProposal(rawCommand) {
      try {
        return createTransaction.immediate(rawCommand);
      } catch (error) {
        if (
          error instanceof TradeAssetPolicyError ||
          error instanceof TradeProposalFoundationPolicyError
        ) {
          throw error;
        }
        throw mapRepositoryError(error, {
          operation: "createTradeProposal",
          tableName: "trades",
        });
      }
    },
    executeAcceptance(rawCommand) {
      try {
        return executionTransaction.immediate(rawCommand);
      } catch (error) {
        if (
          error instanceof TradeAssetPolicyError ||
          error instanceof TradeExecutionPolicyError ||
          error instanceof TradeLifecyclePolicyError
        ) {
          throw error;
        }
        throw mapRepositoryError(error, {
          operation: "executeTradeAcceptance",
          tableName: "trades",
        });
      }
    },
    findLifecycleParticipants({ leagueId, tradeId } = {}) {
      try {
        return freezeRow(
          unique(
            findLifecycleParticipantsStatement,
            {
              leagueId: stableId(leagueId),
              tradeId: stableId(tradeId),
            },
            "A trade lifecycle participant row was not unique."
          )
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findTradeLifecycleParticipants",
          tableName: "trades",
        });
      }
    },
    loadFoundationState({
      leagueId,
      proposingTeamId,
      receivingTeamId,
      actorUserId,
      actorMembershipId,
    } = {}) {
      try {
        return freezeRow(
          loadFoundationState({
            leagueId: stableId(leagueId),
            proposingTeamId: stableId(proposingTeamId),
            receivingTeamId: stableId(receivingTeamId),
            actorUserId: stableId(actorUserId),
            actorMembershipId: stableId(actorMembershipId),
          })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "loadTradeProposalFoundationState",
          tableName: "trades",
        });
      }
    },
    previewAcceptance(rawCommand) {
      try {
        return acceptancePreview(rawCommand);
      } catch (error) {
        if (
          error instanceof TradeAssetPolicyError ||
          error instanceof TradeLifecyclePolicyError
        ) {
          throw error;
        }
        throw mapRepositoryError(error, {
          operation: "previewTradeAcceptance",
          tableName: "trades",
        });
      }
    },
    transitionLifecycle(rawCommand) {
      try {
        return lifecycleTransaction.immediate(rawCommand);
      } catch (error) {
        if (error instanceof TradeLifecyclePolicyError) throw error;
        throw mapRepositoryError(error, {
          operation: "transitionTradeLifecycle",
          tableName: "trades",
        });
      }
    },
    listVisible({ leagueId, viewerUserId, viewerMembershipId } = {}) {
      try {
        return Object.freeze(
          listVisibleStatement
            .all({
              leagueId: stableId(leagueId),
              viewerUserId: stableId(viewerUserId),
              viewerMembershipId: stableId(viewerMembershipId),
            })
            .map(projectTradeProposalRow)
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "listVisibleTradeProposals",
          tableName: "trades",
        });
      }
    },
    readDetail({ leagueId, tradeId } = {}) {
      try {
        const input = {
          leagueId: stableId(leagueId),
          tradeId: stableId(tradeId),
        };
        const row = unique(
          findVisibleDetailStatement,
          input,
          "A visible trade detail row was not unique."
        );
        if (!row) return null;
        return Object.freeze({
          ...projectTradeProposalRow(row),
          assets: Object.freeze(
            listTradeAssetsStatement.all(input).map((asset) =>
              Object.freeze({
                id: asset.id,
                direction: asset.direction,
                sourceTeamId: asset.source_team_id,
                destinationTeamId: asset.destination_team_id,
                type:
                  asset.asset_type === "future_consideration" &&
                  asset.future_consideration_description !== null
                    ? "future_consideration_instruction"
                    : asset.asset_type,
                sequence: asset.sequence,
                snapshot: Object.freeze(
                  JSON.parse(asset.proposal_snapshot_json)
                ),
              })
            )
          ),
          history: Object.freeze(
            listTradeEventsStatement.all(input).map((event) =>
              Object.freeze({
                id: event.id,
                actorUserId: event.actor_user_id,
                type: event.event_type,
                reason: event.reason,
                metadata:
                  event.metadata_json === null
                    ? null
                    : Object.freeze(JSON.parse(event.metadata_json)),
                occurredAtMs: event.occurred_at_ms,
              })
            )
          ),
        });
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "readVisibleTradeProposal",
          tableName: "trades",
        });
      }
    },
  });
}

module.exports = {
  createSqliteTradeProposalRepository,
};
