const Database = require('better-sqlite3');
const { createSqliteFadPushReminders } = require('../../src/infrastructure/persistence/sqlite/SqliteFadPushReminders');

const HOUR = 3_600_000;
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Focused read-model fixture, matching the deadline-reminder writer tests.
// This deliberately omits unrelated lifecycle triggers; migrated-schema push
// foundation tests separately verify the real database integration.
function createWebPushFadFixture({ now = 1_800_000_000_000, configuredSeasonsOnly = false } = {}) {
  const database = new Database(':memory:');
  const ids = {
    league: id(1), season: id(2), fad: id(3),
    teams: [id(11), id(12)], cards: [id(21), id(22)],
    rounds: [id(31), id(32), id(33)],
    participants: [id(41), id(42)], schedule: id(51), freeze: id(61),
  };
  Object.assign(ids, { teamOne: ids.teams[0], teamTwo: ids.teams[1],
    cardOne: ids.cards[0], cardTwo: ids.cards[1], roundOne: ids.rounds[0] });
  const deadline = now + 24 * HOUR;
  const roundTimes = [1, 2, 3].map(sequence => deadline + sequence * HOUR);
  database.exec(`
    CREATE TABLE leagues (
      id TEXT PRIMARY KEY, current_season_id TEXT, status TEXT NOT NULL
    ) STRICT;
    CREATE TABLE seasons (
      id TEXT PRIMARY KEY, league_id TEXT NOT NULL, status TEXT NOT NULL
    ) STRICT;
    CREATE TABLE teams (
      id TEXT PRIMARY KEY, league_id TEXT NOT NULL, status TEXT NOT NULL
    ) STRICT;
    CREATE TABLE free_agent_drafts (
      id TEXT PRIMARY KEY, league_id TEXT NOT NULL, season_id TEXT NOT NULL,
      status TEXT NOT NULL, candidate_deadline_at_ms INTEGER,
      initial_rollover_times_json TEXT
    ) STRICT;
    CREATE TABLE free_agent_draft_teams (
      id TEXT PRIMARY KEY, league_id TEXT NOT NULL, season_id TEXT NOT NULL,
      fad_id TEXT NOT NULL, team_id TEXT NOT NULL,
      UNIQUE(league_id, season_id, fad_id, team_id)
    ) STRICT;
    CREATE TABLE candidate_cards (
      id TEXT PRIMARY KEY, league_id TEXT NOT NULL, season_id TEXT NOT NULL,
      fad_id TEXT NOT NULL, team_id TEXT NOT NULL, status TEXT NOT NULL,
      completeness_code TEXT NOT NULL,
      UNIQUE(league_id, season_id, fad_id, team_id)
    ) STRICT;
    CREATE TABLE free_agent_draft_rollovers (
      id TEXT PRIMARY KEY, league_id TEXT NOT NULL, season_id TEXT NOT NULL,
      fad_id TEXT NOT NULL, sequence INTEGER NOT NULL,
      window_kind TEXT NOT NULL DEFAULT 'initial', opens_at_ms INTEGER NOT NULL,
      creation_cutoff_at_ms INTEGER NOT NULL, rolls_over_at_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      UNIQUE(league_id, season_id, fad_id, sequence)
    ) STRICT;
    CREATE TABLE league_freezes (
      id TEXT PRIMARY KEY, league_id TEXT NOT NULL, status TEXT NOT NULL
    ) STRICT;
    CREATE TABLE fad_deadline_controls (
      id TEXT PRIMARY KEY, league_id TEXT NOT NULL, season_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('held', 'proceed'))
    ) STRICT;
    CREATE TABLE season_matchup_schedule_generations (
      id TEXT PRIMARY KEY, league_id TEXT NOT NULL, season_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'current', fad_timing_json TEXT
    ) STRICT;
  `);
  const tables = new Set(database.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name));
  function insert(table, record) {
    if (!tables.has(table)) throw new TypeError(`Unknown fixture table: ${table}`);
    const columns = Object.keys(record);
    if (columns.some(column => !/^[a-z_]+$/.test(column))) throw new TypeError('Invalid fixture column');
    return database.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(column => '@' + column).join(',')})`).run(record);
  }
  insert('leagues', { id: ids.league, current_season_id: ids.season, status: 'active' });
  insert('seasons', { id: ids.season, league_id: ids.league, status: 'active' });
  insert('free_agent_drafts', { id: ids.fad, league_id: ids.league, season_id: ids.season,
    status: 'cards_open', candidate_deadline_at_ms: deadline, initial_rollover_times_json: JSON.stringify(roundTimes) });
  for (let index = 0; index < ids.teams.length; index += 1) {
    const scope = { league_id: ids.league, season_id: ids.season, fad_id: ids.fad, team_id: ids.teams[index] };
    insert('teams', { id: ids.teams[index], league_id: ids.league, status: 'active' });
    insert('free_agent_draft_teams', { id: ids.participants[index], ...scope });
    insert('candidate_cards', { id: ids.cards[index], ...scope, status: 'open', completeness_code: index === 0 ? 'incomplete' : 'complete' });
  }
  for (let index = 0; index < roundTimes.length; index += 1) {
    insert('free_agent_draft_rollovers', { id: ids.rounds[index], league_id: ids.league, season_id: ids.season,
      fad_id: ids.fad, sequence: index + 1, window_kind: 'initial',
      opens_at_ms: index === 0 ? deadline : roundTimes[index - 1],
      creation_cutoff_at_ms: roundTimes[index] - 15 * 60_000,
      rolls_over_at_ms: roundTimes[index], status: 'scheduled' });
  }
  insert('season_matchup_schedule_generations', { id: ids.schedule, league_id: ids.league, season_id: ids.season,
    status: 'current', fad_timing_json: JSON.stringify({ candidateDeadlineAtMs: deadline, rolloverTimesAtMs: roundTimes, auctionCreationCutoffMinutes: 15 }) });
  const reminders = createSqliteFadPushReminders({ database, configuredSeasonsOnly });
  return {
    database, db: database, insert, reminders, ids, now, deadline, roundTimes,
    collect(at = now) {
      const events = [];
      reminders.collect(at, (event, teamId) => events.push({ ...event, teamId }));
      return events;
    },
    close() { if (database.open) database.close(); },
  };
}

module.exports = { createWebPushFadFixture };
