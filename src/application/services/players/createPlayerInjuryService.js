const { parseInjuryList } = require('../../../domain/players/injuryListPolicy');
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function invalid() { throw Object.assign(new Error('Check the injury update and try again.'), { code: 'INJURY_INPUT_INVALID' }); }
function createPlayerInjuryService({ repository, platformAuthorization, adapter = null,
  automaticRepository = null, automaticEnabled = false, nowMs = Date.now } = {}) {
  async function refresh({ authenticated, scheduled = false } = {}) {
    if (!scheduled) platformAuthorization.requireAdministrator(authenticated);
    if (!adapter) throw Object.assign(new Error('No verified injury source is enabled.'), { code: 'INJURY_FEED_UNAVAILABLE' });
    const token = repository.claim(!scheduled);
    if (!token) return { status: 'skipped', reason: 'not_due_or_running' };
    try {
      const snapshot = await adapter.fetchSnapshot({ mappedIds: repository.mappedIds() });
      return { status: 'succeeded', ...repository.apply(snapshot, token) };
    } catch (error) {
      const code = /^INJURY_[A-Z_]+$/.test(error?.code || '') ? error.code : 'INJURY_REFRESH_FAILED';
      repository.fail(token, code);
      throw Object.assign(new Error('Injury refresh failed; existing statuses were preserved.'), { code });
    }
  }
  function authorize(input, authenticated, allowed) {
    const actorId = platformAuthorization.requireAdministrator(authenticated).actorUserId;
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key)) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) invalid();
    return actorId;
  }
  function decision(input, authenticated, mapping) {
    const actorId = authorize(input, authenticated, ['playerId','expectedVersion','reason',mapping ? 'providerId' : 'status']);
    if (!ID.test(input.playerId || '') || typeof input.reason !== 'string' || input.reason.trim().length < 3 || input.reason.length > 500) invalid();
    if (mapping ? !/^\d{1,15}$/.test(input.providerId || '') : !['injured','healthy','unknown'].includes(input.status)) invalid();
    return repository[mapping ? 'map' : 'decide']({ ...input, reason: input.reason.trim(), actorId });
  }
  return {
    previewList: ({ input, authenticated }) => listDecision(input, authenticated, false),
    applyList: ({ input, authenticated }) => listDecision(input, authenticated, true),
    list({ authenticated, search = '' }) {
      platformAuthorization.requireAdministrator(authenticated);
      if (typeof search !== 'string' || search.length > 100) invalid();
      const result = repository.list({ search: search.trim() });
      if (!automaticRepository) return result;
      const state = automaticRepository.state();
      const mappings = new Map(automaticRepository.listMappings().map(row => [row.providerPlayerId, row.playerId]));
      const feed = automaticRepository.listFeed();
      if (!automaticEnabled && state.lastSuccessAtMs === null && feed.length === 0) return result;
      const byPlayer = new Map(feed.filter(row => mappings.has(row.id)).map(row => [mappings.get(row.id), row]));
      return { ...result, sync: { enabled: automaticEnabled === true, lastSuccessAtMs: state.lastSuccessAtMs, errorCode: state.errorCode },
        players: result.players.map(row => row.source !== 'realtime' ? row : { ...row,
          stale: nowMs() - row.observedAtMs > require('../../../domain/players/injuryStatusPolicy').REALTIME_STALE_AFTER_MS,
          designation: byPlayer.get(row.id)?.designation ?? row.designation,
          injuryType: byPlayer.get(row.id)?.medical_reason ?? row.injuryType }),
        unmatched: feed.filter(row => row.present && row.classification !== 'excluded' && !mappings.has(row.id)).slice(0, 100)
          .map(row => ({ id: row.id, name: row.name, birthDate: null, team: row.team,
            designation: row.designation, injuryType: row.medical_reason, version: row.version })) };
    },
    decide: ({ input, authenticated }) => decision(input, authenticated, false),
    map: ({ input, authenticated }) => decision(input, authenticated, true),
    settings({ input, authenticated }) {
      const actorId = authorize(input, authenticated, ['enabled','expectedVersion']);
      if (typeof input.enabled !== 'boolean') invalid();
      if (input.enabled && !adapter) throw Object.assign(new Error('No verified injury source is enabled.'), { code: 'INJURY_FEED_UNAVAILABLE' });
      return repository.settings({ ...input, actorId });
    },
    refresh: ({ authenticated }) => refresh({ authenticated }),
    runScheduled: () => refresh({ scheduled: true }),
  };
  function listDecision(input, authenticated, apply) {
    const actorId = platformAuthorization.requireAdministrator(authenticated).actorUserId;
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['text', 'resolutions', ...(apply ? ['expectedRevision', 'confirmReplacement'] : [])].includes(key))) invalid();
    const rows = parseInjuryList(input.text);
    const resolutions = input.resolutions ?? {};
    if (!resolutions || typeof resolutions !== 'object' || Array.isArray(resolutions) ||
      Object.entries(resolutions).some(([key, value]) => !rows.some(row => row.key === key) || (value !== 'skip' && !ID.test(value)))) invalid();
    if (apply && (!/^[a-f0-9]{64}$/.test(input.expectedRevision || '') || input.confirmReplacement !== true)) invalid();
    return repository[apply ? 'applyList' : 'previewList']({ rows, resolutions, actorId, expectedRevision: input.expectedRevision });
  }
}
module.exports = { createPlayerInjuryService };
