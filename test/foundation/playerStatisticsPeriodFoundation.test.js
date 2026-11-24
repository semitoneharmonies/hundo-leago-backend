const assert = require('node:assert/strict');
const { test } = require('node:test');
const Database = require('better-sqlite3');
const express = require('express');
const { createSqlitePlayerRepository } = require('../../src/infrastructure/persistence/sqlite/SqlitePlayerRepository');
const { createLeaguePlayerReadService } = require('../../src/application/services/players/createLeaguePlayerReadService');
const { createPlayerRouter } = require('../../src/transport/http/createPlayerRouter');
const { normalizePlayerStatisticsPeriod } = require('../../src/domain/statistics/playerStatisticsPeriodPolicy');
const { completedGameEntry } = require('../../src/domain/statistics/completedGameCachePolicy');
const { emptyScoringStats, defaultScoringWeights, calculateExpandedScore } = require('../../src/domain/statistics/expandedScoringPolicy');
const { createPlayerStatisticsPeriodReader } = require('../../src/infrastructure/persistence/sqlite/readPlayerStatisticsPeriod');

const uuid = value => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const LEAGUE = uuid(100), OTHER = uuid(101), SOURCE_AT = Date.parse('2026-11-20T20:00:00Z');
const PERIOD = { statsPeriod: 'lastGames', lastGames: 1 };

