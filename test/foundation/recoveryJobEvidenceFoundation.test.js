const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { canonicalize } = require("../../src/infrastructure/migration/sourceInventory");
const { summarizeRecoveryJobEvidence } = require("../../src/operations/backups/summarizeRecoveryJobEvidence");
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const X = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", Y = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const job = changes => ({ id: X, league_id: A, season_id: null, job_type: "statistics:completed_games",
  occurrence_key: "private-occurrence-key", status: "running", version: 1, attempt_count: 1, scheduled_for_ms: 10,
  created_at_ms: 10, updated_at_ms: 20, started_at_ms: 20, completed_at_ms: null, lease_expires_at_ms: 40,
  lease_owner: "private-owner", lease_token: "private-token", result_json: null, ...changes });
const snapshot = jobs => ({ tables: Object.fromEntries(Object.entries({ leagues: [{ id: A }, { id: B }],
  seasons: [], job_runs: jobs }).map(([name,rows]) => [name,{ rows: new Map(rows.map((row,index) => [String(index),{ row }])) }])) });

test("job evidence joins exact league-scoped occurrences and keeps recorded completion separate from replay authority", () => {
  const old = job({}), unrelated = job({ id: Y, league_id: B, status: "succeeded", completed_at_ms: 30,
    result_json: '{"private-result":"second-league"}', lease_expires_at_ms: null });
  const current = job({ status: "succeeded", version: 2, updated_at_ms: 30, completed_at_ms: 30,
    result_json: '{"private-result":"provider-receipt"}', lease_owner: null, lease_token: null, lease_expires_at_ms: null });
  const left = snapshot([old,unrelated]), right = snapshot([current,unrelated]), copies = structuredClone([left,right]);
  const result = summarizeRecoveryJobEvidence(left,right,50), row = result.occurrences.find(row => row.jobId === X);
  assert.equal(result.occurrences.length,2); assert.equal(result.changedOccurrences,1);
  assert.equal(result.recordedCompletionsAfterBackup,1); assert.equal(result.terminalConflicts,0);
  assert.equal(row.occurrenceKeySha256,hash(canonicalize([A,old.job_type,old.occurrence_key])));
  assert.equal(row.restored.rowSha256,hash(canonicalize(old))); assert.equal(row.preserved.rowSha256,hash(canonicalize(current)));
  assert.equal(row.preserved.resultSha256,hash(current.result_json)); assert.equal(row.recordedResultMatches,null);
  assert.equal(row.restored.leaseExpired,true); assert.equal(row.preserved.leaseExpired,null);
  assert.equal(row.domainOutcomeVerified,false); assert.equal(row.externalOutcomeVerified,false); assert.equal(row.replayPermitted,false);
  assert.equal(result.occurrences.find(row => row.jobId === Y).recordedResultMatches,true);
  assert.equal(result.completeReconciliation,false); assert.equal(result.activationReady,false);
  assert.equal(JSON.stringify(result).includes("private-"),false); assert.deepEqual([left,right],copies);
});

test("job evidence exposes missing occurrences, changed terminal results and terminal regressions without assuming external effects", () => {
  const done = job({ status: "succeeded", result_json: '{"result":1}', completed_at_ms: 30 });
  const changed = job({ status: "succeeded", result_json: '{"result":2}', completed_at_ms: 35, version: 2 });
  assert.equal(summarizeRecoveryJobEvidence(snapshot([done]),snapshot([changed]),50).terminalConflicts,1);
  assert.equal(summarizeRecoveryJobEvidence(snapshot([done]),snapshot([job({})]),50).terminalConflicts,1);
  assert.equal(summarizeRecoveryJobEvidence(snapshot([]),snapshot([done]),50).missingFromBackup,1);
  assert.equal(summarizeRecoveryJobEvidence(snapshot([done]),snapshot([]),50).missingFromPreservedCopy,1);
  const empty = summarizeRecoveryJobEvidence(snapshot([job({})]),snapshot([job({})]),50);
  assert.equal(empty.occurrences[0].recordedResultMatches,null); assert.equal(empty.replayPermitted,false);
});

test("job evidence rejects reused identities, ambiguous occurrences and unsafe recorded state", () => {
  const left = snapshot([job({})]);
  for (const change of [{ id: Y }, { league_id: B }, { occurrence_key: "different" }, { scheduled_for_ms: 11 }]) {
    assert.throws(() => summarizeRecoveryJobEvidence(left,snapshot([job(change)]),50), { code: "RECOVERY_JOB_EVIDENCE_IDENTITY_CHANGED" });
  }
  assert.throws(() => summarizeRecoveryJobEvidence(left,snapshot([job({}),job({ id: Y })]),50), { code: "RECOVERY_JOB_EVIDENCE_AMBIGUOUS" });
  for (const change of [{ status: "unrecognized" }, { version: Number.MAX_SAFE_INTEGER + 1 }, { attempt_count: -1 },
    { result_json: "broken" }, { season_id: Y }, { lease_expires_at_ms: 0.5 }, { occurrence_key: "bad\nkey" }]) {
    assert.throws(() => summarizeRecoveryJobEvidence(left,snapshot([job(change)]),50), { code: "RECOVERY_JOB_EVIDENCE_INVALID" });
  }
  assert.throws(() => summarizeRecoveryJobEvidence({},left,50), { code: "RECOVERY_JOB_EVIDENCE_INVALID" });
});
