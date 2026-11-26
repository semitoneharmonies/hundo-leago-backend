const MEDICAL_REASONS = Object.freeze([
  'upper body', 'lower body', 'illness', 'concussion', 'head', 'neck', 'back', 'shoulder',
  'arm', 'elbow', 'wrist', 'hand', 'finger', 'thumb', 'chest', 'ribs', 'abdomen', 'abdominal',
  'hip', 'groin', 'leg', 'knee', 'ankle', 'foot', 'toe', 'achilles', 'hamstring', 'face',
  'impaired vision', 'pectoral', 'undisclosed',
]);
const medical = new Set(MEDICAL_REASONS);
const normalize = value => typeof value === 'string'
  ? value.normalize('NFKC').trim().toLowerCase().replace(/[-_\s]+/g, ' ') : '';
const unavailable = new Set(['out', 'day to day', 'dtd', 'injured reserve', 'ir', 'ir lt', 'ir nr']);
const nonmedical = /\b(contract|suspend\w*|suspension|disciplin\w*|personal|bereavement|paternity|maternity|family|visa|immigration|holdout|hold out|healthy scratch|coach\w*|non medical|nonmedical|rest|not with team|nwt|reassigned|assignment|minor leagues)\b/;

// Medical reason is the structured reason from the injury feed, never its availability label.
// Undisclosed means an explicitly listed injury with an undisclosed body part; Unknown does not.
function classifyRealtimeInjury(row) {
  const medicalReason = typeof row?.medicalReason === 'string' ? row.medicalReason.trim() : null;
  const fields = [medicalReason, row?.designation, row?.sourceInjuryType, row?.statusType, row?.fantasyStatus];
  if (fields.some(value => nonmedical.test(normalize(value)))) {
    return { status: 'excluded', medicalReason, reason: 'NONMEDICAL_ABSENCE' };
  }
  if (!medical.has(normalize(medicalReason))) return { status: 'review', medicalReason, reason: 'MEDICAL_REASON_UNCONFIRMED' };
  if (!unavailable.has(normalize(row?.designation))) return { status: 'review', medicalReason, reason: 'AVAILABILITY_UNCONFIRMED' };
  return { status: 'injured', medicalReason,
    reason: normalize(medicalReason) === 'illness' ? 'ILLNESS' : 'INJURY' };
}

const validTime = value => Number.isSafeInteger(value) && value >= 0;

// The caller supplies proof already bound to this canonical player from trusted local NHL stats.
// This function performs no lookup and cannot infer participation from roster membership or absence.
function assessRealtimeRecovery({ present, absenceCount, lastInjuryEvidenceAtMs, manualDecisionAtMs = null,
  proof, nowMs = Date.now() } = {}) {
  const pending = { status: null, reason: present !== false ? 'CURRENT_REPORT_PRESENT' : 'POSSIBLE_RETURN',
    evidenceAtMs: null, gameId: null };
  if (present !== false || !Number.isInteger(absenceCount) || absenceCount < 2
    || !validTime(nowMs) || !validTime(lastInjuryEvidenceAtMs) || lastInjuryEvidenceAtMs > nowMs
    || (manualDecisionAtMs !== null && (!validTime(manualDecisionAtMs) || manualDecisionAtMs > nowMs))) return pending;
  if (proof?.source !== 'nhl' || proof.trusted !== true || proof.final !== true || proof.participated !== true
    || typeof proof.gameId !== 'string' || !/^\d{10}$/.test(proof.gameId)
    || !validTime(proof.occurredAtMs) || proof.occurredAtMs > nowMs
    || proof.occurredAtMs <= Math.max(lastInjuryEvidenceAtMs, manualDecisionAtMs ?? 0)) return pending;
  return { status: 'healthy', reason: 'POSITIVE_FINAL_GAME_PARTICIPATION',
    evidenceAtMs: proof.occurredAtMs, gameId: proof.gameId };
}

const identityName = value => typeof value === 'string'
  ? value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[’‘]/g, "'")
    .replace(/[‐‑–—]/g, '-').replace(/\s+/g, ' ').trim() : '';
