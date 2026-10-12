const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createWebPushFadFixture } = require('../helpers/webPushFadFixture');

const MINUTE = 60_000, HOUR = 60 * MINUTE;
function fixture(t, options) {
  const f = createWebPushFadFixture(options);
  t.after(() => f.close());
  return f;
}
function queued(event) {
  return { league_id: event.leagueId, payload_json: JSON.stringify({ title: event.title, url: event.url }) };
}
function rapid(f) { f.db.prepare("UPDATE free_agent_drafts SET status='rapid'").run(); }
function hold(f) {
  f.insert('fad_deadline_controls', { id:f.ids.fad, league_id:f.ids.league, season_id:f.ids.season, mode:'held' });
}
function freeze(f) {
  f.insert('league_freezes', { id:f.ids.freeze, league_id:f.ids.league, status:'active' });
}

test('24-hour card reminder reaches only an unfinished enrolled card, in its bounded window', t => {
  const f = fixture(t);
  assert.deepEqual(f.collect(f.now - 1), []);
  const events = f.collect();
  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.teamId, f.ids.teamOne);
  assert.equal(event.title, 'Candidate Card due in 24h');
  assert.equal(event.category, 'fad_action');
  assert.equal(event.url, `/leagues/${f.ids.league}/free-agent-draft/${f.ids.fad}/cards/${f.ids.teamOne}`);
  assert.equal(event.expiresAt, f.now + HOUR);
  assert.equal(f.collect(f.now + MINUTE)[0].eventKey, event.eventKey);
  assert.equal(f.reminders.authorize(queued(event), event.guard, f.now), true);
  assert.equal(f.reminders.authorize(queued(event), event.guard, f.now + HOUR), false);
  assert.deepEqual(f.collect(f.now + HOUR), []);
  assert.deepEqual(f.collect(f.deadline), []);
});

test('card completion, deadline hold, freeze and removed enrollment suppress queued reminders', t => {
  for (const change of [
    f => f.db.prepare("UPDATE candidate_cards SET completeness_code='complete'").run(),
    f => f.db.prepare("UPDATE candidate_cards SET status='locked'").run(),
    hold,
    freeze,
    f => f.db.prepare('DELETE FROM free_agent_draft_teams WHERE team_id=?').run(f.ids.teamOne),
  ]) {
    const f = fixture(t), event = f.collect()[0];
    change(f);
    assert.deepEqual(f.collect(), []);
    assert.equal(f.reminders.authorize(queued(event), event.guard, f.now), false);
  }
});

test('moving a card deadline invalidates its old alert and gives the new deadline a distinct key', t => {
  const f = fixture(t), event = f.collect()[0];
  f.db.prepare('UPDATE free_agent_drafts SET candidate_deadline_at_ms=?').run(f.deadline + 2 * HOUR);
  assert.deepEqual(f.collect(), []);
  assert.equal(f.reminders.authorize(queued(event), event.guard, f.now), false);
  assert.notEqual(f.collect(f.now + 2 * HOUR)[0].eventKey, event.eventKey);
});

test('rapid round reminder starts ten minutes before closing, after nomination cutoff, for all participants', t => {
  const f = fixture(t); rapid(f);
  const close = f.roundTimes[1], at = close - 10 * MINUTE;
  assert.deepEqual(f.collect(close - 15 * MINUTE), []);
  assert.deepEqual(f.collect(at - 1), []);
  const events = f.collect(at);
  assert.deepEqual(events.map(e => e.teamId).sort(), f.ids.teams.slice().sort());
  for (const event of events) {
    assert.equal(event.title, 'FAD round 2/3 closes in 10 min');
    assert.equal(event.category, 'fad_action');
    assert.equal(event.url, `/leagues/${f.ids.league}/free-agent-draft/${f.ids.fad}`);
    assert.equal(event.expiresAt, close);
    assert.equal(f.reminders.authorize(queued(event), event.guard, at), true);
  }
  assert.equal(events[0].eventKey, events[1].eventKey);
  assert.equal(f.collect(at + MINUTE)[0].eventKey, events[0].eventKey);
  const delivery = queued(events[0]);
  assert.equal(f.reminders.authorize(delivery, events[0].guard, close - 3 * MINUTE), true);
  assert.equal(JSON.parse(delivery.payload_json).title, 'FAD round 2/3 closes in 3 min');
  assert.equal(f.reminders.authorize(delivery, events[0].guard, close), false);
  assert.deepEqual(f.collect(close), []);
});

