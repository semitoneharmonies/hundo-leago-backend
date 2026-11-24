const { createHash, randomUUID } = require('node:crypto');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const NHL_ID = /^[1-9]\d{0,19}$/;
const TEAMS = new Set('ANA BOS BUF CAR CBJ CGY CHI COL DAL DET EDM FLA LAK MIN MTL NJD NSH NYI NYR OTT PHI PIT SEA SJS STL TBL TOR UTA VAN VGK WPG WSH'.split(' '));
const COUNT_KEYS = ['cataloguePlayers', 'indexPlayers', 'matchedPlayers', 'unchangedPlayers', 'omittedPlayers', 'confirmedChanges'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function valid(condition) { if (!condition) fail('NHL_TEAM_ASSIGNMENT_INPUT_INVALID', 'A valid NHL team-assignment snapshot is required.'); }
function object(value, required, optional = []) {
  valid(value && typeof value === 'object' && !Array.isArray(value));
  valid(required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key)));
}

function validate(input) {
  object(input, ['observedAtMs', 'sourceVersion', 'assignments'], ['authorizePersist', 'counts']);
  valid(Number.isSafeInteger(input.observedAtMs) && input.observedAtMs >= 0 && input.observedAtMs <= 8_640_000_000_000_000);
  valid(typeof input.sourceVersion === 'string' && /^[a-f0-9]{64}$/.test(input.sourceVersion));
  valid(input.authorizePersist === undefined || typeof input.authorizePersist === 'function');
  valid(Array.isArray(input.assignments) && input.assignments.length <= 20_000);
  const players = new Set(), identifiers = new Set();
  const assignments = input.assignments.map(row => {
    object(row, ['playerId', 'providerPlayerId', 'nhlTeamAbbreviation']);
    valid(typeof row.playerId === 'string' && UUID.test(row.playerId));
    valid(typeof row.providerPlayerId === 'string' && NHL_ID.test(row.providerPlayerId));
    valid(typeof row.nhlTeamAbbreviation === 'string' && TEAMS.has(row.nhlTeamAbbreviation));
    valid(!players.has(row.playerId) && !identifiers.has(row.providerPlayerId));
    players.add(row.playerId); identifiers.add(row.providerPlayerId);
    return { playerId: row.playerId, providerPlayerId: row.providerPlayerId, nhlTeamAbbreviation: row.nhlTeamAbbreviation };
  }).sort((a, b) => a.playerId.localeCompare(b.playerId));
  let counts;
  if (input.counts !== undefined) {
    object(input.counts, COUNT_KEYS);
    valid(COUNT_KEYS.every(key => Number.isSafeInteger(input.counts[key]) && input.counts[key] >= 0));
    counts = Object.fromEntries(COUNT_KEYS.map(key => [key, input.counts[key]]));
  }
  return { observedAtMs: input.observedAtMs, sourceVersion: input.sourceVersion, assignments, counts, authorizePersist: input.authorizePersist };
}

