const { randomUUID } = require('node:crypto');
const { normalizedName } = require('../../../domain/players/injuryStatusPolicy');
const { classifyRealtimeInjury, assessRealtimeRecovery, resolveRealtimeIdentityCandidates } = require('../../../domain/players/realtimeInjuryPolicy');
const { legacyRealtimeRecoveryCandidates } = require('../../../domain/players/realtimeLegacyInjuryRecoveryPolicy');

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/+\-]{0,159}$/;
const NHL_ID = /^[1-9]\d{0,19}$/;
const MAX_TIME = 8_640_000_000_000_000;
const SAFE_ERRORS = new Set(['INJURY_FEED_INVALID', 'INJURY_FEED_UNAVAILABLE', 'INJURY_FEED_RATE_LIMITED',
  'INJURY_FEED_INCOMPLETE', 'INJURY_FEED_STALE', 'INJURY_REFRESH_CONFLICT', 'INJURY_REFRESH_FAILED',
  'INJURY_IDENTITY_CHANGED', 'INJURY_INPUT_INVALID', 'INJURY_MAPPING_CONFLICT']);
function fail(code) { throw Object.assign(new Error(code), { code }); }
function valid(condition, code = 'INJURY_INPUT_INVALID') { if (!condition) fail(code); }
const timestamp = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIME;
const text = (value, max, optional = false) => optional && value == null ||
  typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const month = at => new Date(at).toISOString().slice(0, 7);

