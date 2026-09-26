"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const Database = require("better-sqlite3");
const { before, after, test } = require("node:test");
const { applyMigrations, discoverMigrations } = require("../../src/infrastructure/database/migrate");

let schema;
let tableDefinitions;
let resourceGuard;
let publicationGuard;
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
  publicationGuard = predicate(trigger, "FAD milestone requires automatic-award activity and scoped outbox evidence");
  accountedStateGuard = predicate(schema.prepare("SELECT sql FROM sqlite_schema WHERE name = 'free_agent_drafts_allocation_completion_barrier'").get().sql, "FAD rapid phase requires an approved accounted allocation state");
  tableDefinitions = schema.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(({ name }) => {
    const columns = schema.pragma(`table_info("${name}")`).map(({ name: column, type }) => `"${column}" ${type}`);
    return `CREATE TABLE "${name}" (${columns.join(",")});`;
  }).join("\n");
  tableDefinitions += "\n" + schema.prepare("SELECT sql FROM sqlite_schema WHERE type='view' AND name='free_agent_draft_confirmed_corrected_awards'").get().sql + ";";
  tableDefinitions += "\n" + schema.prepare("SELECT sql FROM sqlite_schema WHERE type='view' AND name='free_agent_draft_confirmed_correction_publications'").get().sql + ";";
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
  return { database, put, scope, blocked: () => database.prepare(resourceGuard).get({ league: "league", season: "season", fad: "fad" }).blocked, publicationBlocked: () => database.prepare(publicationGuard).get({ league: "league", season: "season", fad: "fad" }).blocked };
}

function correctedFixture(t, authority = "commissioner") {
  const state = fixture(t);
  const { database, put, scope } = state;
  database.exec("UPDATE free_agent_draft_player_allocations SET version=3,decision_code='corrected'; UPDATE ownership_events SET actor_user_id='corrector'; UPDATE contract_events SET actor_user_id='corrector'");
  put("free_agent_draft_allocation_correction_command_results", { ...scope, id: "receipt", fad_id: "fad", allocation_id: "allocation", commissioner_correction_id: "award-correction", activity_id: "correction-activity", actor_user_id: "corrector", actor_membership_id: "corrector-membership", actor_authority: authority, accepted_from_allocation_version: 2, resulting_allocation_version: 3, completed_at_ms: 1000, response_http_status: 200 });
  put("commissioner_corrections", { id: "award-correction", league_id: "league", season_id: "season", feature: "free_agent_draft_allocation", feature_record_id: "allocation", actor_user_id: "corrector", corrected_at_ms: 1000, before_snapshot_json: JSON.stringify({fadVersion:4}), after_snapshot_json: JSON.stringify({ status: "automatic_award", decisionCode: "corrected", version: 3, fadVersion:4, accountedAtMs: 1000, contractId: "contract", ownershipId: "ownership", winningTeamId: "team", winningSnapshotEntryId: "offer" }) });
  put("free_agent_draft_allocation_events", { ...scope, id: "corrected-event", fad_id: "fad", allocation_id: "allocation", allocation_version: 3, correction_id: "award-correction", event_kind: "correction_applied", decision_code: "corrected", resulting_allocation_status: "automatic_award", contract_id: "contract", ownership_id: "ownership", actor_user_id: "corrector", actor_membership_id: "corrector-membership", actor_authority: authority, occurred_at_ms: 1000 });
  put("league_activity", { ...scope, id: "correction-activity", event_type: "free_agent_draft_corrected", related_type: "free_agent_draft_allocation", related_id: "allocation", actor_user_id: "corrector", actor_authority: authority, occurred_at_ms: 1000 });
  database.exec("UPDATE player_ownerships SET roster_category='Active',slot_number=5,version=2");
  put("ownership_events", { ...scope, id: "moved", team_id: "team", ownership_id: "ownership", event_type: "roster_category_moved", source_type: "roster_move", source_id: "move-activity", actor_user_id: "manager", occurred_at_ms: 2000, before_metadata_json: JSON.stringify({ version: 1 }), after_metadata_json: JSON.stringify({ rosterCategory: "Active", positionGroup: "D", slotNumber: 5, version: 2 }) });
  put("league_activity", { id: "move-activity", league_id: "league", season_id: "season", actor_user_id: "manager", team_id: "team", event_type: "roster_moved" });
  for (const [id, type, aggregate, resource, version] of [["fad-notice", "free_agent_draft.changed", "free_agent_draft", "fad", 4], ["activity-notice", "activity.created", "league_activity", "correction-activity", 1]]) {
    const payload={eventId:id,type,leagueId:"league",resourceId:resource,version,reasonCode:"correction_applied",occurredAt:1000,related:{fadId:"fad",teamId:"team",cardId:null,allocationId:"allocation",auctionId:null,recoveryId:null,nominationQueueId:null,scheduleRecoveryOperationId:null}};
    put("outbox_events", {id,league_id:"league",event_type:type,aggregate_type:aggregate,aggregate_id:resource,created_at_ms:1000,payload_json:JSON.stringify(payload)});
    put("outbox_event_audiences", {id:id+"-audience",league_id:"league",outbox_event_id:id,audience_kind:"league",team_id:null,user_id:null,created_at_ms:1000});
  }
  return state;
}