const TEAM_NAMES = Object.freeze({
  ANA: 'Anaheim Ducks', BOS: 'Boston Bruins', BUF: 'Buffalo Sabres', CAR: 'Carolina Hurricanes',
  CBJ: 'Columbus Blue Jackets', CGY: 'Calgary Flames', CHI: 'Chicago Blackhawks', COL: 'Colorado Avalanche',
  DAL: 'Dallas Stars', DET: 'Detroit Red Wings', EDM: 'Edmonton Oilers', FLA: 'Florida Panthers',
  LAK: 'Los Angeles Kings', MIN: 'Minnesota Wild', MTL: 'Montreal Canadiens', NJD: 'New Jersey Devils',
  NSH: 'Nashville Predators', NYI: 'New York Islanders', NYR: 'New York Rangers', OTT: 'Ottawa Senators',
  PHI: 'Philadelphia Flyers', PIT: 'Pittsburgh Penguins', SEA: 'Seattle Kraken', SJS: 'San Jose Sharks',
  STL: 'St. Louis Blues', TBL: 'Tampa Bay Lightning', TOR: 'Toronto Maple Leafs', UTA: 'Utah Mammoth',
  VAN: 'Vancouver Canucks', VGK: 'Vegas Golden Knights', WPG: 'Winnipeg Jets', WSH: 'Washington Capitals',
});
const teamNames = new Map(Object.entries(TEAM_NAMES).map(([abbr, name]) => [identityName(name), abbr]));
function identityTeam(row) {
  const abbreviation = typeof row?.teamAbbreviation === 'string' ? row.teamAbbreviation.toUpperCase().trim() : null;
  const namedTeam = typeof row?.team === 'string' ? teamNames.get(identityName(row.team)) : null;
  if (abbreviation && (!Object.hasOwn(TEAM_NAMES, abbreviation) || (namedTeam && namedTeam !== abbreviation))) return null;
  return abbreviation || namedTeam || null;
}
function identityPosition(value) {
  const position = typeof value === 'string' ? value.toUpperCase().trim() : '';
  if (['F', 'C', 'LW', 'RW', 'L', 'R'].includes(position)) return 'F';
  if (['D', 'LD', 'RD'].includes(position)) return 'D';
  return position === 'G' ? 'G' : null;
}
const identityId = value => typeof value === 'string' && /^\d{1,16}$/.test(value);
function counts(rows, key) {
  const result = new Map();
  for (const row of rows) {
    const value = key(row);
    if (value) result.set(value, (result.get(value) || 0) + 1);
  }
  return result;
}

// Catalogue provenance is the caller's responsibility: existing authoritative NHL source_state only.
// This is an identity-only proposal. It never creates players, changes teams, or infers eligibility.
function resolveRealtimeIdentityCandidates({ snapshot, catalogue = [], mappings = [], nowMs = Date.now() } = {}) {
  const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
  const result = { mappings: [], pending: [] };
  const pending = (row, reason) => result.pending.push({ providerPlayerId: row?.providerPlayerId ?? null, reason });
  if (snapshot?.source !== 'realtime' || !validTime(snapshot.fetchedAtMs) || snapshot.fetchedAtMs > nowMs
    || !validTime(nowMs) || !Array.isArray(catalogue) || !Array.isArray(mappings)) {
    for (const row of rows) pending(row, 'IDENTITY_INPUT_UNVERIFIED');
    return result;
  }
  const existingProviderIds = new Set(mappings.map(row => row?.providerPlayerId));
  const occupiedNhlIds = new Set(mappings.map(row => row?.nhlPlayerId));
  const occupiedPlayerIds = new Set(mappings.map(row => row?.playerId).filter(Boolean));
  const incomingNames = counts(rows, row => identityName(row?.name));
  const incomingIds = counts(rows, row => row?.providerPlayerId);
  const catalogueNames = counts(catalogue, row => identityName(row?.name));
  const catalogueNhlIds = counts(catalogue, row => row?.nhlPlayerId);
  const cataloguePlayerIds = counts(catalogue, row => row?.playerId);
  for (const row of rows) {
    if (existingProviderIds.has(row?.providerPlayerId)) continue;
    const name = identityName(row?.name), team = identityTeam(row), position = identityPosition(row?.position);
    if (!identityId(row?.providerPlayerId) || !name || !team || !position) {
      pending(row, 'IDENTITY_DETAILS_MISSING'); continue;
    }
    if (incomingIds.get(row.providerPlayerId) !== 1 || incomingNames.get(name) !== 1 || catalogueNames.get(name) !== 1) {
      pending(row, 'IDENTITY_NAME_AMBIGUOUS_OR_MISSING'); continue;
    }
    const candidate = catalogue.find(player => identityName(player?.name) === name);
    if (candidate.active !== true || !identityId(candidate.nhlPlayerId) || typeof candidate.playerId !== 'string'
      || !candidate.playerId.trim() || identityTeam(candidate) !== team || identityPosition(candidate.position) !== position) {
      pending(row, 'IDENTITY_TEAM_POSITION_UNCONFIRMED'); continue;
    }
    if (catalogueNhlIds.get(candidate.nhlPlayerId) !== 1 || cataloguePlayerIds.get(candidate.playerId) !== 1
      || occupiedNhlIds.has(candidate.nhlPlayerId) || occupiedPlayerIds.has(candidate.playerId)) {
      pending(row, 'IDENTITY_ALREADY_MAPPED_OR_CONFLICTING'); continue;
    }
    result.mappings.push({ providerPlayerId: row.providerPlayerId, nhlPlayerId: candidate.nhlPlayerId,
      playerId: candidate.playerId, providerName: row.name, teamAbbreviation: team, position,
      verified: true, verifiedAtMs: nowMs, verificationMethod: 'unique_name_team_position',
      // Source reference links, not a claim of a new network verification.
      evidenceUrls: [`https://api-web.nhle.com/v1/player/${candidate.nhlPlayerId}/landing`,
        'https://www.realtimesportsapi.com/apis/nhl/injuries'] });
    occupiedNhlIds.add(candidate.nhlPlayerId); occupiedPlayerIds.add(candidate.playerId);
  }
  return result;
}

module.exports = { MEDICAL_REASONS, classifyRealtimeInjury, assessRealtimeRecovery, resolveRealtimeIdentityCandidates };
