const crypto = require('node:crypto');
const { RULESET_VERSION, validatedCommands, exactObject, checkedResult, comparePrefix, startProjection, INITIAL, UUID } = require('./createMrBoniService');
const GUEST_KEY = /^[0-9a-f]{64}$/;
function fail(code) { const error = new Error('The Mr. Boni request could not be completed.'); error.code = code; throw error; }
function guestIdentity(key) {
  if (typeof key !== 'string' || !GUEST_KEY.test(key)) fail('MR_BONI_INPUT_INVALID');
  return crypto.createHash('sha256').update(`mrboni-guest\0${key}`).digest('hex');
}
function displayName(value) {
  if (typeof value !== 'string') fail('MR_BONI_NAME_INVALID');
  const name = value.normalize('NFKC').trim().replace(/ +/g, ' ');
  if ([...name].length < 1 || [...name].length > 30 || !/^[\p{L}\p{N} ._'’-]+$/u.test(name) || !/[\p{L}\p{N}]/u.test(name)) fail('MR_BONI_NAME_INVALID');
  return name;
}
function createMrBoniPublicService({ repositoryContext, repository, clock, secureRandom, verifyRun } = {}) {
  const id = () => secureRandom?.id ? secureRandom.id() : crypto.randomUUID();
  function available() { if (!repository) fail('MR_BONI_UNAVAILABLE'); }
  function transaction(callback) {
    try { return repositoryContext.transaction(callback); }
    catch (error) {
      for (let cause=error; cause; cause=cause.cause) if (/^MR_BONI_/.test(cause.code || '')) throw cause;
      throw error;
    }
  }
  function best(guestHash) { return repository.findBest({ guestHash, rulesetVersion: RULESET_VERSION }); }
  function qualifies(row) {
    return Boolean(row?.highest_level_completed > 0 && repository.betterCount({ rulesetVersion: RULESET_VERSION,
      playerId: row.id, highestLevel: row.highest_level_completed, cumulativeTimeMs: row.cumulative_time_ms }) < 100);
  }
  function receipt(run, guestHash) {
    const currentBest = best(guestHash);
    const result = JSON.parse(run.result_json);
    return { runId: run.id, ...result, qualifies: result.highestLevelCompleted > 0 && qualifies(currentBest), named: Boolean(currentBest?.display_name) };
  }
  async function verifier(seed, commands) {
    return verifyRun ? verifyRun({ seed, commands }) : require('../../../features/mrBoni/replayPool').verifyRun({ seed, commands });
  }
  function start({ input }) {
    available();
    if (!exactObject(input, ['clientRunId', 'guestKey']) || typeof input.clientRunId !== 'string' || !UUID.test(input.clientRunId)) fail('MR_BONI_INPUT_INVALID');
    const guestHash = guestIdentity(input.guestKey);
    return transaction(() => {
      const existing = repository.findClientRun({ guestHash, clientRunId: input.clientRunId });
      if (existing) return startProjection(existing);
      const runId=id(), bytes=secureRandom?.bytes ? secureRandom.bytes(4) : crypto.randomBytes(4), nowMs=clock.nowMs();
      repository.insertRun({ id:runId,guestHash,clientRunId:input.clientRunId,rulesetVersion:RULESET_VERSION,
        seed:Buffer.from(bytes).readUInt32LE(0),resultJson:JSON.stringify(INITIAL),nowMs });
      return startProjection(repository.findRun({ guestHash, runId }));
    });
  }
  async function checkpoint({ runId, input }) {
    available();
    if (typeof runId !== 'string' || !UUID.test(runId) || !exactObject(input, ['commands', 'guestKey'])) fail('MR_BONI_INPUT_INVALID');
    const guestHash=guestIdentity(input.guestKey), commands=validatedCommands({ commands:input.commands });
    const run=repository.findRun({ guestHash,runId });
    if (!run) fail('MR_BONI_RUN_NOT_FOUND');
    if (run.ruleset_version !== RULESET_VERSION) fail('MR_BONI_RULESET_CONFLICT');
    if (!comparePrefix(JSON.parse(run.commands_json),commands)) return receipt(run,guestHash);
    let result;
    try { result=checkedResult(await verifier(run.seed,commands),commands); }
    catch (error) {
      if (['MR_BONI_UNAVAILABLE','MR_BONI_VERIFICATION_FAILED','MR_BONI_REPLAY_BUSY','MR_BONI_REPLAY_TIMEOUT'].includes(error?.code)) throw error;
      fail('MR_BONI_TRANSCRIPT_INVALID');
    }
    return transaction(() => {
      const current=repository.findRun({ guestHash,runId });
      if (!current) fail('MR_BONI_RUN_NOT_FOUND');
      if (!comparePrefix(JSON.parse(current.commands_json),commands)) return receipt(current,guestHash);
      const nowMs=clock.nowMs();
      repository.updateRun({ guestHash,runId,commandsJson:JSON.stringify(commands),resultJson:JSON.stringify(result),nowMs });
      if (result.highestLevelCompleted>0) repository.saveBest({ id:id(),guestHash,runId,rulesetVersion:RULESET_VERSION,
        highestLevel:result.highestLevelCompleted,cumulativeTimeMs:result.cumulativeTimeMs,nowMs });
      return receipt(repository.findRun({ guestHash,runId }),guestHash);
    });
  }
  function name({ runId, input }) {
    available();
    if (typeof runId !== 'string' || !UUID.test(runId) || !exactObject(input,['guestKey','name'])) fail('MR_BONI_INPUT_INVALID');
    const guestHash=guestIdentity(input.guestKey), name=displayName(input.name);
    return transaction(() => {
      const run=repository.findRun({ guestHash,runId });
      if (!run) fail('MR_BONI_RUN_NOT_FOUND');
      const currentBest=best(guestHash), eligible=qualifies(currentBest);
      if (currentBest?.display_name) {
        if (currentBest.display_name !== name) fail('MR_BONI_NAME_CONFLICT');
        return { saved:true,qualifies:eligible };
      }
      if (!eligible || JSON.parse(run.result_json).highestLevelCompleted<1) return { saved:false,qualifies:false };
      repository.nameBest({ guestHash,name });
      return { saved:true,qualifies:true };
    });
  }
  function leaderboard() {
    available();
    return { rulesetVersion:RULESET_VERSION,entries:repository.leaderboard({ rulesetVersion:RULESET_VERSION }).map(row => ({
      rank:row.rank,playerId:row.is_guest ? `guest:${row.player_id}` : `account:${crypto.createHash('sha256').update(`mrboni-public\0${row.player_id}`).digest('hex')}`,
      playerName:row.player_name,isGuest:Boolean(row.is_guest),highestLevelCompleted:row.highest_level_completed,
      cumulativeTimeMs:row.cumulative_time_ms,completed:row.highest_level_completed===3,updatedAt:new Date(row.updated_at_ms).toISOString(),
    })) };
  }
  return Object.freeze({ start,checkpoint,name,leaderboard });
}
module.exports = { createMrBoniPublicService, guestIdentity, displayName };
