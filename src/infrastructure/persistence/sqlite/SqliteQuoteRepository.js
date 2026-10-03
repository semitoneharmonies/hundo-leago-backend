const { createSqliteRecordRepository } = require("./createSqliteRecordRepository");
const { getRepositoryDefinition } = require("./repositoryCatalog");
const { mapRepositoryError } = require("./SqliteRepositoryError");

function createSqliteQuoteRepository({ database } = {}) {
  const records = createSqliteRecordRepository({ database, definition: getRepositoryDefinition("quote_submissions") });
  const receipts = createSqliteRecordRepository({ database, definition: getRepositoryDefinition("idempotency_requests") });
  const from = `FROM quote_submissions q LEFT JOIN users u ON u.id = q.submitted_by_user_id
    LEFT JOIN leagues l ON l.id = q.source_league_id`;
  const columns = "q.*, u.display_name AS submitter_name, l.name AS league_name";
  const scopes = {
    rotation: "(q.global_status = 'approved' OR (q.source_league_id = @leagueId AND q.league_status = 'approved'))",
    league: "q.source_league_id = @leagueId AND q.league_status = 'pending' AND q.global_status <> 'approved'",
    global: "q.global_status = 'pending' AND q.source_league_id IS NOT NULL",
  };
  const pages = Object.fromEntries(Object.entries(scopes).map(([scope, condition]) => [scope, database.prepare(`
    SELECT ${columns} ${from} WHERE ${condition}
    AND (@cursorTime IS NULL OR q.created_at_ms < @cursorTime OR (q.created_at_ms = @cursorTime AND q.id < @cursorId))
    ORDER BY q.created_at_ms DESC, q.id DESC LIMIT @fetchLimit`)]));
  const find = database.prepare(`SELECT ${columns} ${from} WHERE q.id = ?`);
  const receipt = database.prepare(`SELECT * FROM idempotency_requests WHERE league_id IS @leagueId
    AND actor_user_id = @actorUserId AND operation = @operation AND client_key = @clientKey`);
  function read(statement, method, params) {
    try { return statement[method](params); }
    catch (error) { throw mapRepositoryError(error, { operation: "readQuotes", tableName: "quote_submissions" }); }
  }
  return Object.freeze({
    listPage({ scope, leagueId, limit, cursor }) {
      const rows = read(pages[scope], "all", { ...(scope === "global" ? {} : { leagueId }),
        cursorTime: cursor?.occurredAtMs ?? null, cursorId: cursor?.id ?? null, fetchLimit: limit + 1 });
      return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
    },
    find(id) { return read(find, "get", id) || null; },
    insert(row) { return records.insert(row); },
    review({ id, version, scope, status, nowMs }) {
      return records.updateVersioned({ key: id, expectedVersion: version, changes: { [`${scope}_status`]: status, updated_at_ms: nowMs } });
    },
    findReceipt(params) { return read(receipt, "get", params) || null; },
    saveReceipt(row) { return receipts.insert(row); },
  });
}
module.exports = { createSqliteQuoteRepository };
