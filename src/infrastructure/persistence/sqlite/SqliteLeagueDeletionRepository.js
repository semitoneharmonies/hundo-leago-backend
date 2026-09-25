const crypto = require("node:crypto");
const { REPOSITORY_CATALOG } = require("./repositoryCatalog");
const { validateCompleteRepositorySchema } = require("./createSqliteRepositoryContext");

// These are platform evidence, not league content. Preserve their payloads and
// remove only the foreign-key link after the league's dependants are gone.
const RETAINED_TABLES = new Set([
  "backup_catalog", "migration_reports", "security_audit_events",
]);
// Reviewed schema-57 league tables and guards. A future schema change must be
// reviewed for erasure before this digest is advanced; unknown guards are never
// silently suspended by the deletion endpoint.
const REVIEWED_SCHEMA_SHA256 = new Set([
  // Schema 62 keeps the reviewed auction guards and includes league-scoped
  // three-team responses in the same atomic deletion and preservation checks.
  "72e1b08e7c71b01975c2230da1b732082d0ead40b4935b5257dbfbbeb3ba90b7",
  "05343a2501a75487e54e10788f92ccd54e3436ee1e4c0bafdad1a4e979e815a2",
  // Existing staging allocation-table rebuild omits the historical whole-dollar
  // offer check. Its columns, foreign keys and deletion guards are identical.
  "047da8be6a07ad0fc01449fa26e4c3583a7bdc30f26de63eac6ac2816c8223ec",
]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function createSqliteLeagueDeletionRepository({ database } = {}) {
  validateCompleteRepositorySchema(database);
  const tables = REPOSITORY_CATALOG.filter(({ scope }) => scope !== "global")
    .map(({ tableName }) => tableName).sort();
  const schema = () => database.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name"
  ).all();

  function assertReviewedSchema() {
    const relevant = schema().filter(({ tbl_name }) => tables.includes(tbl_name) || tbl_name === "leagues");
    if (!REVIEWED_SCHEMA_SHA256.has(crypto.createHash("sha256").update(JSON.stringify(relevant)).digest("hex"))) {
      fail("LEAGUE_DELETION_SCHEMA_CHANGED");
    }
  }

  function findLeague(leagueId) {
    return database.prepare("SELECT * FROM leagues WHERE id = ?").get(leagueId);
  }

  function snapshot(leagueId) {
    assertReviewedSchema();
    const league = findLeague(leagueId);
    if (!league) fail("LEAGUE_NOT_FOUND");
    const digest = crypto.createHash("sha256").update(JSON.stringify(league));
    const counts = {};
    const retainedCounts = {};
    for (const table of tables) {
      // Catalog identifiers are validated by the repository context. Rowid is
      // stable during the preview/confirmation interval, including BLOB rows.
      const rows = database.prepare(
        `SELECT * FROM "${table}" WHERE league_id = ? ORDER BY rowid`
      ).iterate(leagueId);
      let count = 0;
      digest.update(table);
      for (const row of rows) {
        digest.update(JSON.stringify(row));
        count += 1;
      }
      (RETAINED_TABLES.has(table) ? retainedCounts : counts)[table] = count;
    }
    return {
      league: { id: league.id, name: league.name, status: league.status },
      previewHash: digest.digest("hex"),
      counts,
      retainedCounts,
      totalRecords: 1 + Object.values(counts).reduce((sum, count) => sum + count, 0),
    };
  }

  function erase(leagueId) {
    assertReviewedSchema();
    if (!database.inTransaction || database.pragma("foreign_keys", { simple: true }) !== 1) {
      fail("LEAGUE_DELETION_TRANSACTION_REQUIRED");
    }
    const beforeSchema = schema();
    const deleteGuards = beforeSchema.filter(({ type, tbl_name, sql }) =>
      type === "trigger" && tables.includes(tbl_name) &&
      !RETAINED_TABLES.has(tbl_name) && /\bBEFORE\s+DELETE\s+ON\b/i.test(sql)
    );
    // The immediate transaction excludes all competing writers. As in the
    // existing fixture-erasure path, suspend delete guards only for this
    // transaction, restore exact SQL before commit, and roll back DDL on error.
    // Foreign keys stay enabled, with cyclic relationships deferred to commit.
    database.pragma("defer_foreign_keys = ON");
    for (const { name } of deleteGuards) database.exec(`DROP TRIGGER "${name}"`);
    for (const table of tables.filter((name) => !RETAINED_TABLES.has(name))) {
      database.prepare(`DELETE FROM "${table}" WHERE league_id = ?`).run(leagueId);
    }
    for (const table of RETAINED_TABLES) {
      database.prepare(`UPDATE "${table}" SET league_id = NULL WHERE league_id = ?`).run(leagueId);
    }
    if (database.prepare("DELETE FROM leagues WHERE id = ?").run(leagueId).changes !== 1) {
      fail("LEAGUE_NOT_FOUND");
    }
    for (const { sql } of deleteGuards) database.exec(sql);
    if (JSON.stringify(beforeSchema) !== JSON.stringify(schema())) {
      fail("LEAGUE_DELETION_SCHEMA_CHANGED");
    }
    if (database.pragma("foreign_key_check").length !== 0) {
      fail("LEAGUE_DELETION_INTEGRITY_FAILED");
    }
  }

  return Object.freeze({
    snapshot,
    erase,
    findLeague,
    retainedEvidence(leagueId) {
      return Object.fromEntries([...RETAINED_TABLES].map((table) => [table,
        database.prepare(`SELECT id FROM "${table}" WHERE league_id = ? ORDER BY id`)
          .all(leagueId).map(({ id }) => id),
      ]));
    },
    hasMembership(leagueId, userId) {
      return Boolean(database.prepare(
        "SELECT 1 FROM league_memberships WHERE league_id = ? AND user_id = ? " +
        "AND status = 'active' AND ended_at_ms IS NULL"
      ).get(leagueId, userId));
    },
    hasRunningJobs(leagueId) {
      return Boolean(database.prepare(
        "SELECT 1 FROM job_runs WHERE league_id = ? AND status IN ('leased', 'running') LIMIT 1"
      ).get(leagueId)) || Boolean(database.prepare(
        "SELECT 1 FROM outbox_events WHERE league_id = ? AND status = 'publishing' LIMIT 1"
      ).get(leagueId));
    },
    findReceipt(actorUserId, clientKey) {
      return database.prepare(
        "SELECT * FROM idempotency_requests WHERE league_id IS NULL " +
        "AND actor_user_id = ? AND operation = 'admin.league.delete.v1' AND client_key = ?"
      ).get(actorUserId, clientKey);
    },
    readResult(id) {
      const row = database.prepare(
        "SELECT details_json FROM operational_events WHERE id = ? AND league_id IS NULL " +
        "AND event_type = 'platform_administration.league_deleted'"
      ).get(id);
      if (!row) fail("IDEMPOTENCY_REQUEST_UNAVAILABLE");
      return JSON.parse(row.details_json).result;
    },
  });
}

module.exports = { createSqliteLeagueDeletionRepository };
