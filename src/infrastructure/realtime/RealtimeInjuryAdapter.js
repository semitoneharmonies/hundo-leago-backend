const { classifyRealtimeInjury } = require('../../domain/players/realtimeInjuryPolicy');
const ENDPOINT = 'https://www.realtimesportsapi.com/api/v1/sports/hockey/leagues/nhl/injuries';
class RealtimeInjuryError extends Error {}
function failure(code, extra = {}) {
  return Object.assign(new RealtimeInjuryError('Automatic injury data could not be verified.'), { code, ...extra });
}
function invalid() { throw failure('INJURY_FEED_INVALID'); }
function string(value, maximum = 180, optional = false) {
  if (optional && value == null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f]/.test(value)) invalid();
  return value.trim();
}
function id(value) {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== 'string' || !/^\d{1,16}$/.test(text)) invalid();
  return text;
}
function timestamp(value, nowMs) {
  if (typeof value !== 'string') invalid();
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) invalid();
  const [, year, month, day, hour, minute, second = '0', zone] = parts;
  const monthDays = new Date(Date.UTC(+year, +month, 0)).getUTCDate();
  if (+month < 1 || +month > 12 || +day < 1 || +day > monthDays || +hour > 23 || +minute > 59 || +second > 59
    || (zone !== 'Z' && (+zone.slice(1, 3) > 23 || +zone.slice(4) > 59))) invalid();
  const result = Date.parse(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > nowMs) invalid();
  return result;
}
function normalizeRow(entry, fetchedAtMs, groupTeam) {
  if (!entry || typeof entry !== 'object') invalid();
  const teamId = id(entry.team?.id ?? groupTeam?.id);
  if (groupTeam && teamId !== id(groupTeam.id)) invalid();
  const row = {
    providerPlayerId: id(entry.athlete?.id), name: string(entry.athlete?.displayName, 150),
    reportedAtMs: timestamp(entry.date, fetchedAtMs), designation: string(entry.status, 80),
    medicalReason: string(entry.bodyPart, 120, true), sourceInjuryType: string(entry.type, 120, true),
    statusType: string(entry.statusType, 100, true), fantasyStatus: string(entry.fantasyStatus, 80, true),
    teamId, team: string(entry.team?.displayName ?? groupTeam?.displayName, 100, true),
    position: string(entry.athlete?.position, 30, true), timeline: null,
  };
  const decision = classifyRealtimeInjury(row);
  return { ...row, status: decision.status, classificationReason: decision.reason };
}
function normalizeRealtimeInjurySnapshot(body, fetchedAtMs) {
  if (!Number.isSafeInteger(fetchedAtMs) || fetchedAtMs < 0 || body?.success !== true
    || !body.data || !Array.isArray(body.data.groups) || !body.data.groups.length || body.data.groups.length > 32) invalid();
  const rows = [], teams = new Set(), ids = new Set();
  for (const group of body.data.groups) {
    const teamId = id(group?.team?.id);
    if (teams.has(teamId) || !Array.isArray(group.injuries)) invalid();
    // League-wide responses are capped at 25 rows/team; never apply a potentially clipped snapshot.
    if (group.injuries.length >= 25) throw failure('INJURY_FEED_INCOMPLETE');
    teams.add(teamId);
    for (const entry of group.injuries) {
      const row = normalizeRow(entry, fetchedAtMs, group.team);
      if (ids.has(row.providerPlayerId)) invalid();
      ids.add(row.providerPlayerId); rows.push(row);
    }
  }
  if (!rows.length || rows.length > 1000 || body.data.count !== rows.length || !Number.isInteger(body.data.count)) invalid();
  if (body.data.injuries != null) {
    if (!Array.isArray(body.data.injuries) || body.data.injuries.length !== rows.length) invalid();
    const flat = body.data.injuries.map(entry => JSON.stringify(normalizeRow(entry, fetchedAtMs))).sort();
    if (JSON.stringify(flat) !== JSON.stringify(rows.map(row => JSON.stringify(row)).sort())) invalid();
  }
  let quota = null;
  if (body.meta?.rateLimit != null) {
    const rate = body.meta.rateLimit;
    if (!Number.isSafeInteger(rate.remaining) || rate.remaining < 0 || !Number.isSafeInteger(rate.reset) || rate.reset < 0
      || (rate.limit != null && (!Number.isSafeInteger(rate.limit) || rate.limit < 0))) invalid();
    quota = { remaining: rate.remaining, resetAtMs: rate.reset, ...(rate.limit != null ? { limit: rate.limit } : {}) };
  }
  return { source: 'realtime', fetchedAtMs, sourceGeneratedAtMs: null, sourceCount: rows.length,
    teamCount: teams.size, rows: rows.sort((a, b) => a.providerPlayerId.localeCompare(b.providerPlayerId)), quota };
}
async function boundedJson(response, maximum) {
  if (!(response.headers.get('content-type') || '').toLowerCase().includes('application/json') || !response.body?.getReader) invalid();
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximum) { await reader.cancel(); throw failure('INJURY_FEED_TOO_LARGE'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { invalid(); }
}
function retryDelay(value, at) {
  const until = /^\d+$/.test(value || '') ? at + Number(value) * 1000 : Date.parse(value || '');
  return Math.min(31 * 86400_000, Math.max(60_000, Number.isFinite(until) ? until - at : 3600_000));
}
function createRealtimeInjuryAdapter({ apiKey, fetchImpl = fetch, nowMs = Date.now,
  timeoutMs = 15000, maxResponseBytes = 2 * 1024 * 1024 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000
    || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 2 * 1024 * 1024) invalid();
  return { async fetchSnapshot() {
    if (typeof apiKey !== 'string' || !apiKey.trim()) throw failure('INJURY_API_KEY_MISSING');
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(failure('INJURY_FEED_TIMEOUT')); }, timeoutMs);
    });
    try {
      return await Promise.race([deadline, (async () => {
        const response = await fetchImpl(ENDPOINT, { method: 'GET', redirect: 'error',
          headers: { Authorization: `Bearer ${apiKey.trim()}`, Accept: 'application/json' }, signal: controller.signal });
        if (!response.ok) {
          const code = response.status === 429 ? 'INJURY_FEED_RATE_LIMITED'
            : [401, 403].includes(response.status) ? 'INJURY_FEED_AUTH_FAILED' : 'INJURY_FEED_UNAVAILABLE';
          const extra = response.status === 429 ? { retryAfterMs: retryDelay(response.headers.get('retry-after'), nowMs()) } : {};
          await response.body?.cancel();
          throw failure(code, extra);
        }
        return normalizeRealtimeInjurySnapshot(await boundedJson(response, maxResponseBytes), nowMs());
      })()]);
    } catch (error) {
      const code = controller.signal.aborted ? 'INJURY_FEED_TIMEOUT'
        : error instanceof RealtimeInjuryError ? error.code : 'INJURY_FEED_UNAVAILABLE';
      // Never expose response text, credentials, upstream messages, URLs, or exception causes.
      throw failure(code, code === 'INJURY_FEED_RATE_LIMITED' ? { retryAfterMs: error.retryAfterMs } : {});
    } finally { clearTimeout(timer); }
  } };
}
module.exports = { ENDPOINT, createRealtimeInjuryAdapter, normalizeRealtimeInjurySnapshot };
