const {
  createEmptySocketRelated,
  createSocketEventMetadata,
} = require("../../../domain/leagues/socketInvalidation");
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");
const {
  isPlainObject,
} = require("./createSqliteRecordRepository");
const {
  resolveSqliteLeagueOutboxWriter,
} = require("./SqliteLeagueOutboxWriter");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const USER_INPUT_KEYS = Object.freeze([
  "action",
  "actor",
  "authority",
  "cardVersion",
  "changedAtMs",
  "kind",
  "revisionId",
  "scope",
]);
const SYSTEM_INPUT_KEYS = Object.freeze([
  "action",
  "actor",
  "cardVersion",
  "changedAtMs",
  "kind",
  "revisionId",
  "scope",
]);
const SCOPE_KEYS = Object.freeze([
  "cardId",
  "fadId",
  "leagueId",
  "seasonId",
  "teamId",
]);
const ACTOR_KEYS = Object.freeze([
  "authority",
  "membershipId",
  "userId",
]);
const AUTHORITY_KEYS = Object.freeze([
  "accessReason",
  "actorDisplayName",
  "authorizationEvidence",
  "decision",
  "help",
]);
const AUTHORIZATION_EVIDENCE_KEYS = Object.freeze([
  "id",
  "kind",
]);
const DECISION_KEYS = Object.freeze([
  "accessSource",
  "actorAuthority",
  "canEditCandidateEntries",
  "canEditCarryoverContracts",
  "canMoveEligibleCarryovers",
  "canReadPrivateCard",
  "canRemoveCarryovers",
  "canRequestHelp",
  "helpWindowOpen",
]);
const EDITOR_AUTHORITIES = new Set([
  "commissioner",
  "manager",
  "platform_administrator_as_commissioner",
]);
const ACTIONS = new Set([
  "candidate_added",
  "candidate_edited",
  "candidate_moved",
  "candidate_removed",
  "carryover_moved",
]);
const SYSTEM_ACTION_BY_KIND = Object.freeze({
  candidate_card_carryovers_synchronized:
    "carryover_synchronized",
  candidate_card_eligibility_revalidated:
    "eligibility_revalidated",
  candidate_card_summer_state_synchronized:
    "summer_state_synchronized",
});

function invalid(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    message
  );
}

function incompatible(message) {
  throw repositoryError(
    REPOSITORY_ERROR_CODES.schemaIncompatible,
    message
  );
}

