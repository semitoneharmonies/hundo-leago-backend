const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function invalid() { throw Object.assign(new Error('Check the injury update and try again.'), { code: 'INJURY_INPUT_INVALID' }); }
function createPlayerInjuryService({ repository, platformAuthorization, adapter = null } = {}) {
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
    list({ authenticated, search = '' }) {
      platformAuthorization.requireAdministrator(authenticated);
      if (typeof search !== 'string' || search.length > 100) invalid();
      return repository.list({ search: search.trim() });
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
}
module.exports = { createPlayerInjuryService };
