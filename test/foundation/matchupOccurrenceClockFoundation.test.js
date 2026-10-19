const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createRunMatchupOccurrencesJob } = require('../../src/jobs/definitions/runMatchupOccurrences');
const { M6_JOB_TYPES } = require('../../src/domain/matchups/matchupJobPolicy');
const { evaluateFinalSource } = require('../../src/domain/matchups/matchupResultPolicy');

test('a long refresh gives the next occurrence a current observation time and a fresh lease', async () => {
  const initial = 1792437000000;
  let now = initial;
  let completedAtMs;
  const claims = [], failures = [];
  const due = ['matchup:statistics_refresh', 'matchup:finalize'].map((job_type, i) => ({
    id: 'run-' + i, league_id: 'league', season_id: 'season', job_type, occurrence_key: 'key-' + i,
  }));
  const repository = {
    listDue(input) { assert.equal(input.nowMs, initial); return due; },
    claim(input) {
      claims.push(input);
      return { acquired: true, occurrence: due.find(r => r.job_type === input.jobType),
        occurrenceExecution: Object.freeze({ ...input, runId: 'run-' + claims.length, claimedJobVersion: 1 }) };
    },
    succeed() {}, skipSuperseded() {}, fail(input) { failures.push(input); },
  };
  const handlers = Object.fromEntries(M6_JOB_TYPES.map(type => [type, async () => { throw Error('Unexpected job'); }]));
  handlers['matchup:statistics_refresh'] = async () => { now += 6 * 60_000; completedAtMs = now; };
  handlers['matchup:finalize'] = async (_, observedAtMs) => {
    assert.equal(evaluateFinalSource({ weekEndsAtMs: initial - 60_000, refreshCompletedAtMs: completedAtMs, nowMs: observedAtMs }).ready, true);
  };
  const job = createRunMatchupOccurrencesJob({ repository, handlers,
    executionGuard: { assertCurrent() {} }, clock: { nowMs: () => now },
    secureRandom: { id: () => 'lease-token' }, leaseOwner: 'test-owner',
    logger: { info() {}, error() {}, warn() {} },
  });
  const result = await job.run();
  assert.equal(result.succeeded, 2);
  assert.deepEqual(failures, []);
  assert.equal(claims[1].nowMs, completedAtMs);
  assert.equal(claims[1].leaseExpiresAtMs, completedAtMs + 5 * 60_000);
});
