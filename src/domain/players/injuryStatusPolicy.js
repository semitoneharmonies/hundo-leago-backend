const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

function injuryProjection(row, nowMs = Date.now()) {
  if (!row) return { status: 'unknown', source: null, observedAtMs: null, needsReview: false, stale: false };
  return {
    status: row.status, source: row.source, observedAtMs: row.observed_at_ms,
    needsReview: Boolean(row.review_reason),
    stale: row.source === 'espn' && nowMs - row.observed_at_ms > STALE_AFTER_MS,
  };
}

function canUseInjuredReserve(player) {
  const status = player.injury?.status;
  if (status === 'healthy') return false;
  if (status === 'injured') return true;
  // Keep the existing placement policy for players without reviewed injury data.
  try {
    const source = JSON.parse(player.source_payload_json || '{}');
    return String(source.Status || source.status || '').trim().toLowerCase() === 'injured reserve';
  } catch { return false; }
}

function normalizedName(value) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
}

module.exports = { STALE_AFTER_MS, injuryProjection, canUseInjuredReserve, normalizedName };
