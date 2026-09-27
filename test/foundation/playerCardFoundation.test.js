const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createReleaseQaFixture } = require('../../src/operations/release/createReleaseQaFixture');
const { fixtureId } = require('../../src/operations/release/releaseQaFixtureContract');
const { openDatabase } = require('../../src/infrastructure/database/connection');
const { createSqliteRepositoryContext } = require('../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext');
const { createLeagueAuthorizationService } = require('../../src/application/services/authorization/requireLeagueAuthority');
const { createSqliteUserRepository } = require('../../src/infrastructure/persistence/sqlite/SqliteUserRepository');
const { createSqliteLeagueAccessRepository } = require('../../src/infrastructure/persistence/sqlite/SqliteLeagueAccessRepository');
const { createSqlitePlayerRepository } = require('../../src/infrastructure/persistence/sqlite/SqlitePlayerRepository');
const { createSqliteLeaguePlayerReadRepository } = require('../../src/infrastructure/persistence/sqlite/SqliteLeaguePlayerReadRepository');
const { createSqliteTradeProposalRepository } = require('../../src/infrastructure/persistence/sqlite/SqliteTradeProposalRepository');
const { createSqlitePlayerCardRepository } = require('../../src/infrastructure/persistence/sqlite/SqlitePlayerCardRepository');
const { createLeaguePlayerReadService } = require('../../src/application/services/players/createLeaguePlayerReadService');
const { createPlayerCardService, signingMethod } = require('../../src/application/services/players/createPlayerCardService');

test('signing provenance distinguishes Candidate Cards, rapid, restricted and ordinary auctions', () => {
  for (const [source, context, expected] of [
    ['free_agent_draft_allocation', null, 'Candidate Card'], ['auction_resolution', 'fad_open_rapid', 'Rapid auction'],
    ['auction_resolution', 'fad_restricted', 'Restricted auction'], ['auction_resolution', null, 'Auction'],
    ['fantasy_elc', null, 'Fantasy ELC'], ['legacy_import', null, 'Signing source not recorded'],
  ]) assert.equal(signingMethod({ acquisition_source_type: source, auction_source_kind: context }), expected);
});

test('player value handles retention, missing games and unsigned players without infinity', async () => {
  let stats = { gamesPlayed: 10, fantasyPointsHundredths: 3000 };
  let active = { aavCents: 1000 };
  const service = createPlayerCardService({ leaguePlayerReadService: { read: () => ({ statistics: stats, league: { activeContract: active } }) },
    repository: { read: () => ({ cap: { retained_aav_cents: 250 }, signings: [], tradeIds: [] }) } });
  const read = () => service.read({ leagueId: 'test', playerId: 'test' });
  assert.equal((await read()).value.fantasyPointsPerGame, 3);
  assert.equal((await read()).value.perCapDollar, 0.4);
  stats.gamesPlayed = 0; assert.equal((await read()).value.perCapDollar, null);
  stats = null; assert.equal((await read()).statistics, null);
  active = null; assert.equal((await read()).contract, null); assert.equal((await read()).value.perCapDollar, null);
});