function createSqliteNhlTeamAssignmentRepository({ database, createId = randomUUID } = {}) {
  if (!database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function' || typeof createId !== 'function') {
    throw new TypeError('NHL team assignments require a SQLite database and ID factory.');
  }
  const read = database.prepare(`SELECT p.id AS playerId, e.external_value AS providerPlayerId,
    s.nhl_team_abbreviation AS nhlTeamAbbreviation FROM players p
    JOIN player_external_ids e ON e.player_id = p.id AND e.provider = 'nhl'
    JOIN player_source_state s ON s.player_id = p.id AND s.provider = 'nhl' AND s.ended_at_ms IS NULL
    ORDER BY p.id`);
  const identity = database.prepare("SELECT player_id FROM player_external_ids WHERE provider = 'nhl' AND external_value = ?");
  const current = database.prepare("SELECT * FROM player_source_state WHERE player_id = ? AND ended_at_ms IS NULL ORDER BY provider, id");
  const close = database.prepare('UPDATE player_source_state SET ended_at_ms = ? WHERE id = ? AND ended_at_ms IS NULL');
  const append = database.prepare(`INSERT INTO player_source_state
    (id, player_id, provider, source_position, normalized_position, nhl_team_abbreviation, active,
      source_version, source_payload_json, effective_at_ms, ended_at_ms, created_at_ms)
    VALUES (@id, @player_id, 'nhl', @source_position, @normalized_position, @nhl_team_abbreviation,
      @active, @source_version, @source_payload_json, @effective_at_ms, NULL, @created_at_ms)`);
  const audit = database.prepare(`INSERT INTO operational_events
    (id, league_id, season_id, event_type, feature, outcome, actor_user_id, reason_code, details_json, occurred_at_ms)
    VALUES (?, NULL, NULL, 'nhl_team_assignments_refreshed', 'player_data_provider', 'succeeded',
      NULL, 'daily_nhl_team_assignments', ?, ?)`);
  function nextId() {
    const value = createId();
    if (typeof value !== 'string' || !UUID.test(value)) fail('NHL_TEAM_ASSIGNMENT_ID_INVALID', 'The team-assignment ID factory returned an invalid ID.');
    return value;
  }
  const apply = database.transaction(command => {
    const changes = [];
    let unchangedPlayers = 0, skippedPlayers = 0;
    // Validate every identity and timestamp before performing the first write.
    for (const assignment of command.assignments) {
      if (identity.get(assignment.providerPlayerId)?.player_id !== assignment.playerId) {
        fail('NHL_TEAM_ASSIGNMENT_IDENTITY_CHANGED', 'A player NHL identity changed after the snapshot was fetched.');
      }
      const sources = current.all(assignment.playerId);
      // Mixed/unsupported provider catalogues require their own reviewed policy.
      if (sources.length !== 1 || sources[0].provider !== 'nhl') { skippedPlayers++; continue; }
      const before = sources[0];
      const changed = before.nhl_team_abbreviation !== assignment.nhlTeamAbbreviation;
      if (command.observedAtMs < before.effective_at_ms || (changed && command.observedAtMs === before.effective_at_ms)) {
        fail('NHL_TEAM_ASSIGNMENT_STALE', 'The NHL team snapshot predates the current player source state.');
      }
      if (!changed) { unchangedPlayers++; continue; }
      changes.push({ assignment, before });
    }
    if (changes.length === 0) return { changedPlayers: 0, unchangedPlayers, skippedPlayers, operationId: null };
    if (command.authorizePersist) {
      const authorization = command.authorizePersist();
      if (authorization === false || authorization?.then) fail('NHL_TEAM_ASSIGNMENT_PERSISTENCE_NOT_AUTHORIZED', 'Current synchronous persistence authorization is required.');
    }
    const operationId = nextId();
    const evidence = [];
    for (const { assignment, before } of changes) {
      const id = nextId();
      const sourceVersion = hash({ kind: 'nhl_team_assignment', provider: 'nhl',
        observedAtMs: command.observedAtMs, sourceVersion: command.sourceVersion,
        playerId: assignment.playerId, providerPlayerId: assignment.providerPlayerId,
        nhlTeamAbbreviation: assignment.nhlTeamAbbreviation, previousSourceVersion: before.source_version });
      close.run(command.observedAtMs, before.id);
      append.run({ ...before, id, nhl_team_abbreviation: assignment.nhlTeamAbbreviation,
        source_version: sourceVersion, effective_at_ms: command.observedAtMs, created_at_ms: command.observedAtMs });
      evidence.push({ playerId: assignment.playerId, providerPlayerId: assignment.providerPlayerId,
        before: before.nhl_team_abbreviation, after: assignment.nhlTeamAbbreviation,
        previousSourceStateId: before.id, sourceStateId: id, sourceVersion });
    }
    audit.run(operationId, JSON.stringify({ schemaVersion: 1, observedAtMs: command.observedAtMs,
      sourceVersion: command.sourceVersion, ...(command.counts ? { counts: command.counts } : {}),
      changedPlayers: changes.length, unchangedPlayers, skippedPlayers, changes: evidence }), command.observedAtMs);
    return { changedPlayers: changes.length, unchangedPlayers, skippedPlayers, operationId };
  });
  return Object.freeze({
    readPlayers: () => read.all().map(row => ({ ...row })),
    applyAssignments: input => apply.immediate(validate(input)),
  });
}

module.exports = { createSqliteNhlTeamAssignmentRepository };
