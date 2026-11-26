const SLOTS = Object.freeze(['13:00', '23:30']);
const DEFAULT_TIME_ZONE = 'Etc/GMT+8';
const formatters = new Map();
function formatter(timeZone) {
  if (!formatters.has(timeZone)) formatters.set(timeZone, new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }));
  return formatters.get(timeZone);
}
function dueRealtimeInjuryOccurrence(nowMs, { timeZone = DEFAULT_TIME_ZONE, maxLatenessMinutes = 30 } = {}) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isInteger(maxLatenessMinutes) || maxLatenessMinutes < 0 || maxLatenessMinutes > 60) throw new TypeError('A valid injury schedule clock is required.');
  const minute = 60_000, end = Math.floor(nowMs / minute) * minute;
  for (let offset = 0; offset <= maxLatenessMinutes; offset++) {
    const scheduledAtMs = end - offset * minute;
    if (scheduledAtMs < 0 || nowMs - scheduledAtMs > maxLatenessMinutes * minute) continue;
    const parts = Object.fromEntries(formatter(timeZone).formatToParts(scheduledAtMs).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    const time = `${parts.hour}:${parts.minute}`;
    if (SLOTS.includes(time)) return { occurrenceId: `${timeZone}/${parts.year}-${parts.month}-${parts.day}/${time}`, scheduledAtMs, timeZone, time };
  }
  return null;
}
module.exports = { SLOTS, DEFAULT_TIME_ZONE, dueRealtimeInjuryOccurrence };