// Small relational fixture exercises the actual player SQL, period reader and
// service without migrating, opening, or copying a real league database.
function fixture(t) {
  const database = new Database(':memory:');
  t.after(() => database.close());
  database.exec(`
    PRAGMA user_version=96;
    CREATE TABLE players(id TEXT PRIMARY KEY,first_name,last_name,full_name,birth_date,status,created_at_ms,updated_at_ms,version);
    CREATE TABLE player_external_ids(id TEXT PRIMARY KEY,player_id,provider,external_value,created_at_ms);
    CREATE TABLE player_source_state(id,player_id,provider,source_position,normalized_position,nhl_team_abbreviation,active,source_version,effective_at_ms,ended_at_ms);
    CREATE TABLE player_injury_status(id);
    CREATE TABLE stat_sources(id,provider);
    CREATE TABLE stat_refreshes(id,stat_source_id,nhl_season_key,status,started_at_ms,completed_at_ms,player_count);
    CREATE TABLE player_stat_totals(id,stat_source_id,refresh_id,nhl_season_key,player_id,games_played,goals,assists,nhl_points,fantasy_points_hundredths,source_updated_at_ms,created_at_ms);
    CREATE TABLE expanded_stat_totals(total_id,stats_json,forward_fp_hundredths,defence_fp_hundredths);
    CREATE TABLE nhl_completed_game_cache(nhl_season_key,nhl_game_id,expanded,checked_at_ms,entry_json);
    CREATE TABLE leagues(id,current_season_id,timezone);
    CREATE TABLE seasons(id,league_id,nhl_season_key);
    CREATE TABLE player_ownerships(id,league_id,season_id,player_id,team_id,ownership_kind,roster_category);
    CREATE TABLE contracts(id,league_id,player_id,current_team_id,status,aav_cents,contract_type);
    CREATE TABLE contract_years(league_id,contract_id,status);
    CREATE TABLE league_player_positions(league_id,player_id,ended_at_ms,position_group);
    CREATE TABLE ownership_events(league_id,player_id,event_type);
    CREATE TABLE auctions(league_id,player_id,status);
    CREATE TABLE league_scoring_rules(id,league_id,season_id,effective_week_sequence,revision,weights_json);
    CREATE TABLE matchup_weeks(league_id,season_id,sequence,starts_at_ms);
    CREATE TABLE unrelated_events(id);
  `);
  for (const leagueId of [LEAGUE, OTHER]) {
    database.prepare('INSERT INTO leagues VALUES (?, ?, ?)').run(leagueId, `season-${leagueId}`, 'America/Vancouver');
    database.prepare('INSERT INTO seasons VALUES (?, ?, ?)').run(`season-${leagueId}`, leagueId, '20262027');
  }
  const playerStats = new Map([1, 2, 3].map(id => [id, { gp: 0, goals: 0, assists: 0, stats: emptyScoringStats() }]));
  for (const [id, first, last, position, team] of [[1, 'Alex', 'League', 'F', 'VAN'], [2, 'Blair', 'Free', 'D', 'VAN'], [3, 'Charlie', 'Free', 'F', 'EDM']]) {
    database.prepare('INSERT INTO players VALUES (?, ?, ?, ?, NULL, ?, 1, 1, 1)').run(uuid(id), first, last, `${first} ${last}`, 'active');
    database.prepare('INSERT INTO player_external_ids VALUES (?, ?, ?, ?, 1)').run(uuid(200 + id), uuid(id), 'nhl', String(id));
    database.prepare('INSERT INTO player_source_state VALUES (?, ?, ?, ?, ?, ?, 1, ?, 1, NULL)').run(uuid(300 + id), uuid(id), 'nhl', position, position, team, 'catalogue');
  }
  database.prepare('INSERT INTO player_ownerships VALUES (?, ?, ?, ?, ?, ?, ?)').run(uuid(400), LEAGUE, `season-${LEAGUE}`, uuid(1), uuid(500), 'Rostered', 'Active');
  const definitions = [
    ['2026020001', '2026-10-28T01:00:00Z', [[1, { evenStrengthGoals: 10 }]]],
    ['2026020002', '2026-10-29T01:00:00Z', [[3, { evenStrengthGoals: 2 }]]],
    ['2026020003', '2026-11-18T07:30:00Z', [[1, {}], [2, { evenStrengthGoals: 1, hits: 5 }], [3, { penaltiesTaken: 2 }]]],
  ];
  for (const [gameId, starts, known] of definitions) {
    const participants = [...known, ...Array.from({ length: 30 - known.length }, (_, n) => [10 + n, {}])];
    const rows = [], categories = [];
    for (const [id, additions] of participants) {
      const stats = { ...emptyScoringStats(), ...additions };
      const goals = stats.evenStrengthGoals + stats.powerPlayGoals + stats.shortHandedGoals;
      const assists = stats.primaryAssists + stats.secondaryAssists;
      rows.push({ playerId: id, gameId: Number(gameId), gamesPlayed: 1, goals, assists, points: goals + assists });
      categories.push([`${gameId}:${id}`, stats]);
      if (playerStats.has(id)) {
        const value = playerStats.get(id);
        value.gp++; value.goals += goals; value.assists += assists;
        for (const key of Object.keys(stats)) value.stats[key] += stats[key];
      }
    }
    const entry = completedGameEntry({ game: { id: gameId, startsAtMs: Date.parse(starts), homeTeamId: '1', awayTeamId: '2' },
      season: '20262027', expanded: true, checkedAtMs: SOURCE_AT, data: { rows, categories } });
    database.prepare('INSERT INTO nhl_completed_game_cache VALUES (?, ?, 1, ?, ?)').run('20262027', gameId, SOURCE_AT, JSON.stringify(entry));
  }
  database.prepare('INSERT INTO stat_sources VALUES (?, ?)').run('source', 'nhl-completed-games');
  database.prepare('INSERT INTO stat_refreshes VALUES (?, ?, ?, ?, ?, ?, 3)').run('accepted', 'source', '20262027', 'succeeded', SOURCE_AT, SOURCE_AT + 1);
  for (const [id, value] of playerStats) {
    database.prepare('INSERT INTO player_stat_totals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(`total-${id}`, 'source', 'accepted', '20262027', uuid(id), value.gp, value.goals, value.assists, value.goals + value.assists, value.goals * 125 + value.assists * 100, SOURCE_AT, SOURCE_AT);
    database.prepare('INSERT INTO expanded_stat_totals VALUES (?, ?, ?, ?)').run(`total-${id}`, JSON.stringify(value.stats),
      calculateExpandedScore(value.stats, 'F').fantasyPointsHundredths, calculateExpandedScore(value.stats, 'D').fantasyPointsHundredths);
  }
  const playerRepository = createSqlitePlayerRepository({ database, currentNhlStatisticsSeason: '20262027', expandedScoringEnabled: true, nowMs: () => SOURCE_AT });
  const service = createLeaguePlayerReadService({
    leagueAuthorization: { requireActiveMembership(authenticated, leagueId) {
      if (authenticated !== 'member' || ![LEAGUE, OTHER].includes(leagueId)) throw Object.assign(new Error('Denied'), { code: 'LEAGUE_NOT_FOUND' });
      return { leagueId };
    } },
    playerRepository,
    leaguePlayerRepository: {
      findByPlayerId({ playerId }) { return { player_id: playerId, ownership_id: null, contract_id: null }; },
      listByPlayerIds({ playerIds }) { return playerIds.map(playerId => ({ player_id: playerId, ownership_id: null, contract_id: null })); },
    },
  });
  return { database, service, list: options => service.list({ authenticated: 'member', leagueId: LEAGUE, sort: 'fantasyPoints', ...options }) };
}

test('period validation rejects impossible, mixed, unbounded and out-of-season requests', t => {
  for (const options of [{ startDate: '2026-10-28' }, { statsPeriod: 'bad' }, { statsPeriod: 'lastGames', lastGames: 0 },
    { statsPeriod: 'lastGames', lastGames: 201 }, { statsPeriod: 'lastGames', lastGames: ['10'] },
    { statsPeriod: 'dateRange', startDate: '2026-02-30', endDate: '2026-03-01' },
    { statsPeriod: 'dateRange', startDate: '2026-11-18', endDate: '2026-10-28' },
    { statsPeriod: 'dateRange', startDate: '2026-10-28', endDate: '2026-11-18', lastGames: 10 }]) {
    assert.throws(() => normalizePlayerStatisticsPeriod(options), { code: 'PLAYER_READ_INPUT_INVALID' });
  }
  const runtime = fixture(t);
  assert.throws(() => runtime.list({ statsPeriod: 'dateRange', startDate: '2025-10-28', endDate: '2026-11-18' }), { code: 'PLAYER_READ_INPUT_INVALID' });
});

test('date ranges are inclusive, use Vancouver UTC-7 and compose with current free-agent/position/team filters without writes', t => {
  const { database, list } = fixture(t), before = database.serialize();
  const range = { statsPeriod: 'dateRange', startDate: '2026-10-28', endDate: '2026-11-18' };
  const rows = list(range).players;
  assert.deepEqual(rows.map(p => [p.id, p.statistics.gamesPlayed, p.statistics.goals, p.statistics.fantasyPointsHundredths]),
    [[uuid(3), 2, 2, 560], [uuid(2), 1, 1, 475], [uuid(1), 1, 0, 0]]);
  assert.deepEqual(rows[0].statistics.period, { mode: 'dateRange', startDate: range.startDate, endDate: range.endDate, timeZone: 'America/Vancouver' });
  assert.deepEqual(list({ ...range, ownership: 'free', position: 'F', nhlTeam: 'EDM' }).players.map(p => p.id), [uuid(3)]);
  assert.equal(list({ ...range, startDate: '2026-11-18' }).players[0].statistics.goals, 1);
  assert.deepEqual(list({ ...range, minimumGames: 2 }).players.map(p => p.id), [uuid(3)]);
  assert.deepEqual(list({ ...range, startDate: '2026-11-19', endDate: '2026-11-19' }).players.map(p => p.statistics.gamesPlayed), [0, 0, 0]);
  assert.ok(before.equals(database.serialize()));
});

test('last games uses each player appearances, counts zero-point games, handles negative FP, fewer games, detail and both pagination orders', t => {
  const { database, service, list } = fixture(t), before = database.serialize();
  const first = list({ ...PERIOD, limit: 1 });
  assert.deepEqual([first.players[0].id, first.players[0].statistics.fantasyPointsHundredths], [uuid(2), 475]);
  const second = list({ ...PERIOD, limit: 1, cursor: first.page.nextCursor });
  assert.deepEqual([second.players[0].id, second.players[0].statistics.gamesPlayed, second.players[0].statistics.fantasyPointsHundredths], [uuid(1), 1, 0]);
  const third = list({ ...PERIOD, limit: 1, cursor: second.page.nextCursor });
  assert.equal(third.players[0].statistics.fantasyPointsHundredths, -40);
  assert.equal(third.page.hasMore, false);
  assert.deepEqual(list({ ...PERIOD, lastGames: 200, minimumGames: 2 }).players.map(p => p.id), [uuid(1), uuid(3)]);
  const detail = service.read({ authenticated: 'member', leagueId: LEAGUE, playerId: uuid(3), ...PERIOD });
  assert.deepEqual(detail.statistics, third.players[0].statistics);
  const named = list({ ...PERIOD, sort: 'name', limit: 1 });
  assert.equal(named.players[0].id, uuid(1));
  assert.equal(list({ ...PERIOD, sort: 'name', limit: 1, cursor: named.page.nextCursor }).players[0].id, uuid(2));
  const season = list({}).players;
  assert.equal(season[0].statistics.fantasyPointsHundredths, 3000);
  assert.equal('period' in season[0].statistics, false);
  assert.ok(before.equals(database.serialize()));
});

test('period scores use the current league weights and source position without leaking another league rule', t => {
  const { database, list } = fixture(t);
  list(PERIOD); // Warm the game projection before the league rule changes.
  const weights = defaultScoringWeights(); weights.D.hits = 100;
  database.prepare('INSERT INTO league_scoring_rules VALUES (?, ?, ?, 1, 1, ?)').run('custom', LEAGUE, `season-${LEAGUE}`, JSON.stringify(weights));
  assert.equal(list(PERIOD).players[0].statistics.fantasyPointsHundredths, 800);
  assert.equal(list({ ...PERIOD, leagueId: OTHER }).players[0].statistics.fantasyPointsHundredths, 475);
  assert.throws(() => list({ ...PERIOD, authenticated: null }), { code: 'LEAGUE_NOT_FOUND' });
});

test('missing games, invalid hashes and unaccepted newer captures fail explicitly while ordinary season totals remain available', t => {
  for (const mutation of [
    db => db.prepare('DELETE FROM nhl_completed_game_cache WHERE nhl_game_id=?').run('2026020001'),
    db => db.prepare("UPDATE nhl_completed_game_cache SET entry_json=json_set(entry_json,'$.sha256','bad'),checked_at_ms=checked_at_ms-1 WHERE nhl_game_id=?").run('2026020001'),
    db => db.prepare("UPDATE nhl_completed_game_cache SET checked_at_ms=checked_at_ms+1,entry_json=json_set(entry_json,'$.checkedAtMs',checked_at_ms+1) WHERE nhl_game_id=?").run('2026020001'),
  ]) {
    const { database, list } = fixture(t);
    list(PERIOD);
    mutation(database);
    assert.throws(() => list(PERIOD), { code: 'PLAYER_PERIOD_UNAVAILABLE' });
    assert.equal(list({}).players[0].statistics.fantasyPointsHundredths, 3000);
  }
});

test('history on older staging schemas is unavailable without preparing absent cache tables', t => {
  const database = new Database(':memory:'); t.after(() => database.close());
  database.pragma('user_version=87');
  const read = createPlayerStatisticsPeriodReader({ database, season: '20262027', expanded: true });
  assert.throws(() => read({ leagueId: LEAGUE, period: { mode: 'lastGames', lastGames: 10 } }), { code: 'PLAYER_PERIOD_UNAVAILABLE' });
  database.exec('CREATE TABLE nhl_completed_game_cache(nhl_game_id)');
  const partial = createPlayerStatisticsPeriodReader({ database, season: '20262027', expanded: true });
  assert.throws(() => partial({ leagueId: LEAGUE, period: { mode: 'lastGames', lastGames: 10 } }), { code: 'PLAYER_PERIOD_UNAVAILABLE' });
});

test('period projection stays cached across unrelated writes and invalidates for new accepted/cached data', t => {
  const { database } = fixture(t);
  const read = createPlayerStatisticsPeriodReader({ database, season: '20262027', expanded: true });
  const command = { leagueId: LEAGUE, period: { mode: 'lastGames', lastGames: 10 } };
  const first = read(command);
  database.prepare('INSERT INTO unrelated_events VALUES (?)').run('job-write');
  assert.equal(read(command), first);
  database.prepare('UPDATE nhl_completed_game_cache SET checked_at_ms=checked_at_ms+1').run();
  assert.throws(() => read(command), { code: 'PLAYER_PERIOD_UNAVAILABLE' });
});

test('a newly accepted provider correction replaces historical window totals', t => {
  const { database, list } = fixture(t);
  const options = { statsPeriod: 'dateRange', startDate: '2026-10-27', endDate: '2026-10-27' };
  assert.equal(list(options).players[0].statistics.fantasyPointsHundredths, 3000);
  const entry = JSON.parse(database.prepare('SELECT entry_json FROM nhl_completed_game_cache WHERE nhl_game_id=?').get('2026020001').entry_json);
  entry.data.rows[0].goals = 11; entry.data.rows[0].points = 11;
  entry.data.categories[0][1].evenStrengthGoals = 11;
  const next = completedGameEntry({ game: { id: '2026020001', startsAtMs: Date.parse('2026-10-28T01:00:00Z'), homeTeamId: '1', awayTeamId: '2' },
    season: '20262027', expanded: true, checkedAtMs: SOURCE_AT + 2, data: entry.data });
  database.prepare('UPDATE nhl_completed_game_cache SET checked_at_ms=?,entry_json=? WHERE nhl_game_id=?').run(SOURCE_AT + 2, JSON.stringify(next), '2026020001');
  assert.throws(() => list(options), { code: 'PLAYER_PERIOD_UNAVAILABLE' });
  database.prepare('UPDATE stat_refreshes SET id=?,started_at_ms=?,completed_at_ms=?').run('corrected', SOURCE_AT + 2, SOURCE_AT + 3);
  database.prepare('UPDATE player_stat_totals SET refresh_id=?,source_updated_at_ms=?').run('corrected', SOURCE_AT + 2);
  database.prepare('UPDATE player_stat_totals SET goals=11,nhl_points=11,fantasy_points_hundredths=1375 WHERE player_id=?').run(uuid(1));
  const scoringStats = { ...emptyScoringStats(), evenStrengthGoals: 11 };
  database.prepare('UPDATE expanded_stat_totals SET stats_json=?,forward_fp_hundredths=3300,defence_fp_hundredths=3300 WHERE total_id=?').run(JSON.stringify(scoringStats), 'total-1');
  assert.equal(list(options).players[0].statistics.fantasyPointsHundredths, 3300);
});

test('HTTP forwards period fields to list and detail, returns explicit 400/503 and preserves the database', async t => {
  const { database, service } = fixture(t);
  const middleware = (_request, _response, next) => next();
  const security = Object.fromEntries(['assignRequestId', 'authenticateBootstrap', 'credentialedCors', 'requireAllowedOrigin', 'requireCompatibleFetchMetadata', 'securityHeaders'].map(name => [name, middleware]));
  security.getRequestId = () => 'period-test'; security.getSessionBootstrap = () => 'member';
  const app = express(); app.use(createPlayerRouter({ requestSecurity: security, playerReadService: service, leaguePlayerReadService: service }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}/api/v1/leagues/${LEAGUE}/players`;
  const before = database.serialize();
  const list = await fetch(`${origin}?statsPeriod=lastGames&lastGames=1`);
  assert.equal(list.status, 200);
  const detail = await fetch(`${origin}/${uuid(3)}?statsPeriod=lastGames&lastGames=1`);
  assert.equal((await detail.json()).data.statistics.fantasyPointsHundredths, -40);
  assert.equal((await fetch(`${origin}?statsPeriod=lastGames&lastGames=0`)).status, 400);
  assert.ok(before.equals(database.serialize()));
  database.prepare('DELETE FROM nhl_completed_game_cache').run();
  const unavailable = await fetch(`${origin}?statsPeriod=lastGames&lastGames=1`);
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.code, 'PLAYER_PERIOD_UNAVAILABLE');
});
