const crypto = require("node:crypto");
const { canonicalize } = require("../../infrastructure/migration/sourceInventory");
const { parsePayload,parseAudiences } = require("../../application/services/activity/createLeagueOutboxPublicationService");

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ERROR_CODE = "RECOVERY_INVALIDATION_SUPPRESSED";
const DISPOSITION = "suppress-restored-refresh-hint";
const REFRESH_HINTS = new Set(["league.changed","team.changed","roster.changed","contract.changed","auction.changed","trade.changed",
  "matchup.changed","standings.changed","draft.changed","candidate_card.changed","candidate_card_help.changed","fad_nomination_queue.changed","operations.changed"]);
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const fingerprint = rows => ({ count: rows.length,sha256: hash(canonicalize(rows.map(row => hash(canonicalize(row))).sort())) });
class RecoveryInvalidationError extends Error {
  constructor(code) {
    super("Recovery invalidation suppression requires exact reviewed refresh hints in an unchanged held candidate.");
    this.name = "RecoveryInvalidationError";this.code = code;
  }
}
function fail(code) { throw new RecoveryInvalidationError(code); }
function validateInvalidationDecisions(events) {
  if (!Array.isArray(events) || events.length < 1 || events.length > 1000) fail("RECOVERY_INVALIDATION_INPUT_INVALID");
  const decisions = events.map(event => {
    if (!event || Object.keys(event).sort().join(",") !== "audienceSha256,eventId,evidenceSha256,leagueId,payloadSha256,reasonCode,rowSha256" ||
        ![event.eventId,event.leagueId].every(value => UUID.test(value || "")) ||
        ![event.rowSha256,event.payloadSha256,event.audienceSha256,event.evidenceSha256].every(value => DIGEST.test(value || "")) ||
        !/^[A-Z][A-Z0-9_]{0,79}$/.test(event.reasonCode || "")) fail("RECOVERY_INVALIDATION_INPUT_INVALID");
    return Object.freeze({ ...event });
  }).sort((left,right) => left.eventId.localeCompare(right.eventId));
  if (new Set(decisions.map(row => row.eventId)).size !== decisions.length) fail("RECOVERY_INVALIDATION_INPUT_INVALID");
  return Object.freeze(decisions);
}
function readReviewedInvalidations(database,events,{ preparedAtMs,reconciledAtMs }) {
  if (!Number.isSafeInteger(preparedAtMs) || preparedAtMs < 0 || !Number.isSafeInteger(reconciledAtMs) || reconciledAtMs < preparedAtMs ||
      database.prepare("SELECT 1 FROM sessions WHERE status='active' LIMIT 1").get() ||
      database.prepare("SELECT 1 FROM account_action_tokens WHERE status='active' LIMIT 1").get()) fail("RECOVERY_INVALIDATION_CREDENTIAL_BOUNDARY_INVALID");
  return events.map(event => {
    const row = database.prepare("SELECT * FROM outbox_events WHERE id=? AND league_id=?").get(event.eventId,event.leagueId);
    if (!row || !["pending","failed","publishing"].includes(row.status) || row.published_at_ms !== null ||
        row.created_at_ms > preparedAtMs || row.updated_at_ms > reconciledAtMs || !Number.isSafeInteger(row.version+1) ||
        hash(canonicalize(row)) !== event.rowSha256 || hash(row.payload_json) !== event.payloadSha256) fail("RECOVERY_INVALIDATION_EVENT_MISMATCH");
    const audiences = database.prepare("SELECT * FROM outbox_event_audiences WHERE outbox_event_id=? AND league_id=? ORDER BY id").all(row.id,row.league_id);
    if (fingerprint(audiences).sha256 !== event.audienceSha256) fail("RECOVERY_INVALIDATION_AUDIENCE_MISMATCH");
    try {
      parseAudiences(audiences,row);
      if (!REFRESH_HINTS.has(parsePayload(row).type)) fail("RECOVERY_INVALIDATION_NOT_REFRESH_HINT");
    } catch (error) {
      if (error instanceof RecoveryInvalidationError) throw error;
      fail("RECOVERY_INVALIDATION_PAYLOAD_INVALID");
    }
    return row;
  });
}
function suppressedInvalidation(row,reconciledAtMs) {
  // Keep the original envelope and publication/attempt history. Discarded is
  // explicit suppression, never a claim that a recipient received this event.
  return { ...row,status: "discarded",last_error_code: ERROR_CODE,updated_at_ms: reconciledAtMs,version: row.version+1 };
}
function invalidationReviewRecords({ plan,events,reconciliationId,reviewedByUserId,reconciledAtMs }) {
  const decisionChecksum = hash(canonicalize(events));
  const metadata = { metadata_key: `recovery_invalidation_review:${reconciliationId}`,metadata_value: canonicalize({ recoveryId: plan.recoveryId,
    reconciliationId,reviewedByUserId,reconciledAtMs,planChecksum: plan.planChecksum,decisionChecksum,disposition: DISPOSITION,events }),
    created_at_ms: reconciledAtMs,updated_at_ms: reconciledAtMs };
  const audit = { id: reconciliationId,event_type: "recovery.invalidations_suppressed",outcome: "success",actor_user_id: reviewedByUserId,
    target_user_id: null,league_id: null,session_id: null,request_correlation_id: plan.recoveryId,reason_code: `invalidation_${decisionChecksum}`,
    network_key_version: null,network_metadata_digest: null,unknown_account_digest: null,client_metadata_json: '{"networkSourceCategory":"local"}',occurred_at_ms: reconciledAtMs };
  return { decisionChecksum,metadata,audit };
}

module.exports = { UUID,DIGEST,ERROR_CODE,DISPOSITION,RecoveryInvalidationError,fail,hash,fingerprint,
  validateInvalidationDecisions,readReviewedInvalidations,suppressedInvalidation,invalidationReviewRecords };
