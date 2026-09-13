const crypto = require("node:crypto");
const { canonicalize } = require("../../infrastructure/migration/sourceInventory");

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const STATES = new Set(["pending", "leased", "running", "succeeded", "failed", "skipped"]);
const terminal = state => state === "succeeded" || state === "skipped";
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
const text = (value, maximum) => typeof value === "string" && value.length > 0 && value.length <= maximum &&
  value === value.trim() && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
class RecoveryJobEvidenceError extends Error {
  constructor(code) {
    super("Recovery job evidence requires exact, unambiguous recorded occurrences. No replay is permitted.");
    this.name = "RecoveryJobEvidenceError"; this.code = code;
  }
}
function fail(code = "RECOVERY_JOB_EVIDENCE_INVALID") { throw new RecoveryJobEvidenceError(code); }
function table(snapshot, name) {
  const entries = snapshot?.tables?.[name]?.rows;
  if (!(entries instanceof Map)) fail();
  return [...entries.values()].map(value => value.row);
}
function jobs(snapshot, observedAtMs) {
  const leagues = new Set(table(snapshot, "leagues").map(row => row.id));
  const seasons = new Map(table(snapshot, "seasons").map(row => [row.id, row.league_id]));
  const records = new Map(), ids = new Set();
  for (const row of table(snapshot, "job_runs")) {
    if (!row || !UUID.test(row.id || "") || ids.has(row.id) || !STATES.has(row.status) ||
        !text(row.job_type, 120) || !/^[a-zA-Z0-9:._-]+$/.test(row.job_type) || !text(row.occurrence_key, 1000) ||
        (row.league_id !== null && (!UUID.test(row.league_id || "") || !leagues.has(row.league_id))) ||
        (row.season_id !== null && (!UUID.test(row.season_id || "") || seasons.get(row.season_id) !== row.league_id)) ||
        !Number.isSafeInteger(row.version) || row.version < 1 || !Number.isSafeInteger(row.attempt_count) || row.attempt_count < 0 ||
        !timestamp(row.scheduled_for_ms) || !timestamp(row.created_at_ms) || !timestamp(row.updated_at_ms) ||
        [row.started_at_ms,row.completed_at_ms,row.lease_expires_at_ms].some(value => value !== null && !timestamp(value)) ||
        (row.result_json !== null && typeof row.result_json !== "string")) fail();
    if (row.result_json !== null) {
      try { JSON.parse(row.result_json); } catch { fail(); }
    }
    ids.add(row.id);
    const occurrenceKeySha256 = hash(canonicalize([row.league_id, row.job_type, row.occurrence_key]));
    if (records.has(occurrenceKeySha256)) fail("RECOVERY_JOB_EVIDENCE_AMBIGUOUS");
    records.set(occurrenceKeySha256, {
      identity: { jobId: row.id, leagueId: row.league_id, seasonId: row.season_id, jobType: row.job_type,
        occurrenceKeySha256, scheduledForMs: row.scheduled_for_ms },
      evidence: { status: row.status, version: row.version, attemptCount: row.attempt_count,
        rowSha256: hash(canonicalize(row)), resultSha256: row.result_json === null ? null : hash(row.result_json),
        completedAtMs: row.completed_at_ms, leaseRecorded: row.lease_expires_at_ms !== null,
        leaseExpired: row.lease_expires_at_ms === null ? null : row.lease_expires_at_ms <= observedAtMs },
    });
  }
  return records;
}

// Only consumes the verified private database snapshots. A recorded result is
// neither independent external evidence nor authority to repeat a side effect.
function summarizeRecoveryJobEvidence(restored, preserved, observedAtMs) {
  if (!timestamp(observedAtMs)) fail();
  const left = jobs(restored, observedAtMs), right = jobs(preserved, observedAtMs);
  const identities = new Map();
  for (const record of [...left.values(), ...right.values()]) {
    const previous = identities.get(record.identity.jobId);
    if (previous && canonicalize(previous) !== canonicalize(record.identity)) fail("RECOVERY_JOB_EVIDENCE_IDENTITY_CHANGED");
    identities.set(record.identity.jobId, record.identity);
  }
  const occurrences = [...new Set([...left.keys(), ...right.keys()])].sort().map(key => {
    const before = left.get(key), after = right.get(key);
    if (before && after && canonicalize(before.identity) !== canonicalize(after.identity)) fail("RECOVERY_JOB_EVIDENCE_IDENTITY_CHANGED");
    const restored = before?.evidence ?? null, preserved = after?.evidence ?? null;
    const terminalConflict = !!(restored && preserved && terminal(restored.status) &&
      (!terminal(preserved.status) || restored.status !== preserved.status || restored.resultSha256 !== preserved.resultSha256));
    const recordedCompletionAfterBackup = !!(restored && preserved && !terminal(restored.status) && terminal(preserved.status));
    return { ...(before ?? after).identity, restored, preserved,
      comparison: !before ? "absent-from-backup" : !after ? "absent-from-preserved-copy" :
        restored.rowSha256 === preserved.rowSha256 ? "unchanged" : "changed-after-backup",
      recordedCompletionAfterBackup, terminalConflict,
      recordedResultMatches: restored?.resultSha256 && preserved?.resultSha256 ? restored.resultSha256 === preserved.resultSha256 : null,
      domainOutcomeVerified: false, externalOutcomeVerified: false, replayPermitted: false };
  });
  return { summaryVersion: 1, scope: "recorded-job-occurrences", occurrences,
    changedOccurrences: occurrences.filter(row => row.comparison !== "unchanged").length,
    recordedCompletionsAfterBackup: occurrences.filter(row => row.recordedCompletionAfterBackup).length,
    terminalConflicts: occurrences.filter(row => row.terminalConflict).length,
    missingFromBackup: occurrences.filter(row => row.comparison === "absent-from-backup").length,
    missingFromPreservedCopy: occurrences.filter(row => row.comparison === "absent-from-preserved-copy").length,
    completeReconciliation: false, activationReady: false, replayPermitted: false };
}

module.exports = { RecoveryJobEvidenceError, summarizeRecoveryJobEvidence };
