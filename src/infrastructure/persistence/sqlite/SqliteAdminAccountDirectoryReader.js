"use strict";

const SORT_EXPRESSIONS = Object.freeze({
  username: "users.display_name_normalized",
  email: "users.email_normalized",
  createdAt: "users.created_at_ms",
  league: "(SELECT MIN(league.name_normalized) FROM league_memberships AS membership " +
    "JOIN leagues AS league ON league.id=membership.league_id WHERE membership.user_id=users.id " +
    "AND membership.status='active' AND membership.ended_at_ms IS NULL AND league.status<>'deleted')",
  status: "CASE users.status WHEN 'active' THEN 'active' WHEN 'pending_credential_setup' THEN 'awaiting password setup' " +
    "WHEN 'pending_verification' THEN 'awaiting verification' WHEN 'deactivated' THEN 'deactivated' ELSE 'disabled' END",
});
function invalidPagination() {
  const error = new Error("Choose a valid account-directory page and sort order.");
  error.code = "ACCOUNT_DIRECTORY_INPUT_INVALID";
  return error;
}
function validatePagination({ limit = 50, offset = 0, sort = "username", direction = "asc" } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      !Number.isSafeInteger(offset) || offset < 0 || typeof sort !== "string" || !Object.hasOwn(SORT_EXPRESSIONS, sort) ||
      !["asc", "desc"].includes(direction)) throw invalidPagination();
  return { limit, offset, sort, direction };
}
function createSqliteAdminAccountDirectoryReader({ database } = {}) {
  if (!database || typeof database.prepare !== "function" || typeof database.transaction !== "function") {
    throw new TypeError("The account directory requires a database reader.");
  }
  const totalStatement = database.prepare("SELECT COUNT(*) AS total FROM users");
  const statements = new Map();
  // Every SQL fragment is fixed here; request strings never become SQL.
  for (const [sort, expression] of Object.entries(SORT_EXPRESSIONS)) {
    for (const direction of ["asc", "desc"]) {
      const order = (sort === "league" ? expression + " IS NULL ASC, " : "") +
        expression + (direction === "asc" ? " ASC" : " DESC") + ", users.display_name_normalized ASC, users.id ASC";
      const pageSql = "SELECT users.id FROM users ORDER BY " + order + " LIMIT @limit OFFSET @offset";
      statements.set(sort + ":" + direction, {
        accounts: database.prepare(
          "SELECT users.id, users.display_name AS username, users.email_display AS email, users.status, " +
          "users.created_at_ms AS createdAtMs FROM users ORDER BY " + order + " LIMIT @limit OFFSET @offset"
        ),
        memberships: database.prepare(
          "SELECT membership.user_id, league.id, league.name FROM league_memberships AS membership " +
          "JOIN leagues AS league ON league.id=membership.league_id " +
          "JOIN (" + pageSql + ") AS page ON page.id=membership.user_id " +
          "WHERE membership.status='active' AND membership.ended_at_ms IS NULL AND league.status<>'deleted' " +
          "ORDER BY league.name_normalized ASC, league.id ASC"
        ),
      });
    }
  }
  const readPage = database.transaction(pagination => {
    const total = totalStatement.get().total;
    if (!Number.isSafeInteger(total) || total < 0) throw new Error("Account count is unavailable.");
    const selected = statements.get(pagination.sort + ":" + pagination.direction);
    const bounds = { limit: pagination.limit, offset: pagination.offset };
    const accounts = selected.accounts.all(bounds).map(account => ({ ...account, leagues: [] }));
    const byId = new Map(accounts.map(account => [account.id, account]));
    if (accounts.length) {
      for (const membership of selected.memberships.all(bounds)) {
        byId.get(membership.user_id).leagues.push({ id: membership.id, name: membership.name });
      }
    }
    return {
      code: "ADMIN_ACCOUNT_DIRECTORY_FOUND", accounts,
      pagination: { ...pagination, total, hasMore: pagination.offset + accounts.length < total },
    };
  });
  return Object.freeze({ read(input) { return readPage.deferred(validatePagination(input)); } });
}
module.exports = { createSqliteAdminAccountDirectoryReader, validatePagination };
