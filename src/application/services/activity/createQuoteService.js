const crypto = require("node:crypto");
const { validatePageInput, encodeCursor } = require("../../../domain/activity/activityPolicy");
const { validateIdempotencyKey } = require("../../../domain/leagues/teamPolicy");

function fail(code) { const error = new Error("The quote request could not be completed."); error.code = code; throw error; }
function quote(row, privateFields = false) {
  if (!row) fail("QUOTE_NOT_FOUND");
  return { id: row.id, text: row.quote_text, author: row.attribution,
    scope: row.global_status === "approved" ? "global" : row.league_status === "approved" ? "league" : "pending",
    ...(privateFields ? { leagueId: row.source_league_id, leagueName: row.league_name, submittedBy: row.submitter_name,
      leagueStatus: row.league_status, globalStatus: row.global_status, createdAtMs: row.created_at_ms, version: row.version } : {}) };
}
function text(value, max, optional = false) {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) fail("QUOTE_INPUT_INVALID");
  const clean = value.trim().replace(/\s+/gu, " ");
  if (!clean && !optional) fail("QUOTE_INPUT_INVALID");
  return clean;
}
function createQuoteService({ repositoryContext, repository, leagueAuthorization, platformAuthorization, auditRepository, clock, secureRandom } = {}) {
  function page({ scope, leagueId, query = {}, authenticated }) {
    if (scope === "global") platformAuthorization.requireAdministrator(authenticated);
    else if (scope === "league") leagueAuthorization.requireCommissioner(authenticated, leagueId);
    else leagueAuthorization.requireActiveMembership(authenticated, leagueId);
    if (!repository) fail("QUOTE_UNAVAILABLE");
    const options = validatePageInput(query);
    const result = repository.listPage({ scope, leagueId, ...options });
    const last = result.rows.at(-1);
    return { code: "QUOTES_FOUND", quotes: result.rows.map((row) => quote(row, scope !== "rotation")),
      page: { limit: options.limit, nextCursor: result.hasMore && last ? encodeCursor({ occurredAtMs: last.created_at_ms, id: last.id }) : null } };
  }
  function write({ authenticated, idempotencyKey, leagueId = null, requestCorrelationId = null, input, quoteId = null, scope }) {
    const clientKey = validateIdempotencyKey(idempotencyKey);
    const operation = `quote.${scope}.v1`;
    const digest = crypto.createHash("sha256").update(JSON.stringify({ operation, leagueId, quoteId, input })).digest("hex");
    try {
      return repositoryContext.transaction(() => {
        const authority = scope === "submit" ? leagueAuthorization.requireActiveMembership(authenticated, leagueId)
          : scope === "global" ? platformAuthorization.requireAdministrator(authenticated)
            : leagueAuthorization.requireCommissioner(authenticated, leagueId);
        if (!repository) fail("QUOTE_UNAVAILABLE");
        const previous = repository.findReceipt({ leagueId, actorUserId: authority.actorUserId, operation, clientKey });
        if (previous) {
          if (previous.request_hash !== digest) fail("IDEMPOTENCY_KEY_REUSED");
          return { code: scope === "submit" ? "QUOTE_SUBMITTED" : "QUOTE_REVIEWED", quote: quote(repository.find(previous.result_id), true) };
        }
        const nowMs = clock.nowMs();
        let id = quoteId;
        if (scope === "submit") {
          id = secureRandom.id();
          repository.insert({ id, source_league_id: leagueId, submitted_by_user_id: authority.actorUserId,
            quote_text: input.text, attribution: input.author, league_status: "pending", global_status: "pending",
            created_at_ms: nowMs, updated_at_ms: nowMs, version: 1 });
        } else {
          const row = repository.find(id);
          if (!row || !row.source_league_id || (scope === "league" && row.source_league_id !== leagueId)) fail("QUOTE_NOT_FOUND");
          if (row.version !== input.version || row[`${scope}_status`] !== "pending" || (scope === "league" && row.global_status === "approved")) fail("QUOTE_REVIEW_CONFLICT");
          repository.review({ id, version: row.version, scope, status: input.decision === "approve" ? "approved" : "rejected", nowMs });
        }
        auditRepository.append({ id: secureRandom.id(), event_type: `quote.${scope}.${input.decision || "submitted"}`, outcome: "success",
          actor_user_id: authority.actorUserId, target_user_id: null, league_id: leagueId, session_id: authenticated.session.id,
          request_correlation_id: requestCorrelationId, reason_code: `quote.${id}`, network_key_version: null, network_metadata_digest: null,
          client_metadata_json: null, unknown_account_digest: null, occurred_at_ms: nowMs });
        repository.saveReceipt({ id: secureRandom.id(), league_id: leagueId, actor_user_id: authority.actorUserId,
          operation, client_key: clientKey, request_hash: digest, status: "completed", result_type: "quote", result_id: id,
          created_at_ms: nowMs, completed_at_ms: nowMs, expires_at_ms: nowMs + 86400000 });
        return { code: scope === "submit" ? "QUOTE_SUBMITTED" : "QUOTE_REVIEWED", quote: quote(repository.find(id), true) };
      });
    } catch (error) {
      throw [error, error?.cause].find((item) => /^(QUOTE_|LEAGUE_|PLATFORM_ADMINISTRATOR_REQUIRED$|IDEMPOTENCY_KEY_REUSED$)/.test(item?.code || "")) || error;
    }
  }
  return Object.freeze({
    rotation: (args) => page({ ...args, scope: "rotation" }),
    reviewQueue: (args) => page({ ...args, scope: args.global ? "global" : "league" }),
    submit(args) {
      const input = args.input;
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["text", "author"].includes(key))) fail("QUOTE_INPUT_INVALID");
      return write({ ...args, input: { text: text(input.text, 500), author: text(input.author ?? "", 80, true) || "Anonymous" }, scope: "submit" });
    },
    review(args) {
      const input = args.input;
      if (!input || Object.keys(input).length !== 2 || !["approve", "reject"].includes(input.decision) || !Number.isSafeInteger(input.version) || input.version < 1) fail("QUOTE_INPUT_INVALID");
      return write({ ...args, scope: args.global ? "global" : "league" });
    },
  });
}
module.exports = { createQuoteService };