test('legacy round totals and dynamically added extensions stay accurate when delivery is delayed', t => {
  const f = fixture(t); rapid(f);
  f.db.prepare('UPDATE free_agent_drafts SET initial_rollover_times_json=NULL').run();
  const at = f.roundTimes[2] - 10 * MINUTE, event = f.collect(at)[0];
  assert.equal(event.title, 'FAD round 3/7 closes in 10 min');
  const extensionClose = f.roundTimes[2] + HOUR;
  f.insert('free_agent_draft_rollovers', { id:'extension', league_id:f.ids.league, season_id:f.ids.season,
    fad_id:f.ids.fad, sequence:8, window_kind:'extension', opens_at_ms:f.roundTimes[2],
    creation_cutoff_at_ms:extensionClose - 15 * MINUTE, rolls_over_at_ms:extensionClose, status:'scheduled' });
  const delivery = queued(event);
  assert.equal(f.reminders.authorize(delivery, event.guard, at), true);
  assert.equal(JSON.parse(delivery.payload_json).title, 'FAD round 3/8 closes in 10 min');
  assert.equal(f.collect(extensionClose - 10 * MINUTE)[0].title, 'FAD round 8/8 closes in 10 min');
});

test('moving a rapid close suppresses the old queued warning and creates a new event', t => {
  const f = fixture(t); rapid(f);
  const at = f.roundTimes[0] - 10 * MINUTE, event = f.collect(at)[0];
  f.db.prepare('UPDATE free_agent_draft_rollovers SET rolls_over_at_ms=rolls_over_at_ms+? WHERE id=?').run(20 * MINUTE, f.ids.roundOne);
  assert.deepEqual(f.collect(at), []);
  assert.equal(f.reminders.authorize(queued(event), event.guard, at), false);
  assert.notEqual(f.collect(at + 20 * MINUTE)[0].eventKey, event.eventKey);
});

test('rapid reminders stop for unopened, processing, completed and paused rounds or removed participants', t => {
  for (const change of [
    (f, at) => f.db.prepare('UPDATE free_agent_draft_rollovers SET opens_at_ms=?').run(at + 1),
    f => f.db.prepare("UPDATE free_agent_draft_rollovers SET status='processing'").run(),
    f => f.db.prepare("UPDATE free_agent_draft_rollovers SET status='completed'").run(),
    f => f.db.prepare("UPDATE free_agent_drafts SET status='completed'").run(),
    freeze,
    f => f.db.prepare('DELETE FROM free_agent_draft_teams').run(),
  ]) {
    const f = fixture(t); rapid(f);
    const at = f.roundTimes[0] - 10 * MINUTE, event = f.collect(at)[0];
    change(f, at);
    assert.deepEqual(f.collect(at), []);
    assert.equal(f.reminders.authorize(queued(event), event.guard, at), false);
  }
});

test('historical seasons and inactive leagues do not produce either timer', t => {
  for (const sql of ["UPDATE leagues SET current_season_id='another-season'", "UPDATE leagues SET status='paused'"]) {
    const f = fixture(t), card = f.collect()[0];
    f.db.exec(sql);
    assert.deepEqual(f.collect(), []);
    assert.equal(f.reminders.authorize(queued(card), card.guard, f.now), false);
    rapid(f);
    assert.deepEqual(f.collect(f.roundTimes[0] - 10 * MINUTE), []);
  }
});

test('configured-season scope applies to both collection and queued delivery', t => {
  const f = fixture(t, { configuredSeasonsOnly:true }), card = f.collect()[0];
  assert.ok(card);
  rapid(f);
  const at = f.roundTimes[0] - 10 * MINUTE, round = f.collect(at)[0];
  assert.ok(round);
  f.db.exec('UPDATE season_matchup_schedule_generations SET fad_timing_json=NULL');
  assert.deepEqual(f.collect(at), []);
  assert.equal(f.reminders.authorize(queued(round), round.guard, at), false);
  f.db.exec("UPDATE free_agent_drafts SET status='cards_open'");
  assert.deepEqual(f.collect(), []);
  assert.equal(f.reminders.authorize(queued(card), card.guard, f.now), false);
});

test('collecting and authorizing reminders never changes draft, card or auction schedule state', t => {
  const f = fixture(t);
  const count = () => f.db.prepare('SELECT total_changes() n').get().n;
  const before = count(), card = f.collect()[0];
  f.reminders.authorize(queued(card), card.guard, f.now);
  assert.equal(count(), before);
  rapid(f);
  const beforeRound = count(), at = f.roundTimes[0] - 10 * MINUTE;
  for (const round of f.collect(at)) f.reminders.authorize(queued(round), round.guard, at);
  assert.equal(count(), beforeRound);
  assert.equal(f.reminders.authorize({}, {kind:'unrelated'}, at), null);
});
