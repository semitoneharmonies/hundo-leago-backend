const { randomUUID } = require("node:crypto");
const { setImmediate: yieldToEventLoop } = require("node:timers/promises");
const { prepareGameRecord, prepareGameCapture, prepareGameCaptureAsync, finishGameCapture, stableId, timestamp } = require("../../../domain/statistics/sharedGameEvidencePolicy");

function createSqliteSharedGameEvidenceRepository({ database, createId = randomUUID }) {
  const preparations = new WeakMap();
  const findCapture = database.prepare("SELECT * FROM shared_game_evidence_captures WHERE refresh_id = ?");
  const latest = database.prepare("SELECT * FROM shared_game_evidence_captures WHERE stat_source_id = ? AND nhl_season_key = ? ORDER BY revision DESC LIMIT 1");
  // Select the effective keys from the covering index, including tombstones,
  // then read only those payloads in rowid order. Historical versions remain
  // available without forcing a cold reader through every old payload page.
  const effective = database.prepare(`WITH latest AS (
    SELECT player_id,nhl_game_id,MAX(revision) revision FROM shared_game_evidence_changes
    WHERE stat_source_id=@statSourceId AND nhl_season_key=@nhlSeasonKey AND revision<=@revision
    GROUP BY player_id,nhl_game_id
  ) SELECT current.* FROM shared_game_evidence_changes current WHERE current.rowid IN (
    SELECT selected.rowid FROM latest JOIN shared_game_evidence_changes selected
      ON selected.player_id=latest.player_id AND selected.nhl_game_id=latest.nhl_game_id AND selected.revision=latest.revision
    WHERE selected.stat_source_id=@statSourceId AND selected.nhl_season_key=@nhlSeasonKey
  ) AND current.payload_json IS NOT NULL`);
  const insertCapture = database.prepare(`INSERT INTO shared_game_evidence_captures
    (refresh_id, stat_source_id, nhl_season_key, revision, observed_at_ms, captured_at_ms, record_count, evidence_sha256)
    VALUES (@refreshId, @statSourceId, @nhlSeasonKey, @revision, @observedAtMs, @capturedAtMs, @recordCount, @evidenceSha256)`);
  const insertChange = database.prepare(`INSERT INTO shared_game_evidence_changes
    (id, stat_source_id, nhl_season_key, player_id, nhl_game_id, revision, payload_json, payload_sha256)
    VALUES (@id, @statSourceId, @nhlSeasonKey, @playerId, @nhlGameId, @revision, @payload, @sha256)`);
  const seal = database.prepare("UPDATE shared_game_evidence_captures SET sealed = 1 WHERE refresh_id = ? AND sealed = 0");

  function scope(capture) {
    return { statSourceId: capture.stat_source_id, nhlSeasonKey: capture.nhl_season_key, revision: capture.revision };
  }
  function storedEntry(row) {
    const entry = prepareGameRecord(JSON.parse(row.payload_json));
    if (entry.record.playerId !== row.player_id || entry.record.nhlGameId !== row.nhl_game_id || entry.sha256 !== row.payload_sha256 || entry.payload !== row.payload_json) throw new Error("Shared game evidence is corrupt.");
    return entry;
  }
  function verifyCapture(capture, entries) {
    const prepared = finishGameCapture(scope(capture), entries);
    if (prepared.records.length !== capture.record_count || prepared.evidenceSha256 !== capture.evidence_sha256) throw new Error("Shared game capture does not match its sealed evidence.");
    return prepared;
  }
  function readPrepared(capture) {
    return verifyCapture(capture, effective.all(scope(capture)).map(storedEntry));
  }
  async function readPreparedAsync(capture) {
    const rows = effective.all(scope(capture)), entries = [];
    for (let n = 0; n < rows.length; n++) {
      entries.push(storedEntry(rows[n]));
      if ((n + 1) % 256 === 0) await yieldToEventLoop();
    }
    return verifyCapture(capture, entries);
  }
  function metadata(command) {
    const value = { refreshId: stableId(command?.refreshId), statSourceId: stableId(command?.statSourceId),
      nhlSeasonKey: command?.nhlSeasonKey, observedAtMs: timestamp(command?.observedAtMs), capturedAtMs: timestamp(command?.capturedAtMs) };
    if (value.observedAtMs > value.capturedAtMs) throw new TypeError("Game observation cannot be later than capture.");
    return Object.freeze(value);
  }
  function matches(capture, command, normalized) {
    return capture?.sealed === 1 && capture.stat_source_id === command.statSourceId && capture.nhl_season_key === command.nhlSeasonKey &&
      capture.observed_at_ms === command.observedAtMs && capture.captured_at_ms === command.capturedAtMs &&
      capture.record_count === normalized.records.length && capture.evidence_sha256 === normalized.evidenceSha256;
  }
  function predecessor(command, normalized) {
    const existing = findCapture.get(command.refreshId);
    if (existing && !matches(existing, command, normalized)) throw new Error("Shared game capture replay conflicts with stored evidence.");
    const previous = existing ?? latest.get(command.statSourceId, command.nhlSeasonKey);
    if (previous && previous.sealed !== 1) throw new Error("An incomplete shared game capture exists.");
    return { existing, previous };
  }
  function makePlan(command, normalized, { existing, previous }, old) {
    const revision = existing?.revision ?? (previous?.revision ?? 0) + 1;
    if (!Number.isSafeInteger(revision)) throw new RangeError("Shared game revision limit exceeded.");
    const changes = [];
    if (!existing && normalized.evidenceSha256 !== old?.evidenceSha256) {
      const prior = new Map((old?.entries ?? []).map(entry => [entry.key, entry]));
      for (const entry of normalized.entries) {
        if (prior.get(entry.key)?.payload !== entry.payload) changes.push({ id: stableId(createId()), playerId: entry.record.playerId,
          nhlGameId: entry.record.nhlGameId, payload: entry.payload, sha256: entry.sha256 });
        prior.delete(entry.key);
      }
      for (const entry of prior.values()) changes.push({ id: stableId(createId()), playerId: entry.record.playerId,
        nhlGameId: entry.record.nhlGameId, payload: null, sha256: null });
    }
    const token = Object.freeze({ revision, changedRecordCount: changes.length });
    preparations.set(token, { command, normalized, existing, previous, revision, changes });
    return token;
  }
  function prepareSync(command) {
    const meta = metadata(command), normalized = prepareGameCapture({ ...meta, records: command.records });
    const state = predecessor(meta, normalized);
    return makePlan(meta, normalized, state, state.previous ? readPrepared(state.previous) : null);
  }

  const commitTransaction = database.transaction(plan => {
    const { command, normalized, existing, previous, revision, changes } = plan;
    const current = findCapture.get(command.refreshId);
    if (existing) {
      if (!matches(current, command, normalized) || current.revision !== revision) throw new Error("Shared game preparation is stale; prepare again.");
      return Object.freeze({ revision, changedRecordCount: 0, replayed: true });
    }
    const head = latest.get(command.statSourceId, command.nhlSeasonKey);
    if (current || (head?.refresh_id ?? null) !== (previous?.refresh_id ?? null) ||
        (head?.revision ?? 0) !== (previous?.revision ?? 0) || (head?.evidence_sha256 ?? null) !== (previous?.evidence_sha256 ?? null)) {
      throw new Error("Shared game preparation is stale; prepare again.");
    }
    if (insertCapture.run({ ...command, revision, recordCount: normalized.records.length, evidenceSha256: normalized.evidenceSha256 }).changes !== 1) throw new Error("Shared game capture was not inserted.");
    for (const change of changes) {
      if (insertChange.run({ ...command, ...change, revision }).changes !== 1) throw new Error("Shared game change was not inserted.");
    }
    // All old evidence was verified before this transaction. Its immutable
    // history plus the head check makes this exact validated delta sufficient.
    if (seal.run(command.refreshId).changes !== 1) throw new Error("Shared game capture could not be sealed.");
    return Object.freeze({ revision, changedRecordCount: changes.length, replayed: false });
  });
  function commit(token) {
    const plan = preparations.get(token);
    if (!plan) throw new TypeError("An owned shared game preparation is required.");
    return commitTransaction.immediate(plan);
  }

  return Object.freeze({
    // Synchronous helper for existing callers/tests. Scheduled refreshes should
    // await prepare first, then commit inside their atomic completion transaction.
    capture(command) {
      return commit(prepareSync(command));
    },
    async prepare(command) {
      if (database.inTransaction) throw new Error("Prepare shared games before opening the refresh transaction.");
      const meta = metadata(command), normalized = await prepareGameCaptureAsync({ ...meta, records: command.records });
      const state = predecessor(meta, normalized);
      const old = state.previous ? await readPreparedAsync(state.previous) : null;
      if (database.inTransaction) throw new Error("Prepare shared games before opening the refresh transaction.");
      return makePlan(meta, normalized, state, old);
    },
    commit,
    read({ refreshId }) {
      const capture = findCapture.get(stableId(refreshId));
      if (!capture || capture.sealed !== 1) throw new Error("A sealed shared game capture is required.");
      return Object.freeze({ refreshId, statSourceId: capture.stat_source_id, nhlSeasonKey: capture.nhl_season_key,
        observedAtMs: capture.observed_at_ms, capturedAtMs: capture.captured_at_ms,
        evidenceSha256: capture.evidence_sha256, records: readPrepared(capture).records });
    },
  });
}

module.exports = { createSqliteSharedGameEvidenceRepository };