for (const authority of ["commissioner", "platform_administrator_as_commissioner"]) {
  test(`a moved corrected award retains its ${authority} attribution and permits completion`, (t) => {
    const { database, blocked, publicationBlocked } = correctedFixture(t, authority);
    assert.equal(blocked(), 0);
    assert.equal(publicationBlocked(), 0);
    assert.equal(database.prepare("SELECT actor_user_id FROM ownership_events WHERE id='acquired'").get().actor_user_id, "corrector");
  });
}

for (const [name, damage] of [
  ["missing draft notice", "DELETE FROM outbox_events WHERE id='fad-notice'"],
  ["missing activity notice", "DELETE FROM outbox_events WHERE id='activity-notice'"],
  ["wrong audience", "UPDATE outbox_event_audiences SET audience_kind='team',team_id='team'"],
  ["wrong notice version", "UPDATE outbox_events SET payload_json=json_set(payload_json,'$.version',99)"],
  ["wrong related allocation", "UPDATE outbox_events SET payload_json=json_set(payload_json,'$.related.allocationId','other')"],
  ["extra private payload field", "UPDATE outbox_events SET payload_json=json_set(payload_json,'$.bidAmount',100)"],
  ["wrong correction receipt actor", "UPDATE free_agent_draft_allocation_correction_command_results SET actor_user_id='other'"],
]) {
  test(`corrected award publication with ${name} blocks completion`, (t) => {
    const {database,publicationBlocked}=correctedFixture(t);
    assert.equal(publicationBlocked(),0);
    database.exec(damage);
    assert.equal(publicationBlocked(),1);
  });
}

for (const [name, damage] of [
  ["missing receipt", "DELETE FROM free_agent_draft_allocation_correction_command_results"],
  ["cross-league receipt", "UPDATE free_agent_draft_allocation_correction_command_results SET league_id='other'"],
  ["cross-draft receipt", "UPDATE free_agent_draft_allocation_correction_command_results SET fad_id='other'"],
  ["wrong receipt actor", "UPDATE free_agent_draft_allocation_correction_command_results SET actor_user_id='other'"],
  ["unapproved actor authority", "UPDATE free_agent_draft_allocation_correction_command_results SET actor_authority='manager'"],
  ["stale correction version", "UPDATE free_agent_draft_allocation_correction_command_results SET resulting_allocation_version=2"],
  ["wrong correction time", "UPDATE free_agent_draft_allocation_correction_command_results SET completed_at_ms=999"],
  ["wrong correction ownership", "UPDATE commissioner_corrections SET after_snapshot_json=json_set(after_snapshot_json,'$.ownershipId','other')"],
  ["wrong corrected winner", "UPDATE commissioner_corrections SET after_snapshot_json=json_set(after_snapshot_json,'$.winningTeamId','other')"],
  ["missing correction event", "DELETE FROM free_agent_draft_allocation_events"],
  ["wrong correction event actor", "UPDATE free_agent_draft_allocation_events SET actor_user_id='other'"],
  ["missing correction activity", "DELETE FROM league_activity WHERE id='correction-activity'"],
  ["wrong original contract actor", "UPDATE contract_events SET actor_user_id='other' WHERE id='created'"],
  ["wrong original contract price", "UPDATE contract_events SET metadata_json=json_set(metadata_json,'$.aavCents',900) WHERE id='created'"],
  ["wrong original acquisition slot", "UPDATE ownership_events SET after_metadata_json=json_set(after_metadata_json,'$.slotNumber',2) WHERE id='acquired'"],
  ["missing later move", "DELETE FROM ownership_events WHERE id='moved'"],
]) {
  test(`a corrected award with ${name} still blocks completion`, (t) => {
    const { database, blocked } = correctedFixture(t);
    assert.equal(blocked(), 0);
    database.exec(damage);
    assert.equal(blocked(), 1);
  });
}

