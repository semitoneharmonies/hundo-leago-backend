"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const Database = require("better-sqlite3");
const { migrateDatabase } = require("../../src/infrastructure/database/migrate");
const { readFreeAgentDraftCommissionerWindow: readWindow, requireFreeAgentDraftCommissionerWindow: requireWindow } = require("../../src/infrastructure/persistence/sqlite/SqliteFreeAgentDraftCommissionerWindow");

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const nowMs = Date.parse("2026-10-05T07:00:00Z");

function fixture(t) {
  const db = new Database(":memory:");
  t.after(() => db.close());
  db.pragma("foreign_keys = ON");
  migrateDatabase({ database: db, migrationsDirectory: path.resolve(__dirname, "../../database/migrations"), applicationBuildId: "fad-window-test", now: () => 1 });
  db.prepare(`INSERT INTO users (id,email_normalized,email_display,display_name,display_name_normalized,status,created_at_ms,updated_at_ms)
    VALUES (?, 'commissioner@example.invalid', 'commissioner@example.invalid', 'Commissioner', 'commissioner', 'active', 1, 1)`).run(id(1));
  for (const league of [2, 3]) db.prepare(`INSERT INTO leagues (id,name,name_normalized,status,timezone,created_at_ms,updated_at_ms)
    VALUES (?, ?, ?, 'active', 'America/Vancouver', 1, 1)`).run(id(league), `League ${league}`, `league ${league}`);
  function season(n, league = 2, key = "20262027", status = "active", completed = null) {
    db.prepare(`INSERT INTO seasons (id,league_id,label,nhl_season_key,status,created_at_ms,updated_at_ms,free_agent_draft_completed_at_ms)
      VALUES (?,?,?,?,?,1,1,?)`).run(id(n), id(league), key, key, status, completed);
  }
  function week(seasonId, status = "scheduled", starts = nowMs) {
    db.prepare(`INSERT INTO matchup_weeks (id,league_id,season_id,week_key,sequence,starts_at_ms,baseline_at_ms,locks_at_ms,ends_at_ms,rolls_over_at_ms,status,created_at_ms,updated_at_ms)
      VALUES (?, ?, ?, 'week-1', 1, ?, ?, ?, ?, ?, ?, 1, 1)`).run(id(100 + seasonId), id(2), id(seasonId), starts, starts + 3600000, starts + 7200000, starts + 604800000, starts + 604800000, status);
  }
  function entryDraft(seasonId, status, completedAt = null, league = 2) {
    db.prepare(`INSERT INTO entry_drafts (id,league_id,season_id,status,starts_at_ms,completed_at_ms,created_by_user_id,created_at_ms,updated_at_ms)
      VALUES (?,?,?,?,1,?,?,1,1)`).run(id(200 + seasonId), id(league), id(seasonId), status, completedAt, id(1));
  }
  const scope = (seasonId, at = nowMs, league = 2) => ({ leagueId: id(league), seasonId: id(seasonId), nowMs: at });
  return { db, season, week, entryDraft, scope };
}

test("initial league activation and an overdue unopened draft do not mean competition started", (t) => {
  const f = fixture(t); f.season(10); f.week(10);
  assert.equal(readWindow(f.db, f.scope(10, nowMs + 1000)).allowed, true);
  assert.equal(f.db.pragma("foreign_key_check").length, 0);
});

test("completed preseason draft closes exactly at Week 1 even before the matchup worker runs", (t) => {
  const f = fixture(t); f.season(10, 2, "20262027", "active", nowMs - 1); f.week(10);
  assert.equal(readWindow(f.db, f.scope(10, nowMs - 1)).allowed, true);
  for (const at of [nowMs, nowMs + 1]) {
    assert.equal(readWindow(f.db, f.scope(10, at)).reasonCode, "FAD_SEASON_CLOSED");
    assert.throws(() => requireWindow(f.db, f.scope(10, at)), { code: "FAD_SEASON_CLOSED" });
  }
});

test("persisted competition activity keeps commissioner changes closed", (t) => {
  const f = fixture(t); f.season(10); f.week(10, "live", nowMs + 1000);
  assert.equal(readWindow(f.db, f.scope(10)).reasonCode, "FAD_SEASON_CLOSED");
});

test("season end alone and an incomplete Entry Draft do not unlock the upcoming FAD", (t) => {
  const f = fixture(t); f.season(10, 2, "20252026", "completed"); f.season(11);
  assert.equal(readWindow(f.db, f.scope(10)).reasonCode, "FAD_SEASON_CLOSED");
  assert.equal(readWindow(f.db, f.scope(11)).reasonCode, "FAD_ENTRY_DRAFT_REQUIRED");
  f.entryDraft(11, "active");
  assert.equal(readWindow(f.db, f.scope(11)).reasonCode, "FAD_ENTRY_DRAFT_REQUIRED");
});

test("completed Entry Draft unlocks only its upcoming season and never another league or old FAD", (t) => {
  const f = fixture(t); f.season(10, 2, "20252026", "completed"); f.season(11); f.season(12, 3);
  f.entryDraft(11, "completed", nowMs - 1);
  const before = f.db.prepare("SELECT total_changes() AS n").get().n;
  assert.equal(readWindow(f.db, f.scope(11)).allowed, true);
  assert.equal(readWindow(f.db, f.scope(10)).allowed, false);
  assert.equal(readWindow(f.db, f.scope(12)).allowed, false);
  assert.equal(f.db.prepare("SELECT total_changes() AS n").get().n, before);
  assert.equal(f.db.pragma("foreign_key_check").length, 0);
});

test("a future-dated draft completion cannot unlock changes early", (t) => {
  const f = fixture(t); f.season(10, 2, "20252026", "completed"); f.season(11);
  f.entryDraft(11, "completed", nowMs + 1);
  assert.equal(readWindow(f.db, f.scope(11)).allowed, false);
  assert.equal(readWindow(f.db, f.scope(11, nowMs + 1)).allowed, true);
});
