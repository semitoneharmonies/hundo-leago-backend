const { dueRealtimeInjuryOccurrence } = require('../../domain/players/realtimeInjurySchedule');
const { resolveRealtimeIdentityCandidates } = require('../../domain/players/realtimeInjuryPolicy');
const { createJobRunner } = require('../runJob');

function createRefreshRealtimeInjuriesJob({ repository, adapter, recoveryReader, initialMappings = [], clock,
  timeZone = 'Etc/GMT+8', logger = console } = {}) {
  if (!repository?.claim || !repository?.apply || !repository?.registerMappings || !repository?.listMappings
    || !repository?.readIdentityCatalogue || !adapter?.fetchSnapshot || !clock?.nowMs || !Array.isArray(initialMappings)) {
    throw new TypeError('The injury job requires its own repository, provider and clock.');
  }
  return createJobRunner({ name: 'players:realtime_injuries', logger, async execute() {
    const atMs = clock.nowMs();
    const occurrence = dueRealtimeInjuryOccurrence(atMs, { timeZone });
    if (!occurrence) return { status: 'skipped', reason: 'not_due' };
    const claim = repository.claim({ ...occurrence, atMs });
    if (claim.status !== 'claimed') return claim;
    try {
      const snapshot = await adapter.fetchSnapshot();
      const catalogue = repository.readIdentityCatalogue();
      const existing = repository.listMappings();
      const providerIds = new Set(existing.map(row => row.providerPlayerId));
      const nhlIds = new Set(existing.map(row => row.nhlPlayerId));
      const availableIds = new Set(catalogue.map(row => row.nhlPlayerId));
      const presentIds = new Set(snapshot.rows.map(row => row.providerPlayerId));
      const reviewed = initialMappings.filter(row => presentIds.has(row.providerPlayerId) && availableIds.has(row.nhlPlayerId)
        && !providerIds.has(row.providerPlayerId) && !nhlIds.has(row.nhlPlayerId) && row.verifiedAtMs <= clock.nowMs());
      const automatic = resolveRealtimeIdentityCandidates({ snapshot, catalogue,
        mappings: [...existing, ...reviewed], nowMs: clock.nowMs() });
      const newMappings = [...reviewed, ...automatic.mappings];
      if (newMappings.length) repository.registerMappings(newMappings);
      let recoveryProofs = {};
      if (recoveryReader && repository.recoveryCandidates) {
        try {
          recoveryProofs = await recoveryReader.read({ candidates: repository.recoveryCandidates(snapshot), nowMs: clock.nowMs() });
          if (recoveryProofs.warnings?.length) logger.error?.('realtime_injuries.recovery_evidence_unavailable', { code: 'INJURY_RECOVERY_EVIDENCE_UNAVAILABLE', count: recoveryProofs.warnings.length });
        } catch {
          // Lack of recovery proof must never clear a player or prevent positive injury updates.
          logger.error?.('realtime_injuries.recovery_evidence_unavailable', { code: 'INJURY_RECOVERY_EVIDENCE_UNAVAILABLE' });
        }
      }
      const result = repository.apply(snapshot, claim.token, { recoveryProofs });
      return { status: 'succeeded', occurrenceId: occurrence.occurrenceId, scheduledAtMs: occurrence.scheduledAtMs,
        newMappings: newMappings.length, ...result };
    } catch (error) {
      const code = /^INJURY_[A-Z_]{1,80}$/.test(error?.code || '') ? error.code : 'INJURY_REFRESH_FAILED';
      repository.fail(claim.token, code, { retryAfterMs: Number.isSafeInteger(error?.retryAfterMs) ? error.retryAfterMs : undefined });
      logger.error?.('realtime_injuries.failed', { code });
      return { status: 'failed', code, occurrenceId: occurrence.occurrenceId };
    }
  } });
}
module.exports = { createRefreshRealtimeInjuriesJob };