test("a corrected award later released by an audited commissioner removal remains accounted", (t) => {
  const { database, put, scope, blocked } = correctedFixture(t);
  database.exec("DELETE FROM player_ownerships; UPDATE contracts SET status='cancelled'");
  put("ownership_events", { ...scope, id: "released", team_id: "team", ownership_id: "ownership", event_type: "commissioner_player_removed", source_type: "commissioner_correction", source_id: "removal", actor_user_id: "commissioner", occurred_at_ms: 3000, before_metadata_json: JSON.stringify({ ownership: { id: "ownership" }, contract: { id: "contract" } }), after_metadata_json: JSON.stringify({ ownership: null }) });
  put("commissioner_corrections", { id: "removal", league_id: "league", season_id: "season", actor_user_id: "commissioner", corrected_at_ms: 3000, feature: "roster_remove" });
  put("contract_events", { id: "cancelled", league_id: "league", player_id: "player", contract_id: "contract", event_type: "commissioner_contract_cancelled", source_type: "commissioner_correction", source_id: "removal", actor_user_id: "commissioner", occurred_at_ms: 3000, metadata_json: JSON.stringify({ after: { id: "contract", status: "cancelled" } }) });
  assert.equal(blocked(), 0);
  database.exec("DELETE FROM free_agent_draft_allocation_correction_command_results");
  assert.equal(blocked(), 1);
});

test("a recorded roster move permits completion; unexplained movement, missing acquisition, and wrong scope still block", (t) => {
  const { database, put, scope, blocked } = fixture(t);
  assert.equal(blocked(), 0);
  database.exec("UPDATE player_ownerships SET roster_category='Active', slot_number=5, version=2");
  assert.equal(blocked(), 1);
  put("ownership_events", { ...scope, id: "moved", team_id: "team", ownership_id: "ownership", event_type: "roster_category_moved", source_type: "roster_move", source_id: "activity", actor_user_id: "manager", occurred_at_ms: 2000, before_metadata_json: JSON.stringify({ version: 1 }), after_metadata_json: JSON.stringify({ rosterCategory: "Active", positionGroup: "D", slotNumber: 5, version: 2 }) });
  assert.equal(blocked(), 1);
  put("league_activity", { id: "activity", league_id: "league", season_id: "season", actor_user_id: "manager", team_id: "team", event_type: "roster_moved" });
  assert.equal(blocked(), 0);
  database.exec("UPDATE player_ownerships SET version=1");
  assert.equal(blocked(), 1);
  database.exec("UPDATE player_ownerships SET version=2; UPDATE league_activity SET league_id='other'");
  assert.equal(blocked(), 1);
  database.exec("UPDATE league_activity SET league_id='league'; DELETE FROM ownership_events WHERE id='acquired'");
  assert.equal(blocked(), 1);
});

for (const [name, change] of [
  ["an unplaced destination", "UPDATE ownership_events SET after_metadata_json=json_set(after_metadata_json,'$.slotNumber',NULL) WHERE id='moved'; UPDATE player_ownerships SET slot_number=NULL"],
  ["a subsequently filled slot", "UPDATE ownership_events SET after_metadata_json=json_set(after_metadata_json,'$.slotNumber',NULL) WHERE id='moved'; UPDATE player_ownerships SET slot_number=4,version=3"],
  ["a later trade-block toggle", "UPDATE player_ownerships SET trade_blocked=1,version=3"],
]) {
  test(`a recorded award and latest roster move remain valid after ${name}`, (t) => {
    const {database,blocked}=correctedFixture(t);
    assert.equal(blocked(),0);
    database.exec(change);
    assert.equal(blocked(),0);
    database.exec("UPDATE player_ownerships SET position_group='F'");
    assert.equal(blocked(),1);
    database.exec("UPDATE player_ownerships SET position_group='D'; DELETE FROM ownership_events WHERE id='acquired'");
    assert.equal(blocked(),1);
  });
}

test("an older matching move cannot hide a newer conflicting category move", (t) => {
  const {database,put,scope,blocked}=correctedFixture(t);
  database.exec("UPDATE player_ownerships SET version=3");
  assert.equal(blocked(),0);
  put("ownership_events",{...scope,id:"later",team_id:"team",ownership_id:"ownership",event_type:"roster_category_moved",source_type:"roster_move",source_id:"later-activity",actor_user_id:"manager",occurred_at_ms:3000,before_metadata_json:JSON.stringify({version:2}),after_metadata_json:JSON.stringify({rosterCategory:"Bench",positionGroup:"D",slotNumber:null,version:3})});
  assert.equal(blocked(),1);
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
