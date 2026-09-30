"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");

const GOON_ID = "48e59cfb-b12d-4dfb-ae1a-4d8b3512ef03";
const SEASON_ID = "f53ea724-6f54-4c92-bd7c-f7b60ec41186";
const FAD_ID = "e0293267-4215-42d6-b86e-8115e9cdba8c";
const CLEAR_TABLES = Object.freeze([
  "auction_administration_command_results", "auction_bids", "auction_contexts",
  "auction_events", "auction_resolutions", "auctions", "buyout_obligations", "buyout_years",
  "candidate_card_entries", "candidate_card_help_command_results", "candidate_card_help_requests",
  "candidate_card_revision_entry_changes", "candidate_card_revisions", "candidate_card_snapshot_entries",
  "candidate_card_snapshots", "commissioner_corrections", "contract_events", "contract_years", "contracts",
  "free_agent_draft_allocation_correction_command_results", "free_agent_draft_allocation_events",
  "free_agent_draft_auction_participants", "free_agent_draft_draws",
  "free_agent_draft_eligibility_revalidation_occurrences", "free_agent_draft_nomination_queue",
  "free_agent_draft_player_allocations", "free_agent_draft_recoveries",
  "free_agent_draft_recovery_action_command_results", "free_agent_draft_rollovers",
  "free_agent_draft_schedule_recoveries", "free_agent_draft_schedule_recovery_jobs",
  "free_agent_draft_schedule_recovery_matchups", "free_agent_draft_schedule_recovery_weeks",
  "future_considerations", "matchup_byes", "matchup_operations", "matchup_result_versions",
  "matchup_results", "matchup_roster_game_exclusion_sets", "matchup_roster_game_exclusions",
  "matchup_roster_locks", "matchup_roster_players", "matchup_schedule_command_results",
  "matchup_schedule_job_bindings", "matchup_weeks", "matchups", "ownership_events", "player_ownerships",
  "retention_obligations", "retention_years", "roster_display_order_entries", "roster_display_order_sets",
  "season_matchup_schedule_generations", "standings_operations", "standings_rows",
  "standings_snapshot_finalizations", "standings_snapshot_result_versions",
  "standings_snapshot_team_identities", "standings_snapshots", "stat_snapshot_players", "stat_snapshots",
  "trade_assets", "trade_events", "trade_future_consideration_acceptances", "trade_participants", "trades",
]);
const CHANGED_TABLES = new Set([...CLEAR_TABLES, "candidate_cards", "free_agent_drafts", "seasons", "job_runs", "idempotency_requests"]);
const quote = (s) => '"' + s.replaceAll('"', '""') + '"';

function fingerprints(database, protectedOnly = false) {
  const result = {};
  for (const { name } of database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
    const columns = database.prepare(`PRAGMA table_info(${quote(name)})`).all();
    const scoped = columns.some(x => x.name === "league_id");
    const keys = columns.filter(x => x.pk > 0).sort((a, b) => a.pk - b.pk).map(x => quote(x.name));
    const filter = protectedOnly && CHANGED_TABLES.has(name) ? " WHERE league_id IS NOT ?" : "";
    assert(!filter || scoped, "Changed table must have a league key");
    const hash = createHash("sha256");
    const rows = database.prepare(`SELECT * FROM ${quote(name)}${filter} ORDER BY ${keys.length ? keys.join(",") : "rowid"}`);
    let count = 0;
    for (const row of filter ? rows.iterate(GOON_ID) : rows.iterate()) {
      hash.update(JSON.stringify(row));
      count++;
    }
    result[name] = { count, sha256: hash.digest("hex") };
  }
  return result;
}

