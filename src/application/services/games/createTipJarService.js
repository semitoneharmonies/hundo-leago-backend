const crypto = require('node:crypto');
const RULESET_VERSION = 'campaign-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INITIAL = Object.freeze({ highestLevelCompleted: 0, shotsToCompletion: null, shotsUsed: 0,
  level: 1, pucks: 20, completed: false, failed: false, levelResults: [] });
function fail(code) { const error = new Error('The Tip Jar request could not be completed.'); error.code = code; throw error; }
function exactObject(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
}
function validatedShots(input) {
  if (!exactObject(input, ['shots']) || !Array.isArray(input.shots) || input.shots.length > 60) fail('TIP_JAR_INPUT_INVALID');
  return input.shots.map(shot => {
    if (!exactObject(shot, ['time', 'x', 'height', 'power']) ||
      !Object.values(shot).every(value => typeof value === 'number' && Number.isFinite(value)) ||
      shot.time < 0 || shot.time > 86400 || Math.abs(shot.x) > 1.4048 ||
      shot.height < .025 || shot.height > 1.1298 || shot.power < 15 || shot.power > 100) fail('TIP_JAR_INPUT_INVALID');
    return { time: shot.time, x: shot.x, height: shot.height, power: shot.power };
  });
}
function comparePrefix(saved, submitted) {
  for (let index = 0; index < Math.min(saved.length, submitted.length); index++) {
    if (JSON.stringify(saved[index]) !== JSON.stringify(submitted[index])) fail('TIP_JAR_PREFIX_CONFLICT');
  }
  return submitted.length > saved.length;
}
function startProjection(row) {
  return { runId: row.id, seed: row.seed, rulesetVersion: row.ruleset_version, createdAt: new Date(row.created_at_ms).toISOString() };
}
function checkedResult(value, shots) {
  const highest = value?.highestLevelCompleted;
  if (!Number.isInteger(highest) || highest < 0 || highest > 3 || value.shotsUsed !== shots.length ||
    (highest === 0 ? value.shotsToCompletion !== null : !Number.isInteger(value.shotsToCompletion) || value.shotsToCompletion < 3 || value.shotsToCompletion > shots.length) ||
    value.completed !== (highest === 3) || typeof value.failed !== 'boolean' ||
    !Number.isInteger(value.pucks) || value.pucks < 0 || value.pucks > 60 ||
    !Number.isInteger(value.level) || value.level < 1 || value.level > 3 || !Array.isArray(value.levelResults)) fail('TIP_JAR_VERIFICATION_FAILED');
  // Explicit projection prevents implementation/debug fields leaking through the API.
  return { highestLevelCompleted: highest, shotsToCompletion: value.shotsToCompletion, shotsUsed: value.shotsUsed,
    level: value.level, pucks: value.pucks, completed: value.completed, failed: value.failed,
    levelResults: value.levelResults.map(({ level, shots: count, totalShots }) => ({ level, shots: count, totalShots })) };
}
function createTipJarService({ repositoryContext, repository, leagueAuthorization, teamAuthorization,
  teamAuthorityRepository, clock, secureRandom, verifyRun } = {}) {
  let rulesPromise;
  async function verifier(input) {
    if (verifyRun) return verifyRun(input);
    try { rulesPromise ||= import('../../../features/tipJar/rules/league-rules.js');
      const rules = await rulesPromise;
      if (rules.RULESET_VERSION !== RULESET_VERSION) fail('TIP_JAR_UNAVAILABLE');
      return rules.verifyRun(input);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'TIP_JAR_UNAVAILABLE') fail('TIP_JAR_UNAVAILABLE');
      throw error;
    }
  }
  function authorize(authenticated, leagueId, manager = false) {
    const member = leagueAuthorization.requireActiveMembership(authenticated, leagueId);
    if (manager) {
      const assignment = teamAuthorityRepository.listCurrentManagedTeams(member.actorUserId).find(row => row.league_id === leagueId);
      if (!assignment) fail('TEAM_MANAGER_REQUIRED');
      teamAuthorization.requireManager(authenticated, leagueId, assignment.team_id);
    }
    if (!repository) fail('TIP_JAR_UNAVAILABLE');
    return { leagueId: member.leagueId, userId: member.actorUserId };
  }
  function transaction(callback) {
    try { return repositoryContext.transaction(callback); }
    catch (error) {
      for (let cause = error; cause; cause = cause.cause) {
        if (/^(TIP_JAR_|LEAGUE_|TEAM_)/.test(cause.code || '')) throw cause;
      }
      throw error;
    }
  }
  function start({ authenticated, leagueId, input }) {
    if (!exactObject(input, ['clientRunId']) || !UUID.test(input.clientRunId)) fail('TIP_JAR_INPUT_INVALID');
    return transaction(() => {
      const owner = authorize(authenticated, leagueId, true);
      const existing = repository.findClientRun({ ...owner, clientRunId: input.clientRunId });
      if (existing) return startProjection(existing);
      const runId = secureRandom?.id ? secureRandom.id() : crypto.randomUUID();
      const bytes = secureRandom?.bytes ? secureRandom.bytes(4) : crypto.randomBytes(4);
      const seed = Buffer.from(bytes).readUInt32LE(0), nowMs = clock.nowMs();
      repository.insertRun({ ...owner, id: runId, clientRunId: input.clientRunId, rulesetVersion: RULESET_VERSION,
        seed, resultJson: JSON.stringify(INITIAL), nowMs });
      repository.saveBest({ ...owner, id: secureRandom?.id ? secureRandom.id() : crypto.randomUUID(), runId,
        rulesetVersion: RULESET_VERSION, highestLevel: 0, shotsToCompletion: null, nowMs });
      return startProjection(repository.findRun({ ...owner, runId }));
    });
  }
  async function checkpoint({ authenticated, leagueId, runId, input }) {
    if (!UUID.test(runId)) fail('TIP_JAR_INPUT_INVALID');
    const shots = validatedShots(input), owner = authorize(authenticated, leagueId, true);
    const run = repository.findRun({ ...owner, runId });
    if (!run) fail('TIP_JAR_RUN_NOT_FOUND');
    if (run.ruleset_version !== RULESET_VERSION) fail('TIP_JAR_RULESET_CONFLICT');
    if (!comparePrefix(JSON.parse(run.shots_json), shots)) return { runId, ...JSON.parse(run.result_json) };
    let result;
    try { result = checkedResult(await verifier({ seed: run.seed, shots }), shots); }
    catch (error) {
      if (['TIP_JAR_UNAVAILABLE', 'TIP_JAR_VERIFICATION_FAILED'].includes(error?.code)) throw error;
      fail('TIP_JAR_TRANSCRIPT_INVALID');
    }
    // Replay happens outside SQLite's synchronous transaction. Recheck current
    // authority and prefix after awaiting it to handle revocation and racing saves.
    return transaction(() => {
      const currentOwner = authorize(authenticated, leagueId, true);
      const current = repository.findRun({ ...currentOwner, runId });
      if (!current) fail('TIP_JAR_RUN_NOT_FOUND');
      if (!comparePrefix(JSON.parse(current.shots_json), shots)) return { runId, ...JSON.parse(current.result_json) };
      const nowMs = clock.nowMs();
      repository.updateRun({ ...currentOwner, runId, shotsJson: JSON.stringify(shots), resultJson: JSON.stringify(result), nowMs });
      if (result.highestLevelCompleted > 0) repository.saveBest({ ...currentOwner,
        id: secureRandom?.id ? secureRandom.id() : crypto.randomUUID(), runId, rulesetVersion: RULESET_VERSION,
        highestLevel: result.highestLevelCompleted, shotsToCompletion: result.shotsToCompletion, nowMs });
      return { runId, ...result };
    });
  }
  function leaderboard({ authenticated, leagueId }) {
    const owner = authorize(authenticated, leagueId);
    let previous = null, rank = 0;
    const entries = repository.leaderboard({ leagueId, rulesetVersion: RULESET_VERSION }).map((row, index) => {
      const metric = `${row.highest_level_completed}/${row.shots_to_completion}`;
      if (metric !== previous) rank = index + 1;
      previous = metric;
      return { rank, managerId: row.user_id, managerName: row.manager_name,
        highestLevelCompleted: row.highest_level_completed, shotsToCompletion: row.shots_to_completion,
        completed: row.highest_level_completed === 3, updatedAt: new Date(row.updated_at_ms).toISOString() };
    });
    return { rulesetVersion: RULESET_VERSION, entries, personalBest: entries.find(row => row.managerId === owner.userId) || null };
  }
  return Object.freeze({ start, checkpoint, leaderboard });
}
module.exports = { createTipJarService, RULESET_VERSION, validatedShots, exactObject, checkedResult, comparePrefix, startProjection, INITIAL, UUID };