function exactObject(value, keys, description) {
  if (!isPlainObject(value)) {
    invalid(`An exact ${description} is required.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalid(`An exact ${description} is required.`);
  }
  return value;
}

function canonicalId(value, description) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    invalid(`A canonical ${description} identifier is required.`);
  }
  return value;
}

function positiveVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    invalid("A positive Candidate Card version is required.");
  }
  return value;
}

function safeTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid("A safe Candidate Card change timestamp is required.");
  }
  return value;
}

function displayName(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    invalid("A canonical Candidate Card actor display name is required.");
  }
  return value;
}

function validateDecision(value, actorAuthority) {
  exactObject(
    value,
    DECISION_KEYS,
    "Candidate Card authority decision"
  );
  for (const key of DECISION_KEYS.filter(
    (key) =>
      !["accessSource", "actorAuthority"].includes(key)
  )) {
    if (typeof value[key] !== "boolean") {
      invalid("Candidate Card authority decisions require booleans.");
    }
  }
  const expectedAccessSource =
    actorAuthority === "manager"
      ? "manager_assignment"
      : "help_request";
  if (
    value.actorAuthority !== actorAuthority ||
    value.accessSource !== expectedAccessSource ||
    value.canReadPrivateCard !== true ||
    value.canEditCandidateEntries !== true ||
    value.canMoveEligibleCarryovers !== true ||
    value.canRemoveCarryovers !== false ||
    value.canEditCarryoverContracts !== false
  ) {
    invalid("An authorized Candidate Card mutation decision is required.");
  }
}

function normalizeInput(input) {
  if (!isPlainObject(input)) {
    invalid("An exact Candidate Card mutation side-effect input is required.");
  }
  const systemAction =
    typeof input.kind === "string" &&
    Object.prototype.hasOwnProperty.call(
      SYSTEM_ACTION_BY_KIND,
      input.kind
    )
      ? SYSTEM_ACTION_BY_KIND[input.kind]
      : null;
  const systemSynchronization =
    systemAction !== null;
  exactObject(
    input,
    systemSynchronization ? SYSTEM_INPUT_KEYS : USER_INPUT_KEYS,
    "Candidate Card mutation side-effect input"
  );
  if (
    (!systemSynchronization && input.kind !== "candidate_card_changed") ||
    (systemSynchronization && input.action !== systemAction) ||
    (!systemSynchronization && !ACTIONS.has(input.action))
  ) {
    invalid("A supported Candidate Card mutation action is required.");
  }

  const scope = exactObject(
    input.scope,
    SCOPE_KEYS,
    "Candidate Card side-effect scope"
  );
  const normalizedScope = Object.freeze({
    leagueId: canonicalId(scope.leagueId, "league"),
    seasonId: canonicalId(scope.seasonId, "season"),
    fadId: canonicalId(scope.fadId, "Free Agent Draft"),
    cardId: canonicalId(scope.cardId, "Candidate Card"),
    teamId: canonicalId(scope.teamId, "team"),
  });

  const actor = exactObject(
    input.actor,
    ACTOR_KEYS,
    "Candidate Card side-effect actor"
  );
  let normalizedActor;
  let authority = null;
  if (systemSynchronization) {
    if (
      actor.authority !== "system" ||
      actor.userId !== null ||
      actor.membershipId !== null
    ) {
      invalid("An exact system Candidate Card synchronization actor is required.");
    }
    normalizedActor = Object.freeze({
      userId: null,
      membershipId: null,
      authority: "system",
    });
  } else {
    if (!EDITOR_AUTHORITIES.has(actor.authority)) {
      invalid("A supported Candidate Card editor authority is required.");
    }
    normalizedActor = Object.freeze({
      userId: canonicalId(actor.userId, "actor-user"),
      membershipId: canonicalId(
        actor.membershipId,
        "actor-membership"
      ),
      authority: actor.authority,
    });

    authority = exactObject(
      input.authority,
      AUTHORITY_KEYS,
      "Candidate Card mutation authority"
    );
    const evidence = exactObject(
      authority.authorizationEvidence,
      AUTHORIZATION_EVIDENCE_KEYS,
      "Candidate Card authorization evidence"
    );
    const expectedEvidenceKind =
      normalizedActor.authority === "manager"
        ? "manager_assignment"
        : "help_request";
    const expectedAccessReason =
      normalizedActor.authority === "manager"
        ? "team_manager"
        : normalizedActor.authority === "commissioner"
          ? "help_grant_commissioner"
          : "help_grant_platform_administrator";
    if (
      evidence.kind !== expectedEvidenceKind ||
      authority.accessReason !== expectedAccessReason
    ) {
      invalid("Candidate Card mutation authority evidence is inconsistent.");
    }
    canonicalId(evidence.id, "Candidate Card authorization evidence");
    displayName(authority.actorDisplayName);
    validateDecision(authority.decision, normalizedActor.authority);
    if (
      authority.help !== null &&
      !isPlainObject(authority.help)
    ) {
      invalid("Candidate Card help authority evidence is invalid.");
    }
    if (
      normalizedActor.authority !== "manager" &&
      (authority.help === null || authority.help.id !== evidence.id)
    ) {
      invalid("A help-authorized Candidate Card mutation is required.");
    }
  }

  return Object.freeze({
    action: input.action,
    actor: normalizedActor,
    authority,
    cardVersion: positiveVersion(input.cardVersion),
    changedAtMs: safeTimestamp(input.changedAtMs),
    kind: input.kind,
    revisionId: canonicalId(input.revisionId, "Candidate Card revision"),
    scope: normalizedScope,
  });
}

function uniqueRow(statement, parameters, description) {
  const rows = statement.all(parameters);
  if (rows.length > 1) {
    incompatible(`${description} was not unique.`);
  }
  return rows[0] || null;
}

function createSqliteCandidateCardMutationSideEffectWriter({
  database,
  leagueOutboxWriter,
} = {}) {
  if (
    !database ||
    typeof database.prepare !== "function" ||
    typeof database.transaction !== "function"
  ) {
    throw new TypeError(
      "createSqliteCandidateCardMutationSideEffectWriter requires an opened database"
    );
  }

  let outboxWriter;
  let activeHelpStatement;
  let commissionerStatement;
  let administratorStatement;
  try {
    outboxWriter = resolveSqliteLeagueOutboxWriter({
      database,
      leagueOutboxWriter,
    });
    activeHelpStatement = database.prepare(`
      SELECT id
      FROM candidate_card_help_requests
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND fad_id = @fadId
        AND card_id = @cardId
        AND team_id = @teamId
        AND status = 'active'
        AND requested_at_ms <= @changedAtMs
        AND @changedAtMs < expires_at_ms
      LIMIT 2
    `);
    commissionerStatement = database.prepare(`
      SELECT membership.user_id
      FROM leagues AS league
      JOIN league_memberships AS membership
        ON membership.league_id = league.id
       AND membership.id = league.commissioner_membership_id
      JOIN users AS user
        ON user.id = membership.user_id
      WHERE league.id = @leagueId
        AND membership.status = 'active'
        AND membership.permission_category = 'commissioner'
        AND membership.joined_at_ms IS NOT NULL
        AND membership.joined_at_ms <= @changedAtMs
        AND membership.ended_at_ms IS NULL
        AND user.status = 'active'
      LIMIT 2
    `);
    administratorStatement = database.prepare(`
      SELECT DISTINCT role.user_id
      FROM platform_roles AS role
      JOIN users AS user
        ON user.id = role.user_id
      JOIN league_memberships AS membership
        ON membership.league_id = @leagueId
       AND membership.user_id = role.user_id
      WHERE role.role = 'platform_administrator'
        AND role.status = 'active'
        AND role.ended_at_ms IS NULL
        AND user.status = 'active'
        AND membership.status = 'active'
        AND membership.joined_at_ms IS NOT NULL
        AND membership.joined_at_ms <= @changedAtMs
        AND membership.ended_at_ms IS NULL
      ORDER BY role.user_id
    `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareCandidateCardMutationSideEffectWriter",
      tableName: "candidate_card_help_requests",
    });
  }

  return function writeCandidateCardMutationSideEffects(input) {
    const command = normalizeInput(input);
    try {
      const audiences = [
        Object.freeze({
          kind: "team",
          teamId: command.scope.teamId,
        }),
      ];
      const activeHelp = uniqueRow(
        activeHelpStatement,
        {
          ...command.scope,
          changedAtMs: command.changedAtMs,
        },
        "The active Candidate Card help request"
      );
      if (activeHelp) {
        const commissioner = uniqueRow(
          commissionerStatement,
          {
            leagueId: command.scope.leagueId,
            changedAtMs: command.changedAtMs,
          },
          "The current Candidate Card commissioner audience"
        );
        const userIds = new Set(
          administratorStatement
            .all({
              leagueId: command.scope.leagueId,
              changedAtMs: command.changedAtMs,
            })
            .map(({ user_id: userId }) =>
              canonicalId(userId, "Candidate Card user audience")
            )
        );
        if (commissioner) {
          userIds.add(
            canonicalId(
              commissioner.user_id,
              "Candidate Card commissioner audience"
            )
          );
        }
        for (const userId of [...userIds].sort()) {
          audiences.push(
            Object.freeze({ kind: "user", userId })
          );
        }
      }

      return outboxWriter.write({
        id: command.revisionId,
        leagueId: command.scope.leagueId,
        eventType: "candidate_card.changed",
        aggregateType: "candidate_card",
        aggregateId: command.scope.cardId,
        payload: createSocketEventMetadata({
          eventType: "candidate_card.changed",
          version: command.cardVersion,
          reasonCode: "card_changed",
          occurredAtMs: command.changedAtMs,
          related: createEmptySocketRelated({
            fadId: command.scope.fadId,
            teamId: command.scope.teamId,
            cardId: command.scope.cardId,
          }),
        }),
        occurredAtMs: command.changedAtMs,
        audiences,
      });
    } catch (error) {
      throw mapRepositoryError(error, {
        operation: "writeCandidateCardMutationSideEffects",
        tableName: "outbox_events",
      });
    }
  };
}

module.exports = {
  createSqliteCandidateCardMutationSideEffectWriter,
};
