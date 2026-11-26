const DEFAULT_TIME_ZONE = 'Etc/GMT+8';
function invalid(field) {
  throw Object.assign(new Error(`Invalid injury configuration: ${field}`), { code: 'INJURY_CONFIGURATION_INVALID', field });
}
function loadRealtimeInjuryConfig(env = process.env) {
  if (env.REALTIME_INJURIES_ENABLED !== undefined && !['true', 'false'].includes(env.REALTIME_INJURIES_ENABLED)) invalid('REALTIME_INJURIES_ENABLED');
  const enabled = env.REALTIME_INJURIES_ENABLED === 'true';
  const timeZone = env.REALTIME_INJURY_TIME_ZONE ?? DEFAULT_TIME_ZONE;
  if (typeof timeZone !== 'string' || timeZone.length > 80) invalid('REALTIME_INJURY_TIME_ZONE');
  try { new Intl.DateTimeFormat('en-CA', { timeZone }); } catch { invalid('REALTIME_INJURY_TIME_ZONE'); }
  const apiKey = enabled ? env.REALTIME_INJURY_API_KEY : null;
  if (enabled && (typeof apiKey !== 'string' || apiKey.length < 12 || apiKey.length > 4096 || /[^\x21-\x7e]/.test(apiKey))) invalid('REALTIME_INJURY_API_KEY');
  // This is independent of every existing NHL/statistics provider flag.
  const config = { enabled, timeZone, monthlyRequestLimit: 100 };
  Object.defineProperty(config, 'apiKey', { value: apiKey, enumerable: false });
  return Object.freeze(config);
}
module.exports = { loadRealtimeInjuryConfig, DEFAULT_TIME_ZONE };
