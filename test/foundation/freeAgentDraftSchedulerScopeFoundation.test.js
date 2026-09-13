"use strict";
const assert = require('node:assert/strict');
const { test } = require('node:test');
const Database = require('better-sqlite3');
const { freeAgentDraftSchedulerScopeSql } = require('../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftSchedulerScope');

test('configured staging scope filters before pagination and remains bound to league and season after recovery', (t) => {
  const database = new Database(':memory:');
  t.after(() => database.close());
  database.exec(`CREATE TABLE job_runs (id INTEGER, league_id TEXT, season_id TEXT);
    CREATE TABLE season_matchup_schedule_generations (league_id TEXT, season_id TEXT, status TEXT, fad_timing_json TEXT);
    INSERT INTO job_runs VALUES (1,'legacy','old'),(2,'selected','old'),(3,'other','new'),(4,'selected','new');
    INSERT INTO season_matchup_schedule_generations VALUES ('legacy','old','current',NULL),('selected','new','superseded','{}'),('selected','new','current',NULL);`);
  const before = database.serialize();
  const scoped = freeAgentDraftSchedulerScopeSql({ database, configuredSeasonsOnly: true, alias: 'job_runs' });
  assert.deepEqual(database.prepare(`SELECT id FROM job_runs WHERE ${scoped} ORDER BY id LIMIT 1`).all(), [{ id: 4 }]);
  const normal = freeAgentDraftSchedulerScopeSql({ database, alias: 'job_runs' });
  assert.equal(database.prepare(`SELECT count(*) n FROM job_runs WHERE ${normal}`).get().n, 4);
  assert.deepEqual(database.serialize(), before);
});

test('historical staging schemas remain paused and ordinary runtime discovery stays available', (t) => {
  const database = new Database(':memory:');
  t.after(() => database.close());
  database.exec('CREATE TABLE season_matchup_schedule_generations (league_id TEXT, season_id TEXT)');
  assert.equal(freeAgentDraftSchedulerScopeSql({ database, configuredSeasonsOnly: true, alias: 'draft' }), '0');
  assert.equal(freeAgentDraftSchedulerScopeSql({ database, alias: 'draft' }), '1');
  assert.throws(() => freeAgentDraftSchedulerScopeSql({ database, configuredSeasonsOnly: 'false', alias: 'draft' }), TypeError);
  assert.throws(() => freeAgentDraftSchedulerScopeSql({ database, configuredSeasonsOnly: true, alias: 'draft; DROP TABLE job_runs' }), TypeError);
});
