const assert = require('node:assert/strict');
const { test } = require('node:test');
const Database = require('better-sqlite3');
const { createGoonDraftPublicationIdentity } = require('../../src/infrastructure/persistence/sqlite/goonDraftPublicationIdentity');
const { createFreeAgentDraftNotificationContract } = require('../../src/domain/freeAgentDraft/freeAgentDraftNotificationContracts');
const { GOON_ID } = require('../../src/infrastructure/persistence/sqlite/goonDraftTiming');

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function input(leagueId = GOON_ID) {
  return { type: 'fad_cards_locked', recipientUserId: id(1), messageData: {
    leagueId, seasonId: id(2), fadId: id(3),
    destination: { kind: 'fad_results', leagueId, fadId: id(3) },
  } };
}

test('a confirmed reopened draft gets stable new publication identities without changing message contents', t => {
  const database = new Database(':memory:');
  t.after(() => database.close());
  database.exec('PRAGMA user_version=93; CREATE TABLE goon_draft_scheduling_receipts(id TEXT,league_id TEXT,fad_id TEXT)');
  const identity = createGoonDraftPublicationIdentity(database, value => value);
  const namespace = `fad:${id(3)}:cards-locked:${id(1)}`;
  const original = createFreeAgentDraftNotificationContract(input());
  assert.equal(identity.uuid(namespace), namespace);
  assert.deepEqual(identity.contract(input()), original);

  // Writers may have been constructed before the commissioner schedules it.
  database.prepare('INSERT INTO goon_draft_scheduling_receipts VALUES (?,?,?)').run(id(4), GOON_ID, id(3));
  const changed = identity.contract(input());
  assert.equal(changed.deduplicationKey, `${original.deduplicationKey}:schedule:${id(4)}`);
  assert.equal(identity.uuid(namespace), `${namespace}:schedule:${id(4)}`);
  assert.deepEqual(identity.contract(input()), changed);
  assert.deepEqual({ ...changed, deduplicationKey: original.deduplicationKey }, original);
  assert.deepEqual(identity.contract(input(id(5))), createFreeAgentDraftNotificationContract(input(id(5))));
  assert.equal(identity.uuid(`fad:${id(6)}:completed`), `fad:${id(6)}:completed`);
});

test('legacy schemas retain their exact existing publication identities', t => {
  const database = new Database(':memory:');
  t.after(() => database.close());
  database.pragma('user_version=92');
  const identity = createGoonDraftPublicationIdentity(database, value => value);
  assert.equal(identity.uuid('existing-event'), 'existing-event');
  assert.deepEqual(identity.contract(input()), createFreeAgentDraftNotificationContract(input()));
});
