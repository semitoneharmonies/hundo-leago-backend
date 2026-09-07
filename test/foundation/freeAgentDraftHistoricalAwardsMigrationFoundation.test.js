"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const Database = require("better-sqlite3");
const { before, after, test } = require("node:test");
const { applyMigrations, discoverMigrations } = require("../../src/infrastructure/database/migrate");

let schema;
let tableDefinitions;
let resourceGuard;
let accountedStateGuard;
function predicate(trigger, message) {
  const messageOffset = trigger.indexOf(message);
  const begin = trigger.lastIndexOf("SELECT CASE WHEN EXISTS (", messageOffset);
  const end = trigger.indexOf(") THEN RAISE(", begin);
  assert.ok(messageOffset >= 0 && begin >= 0 && end > begin);
  return (trigger.slice(begin, end).replace("SELECT CASE WHEN EXISTS (", "SELECT EXISTS (") + ") AS blocked")
    .replaceAll("NEW.league_id", "@league").replaceAll("NEW.season_id", "@season").replaceAll("NEW.id", "@fad");
}
before(() => {
  schema = new Database(":memory:");
  applyMigrations({ database: schema, migrations: discoverMigrations({
    migrationsDirectory: path.resolve(__dirname, "../../database/migrations"),
  }), applicationBuildId: "historical-award-regression", now: () => 1000 });
  // Exercise the actual migrated resource predicate with deliberately corrupt
  // rows as well as valid history. Other migration suites verify write guards.
  const trigger = schema.prepare("SELECT sql FROM sqlite_schema WHERE name = 'free_agent_drafts_automatic_award_resources_barrier'").get().sql;
  resourceGuard = predicate(trigger, "FAD milestone requires durable automatic-award resources");
  accountedStateGuard = predicate(schema.prepare("SELECT sql FROM sqlite_schema WHERE name = 'free_agent_drafts_allocation_completion_barrier'").get().sql, "FAD rapid phase requires an approved accounted allocation state");
  tableDefinitions = schema.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(({ name }) => {
    const columns = schema.pragma(`table_info("${name}")`).map(({ name: column, type }) => `"${column}" ${type}`);
    return `CREATE TABLE "${name}" (${columns.join(",")});`;
  }).join("\n");
});
after(() => schema?.close());

function fixture(t) {
  const database = new Database(":memory:");
  database.exec(tableDefinitions);
  t.after(() => database.close());
  const put = (table, row) => database.prepare(`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map((key) => `@${key}`).join(",")})`).run(row);
  const scope = { league_id: "league", season_id: "season", player_id: "player" };
  put("free_agent_draft_player_allocations", { ...scope, id: "allocation", fad_id: "fad", status: "automatic_award", ownership_id: "ownership", contract_id: "contract", winning_team_id: "team", winning_snapshot_entry_id: "offer", accounted_at_ms: 1000 });
  put("candidate_card_snapshot_entries", { ...scope, id: "offer", fad_id: "fad", team_id: "team", row_kind: "slot", occupant_kind: "candidate", proposed_total_value_cents: 1000, proposed_term_years: 1, proposed_aav_cents: 1000, eligibility_status: "valid", allocation_eligibility: "eligible", slot_group: "B", effective_position_group: "D", slot_number: 1 });
  put("contracts", { id: "contract", league_id: "league", player_id: "player", current_team_id: "team", status: "active", contract_type: "normal", start_season_id: "season", acquisition_source_type: "free_agent_draft_allocation", acquisition_source_id: "allocation", created_at_ms: 1000, auction_buyout_lock_expires_at_ms: 1209601000, original_total_value_cents: 1000, original_term_years: 1, aav_cents: 1000 });
  put("player_ownerships", { ...scope, id: "ownership", team_id: "team", ownership_kind: "Rostered", acquired_transaction_type: "free_agent_draft_allocation", acquired_transaction_id: "allocation", created_at_ms: 1000, roster_category: "Bench", position_group: "D", slot_number: 1, version: 1 });
  put("seasons", { id: "season", league_id: "league", nhl_season_key: "20262027", status: "active" });
  put("contract_years", { id: "year", league_id: "league", contract_id: "contract", season_id: "season", year_number: 1, aav_cents: 1000, status: "current", created_at_ms: 1000 });
  put("ownership_events", { ...scope, id: "acquired", team_id: "team", ownership_id: "ownership", event_type: "fad_allocation_player_acquired", source_type: "free_agent_draft_allocation", source_id: "allocation", actor_user_id: null, occurred_at_ms: 1000, before_metadata_json: null, after_metadata_json: JSON.stringify({ ownershipKind: "Rostered", rosterCategory: "Bench", positionGroup: "D", slotNumber: 1 }) });
  put("contract_events", { id: "created", league_id: "league", player_id: "player", team_id: "team", contract_id: "contract", event_type: "contract_created", source_type: "free_agent_draft_allocation", source_id: "allocation", actor_user_id: null, occurred_at_ms: 1000, metadata_json: JSON.stringify({ contractType: "normal", startSeasonId: "season", originalTotalValueCents: 1000, originalTermYears: 1, aavCents: 1000 }) });
  return { database, put, scope, blocked: () => database.prepare(resourceGuard).get({ league: "league", season: "season", fad: "fad" }).blocked };
}

