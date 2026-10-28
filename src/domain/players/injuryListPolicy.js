const { normalizedName } = require('./injuryStatusPolicy');

const MAX_TEXT = 100_000;
const ALIASES = Object.fromEntries(Object.entries({
  'Christopher Tanev': 'Chris Tanev', 'Cameron York': 'Cam York',
  'Sam Montembeault': 'Samuel Montembeault', 'Joseph Veleno': 'Joe Veleno',
  'Cameron Lund': 'Cam Lund', 'Artyom Zub': 'Artem Zub',
  'Matthew Savoie': 'Matt Savoie', 'Benjamin Kindel': 'Ben Kindel',
  'Alexei Toropchenko': 'Alexey Toropchenko',
}).map(([key, value]) => [normalizedName(key), normalizedName(value)]));
// These variants only keep a same-surname candidate for review. They never
// identify a player automatically; that still requires a full name or ALIASES.
const GIVEN_NAME_FAMILIES = [
  ['William', 'Will', 'Willy', 'Bill', 'Billy', 'Liam'],
  ['Robert', 'Rob', 'Robbie', 'Robby', 'Bob', 'Bobby'],
  ['James', 'Jim', 'Jimmy', 'Jamie'], ['John', 'Jack', 'Johnny'],
  ['Jacob', 'Jakob', 'Jake'], ['Andrew', 'Andy', 'Drew'],
  ['Nicholas', 'Nicolas', 'Nikolas', 'Nick'], ['Daniel', 'Dan', 'Danny', 'Dany'],
  ['Samuel', 'Sam', 'Sammy'], ['Nathan', 'Nathaniel', 'Nate'],
  ['Timothy', 'Tim', 'Timmy'], ['Anthony', 'Tony'],
  ['Matthew', 'Matt', 'Matty', 'Mathieu', 'Matthieu'],
  ['Patrick', 'Pat', 'Paddy'], ['Francis', 'Frank', 'Frankie'],
  ['Christopher', 'Kristopher', 'Chris', 'Kris'], ['Sean', 'Shawn', 'Shaun'],
  ['Henry', 'Harry'], ['Richard', 'Rick', 'Ricky', 'Dick'],
  ['Charles', 'Charlie', 'Chuck'], ['Edward', 'Ed', 'Eddie', 'Ted'],
  ['Theodore', 'Theo', 'Ted'], ['Alexander', 'Alex', 'Sasha'],
  ['Michael', 'Mike'], ['Joseph', 'Joe', 'Joey'], ['Thomas', 'Tom', 'Tommy'],
].map(names => new Set(names.map(normalizedName)));

function similarGivenPart(first, second) {
  if (!first || !second) return true;
  if (first.startsWith(second) || second.startsWith(first)) return true;
  if (GIVEN_NAME_FAMILIES.some(family => family.has(first) && family.has(second))) return true;
  const shortest = Math.min(first.length, second.length);
  const maximum = shortest >= 5 || (shortest >= 4 && first[0] === second[0]) ? 2 : 1;
  if (Math.abs(first.length - second.length) > maximum) return false;
  const distance = Array.from({ length: first.length + 1 }, (_, i) =>
    Array.from({ length: second.length + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= first.length; i++) {
    for (let j = 1; j <= second.length; j++) {
      distance[i][j] = Math.min(distance[i - 1][j] + 1, distance[i][j - 1] + 1,
        distance[i - 1][j - 1] + Number(first[i - 1] !== second[j - 1]));
      if (i > 1 && j > 1 && first[i - 1] === second[j - 2] && first[i - 2] === second[j - 1]) {
        distance[i][j] = Math.min(distance[i][j], distance[i - 2][j - 2] + 1);
      }
    }
  }
  return distance[first.length][second.length] <= maximum;
}

function similarGivenName(inputName, playerName) {
  const first = inputName.trim().split(/\s+/)[0];
  const second = playerName.trim().split(/\s+/)[0];
  // Two capital initials can stand for a longer given name, such as J.T.
  if ((/^[A-Z]\.?[A-Z]\.?$/.test(first) || /^[A-Z]\.?[A-Z]\.?$/.test(second)) &&
      normalizedName(first)[0] === normalizedName(second)[0]) return true;
  return first.split('-').some(left => second.split('-').some(right =>
    similarGivenPart(normalizedName(left), normalizedName(right))));
}
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
    const candidates = exact.length ? exact : players.filter(p =>
      normalizedName(p.full_name.split(' ').at(-1)) === lastName && similarGivenName(row.name, p.full_name));
    const hasResolution = Object.hasOwn(resolutions, row.key);
    const resolved = resolutions[row.key];
    // Clearly different given names are outside the catalogue match. Keep close
    // spellings and nickname variants for review before replacing injury states.
    if (candidates.length === 0 && (!hasResolution || resolved === 'skip')) { skipped.push(row); continue; }
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
