const { createSqliteRecordRepository } = require("./createSqliteRecordRepository");
const { getRepositoryDefinition } = require("./repositoryCatalog");
const { mapRepositoryError } = require("./SqliteRepositoryError");

// Announcements are immutable league history entries. Existing backups and
// league deletion/preservation rules cover them without a schema migration.
function createSqliteLeagueAnnouncementRepository({ database } = {}) {
  const activity = createSqliteRecordRepository({ database, definition: getRepositoryDefinition("league_activity") });
  const idempotency = createSqliteRecordRepository({ database, definition: getRepositoryDefinition("idempotency_requests") });
  const columns = "a.id, a.league_id, json_object('body', a.body) AS metadata_json, a.created_at_ms AS occurred_at_ms, u.display_name AS author_name";
  const from = "FROM league_communications a LEFT JOIN users u ON u.id = a.created_by_user_id WHERE a.league_id = @leagueId AND a.kind = 'announcement'";
  const list = database.prepare(`SELECT ${columns} ${from}
    AND a.archived_at_ms IS NULL AND (a.expires_at_ms IS NULL OR a.expires_at_ms > @nowMs)
    AND (@cursorTime IS NULL OR a.created_at_ms < @cursorTime OR (a.created_at_ms = @cursorTime AND a.id < @cursorId))
    ORDER BY a.created_at_ms DESC, a.id DESC LIMIT @fetchLimit`);
  const find = database.prepare(`SELECT ${columns} ${from} AND a.id = @id`);
  const insertCommunication = database.prepare(`INSERT INTO league_communications
    (id,league_id,created_by_user_id,kind,title,body,audience,pinned,expires_at_ms,notify,recipient_count,client_key,request_hash,created_at_ms)
    VALUES (@id,@leagueId,@actorUserId,'announcement','Announcement',@body,'members',0,NULL,0,0,@clientKey,@requestHash,@nowMs)`);
  const findRequest = database.prepare(`SELECT * FROM idempotency_requests
    WHERE league_id = @leagueId AND actor_user_id = @actorUserId AND operation = @operation AND client_key = @clientKey`);
  function read(statement, method, parameters) {
    try { return statement[method](parameters); }
    catch (error) { throw mapRepositoryError(error, { operation: "readLeagueAnnouncements", tableName: "league_activity" }); }
  }
  return Object.freeze({
    listPage({ leagueId, limit, cursor, nowMs }) {
      const rows = read(list, "all", { leagueId, nowMs, fetchLimit: limit + 1, cursorTime: cursor?.occurredAtMs ?? null, cursorId: cursor?.id ?? null });
      return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
    },
    find({ leagueId, id }) { return read(find, "get", { leagueId, id }) || null; },
    findIdempotency(parameters) { return read(findRequest, "get", parameters) || null; },
    append(row) {
      const body = JSON.parse(row.metadata_json).body;
      insertCommunication.run({id:row.id,leagueId:row.league_id,actorUserId:row.actor_user_id,body,
        clientKey:'sidebar:'+row.id,requestHash:require('node:crypto').createHash('sha256').update(body).digest('hex'),nowMs:row.occurred_at_ms});
      return activity.insert(row);
    },
    saveIdempotency(row) { return idempotency.insert(row); },
  });
}

module.exports = { createSqliteLeagueAnnouncementRepository };