test('saved history is league-scoped, read-only, public after execution, and preserves full trade assets', async t => {
  const root = fs.mkdtempSync(path.resolve(__dirname, '../../.test-temp/player-card-'));
  const databasePath = path.join(root, 'card-release-qa.sqlite3');
  await createReleaseQaFixture({ databasePath, environment: 'test', migrationsDirectory: path.resolve(__dirname, '../../database/migrations'), password: 'hundo', temporaryRoot: root });
  const { database } = openDatabase({ databasePath, environment: 'test' });
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  createSqliteRepositoryContext({ database });
  const leagueAuthorization = createLeagueAuthorizationService({ userRepository: createSqliteUserRepository({ database }), leagueAccessRepository: createSqliteLeagueAccessRepository({ database }) });
  const leaguePlayerReadService = createLeaguePlayerReadService({ leagueAuthorization, playerRepository: createSqlitePlayerRepository({ database }), leaguePlayerRepository: createSqliteLeaguePlayerReadRepository({ database }) });
  const tradeRepository = createSqliteTradeProposalRepository({ database, candidateCardSummerSynchronizer: { synchronize() { throw Error('No writes allowed'); } } });
  const repository = createSqlitePlayerCardRepository({ database });
  let appearanceReads = 0;
  const service = createPlayerCardService({ leaguePlayerReadService, repository, tradeRepository,
    appearanceAdapter: { read: async () => { appearanceReads++; return { jerseyNumber: 97, nhlTeam: 'EDM' }; } } });
  const userId = fixtureId('account:leagueAManagerOne');
  const authenticated = { valid: true, user: { id: userId }, session: { userId } };
  const leagueId = fixtureId('league:leagueA');
  const completed = database.prepare(`SELECT t.id, a.player_id FROM trades t JOIN trade_assets a ON a.league_id=t.league_id AND a.trade_id=t.id
    WHERE t.league_id=? AND t.completed_at_ms IS NOT NULL AND a.player_id IS NOT NULL LIMIT 1`).get(leagueId);
  assert.ok(completed, 'release fixture supplies an executed player trade');
  const before = database.serialize();
  const card = await service.read({ authenticated, leagueId, playerId: completed.player_id });
  assert.equal(card.leagueId, leagueId);
  assert.deepEqual(card.appearance, { jerseyNumber: 97, nhlTeam: 'EDM' });
  assert.equal(card.nhlTeam, card.appearance.nhlTeam);
  assert.ok(card.ownership?.team, 'fixture supplies a current owner');
  const owningTeam = database.prepare('SELECT * FROM teams WHERE league_id=? AND id=?').get(leagueId, card.ownership.team.id);
  assert.equal(card.ownership.team.primaryColour, owningTeam.primary_colour);
  assert.equal(card.ownership.team.secondaryColour, owningTeam.secondary_colour);
  assert.equal(card.ownership.team.tertiaryColour, owningTeam.tertiary_colour);
  assert.equal(card.ownership.team.patternTemplate, owningTeam.pattern_template);
  const trade = card.history.trades.find(entry => entry.id === completed.id);
  assert.ok(trade);
  assert.deepEqual(trade.assets.map(({ detail, ...asset }) => asset), tradeRepository.readDetail({ leagueId, tradeId: completed.id }).assets);
  assert.ok(trade.assets.length > 1, 'all sides of the deal are included');
  for (const entry of card.history.trades) {
    assert.ok(database.prepare('SELECT 1 FROM trades WHERE id=? AND league_id=? AND completed_at_ms IS NOT NULL').get(entry.id, leagueId));
    assert.equal(entry.history, undefined, 'no negotiation or audit history');
  }
  await assert.rejects(service.read({ authenticated, leagueId: fixtureId('league:leagueB'), playerId: completed.player_id }), { code: 'LEAGUE_NOT_FOUND' });
  await assert.rejects(service.read({ authenticated, leagueId, playerId: 'invalid' }), { code: 'PLAYER_READ_INPUT_INVALID' });
  assert.equal(appearanceReads, 1, 'unauthorized or invalid requests do not call the public provider');
  assert.deepEqual(database.serialize(), before, 'viewing or denying a card never mutates stored data');
  assert.equal(JSON.stringify(card).includes('winning_bid'), false);
  const pending = database.prepare(`SELECT t.id, COALESCE(a.player_id,c.player_id) AS player_id FROM trades t
    JOIN trade_assets a ON a.league_id=t.league_id AND a.trade_id=t.id
    LEFT JOIN contracts c ON c.league_id=a.league_id AND c.id=a.contract_id
    WHERE t.league_id=? AND t.completed_at_ms IS NULL AND COALESCE(a.player_id,c.player_id) IS NOT NULL LIMIT 1`).get(leagueId);
  assert.ok(pending, 'fixture includes private unexecuted offers');
  assert.ok(!(await service.read({ authenticated, leagueId, playerId: pending.player_id })).history.trades.some(trade => trade.id === pending.id));
  const otherUser = fixtureId('account:leagueBManagerOne');
  const otherCard = await service.read({ authenticated: { valid: true, user: { id: otherUser }, session: { userId: otherUser } },
    leagueId: fixtureId('league:leagueB'), playerId: completed.player_id });
  assert.ok(otherCard.history.signings.every(signing => !card.history.signings.some(original => original.id === signing.id)));
  assert.ok(otherCard.history.trades.every(trade => !card.history.trades.some(original => original.id === trade.id)));
  assert.deepEqual(database.serialize(), before);
});

test('signing history uses the original signing event, not the current owner or corrected contract price', async () => {
  const service = createPlayerCardService({
    leaguePlayerReadService: { read: () => ({ fullName: 'Player', league: { ownership: { team: { name: 'New owner' } }, activeContract: null } }) },
    repository: { read: () => ({ tradeIds: [], signings: [{ id: 'saved', status: 'expired', source_type: 'free_agent_draft_allocation',
      occurred_at_ms: 1000, created_at_ms: 900, signing_team_id: 'original', signing_team_name: 'Signing team',
      metadata_json: JSON.stringify({ aavCents: 500, originalTermYears: 3, originalTotalValueCents: 1500 }) }] }) },
  });
  const signing = (await service.read({ leagueId: 'league', playerId: 'player' })).history.signings[0];
  assert.equal(signing.team.name, 'Signing team'); assert.equal(signing.atMs, 1000);
  assert.equal(signing.aavCents, 500); assert.equal(signing.termYears, 3);
});
