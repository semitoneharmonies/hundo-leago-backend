const crypto = require("node:crypto");
const { canonicalize } = require("../../infrastructure/migration/sourceInventory");
const { buildTradeExpiryOccurrenceKey } = require("../../domain/trades/tradeLifecyclePolicy");
const { createSocketEventEnvelope, createEmptySocketRelated } = require("../../domain/leagues/socketInvalidation");

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const REVIEW_FIELDS = "deadlineAtMs,evidenceSha256,jobId,leagueId,occurrenceKeySha256,reasonCode,reconciliationId,reviewedByUserId,rowSha256,seasonId,tradeId,tradeRowSha256";
const CHANGED_TABLES = ["trades", "job_runs", "trade_events", "league_activity", "outbox_events", "outbox_event_audiences", "security_audit_events", "application_metadata"];
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const same = (left, right) => canonicalize(left) === canonicalize(right);
const fingerprint = rows => ({ count: rows.length, sha256: hash(canonicalize(rows.map(row => hash(canonicalize(row))).sort())) });
const safeTime = value => Number.isSafeInteger(value) && value >= 0;
class RecoveryTradeExpiryError extends Error {
  constructor(code) {
    super("Trade recovery requires an exact reviewed overdue proposal and occurrence in an unchanged held copy.");
    this.name = "RecoveryTradeExpiryError"; this.code = code;
  }
}
function fail(code) { throw new RecoveryTradeExpiryError(code); }
function validateDecision(decision) {
  if (!decision || Object.keys(decision).sort().join(",") !== REVIEW_FIELDS ||
      ![decision.jobId, decision.tradeId, decision.leagueId, decision.seasonId, decision.reviewedByUserId, decision.reconciliationId].every(value => UUID.test(value || "")) ||
      ![decision.rowSha256, decision.tradeRowSha256, decision.occurrenceKeySha256, decision.evidenceSha256].every(value => DIGEST.test(value || "")) ||
      !safeTime(decision.deadlineAtMs) || !/^[A-Z][A-Z0-9_]{0,79}$/.test(decision.reasonCode || "")) fail("RECOVERY_TRADE_INPUT_INVALID");
}
function readRows(database) {
  return Object.fromEntries(database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) fail("RECOVERY_TRADE_STATE_INVALID");
    return [name, database.prepare(`SELECT * FROM "${name}"`).all()];
  }));
}
const snapshots = rows => Object.fromEntries(Object.entries(rows).map(([name, values]) => [name, fingerprint(values)]));
function validateOccurrence(before, decision, executedAtMs) {
  validateDecision(decision);
  const job = before.job_runs.find(row => row.id === decision.jobId), trade = before.trades.find(row => row.id === decision.tradeId);
  if (!safeTime(executedAtMs) || !job || !trade || trade.league_id !== decision.leagueId || trade.season_id !== decision.seasonId ||
      job.league_id !== trade.league_id || job.season_id !== trade.season_id || job.job_type !== "trades:expire:target" ||
      !["pending", "leased", "running", "failed"].includes(job.status) || job.updated_at_ms > executedAtMs ||
      trade.status !== "proposed" || trade.proposal_model_version !== 2 || trade.updated_at_ms > executedAtMs ||
      trade.effective_deadline_at_ms !== decision.deadlineAtMs || decision.deadlineAtMs > executedAtMs ||
      job.scheduled_for_ms !== decision.deadlineAtMs ||
      job.occurrence_key !== buildTradeExpiryOccurrenceKey({ tradeId: trade.id, effectiveDeadlineAtMs: decision.deadlineAtMs }) ||
      (job.lease_expires_at_ms !== null && job.lease_expires_at_ms > executedAtMs) ||
      !Number.isSafeInteger(job.version + 2) || !Number.isSafeInteger(job.attempt_count + 1) || !Number.isSafeInteger(trade.version + 1) ||
      hash(canonicalize(job)) !== decision.rowSha256 || hash(canonicalize(trade)) !== decision.tradeRowSha256 ||
      hash(canonicalize([job.league_id, job.job_type, job.occurrence_key])) !== decision.occurrenceKeySha256) fail("RECOVERY_TRADE_OCCURRENCE_INVALID");
  const user = before.users.find(row => row.id === decision.reviewedByUserId);
  if (user?.status !== "active" || !before.platform_roles.some(row => row.user_id === user.id && row.role === "platform_administrator" && row.status === "active")) fail("RECOVERY_TRADE_REVIEWER_INVALID");
  if (before.security_audit_events.some(row => row.id === decision.reconciliationId) ||
      before.application_metadata.some(row => row.metadata_key === `recovery_trade_review:${decision.reconciliationId}`)) fail("RECOVERY_TRADE_REVIEW_REUSED");
  return { job, trade };
}
function deterministicId(value) {
  const hex = hash(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// Independently describe the permitted persisted delta. This never executes
// the worker, changes a row, or treats receipt checksums as authority.
function expectedTradeExpiryRows({ before, decision, executedAtMs, eventId, plan }) {
  const { job, trade } = validateOccurrence(before, decision, executedAtMs);
  if (!UUID.test(eventId || "") || !DIGEST.test(plan?.planChecksum || "")) fail("RECOVERY_TRADE_INPUT_INVALID");
  const awaiting = before.trade_future_consideration_acceptances.some(row => row.league_id === trade.league_id && row.trade_id === trade.id);
  const fromStatus = awaiting ? "awaiting_commissioner_approval" : "proposed";
  const outboxId = deterministicId(`outbox:${eventId}:trade.changed`), decisionChecksum = hash(canonicalize(decision));
  const event = { id: eventId, league_id: trade.league_id, season_id: trade.season_id, trade_id: trade.id, actor_user_id: null,
    event_type: "proposal_expired", reason: "effective_deadline_elapsed", metadata_json: JSON.stringify({ schemaVersion: 1,
      occurrenceKey: job.occurrence_key, effectiveDeadlineAtMs: decision.deadlineAtMs, fromStatus, toStatus: "expired" }), occurred_at_ms: executedAtMs };
  const activity = { id: deterministicId(`activity:${eventId}`), league_id: trade.league_id, season_id: trade.season_id,
    event_type: "trade_proposal_expired", actor_user_id: null, actor_authority: "system", team_id: null, player_id: null,
    related_type: "trade", related_id: trade.id, display_summary: "Trade proposal expired.", reason: "effective_deadline_elapsed",
    metadata_json: JSON.stringify({ schemaVersion: 1, proposalId: trade.id, occurrenceKey: job.occurrence_key,
      effectiveDeadlineAtMs: decision.deadlineAtMs, fromStatus: awaiting ? "Awaiting Commissioner Approval" : "Pending", toStatus: "Expired" }), occurred_at_ms: executedAtMs };
  const message = { id: outboxId, league_id: trade.league_id, event_type: "trade.changed", aggregate_type: "trade", aggregate_id: trade.id,
    payload_json: JSON.stringify(createSocketEventEnvelope({ eventId: outboxId, type: "trade.changed", leagueId: trade.league_id,
      resourceId: trade.id, version: trade.version + 1, reasonCode: "trade_changed", occurredAt: executedAtMs, related: createEmptySocketRelated() })),
    status: "pending", attempt_count: 0, available_at_ms: executedAtMs, published_at_ms: null, last_error_code: null,
    created_at_ms: executedAtMs, updated_at_ms: executedAtMs, version: 1 };
  const audience = { id: outboxId, outbox_event_id: outboxId, league_id: trade.league_id, audience_kind: "league", team_id: null, user_id: null, created_at_ms: executedAtMs };
  const metadata = { metadata_key: `recovery_trade_review:${decision.reconciliationId}`,
    metadata_value: canonicalize({ recoveryId: plan.recoveryId, planChecksum: plan.planChecksum, decisionChecksum, decision, executedAtMs, eventId, outboxId }),
    created_at_ms: executedAtMs, updated_at_ms: executedAtMs };
  const audit = { id: decision.reconciliationId, event_type: "recovery.trade_expiry_reconciled", outcome: "success",
    actor_user_id: decision.reviewedByUserId, target_user_id: null, league_id: trade.league_id, session_id: null,
    request_correlation_id: plan.recoveryId, reason_code: `trade_expiry_${decisionChecksum}`, network_key_version: null,
    network_metadata_digest: null, unknown_account_digest: null, client_metadata_json: '{"networkSourceCategory":"local"}', occurred_at_ms: executedAtMs };
  const completedJob = { ...job, status: "succeeded", attempt_count: job.attempt_count + 1, lease_owner: null, lease_expires_at_ms: null,
    started_at_ms: executedAtMs, completed_at_ms: executedAtMs, updated_at_ms: executedAtMs, version: job.version + 2,
    result_json: JSON.stringify({ tradeId: trade.id, outcome: "expired" }), last_error_code: null };
  const expected = { ...before, trades: before.trades.map(row => row.id === trade.id ? { ...row, status: "expired",
    responded_at_ms: executedAtMs, updated_at_ms: executedAtMs, version: trade.version + 1 } : row),
    job_runs: before.job_runs.map(row => row.id === job.id ? completedJob : row), trade_events: [...before.trade_events, event],
    league_activity: [...before.league_activity, activity], outbox_events: [...before.outbox_events, message],
    outbox_event_audiences: [...before.outbox_event_audiences, audience], security_audit_events: [...before.security_audit_events, audit],
    application_metadata: [...before.application_metadata, metadata] };
  return { expected, job, trade, event, message, metadata, audit, completedJob, decisionChecksum };
}
module.exports = { RecoveryTradeExpiryError, fail, hash, same, snapshots, readRows, safeTime, validateDecision, validateOccurrence,
  expectedTradeExpiryRows, CHANGED_TABLES };