test("a recorded roster move permits completion; unexplained movement, missing acquisition, and wrong scope still block", (t) => {
  const { database, put, scope, blocked } = fixture(t);
  assert.equal(blocked(), 0);
  database.exec("UPDATE player_ownerships SET roster_category='Active', slot_number=5, version=2");
  assert.equal(blocked(), 1);
  put("ownership_events", { ...scope, id: "moved", team_id: "team", ownership_id: "ownership", event_type: "roster_category_moved", source_type: "roster_move", source_id: "activity", actor_user_id: "manager", occurred_at_ms: 2000, before_metadata_json: JSON.stringify({ version: 1 }), after_metadata_json: JSON.stringify({ rosterCategory: "Active", positionGroup: "D", slotNumber: 5, version: 2 }) });
  assert.equal(blocked(), 1);
  put("league_activity", { id: "activity", league_id: "league", season_id: "season", actor_user_id: "manager", team_id: "team", event_type: "roster_moved" });
  assert.equal(blocked(), 0);
  database.exec("UPDATE player_ownerships SET version=3");
  assert.equal(blocked(), 1);
  database.exec("UPDATE player_ownerships SET version=2; UPDATE league_activity SET league_id='other'");
  assert.equal(blocked(), 1);
  database.exec("UPDATE league_activity SET league_id='league'; DELETE FROM ownership_events WHERE id='acquired'");
  assert.equal(blocked(), 1);
});

test("commissioner removal requires the original award, correction, and paired contract cancellation", (t) => {
  const { database, put, scope, blocked } = fixture(t);
  database.exec("DELETE FROM player_ownerships; UPDATE contracts SET status='cancelled'");
  assert.equal(blocked(), 1);
  put("ownership_events", { ...scope, id: "released", team_id: "team", ownership_id: "ownership", event_type: "commissioner_player_removed", source_type: "commissioner_correction", source_id: "correction", actor_user_id: "commissioner", occurred_at_ms: 2000, before_metadata_json: JSON.stringify({ ownership: { id: "ownership" }, contract: { id: "contract" } }), after_metadata_json: JSON.stringify({ ownership: null }) });
  put("commissioner_corrections", { id: "correction", league_id: "league", season_id: "season", actor_user_id: "commissioner", corrected_at_ms: 2000, feature: "roster_remove" });
  assert.equal(blocked(), 1);
  put("contract_events", { id: "cancelled", league_id: "league", player_id: "player", contract_id: "contract", event_type: "commissioner_contract_cancelled", source_type: "commissioner_correction", source_id: "correction", actor_user_id: "commissioner", occurred_at_ms: 2000, metadata_json: JSON.stringify({ after: { id: "contract", status: "cancelled" } }) });
  assert.equal(blocked(), 0);
  database.exec("UPDATE commissioner_corrections SET actor_user_id='other'");
  assert.equal(blocked(), 1);
  database.exec("UPDATE commissioner_corrections SET actor_user_id='commissioner'; UPDATE contract_events SET team_id='other' WHERE id='created'");
  assert.equal(blocked(), 1);
  database.exec("UPDATE contract_events SET team_id='team' WHERE id='created'; DELETE FROM ownership_events WHERE id='acquired'");
  assert.equal(blocked(), 1);
});

test("an executed trade preserves award evidence; an uncompleted trade or mismatched destination does not", (t) => {
  const { database, put, scope, blocked } = fixture(t);
  database.exec("DELETE FROM player_ownerships; UPDATE contracts SET current_team_id='receiver'");
  put("ownership_events", { ...scope, id: "released", team_id: "team", ownership_id: "ownership", event_type: "trade_transfer_out", source_type: "trade", source_id: "trade", actor_user_id: "manager", occurred_at_ms: 2000, before_metadata_json: JSON.stringify({ ownership: { id: "ownership" } }), after_metadata_json: JSON.stringify({ exists: false, destinationOwnershipId: "destination" }) });
  put("trades", { id: "trade", league_id: "league", season_id: "season", status: "proposed", completed_at_ms: null });
  put("ownership_events", { ...scope, id: "received", team_id: "receiver", ownership_id: "destination", event_type: "trade_transfer_in", source_type: "trade", source_id: "trade", actor_user_id: "manager", occurred_at_ms: 2000, before_metadata_json: JSON.stringify({ sourceOwnershipId: "ownership" }) });
  assert.equal(blocked(), 1);
  database.exec("UPDATE trades SET status='completed', completed_at_ms=2000");
  assert.equal(blocked(), 0);
  database.exec("UPDATE ownership_events SET ownership_id='wrong' WHERE id='received'");
  assert.equal(blocked(), 1);
  database.exec("UPDATE ownership_events SET ownership_id='destination' WHERE id='received'; DELETE FROM contract_events WHERE id='created'");
  assert.equal(blocked(), 1);
});