function createSqliteRealtimeInjuryRepository({ database, nowMs = Date.now, createId = randomUUID,
  monthlyRequestLimit = 100, leaseMs = 15 * 60_000 } = {}) {
  valid(database && typeof database.transaction === 'function' && typeof nowMs === 'function' && typeof createId === 'function');
  valid(Number.isSafeInteger(monthlyRequestLimit) && monthlyRequestLimit >= 1 && monthlyRequestLimit <= 100);
  valid(Number.isSafeInteger(leaseMs) && leaseMs >= 1000 && leaseMs <= 60 * 60_000);
  if (database.pragma('user_version', { simple: true }) < 97) fail('INJURY_SCHEMA_REQUIRED');
  const clock = () => { const at = nowMs(); valid(timestamp(at)); return at; };
  const stateRow = database.prepare("SELECT * FROM player_injury_realtime_state WHERE id='realtime'");
  const initialize = () => database.prepare("INSERT OR IGNORE INTO player_injury_realtime_state(id) VALUES ('realtime')").run();
  const statusRow = database.prepare('SELECT * FROM player_injury_status WHERE id=?');
  const mappingRow = database.prepare('SELECT * FROM player_injury_realtime_mappings WHERE id=?');
  const allMappings = database.prepare('SELECT * FROM player_injury_realtime_mappings ORDER BY id');
  const allFeed = database.prepare('SELECT * FROM player_injury_realtime_feed ORDER BY id');
  const nhlIdentity = database.prepare("SELECT player_id FROM player_external_ids WHERE provider='nhl' AND external_value=? ORDER BY player_id");
  const identityCatalogue = database.prepare(`SELECT p.id AS playerId,e.external_value AS nhlPlayerId,p.full_name AS name,
    s.nhl_team_abbreviation AS teamAbbreviation,s.source_position AS position,s.active AS active
    FROM players p JOIN player_external_ids e ON e.player_id=p.id AND e.provider='nhl'
    JOIN player_source_state s ON s.player_id=p.id AND s.provider='nhl' AND s.ended_at_ms IS NULL
    WHERE p.status='active' AND s.active=1 ORDER BY p.id`);
  const legacyStatuses = database.prepare("SELECT id AS playerId,status,source,evidence_at_ms AS evidenceAtMs FROM player_injury_status WHERE status='injured' AND source IN ('admin','espn')");
  const allNhlIdentities = database.prepare("SELECT player_id AS playerId,external_value AS nhlPlayerId FROM player_external_ids WHERE provider='nhl'");
  function legacyCandidates(snapshot, previous, currentState, mappings) {
    return legacyRealtimeRecoveryCandidates({ snapshot,
      previousRows: previous.map(row => ({ providerPlayerId: row.id, name: row.name, teamId: row.team_id,
        team: row.team, position: row.position, observedAtMs: row.observed_at_ms, present: row.present === 1 })),
      previousSuccessAtMs: currentState?.last_success_at_ms,
      previousSourceCount: currentState?.last_source_count, previousTeamCount: currentState?.last_team_count,
      catalogue: identityCatalogue.all().map(row => ({ ...row, active: row.active === 1 })),
      identities: allNhlIdentities.all(), statuses: legacyStatuses.all(),
      mappings: mappings.map(row => ({ providerPlayerId: row.id, playerId: row.player_id,
        nhlPlayerId: row.nhl_player_id, providerName: row.provider_name, aliases: JSON.parse(row.aliases_json) })) });
  }
  const runByToken = database.prepare('SELECT * FROM player_injury_realtime_runs WHERE token=?');
  const quotaCount = database.prepare('SELECT count(*) AS n FROM player_injury_realtime_runs WHERE request_month=?');
  const writeStatus = database.prepare(`INSERT INTO player_injury_status
    (id,status,source,evidence_at_ms,observed_at_ms,review_reason,updated_at_ms,version,timeline,designation,injury_reason)
    VALUES (@id,@status,'realtime',@evidence_at_ms,@observed_at_ms,@review_reason,@updated_at_ms,1,@timeline,@designation,@injury_reason)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status,source=excluded.source,evidence_at_ms=excluded.evidence_at_ms,
      observed_at_ms=excluded.observed_at_ms,review_reason=excluded.review_reason,updated_at_ms=excluded.updated_at_ms,
      version=version+1,timeline=excluded.timeline,designation=excluded.designation,injury_reason=excluded.injury_reason`);
  const audit = database.prepare(`INSERT INTO player_injury_events
    (id,player_id,actor_user_id,action,reason,before_json,after_json,created_at_ms) VALUES (?,?,NULL,?,?,?,?,?)`);
  const nextId = () => { const id = createId(); valid(typeof id === 'string' && ID.test(id)); return id; };
  function event(playerId, action, reason, before, after, at) {
    audit.run(nextId(), playerId, action, reason, JSON.stringify(before ?? null), JSON.stringify(after ?? null), at);
  }
  function saveStatus(id, next, at, reason) {
    const before = statusRow.get(id) || null;
    const value = { id, timeline: null, designation: null, injury_reason: null, review_reason: null, ...next, updated_at_ms: at };
    if (value.status !== 'injured') Object.assign(value, { timeline: null, designation: null, injury_reason: null });
    const changed = !before || before.source !== 'realtime' ||
      ['status', 'evidence_at_ms', 'review_reason', 'timeline', 'designation', 'injury_reason'].some(key => before[key] !== value[key]);
    writeStatus.run(value);
    if (changed) event(id, 'feed_update', reason, before, statusRow.get(id), at);
    return changed;
  }
  const register = database.transaction(records => {
    const at = clock();
    valid(Array.isArray(records) && records.length <= 2000);
    const providerIds = new Set(), nhlIds = new Set(), canonicalIds = new Set();
    const normalized = records.map(record => {
      valid(record && typeof record === 'object' && !Array.isArray(record));
      valid(typeof record.providerPlayerId === 'string' && ID.test(record.providerPlayerId) &&
        typeof record.nhlPlayerId === 'string' && NHL_ID.test(record.nhlPlayerId) && text(record.providerName, 150) &&
        timestamp(record.verifiedAtMs) && record.verifiedAtMs <= at && (record.verified === undefined || record.verified === true));
      valid(Array.isArray(record.evidenceUrls) && record.evidenceUrls.length >= 1 && record.evidenceUrls.length <= 8 &&
        record.evidenceUrls.every(value => {
          if (!text(value, 1000)) return false;
          try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash; }
          catch { return false; }
        }));
      const aliases = record.aliases ?? [];
      valid(Array.isArray(aliases) && aliases.length <= 10 && aliases.every(value => text(value, 150)));
      const verificationMethod = record.verificationMethod ?? 'reviewed_crosswalk';
      valid(['reviewed_crosswalk','unique_name_team_position'].includes(verificationMethod));
      const identities = nhlIdentity.all(record.nhlPlayerId);
      valid(identities.length === 1, 'INJURY_IDENTITY_CHANGED');
      const playerId = identities[0].player_id;
      valid(record.playerId === undefined || record.playerId === playerId, 'INJURY_IDENTITY_CHANGED');
      valid(!providerIds.has(record.providerPlayerId) && !nhlIds.has(record.nhlPlayerId) && !canonicalIds.has(playerId), 'INJURY_MAPPING_CONFLICT');
      providerIds.add(record.providerPlayerId); nhlIds.add(record.nhlPlayerId); canonicalIds.add(playerId);
      const previous = mappingRow.get(record.providerPlayerId);
      const collision = database.prepare('SELECT id FROM player_injury_realtime_mappings WHERE (player_id=? OR nhl_player_id=?) AND id<>?')
        .get(playerId, record.nhlPlayerId, record.providerPlayerId);
      valid(!collision && (!previous || previous.player_id === playerId && previous.nhl_player_id === record.nhlPlayerId &&
        previous.provider_name === record.providerName && previous.aliases_json === JSON.stringify(aliases)), 'INJURY_MAPPING_CONFLICT');
      if (!previous && verificationMethod === 'unique_name_team_position') {
        const currentMappings = allMappings.all().map(item => ({ providerPlayerId: item.id, playerId: item.player_id, nhlPlayerId: item.nhl_player_id }));
        const resolved = resolveRealtimeIdentityCandidates({
          snapshot: { source: 'realtime', fetchedAtMs: at, rows: [{ providerPlayerId: record.providerPlayerId,
            name: record.providerName, teamAbbreviation: record.teamAbbreviation, position: record.position }] },
          catalogue: identityCatalogue.all().map(item => ({ ...item, active: Boolean(item.active) })),
          mappings: currentMappings, nowMs: at,
        });
        valid(resolved.mappings.length === 1 && resolved.mappings[0].playerId === playerId &&
          resolved.mappings[0].nhlPlayerId === record.nhlPlayerId, 'INJURY_IDENTITY_CHANGED');
      }
      return { ...record, aliases, playerId, previous, verificationMethod };
    });
    let added = 0;
    for (const record of normalized) {
      if (record.previous) continue;
      database.prepare(`INSERT INTO player_injury_realtime_mappings
        (id,player_id,nhl_player_id,provider_name,aliases_json,evidence_json,verification_method,verified_at_ms,created_at_ms)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(record.providerPlayerId, record.playerId, record.nhlPlayerId, record.providerName,
        JSON.stringify(record.aliases), JSON.stringify(record.evidenceUrls), record.verificationMethod, record.verifiedAtMs, at);
      event(record.playerId, 'identity_match', 'Verified Realtime-to-NHL player crosswalk', null,
        { source: 'realtime', providerPlayerId: record.providerPlayerId, nhlPlayerId: record.nhlPlayerId,
          verificationMethod: record.verificationMethod, verifiedAtMs: record.verifiedAtMs, evidenceUrls: record.evidenceUrls }, at);
      added++;
    }
    return { added, unchanged: records.length - added };
  });
  const claim = database.transaction(({ occurrenceId, scheduledAtMs, atMs = clock() }) => {
    valid(typeof occurrenceId === 'string' && ID.test(occurrenceId) && timestamp(scheduledAtMs) && timestamp(atMs) &&
      scheduledAtMs <= atMs && atMs <= clock());
    // A crashed attempt already consumed its request. Retire it, never replay it.
    database.prepare("UPDATE player_injury_realtime_runs SET status='abandoned',completed_at_ms=?,error_code='INJURY_LEASE_EXPIRED' WHERE status='running' AND lease_until_ms<=?").run(atMs, atMs);
    if (database.prepare('SELECT id FROM player_injury_realtime_runs WHERE id=?').get(occurrenceId)) return { status: 'skipped', reason: 'occurrence_already_attempted' };
    if (database.prepare("SELECT id FROM player_injury_realtime_runs WHERE status='running'").get()) return { status: 'skipped', reason: 'already_running' };
    const current = stateRow.get();
    if ((current?.cooldown_until_ms ?? 0) > atMs) return { status: 'skipped', reason: 'provider_cooldown' };
    const requestMonth = month(atMs);
    const providerQuotaApplies = current && (current.provider_reset_at_ms != null ? current.provider_reset_at_ms > atMs :
      current.last_attempt_at_ms != null && month(current.last_attempt_at_ms) === requestMonth);
    if (quotaCount.get(requestMonth).n >= monthlyRequestLimit || providerQuotaApplies && current.provider_remaining === 0) {
      return { status: 'skipped', reason: 'monthly_quota_exhausted' };
    }
    const token = nextId();
    database.prepare(`INSERT INTO player_injury_realtime_runs
      (id,token,scheduled_at_ms,attempted_at_ms,lease_until_ms,request_month,status) VALUES (?,?,?,?,?,?,'running')`)
      .run(occurrenceId, token, scheduledAtMs, atMs, atMs + leaseMs, requestMonth);
    initialize();
    database.prepare(`UPDATE player_injury_realtime_state SET last_attempt_at_ms=?,last_error_code=NULL,
      provider_remaining=CASE WHEN ? THEN CASE WHEN provider_remaining>0 THEN provider_remaining-1 ELSE provider_remaining END ELSE NULL END,
      version=version+1 WHERE id='realtime'`).run(atMs, Number(Boolean(providerQuotaApplies)));
    return { status: 'claimed', token, occurrenceId, scheduledAtMs };
  });
  function validateSnapshot(snapshot, at) {
    valid(snapshot && snapshot.source === 'realtime' && timestamp(snapshot.fetchedAtMs) && snapshot.fetchedAtMs <= at &&
      (snapshot.sourceGeneratedAtMs == null || timestamp(snapshot.sourceGeneratedAtMs) && snapshot.sourceGeneratedAtMs <= snapshot.fetchedAtMs), 'INJURY_FEED_INVALID');
    valid(Array.isArray(snapshot.rows) && snapshot.rows.length >= 1 && snapshot.rows.length <= 1000 &&
      snapshot.sourceCount === snapshot.rows.length && Number.isSafeInteger(snapshot.teamCount) && snapshot.teamCount >= 1 && snapshot.teamCount <= 32, 'INJURY_FEED_INVALID');
    const ids = new Set(), teams = new Set();
    const rows = snapshot.rows.map(row => {
      valid(row && typeof row.providerPlayerId === 'string' && ID.test(row.providerPlayerId) && !ids.has(row.providerPlayerId) &&
        text(row.name, 150) && text(row.teamId, 30) && text(row.team, 100, true) && text(row.position, 15, true) &&
        ['injured','review','excluded'].includes(row.status) && text(row.medicalReason, 200, true) &&
        typeof row.designation === 'string' && row.designation.length <= 30 &&
        text(row.timeline, 100, true) && (row.reportedAtMs == null || timestamp(row.reportedAtMs) && row.reportedAtMs <= snapshot.fetchedAtMs), 'INJURY_FEED_INVALID');
      ids.add(row.providerPlayerId); teams.add(row.teamId);
      const classified = classifyRealtimeInjury(row);
      return { ...row, team: row.team ?? null, position: row.position ?? null, timeline: row.timeline ?? null,
        status: classified.status === 'injured' && row.reportedAtMs == null ? 'review' : classified.status,
        medicalReason: classified.medicalReason ?? null };
    });
    valid(teams.size === snapshot.teamCount, 'INJURY_FEED_INVALID');
    if (snapshot.quota != null) {
      valid(typeof snapshot.quota === 'object' && !Array.isArray(snapshot.quota) &&
        (snapshot.quota.remaining == null || Number.isSafeInteger(snapshot.quota.remaining) && snapshot.quota.remaining >= 0 && snapshot.quota.remaining <= 1_000_000) &&
        (snapshot.quota.resetAtMs == null || timestamp(snapshot.quota.resetAtMs)), 'INJURY_FEED_INVALID');
    }
    return { ...snapshot, rows };
  }
  const apply = database.transaction((snapshot, token, options) => {
    const at = clock(), run = runByToken.get(token);
    valid(run?.status === 'running' && run.lease_until_ms > at && snapshot.fetchedAtMs >= run.attempted_at_ms, 'INJURY_REFRESH_CONFLICT');
    const currentState = stateRow.get();
    valid(currentState.last_success_at_ms == null || snapshot.fetchedAtMs > currentState.last_success_at_ms, 'INJURY_FEED_STALE');
    if (snapshot.sourceGeneratedAtMs != null && currentState.last_source_generated_at_ms != null) {
      valid(snapshot.sourceGeneratedAtMs >= currentState.last_source_generated_at_ms, 'INJURY_FEED_STALE');
    }
    const previous = allFeed.all(), previousCount = previous.filter(row => row.present).length;
    valid(previousCount <= 10 || snapshot.rows.length >= previousCount / 2, 'INJURY_FEED_INCOMPLETE');
    const mappings = new Map(allMappings.all().map(row => [row.id, row]));
    for (const mapping of mappings.values()) {
      const identities = nhlIdentity.all(mapping.nhl_player_id);
      valid(identities.length === 1 && identities[0].player_id === mapping.player_id, 'INJURY_IDENTITY_CHANGED');
    }
    if (options.authorizePersist) {
      const permission = options.authorizePersist();
      valid(permission !== false && !permission?.then, 'INJURY_PERSISTENCE_NOT_AUTHORIZED');
    }
    // Recompute after the asynchronous proof read and before replacing the prior
    // report. A newer manual decision or identity change must win this race.
    const legacy = legacyCandidates(snapshot, previous, currentState, [...mappings.values()]);
    const beforeById = new Map(previous.map(row => [row.id, row]));
    const seen = new Set(snapshot.rows.map(row => row.providerPlayerId));
    let changed = 0, unresolved = 0, preserved = 0, possibleReturns = 0, recovered = 0;
    const writeFeed = database.prepare(`INSERT INTO player_injury_realtime_feed
      (id,name,team_id,team,position,classification,medical_reason,designation,reported_at_ms,observed_at_ms,
        present,absence_count,last_present_at_ms,last_absent_at_ms,last_injury_evidence_at_ms)
      VALUES (@id,@name,@teamId,@team,@position,@status,@medicalReason,@designation,@reportedAtMs,@fetchedAtMs,
        1,0,@fetchedAtMs,NULL,@lastInjuryEvidenceAtMs)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,team_id=excluded.team_id,team=excluded.team,position=excluded.position,
        classification=excluded.classification,medical_reason=excluded.medical_reason,designation=excluded.designation,
        reported_at_ms=excluded.reported_at_ms,observed_at_ms=excluded.observed_at_ms,present=1,absence_count=0,
        last_present_at_ms=excluded.last_present_at_ms,last_absent_at_ms=NULL,
        last_injury_evidence_at_ms=excluded.last_injury_evidence_at_ms,version=version+1`);
    for (const row of snapshot.rows) {
      const previousRow = beforeById.get(row.providerPlayerId);
      // A later unresolved report must also prevent older game evidence from
      // clearing an injury after that report subsequently disappears.
      const lastInjuryEvidenceAtMs = row.reportedAtMs != null &&
        (row.status !== 'excluded' || previousRow?.last_injury_evidence_at_ms != null)
        ? Math.max(row.reportedAtMs, previousRow?.last_injury_evidence_at_ms ?? 0)
        : previousRow?.last_injury_evidence_at_ms ?? null;
      writeFeed.run({ ...row, reportedAtMs: row.reportedAtMs ?? null, id: row.providerPlayerId, fetchedAtMs: snapshot.fetchedAtMs, lastInjuryEvidenceAtMs });
      const mapping = mappings.get(row.providerPlayerId);
      if (!mapping || ![mapping.provider_name, ...JSON.parse(mapping.aliases_json)].some(name => normalizedName(name) === normalizedName(row.name))) { unresolved++; continue; }
      const current = statusRow.get(mapping.player_id);
      if (row.status !== 'injured') {
        if (current?.source === 'realtime' && current.status === 'injured') changed += Number(saveStatus(mapping.player_id,
          { ...current, observed_at_ms: snapshot.fetchedAtMs, review_reason: 'status_changed' }, at, 'Realtime designation requires review'));
        continue;
      }
      if (current && (row.reportedAtMs < current.evidence_at_ms || current.source === 'admin' && row.reportedAtMs <= current.evidence_at_ms)) { preserved++; continue; }
      changed += Number(saveStatus(mapping.player_id, { status: 'injured', evidence_at_ms: row.reportedAtMs,
        observed_at_ms: snapshot.fetchedAtMs, timeline: row.timeline, designation: row.designation || null,
        injury_reason: row.medicalReason }, at, 'Verified Realtime medical injury report'));
    }
    for (const row of previous.filter(entry => !seen.has(entry.id))) {
      const absenceCount = row.absence_count + 1;
      database.prepare('UPDATE player_injury_realtime_feed SET present=0,absence_count=?,last_absent_at_ms=?,observed_at_ms=?,version=version+1 WHERE id=?')
        .run(absenceCount, snapshot.fetchedAtMs, snapshot.fetchedAtMs, row.id);
      const mapping = mappings.get(row.id), current = mapping && statusRow.get(mapping.player_id);
      if (!current || current.status !== 'injured') continue;
      if (![mapping.provider_name, ...JSON.parse(mapping.aliases_json)].some(name => normalizedName(name) === normalizedName(row.name))) { unresolved++; continue; }
      const candidateProof = options.recoveryProofs[mapping.player_id];
      const proof = candidateProof?.playerId === mapping.player_id ? candidateProof : null;
      const recovery = assessRealtimeRecovery({ present: false, absenceCount,
        lastInjuryEvidenceAtMs: row.last_injury_evidence_at_ms,
        manualDecisionAtMs: current.evidence_at_ms,
        proof, nowMs: snapshot.fetchedAtMs });
      if (recovery.status === 'healthy') {
        changed += Number(saveStatus(mapping.player_id, { status: 'healthy', evidence_at_ms: recovery.evidenceAtMs,
          observed_at_ms: snapshot.fetchedAtMs }, at, `Realtime absence and verified NHL game participation: ${recovery.gameId}`));
        recovered++;
      } else if (current.source === 'realtime') {
        changed += Number(saveStatus(mapping.player_id, { ...current, observed_at_ms: snapshot.fetchedAtMs,
          review_reason: 'possible_return' }, at, 'Realtime absence requires return-to-play evidence'));
        possibleReturns++;
      } else preserved++;
    }
    for (const candidate of legacy) {
      const current = statusRow.get(candidate.playerId);
      const candidateProof = options.recoveryProofs[candidate.playerId];
      const proof = candidateProof?.playerId === candidate.playerId && candidateProof.nhlPlayerId === candidate.nhlPlayerId
        ? candidateProof : null;
      if (!current || current.status !== 'injured' || current.evidence_at_ms !== candidate.afterMs) continue;
      const recovery = assessRealtimeRecovery({ present: false, absenceCount: 2,
        lastInjuryEvidenceAtMs: current.evidence_at_ms, manualDecisionAtMs: current.evidence_at_ms,
        proof, nowMs: snapshot.fetchedAtMs });
      if (recovery.status === 'healthy') {
        changed += Number(saveStatus(candidate.playerId, { status: 'healthy', evidence_at_ms: recovery.evidenceAtMs,
          observed_at_ms: snapshot.fetchedAtMs }, at, `Two verified Realtime absences and NHL return after legacy injury: ${recovery.gameId}`));
        recovered++;
      } else preserved++;
    }
    const quota = snapshot.quota ?? {};
    database.prepare(`UPDATE player_injury_realtime_state SET last_success_at_ms=?,last_source_generated_at_ms=COALESCE(?,last_source_generated_at_ms),
      last_source_count=?,last_team_count=?,last_error_code=NULL,cooldown_until_ms=0,
      provider_remaining=COALESCE(?,provider_remaining),provider_reset_at_ms=COALESCE(?,provider_reset_at_ms),version=version+1
      WHERE id='realtime'`).run(snapshot.fetchedAtMs, snapshot.sourceGeneratedAtMs ?? null, snapshot.sourceCount,
      snapshot.teamCount, quota.remaining ?? null, quota.resetAtMs ?? null);
    database.prepare("UPDATE player_injury_realtime_runs SET status='succeeded',completed_at_ms=?,source_count=?,changed_count=? WHERE token=?")
      .run(at, snapshot.sourceCount, changed, token);
    return { status: 'succeeded', imported: snapshot.sourceCount, changed, unresolved, preserved, possibleReturns, recovered };
  });
  const recordFailure = database.transaction((token, code, options) => {
    const at = clock(), run = runByToken.get(token);
    if (run?.status !== 'running') return { status: 'skipped', reason: 'claim_not_current' };
    const safeCode = SAFE_ERRORS.has(code) ? code : 'INJURY_REFRESH_FAILED';
    const delay = options.retryAfterMs;
    valid(delay == null || Number.isSafeInteger(delay) && delay >= 0 && delay <= 31 * 86400_000);
    const cooldown = safeCode === 'INJURY_FEED_RATE_LIMITED' ? at + Math.max(delay ?? 0, 15 * 60_000) : 0;
    database.prepare("UPDATE player_injury_realtime_runs SET status='failed',completed_at_ms=?,error_code=? WHERE token=?")
      .run(at, safeCode, token);
    database.prepare("UPDATE player_injury_realtime_state SET last_error_code=?,cooldown_until_ms=MAX(cooldown_until_ms,?),version=version+1 WHERE id='realtime'")
      .run(safeCode, cooldown);
    return { status: 'failed', code: safeCode, cooldownUntilMs: cooldown || null };
  });
  return Object.freeze({
    registerMappings: records => register.immediate(records),
    readIdentityCatalogue: () => identityCatalogue.all().map(row => ({ ...row, active: Boolean(row.active) })),
    claim: input => claim.immediate(input),
    apply(snapshot, token, options = {}) {
      valid(typeof token === 'string' && ID.test(token) && options && typeof options === 'object' && !Array.isArray(options));
      const recoveryProofs = options.recoveryProofs ?? {};
      valid(recoveryProofs && typeof recoveryProofs === 'object' && !Array.isArray(recoveryProofs) &&
        (options.authorizePersist === undefined || typeof options.authorizePersist === 'function'));
      return apply.immediate(validateSnapshot(snapshot, clock()), token, { ...options, recoveryProofs });
    },
    fail: (token, code, options = {}) => recordFailure.immediate(token, code, options),
    listMappings: () => allMappings.all().map(row => ({ providerPlayerId: row.id, playerId: row.player_id,
      nhlPlayerId: row.nhl_player_id, providerName: row.provider_name, aliases: JSON.parse(row.aliases_json),
      verificationMethod: row.verification_method, verifiedAtMs: row.verified_at_ms, evidenceUrls: JSON.parse(row.evidence_json) })),
    listFeed: () => allFeed.all(),
    recoveryCandidates(snapshot) {
      const verified = validateSnapshot(snapshot, clock());
      const present = new Set(verified.rows.map(row => row.providerPlayerId));
      const tracked = database.prepare(`SELECT m.id,m.player_id,m.nhl_player_id,m.provider_name,m.aliases_json,
        f.name,f.last_injury_evidence_at_ms,s.evidence_at_ms
        FROM player_injury_realtime_mappings m JOIN player_injury_realtime_feed f ON f.id=m.id
        JOIN player_injury_status s ON s.id=m.player_id WHERE s.status='injured' ORDER BY m.id`).all()
        .filter(row => !present.has(row.id) && row.last_injury_evidence_at_ms != null &&
          [row.provider_name, ...JSON.parse(row.aliases_json)].some(name => normalizedName(name) === normalizedName(row.name)))
        .map(row => ({ playerId: row.player_id, nhlPlayerId: row.nhl_player_id,
          afterMs: Math.max(row.last_injury_evidence_at_ms, row.evidence_at_ms) }));
      return [...tracked, ...legacyCandidates(verified, allFeed.all(), stateRow.get(), allMappings.all())];
    },
    state() {
      const at = clock(), current = stateRow.get();
      const latest = database.prepare('SELECT id,status,scheduled_at_ms,attempted_at_ms,completed_at_ms,error_code FROM player_injury_realtime_runs ORDER BY attempted_at_ms DESC,id DESC LIMIT 1').get();
      return { source: 'realtime', lastAttemptAtMs: current?.last_attempt_at_ms ?? null,
        lastSuccessAtMs: current?.last_success_at_ms ?? null, errorCode: current?.last_error_code ?? null,
        sourceCount: current?.last_source_count ?? null, teamCount: current?.last_team_count ?? null,
        cooldownUntilMs: current?.cooldown_until_ms || null,
        quota: { requestMonth: month(at), attempted: quotaCount.get(month(at)).n, limit: monthlyRequestLimit,
          providerRemaining: current?.provider_remaining ?? null, providerResetAtMs: current?.provider_reset_at_ms ?? null },
        latestRun: latest ? { occurrenceId: latest.id, status: latest.status, scheduledAtMs: latest.scheduled_at_ms,
          attemptedAtMs: latest.attempted_at_ms, completedAtMs: latest.completed_at_ms, errorCode: latest.error_code } : null };
    },
  });
}

module.exports = { createSqliteRealtimeInjuryRepository };
