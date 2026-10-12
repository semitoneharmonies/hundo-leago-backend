const CATEGORIES = Object.freeze(['trade_received','trade_accepted','trade_closed','auction_bid','auction_result','auction_closing','roster_illegal','roster_lock','schedule_changed','announcement','fad_action','commissioner_action']);
const DEFAULT_PREFERENCES = Object.freeze(Object.fromEntries(CATEGORIES.map(key => [key, true])));
function invalid() { throw Object.assign(new Error('Invalid notification settings.'), { code: 'PUSH_INPUT_INVALID' }); }
function preferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== CATEGORIES.length ||
    CATEGORIES.some(key => typeof value[key] !== 'boolean') || Object.keys(value).some(key => !CATEGORIES.includes(key))) invalid();
  return Object.fromEntries(CATEGORIES.map(key => [key,value[key]]));
}
function endpoint(value) {
  let url; try { url = new URL(value); } catch { invalid(); }
  const allowed = url.hostname === 'fcm.googleapis.com' || url.hostname === 'updates.push.services.mozilla.com' ||
    url.hostname === 'web.push.apple.com' || /^[a-z0-9-]+\.push\.apple\.com$/.test(url.hostname) ||
    url.hostname === 'wns.windows.com' || /^[a-z0-9-]+\.notify\.windows\.com$/.test(url.hostname);
  if (typeof value !== 'string' || value.length > 2048 || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || !allowed) invalid();
  return value;
}
function subscription(value) {
  if (!value || typeof value !== 'object' || !value.keys || typeof value.keys !== 'object' ||
    Object.keys(value).some(key => !['endpoint','expirationTime','keys'].includes(key)) || Object.keys(value.keys).some(key => !['p256dh','auth'].includes(key))) invalid();
  const result = { endpoint: endpoint(value.endpoint), keys: {} };
  for (const [key, size] of [['p256dh',65],['auth',16]]) {
    const raw = value.keys[key];
    if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(raw) || raw.length > 100 || Buffer.from(raw,'base64url').length !== size) invalid();
    result.keys[key] = raw;
  }
  if (Buffer.from(result.keys.p256dh,'base64url')[0] !== 4) invalid();
  return result;
}
const NOTIFICATION_COPY = Object.freeze({
  trade_proposal_received: ['trade_received','New trade offer'],
  league_calendar_changed: ['schedule_changed','League schedule changed'],
  league_announcement: ['announcement','Commissioner announcement'],
  fad_cards_opened: ['fad_action','Candidate Card ready'],
  fad_deadline_approaching: ['fad_action','Candidate Card due soon'],
  fad_restricted_eligible: ['fad_action','Tie auction: your bid needed'],
  fad_restricted_fallback_opened: ['fad_action','Tie auction reopened'],
  fad_rapid_auction_result: ['auction_result','Auction result ready'],
  fad_help_requested: ['commissioner_action','Candidate Card help requested'],
  fad_correction_required: ['commissioner_action','Draft needs attention'],
  fad_readiness_blocked: ['commissioner_action','Draft setup needs attention'],
});
const TRADE_COPY = Object.freeze({
  participant_accepted: ['trade_accepted','Trade accepted; awaiting others'],
  proposal_accepted_awaiting_commissioner_approval: ['trade_accepted','Trade awaiting approval'],
  proposal_accepted: ['trade_accepted','Trade completed'],
  proposal_rejected: ['trade_closed','Trade declined'],
  proposal_cancelled: ['trade_closed','Trade cancelled'],
  proposal_expired: ['trade_closed','Trade expired'],
  proposal_automatically_cancelled: ['trade_closed','Trade cancelled'],
});
function rosterLegality(activePlayers, cap) {
  const lineup = require('../matchups/matchupLegalityPolicy').evaluateMatchupLineupLegality(activePlayers);
  const reasons = [...lineup.reasonCodes];
  if (!cap || cap.complete !== true || !Number.isSafeInteger(cap.capUsageCents) || cap.capUsageCents < 0 ||
      !Number.isSafeInteger(cap.capLimitCents) || cap.capLimitCents < 0) reasons.push('SALARY_CAP_CALCULATION_INCOMPLETE');
  else if (cap.capUsageCents > cap.capLimitCents) reasons.push('SALARY_CAP_EXCEEDED');
  return { legal: reasons.length === 0, reasonCodes: reasons, primaryReasonCode: reasons[0] || null };
}
module.exports = { CATEGORIES, DEFAULT_PREFERENCES, preferences, endpoint, subscription, invalid, NOTIFICATION_COPY, TRADE_COPY, rosterLegality };
