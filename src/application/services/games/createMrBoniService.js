const crypto = require('node:crypto');
const RULESET_VERSION = 'resurface-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INITIAL = Object.freeze({ highestLevelCompleted: 0, cumulativeTimeMs: null, completed: false, commandsProcessed: 0, rulesetVersion: RULESET_VERSION });
function fail(code) { const error = new Error('The Mr. Boni request could not be completed.'); error.code = code; throw error; }
function exactObject(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
}
function validatedCommands(input) {
  if (!exactObject(input, ['commands'])) fail('MR_BONI_INPUT_INVALID');
  return require('../../../features/mrBoni/commandValidation').validatedCommands(input.commands);
}
function comparePrefix(saved, submitted) {
  for (let index = 0; index < Math.min(saved.length, submitted.length); index++) {
    if (JSON.stringify(saved[index]) !== JSON.stringify(submitted[index])) fail('MR_BONI_PREFIX_CONFLICT');
  }
  return submitted.length > saved.length;
}
function startProjection(row) {
  return { runId: row.id, seed: row.seed, rulesetVersion: row.ruleset_version, createdAt: new Date(row.created_at_ms).toISOString() };
}
function checkedResult(value, commands) {
  const highest = value?.highestLevelCompleted;
  if (!Number.isInteger(highest) || highest < 0 || highest > 3 ||
      (highest === 0 ? value.cumulativeTimeMs !== null : !Number.isSafeInteger(value.cumulativeTimeMs) || value.cumulativeTimeMs <= 0 || value.cumulativeTimeMs > 3600000) ||
      value.completed !== (highest === 3)) fail('MR_BONI_VERIFICATION_FAILED');
  return { highestLevelCompleted: highest, cumulativeTimeMs: value.cumulativeTimeMs, completed: value.completed, commandsProcessed: commands.length, rulesetVersion: RULESET_VERSION };
}
function createMrBoniService({ repositoryContext, repository, leagueAuthorization, teamAuthorization,
  teamAuthorityRepository, clock, secureRandom, verifyRun } = {}) {
  async function verifier(input) {
    return verifyRun ? verifyRun(input) : require('../../../features/mrBoni/replayPool').verifyRun(input);
  }
  function authorize(authenticated, leagueId, manager = false) {
    const member = leagueAuthorization.requireActiveMembership(authenticated, leagueId);
    if (manager) {
      const assignment = teamAuthorityRepository.listCurrentManagedTeams(member.actorUserId).find(row => row.league_id === leagueId);
      if (!assignment) fail('TEAM_MANAGER_REQUIRED');
      teamAuthorization.requireManager(authenticated, leagueId, assignment.team_id);
    }
    if (!repository) fail('MR_BONI_UNAVAILABLE');
    return { leagueId: member.leagueId, userId: member.actorUserId };
  }
  function transaction(callback) {
    try { return repositoryContext.transaction(callback); }
    catch (error) {
      for (let cause = error; cause; cause = cause.cause) {
        if (/^(MR_BONI_|LEAGUE_|TEAM_)/.test(cause.code || '')) throw cause;
      }
      throw error;
    }
  }
  function start({ authenticated, leagueId, input }) {
    if (!exactObject(input, ['clientRunId']) || typeof input.clientRunId !== 'string' || !UUID.test(input.clientRunId)) fail('MR_BONI_INPUT_INVALID');
    return transaction(() => {
      const owner = authorize(authenticated, leagueId, true);
      const existing = repository.findClientRun({ ...owner, clientRunId: input.clientRunId });
      if (existing) return startProjection(existing);
      const runId = secureRandom?.id ? secureRandom.id() : crypto.randomUUID();
      const bytes = secureRandom?.bytes ? secureRandom.bytes(4) : crypto.randomBytes(4);
      const seed = Buffer.from(bytes).readUInt32LE(0), nowMs = clock.nowMs();
      repository.insertRun({ ...owner, id: runId, clientRunId: input.clientRunId, rulesetVersion: RULESET_VERSION,
        seed, resultJson: JSON.stringify(INITIAL), nowMs });
      return startProjection(repository.findRun({ ...owner, runId }));
    });
  }
  async function checkpoint({ authenticated, leagueId, runId, input }) {
    if (typeof runId !== 'string' || !UUID.test(runId)) fail('MR_BONI_INPUT_INVALID');
    const commands = validatedCommands(input), owner = authorize(authenticated, leagueId, true);
    const run = repository.findRun({ ...owner, runId });
    if (!run) fail('MR_BONI_RUN_NOT_FOUND');
    if (run.ruleset_version !== RULESET_VERSION) fail('MR_BONI_RULESET_CONFLICT');
    if (!comparePrefix(JSON.parse(run.commands_json), commands)) return { runId, ...JSON.parse(run.result_json) };
    let result;
    try { result = checkedResult(await verifier({ seed: run.seed, commands }), commands); }
    catch (error) {
      if (['MR_BONI_UNAVAILABLE', 'MR_BONI_VERIFICATION_FAILED', 'MR_BONI_REPLAY_BUSY', 'MR_BONI_REPLAY_TIMEOUT'].includes(error?.code)) throw error;
      fail('MR_BONI_TRANSCRIPT_INVALID');
    }
    // Replay happens outside SQLite's synchronous transaction. Recheck current
    // authority and prefix after awaiting it to handle revocation and racing saves.
    return transaction(() => {
      const currentOwner = authorize(authenticated, leagueId, true);
      const current = repository.findRun({ ...currentOwner, runId });
      if (!current) fail('MR_BONI_RUN_NOT_FOUND');
      if (!comparePrefix(JSON.parse(current.commands_json), commands)) return { runId, ...JSON.parse(current.result_json) };
      const nowMs = clock.nowMs();
      repository.updateRun({ ...currentOwner, runId, commandsJson: JSON.stringify(commands), resultJson: JSON.stringify(result), nowMs });
      if (result.highestLevelCompleted > 0) repository.saveBest({ ...currentOwner,
        id: secureRandom?.id ? secureRandom.id() : crypto.randomUUID(), runId, rulesetVersion: RULESET_VERSION,
        highestLevel: result.highestLevelCompleted, cumulativeTimeMs: result.cumulativeTimeMs, nowMs });
      return { runId, ...result };
    });
  }
  function leaderboard({ authenticated, leagueId }) {
    const owner = authorize(authenticated, leagueId);
    let previous = null, rank = 0;
    const entries = repository.leaderboard({ leagueId, rulesetVersion: RULESET_VERSION }).map((row, index) => {
      const metric = `${row.highest_level_completed}/${row.cumulative_time_ms}`;
      if (metric !== previous) rank = index + 1;
      previous = metric;
      return { rank, managerId: row.user_id, managerName: row.manager_name,
        highestLevelCompleted: row.highest_level_completed, cumulativeTimeMs: row.cumulative_time_ms,
        completed: row.highest_level_completed === 3, updatedAt: new Date(row.updated_at_ms).toISOString() };
    });
    return { rulesetVersion: RULESET_VERSION, entries, personalBest: entries.find(row => row.managerId === owner.userId) || null };
  }
  return Object.freeze({ start, checkpoint, leaderboard });
}
module.exports = { createMrBoniService, RULESET_VERSION, validatedCommands, exactObject, checkedResult, comparePrefix, startProjection, INITIAL, UUID };
