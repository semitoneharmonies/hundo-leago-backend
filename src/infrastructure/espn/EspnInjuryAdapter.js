const { STALE_AFTER_MS } = require('../../domain/players/injuryStatusPolicy');
const ORIGIN = 'https://site.api.espn.com';
const BASE = `${ORIGIN}/apis/site/v2/sports/hockey/nhl`;
const INJURY_TYPES = new Set(['upper body', 'lower body', 'illness', 'concussion', 'head', 'neck', 'back', 'shoulder', 'arm', 'elbow', 'wrist', 'hand', 'finger', 'thumb', 'chest', 'ribs', 'abdomen', 'abdominal', 'hip', 'groin', 'leg', 'knee', 'ankle', 'foot', 'toe', 'achilles', 'hamstring', 'undisclosed']);
function invalid() { throw Object.assign(new Error('The injury feed could not be verified.'), { code: 'INJURY_FEED_INVALID' }); }
function providerId(athlete) {
  const ids = new Set((athlete?.links || []).flatMap(link => {
    try {
      const url = new URL(link.href);
      return ['www.espn.com', 'espn.com'].includes(url.hostname) ? [url.pathname.match(/\/id\/(\d+)(?:\/|$)/)?.[1]].filter(Boolean) : [];
    } catch { return []; }
  }));
  if (ids.size !== 1) invalid();
  return [...ids][0];
}
function timestamp(value, nowMs) {
  const result = Date.parse(value);
  if (!Number.isSafeInteger(result) || result > nowMs + 5 * 60_000 || nowMs - result > STALE_AFTER_MS) invalid();
  return result;
}
function normalizeInjurySnapshot(data, nowMs) {
  const observedAtMs = timestamp(data?.timestamp, nowMs);
  if (!Array.isArray(data.injuries) || data.injuries.length < 1 || data.injuries.length > 32) invalid();
  const ids = new Set(), teams = new Set(), rows = [];
  for (const team of data.injuries) {
    if (!/^\d+$/.test(team.id) || teams.has(team.id) || !Array.isArray(team.injuries)) invalid();
    teams.add(team.id);
    for (const entry of team.injuries) {
      const id = providerId(entry.athlete), reportedAtMs = Date.parse(entry.date);
      if (ids.has(id) || !Number.isSafeInteger(reportedAtMs) || reportedAtMs > observedAtMs + 5 * 60_000 || typeof entry.athlete.displayName !== 'string' || entry.athlete.displayName.length > 150) invalid();
      ids.add(id);
      const designation = String(entry.status || ''), injuryType = String(entry.details?.type || '');
      const eligible = ['Out', 'Day-To-Day', 'Injured Reserve'].includes(designation) &&
        !/(suspension|personal|contract)/i.test(injuryType) && (designation === 'Injured Reserve' || INJURY_TYPES.has(injuryType.toLowerCase()));
      rows.push({ id, name: entry.athlete.displayName, teamId: team.id, team: String(team.displayName || '').slice(0, 100), designation: designation.slice(0, 80), injuryType: injuryType.slice(0, 80), eligible, reportedAtMs, observedAtMs, birthDate: null });
    }
  }
  // An empty or malformed response cannot clear existing injuries.
  if (!rows.length || rows.length > 1000) invalid();
  return { observedAtMs, rows };
}
function createEspnInjuryAdapter({ fetchImpl = fetch, nowMs = Date.now } = {}) {
  async function json(url) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
        if (!response.ok) throw new Error('Injury provider request failed.');
        const text = await response.text();
        if (text.length > 8_000_000) invalid();
        return JSON.parse(text);
      } catch (error) { lastError = error; }
    }
    throw Object.assign(new Error('The injury provider is unavailable.', { cause: lastError }), { code: 'INJURY_FEED_UNAVAILABLE' });
  }
  return { async fetchSnapshot({ mappedIds = [] } = {}) {
    const snapshot = normalizeInjurySnapshot(await json(`${BASE}/injuries`), nowMs());
    const known = new Set(mappedIds);
    const neededTeams = [...new Set(snapshot.rows.filter(row => !known.has(row.id)).map(row => row.teamId))];
    // Only unmatched players need a roster lookup. Failure leaves them for admin review.
    for (const teamId of neededTeams) {
      try {
        const roster = await json(`${BASE}/teams/${teamId}/roster`);
        timestamp(roster.timestamp, nowMs());
        const people = roster.athletes.flatMap(group => group.items);
        for (const row of snapshot.rows.filter(item => item.teamId === teamId)) {
          const matches = people.filter(person => person.id === row.id);
          if (matches.length === 1 && /^\d{4}-\d{2}-\d{2}T/.test(matches[0].dateOfBirth || '')) row.birthDate = matches[0].dateOfBirth.slice(0, 10);
        }
      } catch { /* Retain unresolved identity for review; never guess by name alone. */ }
    }
    return snapshot;
  } };
}
module.exports = { createEspnInjuryAdapter, normalizeInjurySnapshot };
