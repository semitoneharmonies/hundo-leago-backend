const { normalizedName } = require('./injuryStatusPolicy');

const MAX_TEXT = 100_000;
const ALIASES = Object.fromEntries(Object.entries({
  'Christopher Tanev': 'Chris Tanev', 'Cameron York': 'Cam York',
  'Sam Montembeault': 'Samuel Montembeault', 'Joseph Veleno': 'Joe Veleno',
  'Cameron Lund': 'Cam Lund', 'Artyom Zub': 'Artem Zub',
  'Matthew Savoie': 'Matt Savoie', 'Benjamin Kindel': 'Ben Kindel',
  'Alexei Toropchenko': 'Alexey Toropchenko',
}).map(([key, value]) => [normalizedName(key), normalizedName(value)]));
function invalid(message) {
  throw Object.assign(new Error(message), { code: 'INJURY_LIST_INVALID' });
}

// Clipboard tables can contain one TSV row or three wrapped lines per player.
// Every non-header line must belong to a valid record; never silently drop input.
function parseInjuryList(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) invalid('Paste a complete injury list (up to 100,000 characters).');
  const groups = [];
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/).map(x => x.trim()).filter(Boolean)) {
    if (/^Player\s+Timeline\s+Status\s+Reason$/i.test(line)) continue;
    if (line.includes(',')) groups.push(line);
    else if (groups.length) groups[groups.length - 1] += ' ' + line;
    else invalid('The list must start with a player name in Last, First format.');
  }
  if (!groups.length || groups.length > 500) invalid('Paste between 1 and 500 players.');
  const seen = new Set();
  return groups.map((group, index) => {
    const match = group.match(/^([^,]+),\s*(.+?)\s+(Day to Day|Week to Week|Month to Month|Season|Indefinite|Out for Season)\s+(.+)$/i);
    if (!match) invalid(`Row ${index + 1}: check the name, timeline, status, and reason.`);
    const [, last, first, timeline, tail] = match;
    const name = `${first.trim()} ${last.trim()}`;
    if (!/^[\p{L}\p{M} .’'\-]+$/u.test(name) || name.length > 100) invalid(`Row ${index + 1}: invalid player name.`);
    const status = tail.match(/^(OUT|IR|LTIR|SELTIR|SUSP|NR|DTD)\s+(.+)$/i);
    // Some copied rows omit the status column. Keep that field explicitly empty.
    if (!status && !/^(Undisclosed|Upper Body|Lower Body|Knee|Shoulder|Hand|Foot|Ankle|Hip|Back|Groin|Illness|Personal|Concussion)$/i.test(tail)) invalid(`Row ${index + 1}: unrecognized or missing status/reason.`);
    const reason = (status ? status[2] : tail).replace(/\s+/g, ' ').trim();
    if (!reason || reason.length > 200) invalid(`Row ${index + 1}: check the reason.`);
    const key = normalizedName(name);
    if (seen.has(key)) invalid(`Duplicate player: ${name}.`);
    seen.add(key);
    return { key, name, timeline: timeline.replace(/\s+/g, ' '), designation: status ? status[1].toUpperCase() : null, reason };
  });
}

function matchInjuryList(rows, players, resolutions = {}) {
  const matches = [], unresolved = [], skipped = [], used = new Set();
  for (const row of rows) {
    const canonical = ALIASES[row.key] || row.key;
    const exact = players.filter(p => normalizedName(p.full_name) === canonical);
    const lastName = normalizedName(row.name.split(' ').at(-1));
    const candidates = exact.length ? exact : players.filter(p => normalizedName(p.full_name.split(' ').at(-1)) === lastName);
    const hasResolution = Object.hasOwn(resolutions, row.key);
    const resolved = resolutions[row.key];
    if (hasResolution && resolved === 'skip' && candidates.length === 0) { skipped.push(row); continue; }
    const player = hasResolution ? candidates.find(p => p.id === resolved) : exact.length === 1 ? exact[0] : null;
    if (hasResolution && !player) invalid(`Choose a listed match for ${row.name}, or correct the pasted name.`);
    if (!player) {
      unresolved.push({ ...row, candidates: candidates.map(p => ({ id: p.id, name: p.full_name, birthDate: p.birth_date })) });
      continue;
    }
    if (used.has(player.id)) invalid(`More than one row matches ${player.full_name}.`);
    used.add(player.id);
    matches.push({ ...row, playerId: player.id, name: player.full_name });
  }
  return { matches, unresolved, skipped };
}
module.exports = { parseInjuryList, matchInjuryList, MAX_TEXT };
