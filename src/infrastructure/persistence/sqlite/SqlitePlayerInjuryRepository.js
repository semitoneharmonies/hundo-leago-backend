const { randomUUID } = require('node:crypto');
const { normalizedName, injuryProjection, STALE_AFTER_MS } = require('../../../domain/players/injuryStatusPolicy');

function failure(code) { throw Object.assign(new Error(code), { code }); }
function createInjuryReader(database) {
  if (database.pragma('user_version', { simple: true }) < 63) return () => null;
  const read = database.prepare('SELECT * FROM player_injury_status WHERE id = ?');
  return id => read.get(id) || null;
}

function createSqlitePlayerInjuryRepository({ database, nowMs = Date.now } = {}) {
  const read = database.prepare('SELECT * FROM player_injury_status WHERE id = ?');
  const readFeed = database.prepare('SELECT * FROM player_injury_feed WHERE id = ?');
  const sync = database.prepare("SELECT * FROM player_injury_sync WHERE id = 'espn'");
  const syncState = () => sync.get() || { id: 'espn', enabled: 0, last_success_at_ms: null, last_attempt_at_ms: null, next_attempt_at_ms: 0, lease_token: null, lease_until_ms: 0, error_code: null, version: 1 };
  const initializeSync = () => database.prepare("INSERT OR IGNORE INTO player_injury_sync(id) VALUES ('espn')").run();
  const catalog = database.prepare("SELECT id, full_name, birth_date FROM players WHERE status = 'active'");
  const person = database.prepare('SELECT id, full_name FROM players WHERE id = ?');
  const writeState = database.prepare(`INSERT INTO player_injury_status
    (id,status,source,evidence_at_ms,observed_at_ms,review_reason,updated_at_ms,version)
    VALUES (@id,@status,@source,@evidence_at_ms,@observed_at_ms,@review_reason,@updated_at_ms,1)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status,source=excluded.source,
      evidence_at_ms=excluded.evidence_at_ms,observed_at_ms=excluded.observed_at_ms,
      review_reason=excluded.review_reason,updated_at_ms=excluded.updated_at_ms,version=version+1`);
  const audit = database.prepare(`INSERT INTO player_injury_events
    (id,player_id,actor_user_id,action,reason,before_json,after_json,created_at_ms) VALUES (?,?,?,?,?,?,?,?)`);
  function event(playerId, actorId, action, reason, before, after, at) {
    audit.run(randomUUID(), playerId, actorId, action, reason, JSON.stringify(before ?? null), JSON.stringify(after ?? null), at);
  }
  function saveState(id, next, at, actorId = null, reason = 'Verified injury report') {
    const before = read.get(id);
    const value = { id, ...next, updated_at_ms: at };
    const changed = !before || ['status','source','evidence_at_ms','review_reason'].some(key => before[key] !== value[key]);
    writeState.run(value);
    if (changed) event(id, actorId, actorId ? 'admin_decision' : 'feed_update', reason, before, read.get(id), at);
  }
  const apply = database.transaction((snapshot, token, at) => {
    const state = syncState();
    if (state.lease_token !== token || state.lease_until_ms <= at) failure('INJURY_REFRESH_CONFLICT');
    if (state.last_success_at_ms !== null && snapshot.observedAtMs <= state.last_success_at_ms) failure('INJURY_FEED_STALE');
    const previous = database.prepare('SELECT * FROM player_injury_feed').all();
    const presentCount = previous.filter(row => row.present).length;
    if (presentCount > 10 && snapshot.rows.length < presentCount / 2) failure('INJURY_FEED_INCOMPLETE');
    const players = catalog.all();
    const mapped = new Set(previous.map(row => row.player_id).filter(Boolean));
    const seen = new Set(snapshot.rows.map(row => row.id));
    const upsert = database.prepare(`INSERT INTO player_injury_feed
      (id,player_id,name,birth_date,team,designation,injury_type,eligible,present,reported_at_ms,observed_at_ms,version)
      VALUES (@id,@player_id,@name,@birth_date,@team,@designation,@injury_type,@eligible,1,@reported_at_ms,@observed_at_ms,1)
      ON CONFLICT(id) DO UPDATE SET player_id=excluded.player_id,name=excluded.name,
      birth_date=COALESCE(excluded.birth_date,birth_date),team=excluded.team,designation=excluded.designation,
      injury_type=excluded.injury_type,eligible=excluded.eligible,present=1,reported_at_ms=excluded.reported_at_ms,
      observed_at_ms=excluded.observed_at_ms,version=version+1`);
    for (const row of snapshot.rows) {
      const existing = readFeed.get(row.id);
      let playerId = existing?.player_id || null;
      if (!playerId && row.birthDate) {
        const matches = players.filter(p => p.birth_date === row.birthDate && normalizedName(p.full_name) === normalizedName(row.name));
        if (matches.length === 1 && !mapped.has(matches[0].id)) {
          playerId = matches[0].id; mapped.add(playerId);
          event(playerId, null, 'identity_match', 'Unique full name and date of birth', null, { providerId: row.id }, at);
        }
      }
      upsert.run({ id: row.id, player_id: playerId, name: row.name, birth_date: row.birthDate,
        team: row.team, designation: row.designation, injury_type: row.injuryType, eligible: Number(row.eligible),
        reported_at_ms: row.reportedAtMs, observed_at_ms: snapshot.observedAtMs });
      if (!playerId) continue;
      const current = read.get(playerId);
      // An admin decision wins over the report it reviewed; a newer injury can reopen the case.
      if (current?.source === 'admin' && row.reportedAtMs <= current.evidence_at_ms) continue;
      if (row.eligible) saveState(playerId, { status: 'injured', source: 'espn', evidence_at_ms: row.reportedAtMs,
        observed_at_ms: snapshot.observedAtMs, review_reason: null }, at);
      else if (current?.status === 'injured') saveState(playerId, { ...current, review_reason: 'status_changed', observed_at_ms: snapshot.observedAtMs }, at, null, 'Provider designation requires review');
    }
    for (const row of previous.filter(row => row.present && !seen.has(row.id))) {
      database.prepare('UPDATE player_injury_feed SET present=0,version=version+1 WHERE id=?').run(row.id);
      const current = row.player_id && read.get(row.player_id);
      if (current?.status === 'injured') saveState(row.player_id, { ...current, review_reason: 'possible_return' }, at, null, 'No longer listed; recovery needs admin confirmation');
    }
    database.prepare("UPDATE player_injury_sync SET last_success_at_ms=?,lease_token=NULL,lease_until_ms=0,error_code=NULL,version=version+1 WHERE id='espn'").run(snapshot.observedAtMs);
    return { imported: snapshot.rows.length, unresolved: database.prepare('SELECT count(*) AS n FROM player_injury_feed WHERE player_id IS NULL AND present=1').get().n };
  });
  return {
    read: id => read.get(id) || null,
    mappedIds: () => database.prepare('SELECT id FROM player_injury_feed WHERE player_id IS NOT NULL').all().map(row => row.id),
    syncState: () => syncState(),
    claim(force = false) {
      initializeSync();
      const at = nowMs(), token = randomUUID();
      const result = database.prepare(`UPDATE player_injury_sync SET lease_token=?,lease_until_ms=?,
        last_attempt_at_ms=?,next_attempt_at_ms=?,version=version+1 WHERE id='espn' AND lease_until_ms<=?
        AND (?=1 OR (enabled=1 AND next_attempt_at_ms<=?))`).run(token, at+15*60_000, at, at+60*60_000, at, Number(force), at);
      return result.changes === 1 ? token : null;
    },
    apply(snapshot, token) { return apply.immediate(snapshot, token, nowMs()); },
    fail(token, code) {
      database.prepare("UPDATE player_injury_sync SET lease_token=NULL,lease_until_ms=0,error_code=?,next_attempt_at_ms=?,version=version+1 WHERE id='espn' AND lease_token=?")
        .run(code, nowMs()+15*60_000, token);
    },
    list({ search = '' } = {}) {
      const at = nowMs();
      const rows = database.prepare(`SELECT p.id,p.full_name AS name,p.birth_date AS birthDate,s.status,s.source,
        s.version,s.review_reason AS reviewReason,s.observed_at_ms AS observedAtMs,
        f.designation,f.injury_type AS injuryType,f.team,f.present
        FROM players p LEFT JOIN player_injury_status s ON s.id=p.id
        LEFT JOIN player_injury_feed f ON f.player_id=p.id
        WHERE (?<>'' AND instr(lower(p.full_name),lower(?))>0) OR (?='' AND (s.status IS NOT NULL OR f.player_id IS NOT NULL))
        ORDER BY (s.review_reason IS NOT NULL) DESC,p.full_name LIMIT 100`).all(search, search, search)
        .map(row => ({ ...row, status: row.status || 'unknown', version: row.version || 0, stale: row.source === 'espn' && at-row.observedAtMs>STALE_AFTER_MS }));
      const unmatched = database.prepare('SELECT id,name,birth_date AS birthDate,team,designation,injury_type AS injuryType,version FROM player_injury_feed WHERE player_id IS NULL AND present=1 ORDER BY name LIMIT 100').all();
      const history = database.prepare(`SELECT e.id,p.full_name AS name,e.action,e.reason,e.created_at_ms AS createdAtMs,
        u.display_name AS actor,json_extract(e.after_json,'$.status') AS status FROM player_injury_events e LEFT JOIN players p ON p.id=e.player_id
        LEFT JOIN users u ON u.id=e.actor_user_id ORDER BY e.created_at_ms DESC,e.rowid DESC LIMIT 30`).all();
      const state = syncState();
      return { players: rows, unmatched, history, sync: { enabled: false, lastSuccessAtMs: state.last_success_at_ms, errorCode: state.error_code }, importsAvailable: false };
    },
    decide: database.transaction(({ playerId, status, expectedVersion, reason, actorId }) => {
      const current = read.get(playerId), at = nowMs();
      if (!person.get(playerId)) failure('INJURY_PLAYER_NOT_FOUND');
      if ((current?.version || 0) !== expectedVersion) failure('INJURY_VERSION_CONFLICT');
      if (status === 'automatic') {
        const feed = database.prepare('SELECT * FROM player_injury_feed WHERE player_id=?').get(playerId);
        saveState(playerId, { status: feed?.present && feed.eligible && at-feed.observed_at_ms<=STALE_AFTER_MS ? 'injured' : 'unknown', source: 'espn', evidence_at_ms: feed?.reported_at_ms || at, observed_at_ms: feed?.observed_at_ms || at, review_reason: null }, at, actorId, reason);
      } else saveState(playerId, { status, source: 'admin', evidence_at_ms: at, observed_at_ms: at, review_reason: null }, at, actorId, reason);
      return { playerId, injury: injuryProjection(read.get(playerId), at), version: read.get(playerId).version };
    }),
    map: database.transaction(({ providerId, playerId, expectedVersion, reason, actorId }) => {
      const before = readFeed.get(providerId), at = nowMs();
      if (!before || !person.get(playerId)) failure('INJURY_PLAYER_NOT_FOUND');
      if (before.version !== expectedVersion || before.player_id || database.prepare('SELECT id FROM player_injury_feed WHERE player_id=?').get(playerId)) failure('INJURY_VERSION_CONFLICT');
      database.prepare('UPDATE player_injury_feed SET player_id=?,version=version+1 WHERE id=?').run(playerId, providerId);
      event(playerId, actorId, 'identity_match', reason, before, readFeed.get(providerId), at);
      const current = read.get(playerId);
      if (before.present && before.eligible && at-before.observed_at_ms<=STALE_AFTER_MS && (!current || current.source !== 'admin' || before.reported_at_ms>current.evidence_at_ms)) {
        saveState(playerId, { status: 'injured', source: 'espn', evidence_at_ms: before.reported_at_ms, observed_at_ms: before.observed_at_ms, review_reason: null }, at, actorId, reason);
      }
      return { playerId };
    }),
    settings: database.transaction(({ enabled, expectedVersion, actorId }) => {
      const before = syncState();
      initializeSync();
      if (before.version !== expectedVersion) failure('INJURY_VERSION_CONFLICT');
      database.prepare("UPDATE player_injury_sync SET enabled=?,version=version+1 WHERE id='espn'").run(Number(enabled));
      event(null, actorId, 'refresh_settings', enabled ? 'Enabled hourly injury refresh' : 'Disabled hourly injury refresh', { enabled: before.enabled }, { enabled: Number(enabled) }, nowMs());
      return syncState();
    }),
  };
}
module.exports = { createInjuryReader, createSqlitePlayerInjuryRepository };