for (const [status, decision, outcome, sourceKind, origin] of [
  ["restricted_resolved", "restricted_auction_result", "winner", "fad_restricted", "candidate_tie_restricted"],
  ["restricted_fallback_open", "restricted_no_improvement_fallback", "no_winner", "fad_restricted", "candidate_tie_restricted"],
  ["fallback_open_resolved", "fallback_open_result", "winner", "fad_open_rapid", "restricted_no_improvement_fallback"],
  ["fallback_open_resolved", "fallback_open_no_winner", "no_winner", "fad_open_rapid", "restricted_no_improvement_fallback"],
]) {
  test(`${decision} is accounted only by its exact scoped terminal auction receipt`, (t) => {
    const { database, put, scope } = fixture(t);
    const winner = outcome === "winner";
    database.prepare("UPDATE free_agent_draft_player_allocations SET status=?,decision_code=?,restricted_auction_id='auction',fallback_open_auction_id='auction',winning_team_id=?,contract_id=?,ownership_id=?").run(status, decision, winner ? "team" : null, winner ? "contract" : null, winner ? "ownership" : null);
    const blocked = () => database.prepare(accountedStateGuard).get({ league: "league", season: "season", fad: "fad" }).blocked;
    assert.equal(blocked(), 1);
    put("auctions", { ...scope, id: "auction", status: winner ? "resolved" : "no_winner" });
    put("auction_contexts", { league_id: "league", season_id: "season", auction_id: "auction", fad_id: "fad", fad_allocation_id: "allocation", source_kind: sourceKind, fad_origin: origin });
    put("auction_resolutions", { league_id: "league", season_id: "season", auction_id: "auction", status: winner ? "resolved" : "no_winner", outcome_code: outcome, winning_team_id: winner ? "team" : null, contract_id: winner ? "contract" : null, ownership_id: winner ? "ownership" : null });
    assert.equal(blocked(), 0);
    database.exec("UPDATE auction_contexts SET fad_id='other'");
    assert.equal(blocked(), 1);
    database.exec("UPDATE auction_contexts SET fad_id='fad'; UPDATE auctions SET status='open'");
    assert.equal(blocked(), 1);
    database.prepare("UPDATE auctions SET status=?").run(winner ? "resolved" : "no_winner");
    database.exec("UPDATE auction_resolutions SET winning_team_id='wrong'");
    assert.equal(blocked(), 1);
  });
}

test("fallback rollover evidence uses its opening boundary when resolution belongs to the following day", (t) => {
  const { database, put, scope } = fixture(t);
  const source = require("node:fs").readFileSync(path.resolve(__dirname, "../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftRolloverWriter.js"), "utf8");
  const query = source.match(/fallbacksStatement = database.prepare\(`([\s\S]*?)`\);/)[1];
  database.exec("UPDATE free_agent_draft_player_allocations SET fallback_open_auction_id='fallback'");
  put("auctions", { ...scope, id: "restricted", status: "no_winner" });
  put("auction_contexts", { league_id: "league", season_id: "season", auction_id: "restricted", fad_id: "fad", fad_allocation_id: "allocation", source_kind: "fad_restricted", fad_rollover_id: "first" });
  put("auction_resolutions", { league_id: "league", season_id: "season", auction_id: "restricted", outcome_code: "no_winner" });
  put("auctions", { ...scope, id: "fallback", status: "no_winner", opened_at_ms: 2000 });
  put("auction_contexts", { league_id: "league", season_id: "season", auction_id: "fallback", fad_id: "fad", fad_allocation_id: "allocation", fad_origin: "restricted_no_improvement_fallback", fad_rollover_id: "third" });
  put("free_agent_draft_rollovers", { id: "second", league_id: "league", season_id: "season", fad_id: "fad", rolls_over_at_ms: 2000, sequence: 2 });
  const read = () => database.prepare(query).get({ leagueId: "league", seasonId: "season", fadId: "fad", rolloverId: "first", sequence: 1 });
  assert.equal(read().successor_rollover_id, "second");
  database.exec("UPDATE free_agent_draft_rollovers SET league_id='other'");
  assert.equal(read().successor_rollover_id, "third");
});