function resetGoonLeague({ database, leagueId, nowMs, expectedGoonHash }) {
  assert.equal(leagueId, GOON_ID, "RESET_SCOPE_MISMATCH");
  assert(Number.isSafeInteger(nowMs) && nowMs > 0);
  assert(!database.inTransaction, "RESET_REQUIRES_OWN_TRANSACTION");
  assert.equal(database.pragma("user_version", { simple: true }), 66);
  assert.equal(database.pragma("foreign_keys", { simple: true }), 1);
  return database.transaction(() => {
    const league = database.prepare("SELECT name,current_season_id FROM leagues WHERE id=?").get(GOON_ID);
    assert.deepEqual(league, { name: "Goon Spoons", current_season_id: SEASON_ID });
    const fad = database.prepare("SELECT * FROM free_agent_drafts WHERE league_id=? AND id=?").get(GOON_ID, FAD_ID);
    assert.equal(fad.status, "completed", "RESET_ALREADY_APPLIED_OR_DRAFT_CHANGED");
    assert.equal(database.prepare("SELECT count(*) n FROM teams WHERE league_id=? AND status='active'").get(GOON_ID).n, 8);
    assert.equal(database.prepare("SELECT count(*) n FROM job_runs WHERE league_id=? AND status IN ('running','leased')").get(GOON_ID).n, 0);
    assert.equal(database.prepare("SELECT count(*) n FROM outbox_events WHERE league_id=? AND status IN ('publishing','pending')").get(GOON_ID).n, 0);
    const sourceHash = goonFingerprint(database);
    assert.equal(sourceHash, expectedGoonHash, "GOON_CHANGED_SINCE_REVIEW");
    const protectedBefore = fingerprints(database, true);
    const schema = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name").all();
    const guards = schema.filter(x => x.type === "trigger" && CHANGED_TABLES.has(x.tbl_name));
    // This immediate transaction excludes all writers. Restore every exact
    // guard before commit; any failure rolls back the DDL and the data.
    database.pragma("defer_foreign_keys = ON");
    for (const row of guards) database.exec(`DROP TRIGGER ${quote(row.name)}`);
    const removed = {};
    for (const table of CLEAR_TABLES) {
      removed[table] = database.prepare(`DELETE FROM ${quote(table)} WHERE league_id=?`).run(GOON_ID).changes;
    }
    database.prepare(`DELETE FROM job_runs WHERE league_id=? AND id NOT IN (
      SELECT job_run_id FROM free_agent_draft_readiness_operations WHERE league_id=?
      UNION SELECT reminder_job_run_id FROM free_agent_draft_readiness_operations WHERE league_id=?
      UNION SELECT deadline_job_run_id FROM free_agent_draft_readiness_operations WHERE league_id=?
    )`).run(GOON_ID, GOON_ID, GOON_ID, GOON_ID);
    assert.equal(database.prepare("SELECT count(*) n FROM job_runs WHERE league_id=? AND status NOT IN ('succeeded','cancelled')").get(GOON_ID).n, 0);
    database.prepare(`DELETE FROM idempotency_requests WHERE league_id=? AND
      (operation LIKE 'candidate_card.%' OR operation LIKE 'auction.%' OR operation LIKE 'matchup.schedule.%')`).run(GOON_ID);
    database.prepare(`UPDATE candidate_cards SET status='open',completeness_code='incomplete',
      filled_mandatory_count=0,missing_mandatory_count=18,filled_bench_count=0,empty_bench_count=4,
      blocking_validation_count=0,structural_conflict_count=0,carried_roster_structural_conflict_count=0,
      maximum_possible_cap_cents=0,cap_status='compliant',allocation_eligibility='eligible',
      allocation_exclusion_reason=NULL,locked_at_ms=NULL,updated_at_ms=?,version=version+1
      WHERE league_id=? AND fad_id=?`).run(nowMs, GOON_ID, FAD_ID);
    database.prepare(`UPDATE free_agent_drafts SET status='cards_open',
      candidate_deadline_at_ms=NULL,first_matchup_starts_at_ms=NULL,first_matchup_week_id=NULL,
      current_competition_first_matchup_week_id=NULL,initial_rollover_times_json=NULL,
      schedule_recovery_id=NULL,help_opens_at_ms=opened_at_ms,deadline_locked_at_ms=NULL,
      allocation_completed_at_ms=NULL,completed_at_ms=NULL,updated_at_ms=?,version=version+1,
      auction_creation_cutoff_minutes=0,rollover_interval_minutes=15
      WHERE league_id=? AND id=?`).run(nowMs, GOON_ID, FAD_ID);
    database.prepare(`UPDATE seasons SET regular_season_starts_at_ms=NULL,regular_season_ends_at_ms=NULL,
      fantasy_playoffs_start_at_ms=NULL,fantasy_playoffs_end_at_ms=NULL,free_agent_draft_completed_at_ms=NULL,
      updated_at_ms=?,version=version+1 WHERE league_id=? AND id=?`).run(nowMs, GOON_ID, SEASON_ID);
    for (const row of guards) database.exec(row.sql);
    assert.deepEqual(database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name").all(), schema);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    assert.deepEqual(fingerprints(database, true), protectedBefore, "PROTECTED_RECORD_CHANGED");
    assert.equal(database.prepare("SELECT count(*) n FROM candidate_cards WHERE league_id=? AND status='open'").get(GOON_ID).n, 8);
    return { leagueId: GOON_ID, sourceHash, afterHash: goonFingerprint(database), removed,
      protectedTables: Object.keys(protectedBefore).length, protectedRecordsUnchanged: true,
      candidateDeadlineAtMs: null, firstMatchupStartsAtMs: null };
  }).immediate();
}

function goonFingerprint(database) {
  const hash = createHash("sha256");
  for (const { name } of database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
    if (!database.prepare(`PRAGMA table_info(${quote(name)})`).all().some(x => x.name === "league_id")) continue;
    hash.update(name);
    for (const row of database.prepare(`SELECT * FROM ${quote(name)} WHERE league_id=? ORDER BY rowid`).iterate(GOON_ID)) hash.update(JSON.stringify(row));
  }
  return hash.digest("hex");
}

function captureGoonResetState(database) {
  return { leagueId: GOON_ID, schema: 66, sourceHash: goonFingerprint(database),
    tables: Object.fromEntries([...CHANGED_TABLES].map(name => [name,
      database.prepare(`SELECT * FROM ${quote(name)} WHERE league_id=? ORDER BY rowid`).all(GOON_ID)])) };
}

function restoreGoonResetState({ database, snapshot, expectedCurrentGoonHash }) {
  assert.equal(snapshot.leagueId, GOON_ID);
  assert.equal(snapshot.schema, 66);
  assert.equal(database.pragma("user_version", { simple: true }), 66);
  assert.equal(database.pragma("foreign_keys", { simple: true }), 1);
  assert(!database.inTransaction);
  assert.deepEqual(Object.keys(snapshot.tables).sort(), [...CHANGED_TABLES].sort());
  return database.transaction(() => {
    assert.equal(goonFingerprint(database), expectedCurrentGoonHash, "GOON_CHANGED_AFTER_RESET_REVIEW_REQUIRED");
    const protectedBefore = fingerprints(database, true);
    const schema = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name").all();
    const guards = schema.filter(row => row.type === "trigger" && CHANGED_TABLES.has(row.tbl_name));
    database.pragma("defer_foreign_keys=ON");
    for (const row of guards) database.exec(`DROP TRIGGER ${quote(row.name)}`);
    for (const name of CHANGED_TABLES) database.prepare(`DELETE FROM ${quote(name)} WHERE league_id=?`).run(GOON_ID);
    for (const [name, rows] of Object.entries(snapshot.tables)) {
      for (const row of rows) {
        assert.equal(row.league_id, GOON_ID);
        const columns = Object.keys(row);
        database.prepare(`INSERT INTO ${quote(name)} (${columns.map(quote).join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...columns.map(key => row[key]));
      }
    }
    for (const row of guards) database.exec(row.sql);
    assert.deepEqual(database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name").all(), schema);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    assert.deepEqual(fingerprints(database, true), protectedBefore);
    assert.equal(goonFingerprint(database), snapshot.sourceHash);
    return { restored: true, leagueId: GOON_ID, protectedRecordsUnchanged: true };
  }).immediate();
}

module.exports = { GOON_ID, resetGoonLeague, goonFingerprint, fingerprints, captureGoonResetState, restoreGoonResetState };
