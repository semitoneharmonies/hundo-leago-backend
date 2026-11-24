function invalidPeriod() {
  throw Object.assign(new Error('The player statistics period is invalid.'), { code: 'PLAYER_READ_INPUT_INVALID' });
}

function calendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalidPeriod();
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) invalidPeriod();
  return value;
}

function normalizePlayerStatisticsPeriod({ statsPeriod, startDate, endDate, lastGames } = {}) {
  if (statsPeriod === undefined || statsPeriod === 'season') {
    if (startDate !== undefined || endDate !== undefined || lastGames !== undefined) invalidPeriod();
    return null;
  }
  if (statsPeriod === 'dateRange') {
    if (lastGames !== undefined) invalidPeriod();
    const start = calendarDate(startDate), end = calendarDate(endDate);
    if (start > end) invalidPeriod();
    return Object.freeze({ mode: 'dateRange', startDate: start, endDate: end });
  }
  if (statsPeriod === 'lastGames') {
    if (startDate !== undefined || endDate !== undefined ||
        !/^[1-9]\d{0,2}$/.test(String(lastGames)) || !['number', 'string'].includes(typeof lastGames)) invalidPeriod();
    const count = Number(lastGames);
    if (!Number.isSafeInteger(count) || count > 200) invalidPeriod();
    return Object.freeze({ mode: 'lastGames', lastGames: count });
  }
  invalidPeriod();
}

function assertPeriodSeason(period, season) {
  if (!/^\d{8}$/.test(season || '')) invalidPeriod();
  if (period.mode === 'dateRange' && (period.startDate < `${season.slice(0, 4)}-07-01` ||
      period.endDate > `${season.slice(4)}-06-30`)) invalidPeriod();
}

module.exports = { normalizePlayerStatisticsPeriod, assertPeriodSeason };
