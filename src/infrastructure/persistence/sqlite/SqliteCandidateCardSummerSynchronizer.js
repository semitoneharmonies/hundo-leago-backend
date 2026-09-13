const crypto = require("node:crypto");

const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");
const {
  isPlainObject,
} = require("./createSqliteRecordRepository");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INPUT_KEYS = Object.freeze([
  "affectedPlayerIds",
  "affectedTeamIds",
  "leagueId",
  "nowMs",
  "sourceKind",
  "sourceOperationId",
]);
const SCOPE_KEYS = Object.freeze([
  "cardId",
  "fadId",
  "leagueId",
  "seasonId",
  "teamId",
]);
const RESULT_KEYS = Object.freeze([
  "action",
  "cardVersion",
  "changed",
  "revisionId",
]);
const APPROVED_ACTIONS = new Set([
  "carryover_synchronized",
  "eligibility_revalidated",
  "summer_state_synchronized",
]);
const CANDIDATE_CARD_SUMMER_SOURCE_KINDS = Object.freeze([
  "auction_allocation",
  "buyout",
  "commissioner_correction",
  "contract_change",
  "deadline_reconciliation",
  "player_catalog_import",
  "position_correction",
  "prospect_decision",
  "retention_change",
  "roster_movement",
  "trade_execution",
  "trade_reversal",
]);
const SOURCE_KIND_SET = new Set(
  CANDIDATE_CARD_SUMMER_SOURCE_KINDS
);

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
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    invalid(`A canonical ${description} identifier is required.`);
  }
  return value;
}

function canonicalIdArray(value, description) {
  if (!Array.isArray(value) || value.length > 200) {
    invalid(`A bounded ${description} identifier list is required.`);
  }
  const normalized = value.map((id) =>
    canonicalId(id, description)
  );
  if (new Set(normalized).size !== normalized.length) {
    invalid(`${description} identifiers must be unique.`);
  }
  return Object.freeze([...normalized].sort());
}

function safeTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid("A safe summer synchronization timestamp is required.");
  }
  return value;
}

function deterministicUuid(namespace) {
  const bytes = Buffer.from(
    crypto.createHash("sha256").update(namespace).digest().subarray(0, 16)
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-` +
    `${hex.slice(12, 16)}-${hex.slice(16, 20)}-` +
    hex.slice(20)
  );
}

function normalizeInput(input) {
  exactObject(
    input,
    INPUT_KEYS,
    "Candidate Card summer synchronization input"
  );
  if (!SOURCE_KIND_SET.has(input.sourceKind)) {
    invalid("An approved Candidate Card summer source kind is required.");
  }
  const affectedTeamIds = canonicalIdArray(
    input.affectedTeamIds,
    "affected team"
  );
  const affectedPlayerIds = canonicalIdArray(
    input.affectedPlayerIds,
    "affected player"
  );
  if (
    affectedTeamIds.length === 0 &&
    affectedPlayerIds.length === 0
  ) {
    invalid("Summer synchronization requires an affected team or player.");
  }
  return Object.freeze({
    leagueId: canonicalId(input.leagueId, "league"),
    affectedTeamIds,
    affectedPlayerIds,
    sourceOperationId: canonicalId(
      input.sourceOperationId,
      "summer source operation"
    ),
    sourceKind: input.sourceKind,
    nowMs: safeTimestamp(input.nowMs),
  });
}

function canonicalScope(row) {
  return Object.freeze({
    leagueId: canonicalId(row.league_id, "league"),
    seasonId: canonicalId(row.season_id, "season"),
    fadId: canonicalId(row.fad_id, "Free Agent Draft"),
    cardId: canonicalId(row.card_id, "Candidate Card"),
    teamId: canonicalId(row.team_id, "team"),
  });
}

function assertResult(result, revisionId) {
  exactObject(
    result,
    RESULT_KEYS,
    "Candidate Card summer synchronization result"
  );
  if (
    typeof result.changed !== "boolean" ||
    !Number.isSafeInteger(result.cardVersion) ||
    result.cardVersion < 1
  ) {
    incompatible(
      "The Candidate Card summer synchronization result is invalid."
    );
  }
  if (result.changed) {
    if (
      !APPROVED_ACTIONS.has(result.action) ||
      result.revisionId !== revisionId
    ) {
      incompatible(
        "The changed Candidate Card summer result is invalid."
      );
    }
  } else if (
    result.action !== null ||
    result.revisionId !== null
  ) {
    incompatible(
      "The unchanged Candidate Card summer result is invalid."
    );
  }
  return Object.freeze({ ...result });
}

function createSqliteCandidateCardSummerSynchronizer({
  database,
  candidateCardRepository,
} = {}) {
  if (
    !database ||
    typeof database.prepare !== "function" ||
    typeof database.transaction !== "function"
  ) {
    throw new TypeError(
      "createSqliteCandidateCardSummerSynchronizer requires an opened database"
    );
  }
  if (
    !candidateCardRepository ||
    typeof candidateCardRepository.synchronizeSummerStateCurrent !==
      "function"
  ) {
    throw new TypeError(
      "createSqliteCandidateCardSummerSynchronizer requires a Candidate Card repository summer seam"
    );
  }

  let openCardsStatement;
  let entryCardsStatement;
  let ownershipCardsStatement;
  try {
    openCardsStatement = database.prepare(`
      SELECT
        card.league_id,
        card.season_id,
        card.fad_id,
        card.id AS card_id,
        card.team_id,
        card.version AS card_version
      FROM candidate_cards AS card
      JOIN free_agent_drafts AS fad
        ON fad.league_id = card.league_id
       AND fad.season_id = card.season_id
       AND fad.id = card.fad_id
      WHERE card.league_id = @leagueId
        AND card.status = 'open'
        AND fad.status = 'cards_open'
      ORDER BY card.id
    `);
    entryCardsStatement = database.prepare(`
      SELECT DISTINCT entry.card_id
      FROM candidate_card_entries AS entry
      JOIN candidate_cards AS card
        ON card.league_id = entry.league_id
       AND card.season_id = entry.season_id
       AND card.fad_id = entry.fad_id
       AND card.id = entry.card_id
       AND card.team_id = entry.team_id
      JOIN free_agent_drafts AS fad
        ON fad.league_id = card.league_id
       AND fad.season_id = card.season_id
       AND fad.id = card.fad_id
      WHERE entry.league_id = @leagueId
        AND entry.player_id = @playerId
        AND card.status = 'open'
        AND fad.status = 'cards_open'
      ORDER BY entry.card_id
    `);
    ownershipCardsStatement = database.prepare(`
      SELECT DISTINCT card.id AS card_id
      FROM player_ownerships AS ownership
      JOIN candidate_cards AS card
        ON card.league_id = ownership.league_id
       AND card.season_id = ownership.season_id
       AND card.team_id = ownership.team_id
      JOIN free_agent_drafts AS fad
        ON fad.league_id = card.league_id
       AND fad.season_id = card.season_id
       AND fad.id = card.fad_id
      WHERE ownership.league_id = @leagueId
        AND ownership.player_id = @playerId
        AND card.status = 'open'
        AND fad.status = 'cards_open'
      ORDER BY card.id
    `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareCandidateCardSummerSynchronizer",
      tableName: "candidate_cards",
    });
  }

  return Object.freeze({
    synchronize(input) {
      const command = normalizeInput(input);
      if (database.inTransaction !== true) {
        invalid(
          "Candidate Card summer synchronization requires the source transaction."
        );
      }
      try {
        const openRows = openCardsStatement.all({
          leagueId: command.leagueId,
        });
        const openById = new Map(
          openRows.map((row) => [
            canonicalId(row.card_id, "Candidate Card"),
            row,
          ])
        );
        const affectedTeamSet = new Set(
          command.affectedTeamIds
        );
        const affectedCardIds = new Set(
          openRows
            .filter((row) =>
              affectedTeamSet.has(row.team_id)
            )
            .map((row) => row.card_id)
        );
        for (const playerId of command.affectedPlayerIds) {
          for (const row of entryCardsStatement.all({
            leagueId: command.leagueId,
            playerId,
          })) {
            affectedCardIds.add(
              canonicalId(row.card_id, "Candidate Card")
            );
          }
          for (const row of ownershipCardsStatement.all({
            leagueId: command.leagueId,
            playerId,
          })) {
            affectedCardIds.add(
              canonicalId(row.card_id, "Candidate Card")
            );
          }
        }

        const cards = [];
        for (const cardId of [...affectedCardIds].sort()) {
          const row = openById.get(cardId);
          if (!row) {
            incompatible(
              "An affected Candidate Card is outside the open FAD scope."
            );
          }
          const scope = canonicalScope(row);
          const revisionId = deterministicUuid(
            `candidate-card-summer:${command.sourceOperationId}:${cardId}`
          );
          const rawResult =
            candidateCardRepository.synchronizeSummerStateCurrent({
              scope,
              affectedPlayerIds: command.affectedPlayerIds,
              sourceOperationId: command.sourceOperationId,
              sourceKind: command.sourceKind,
              nowMs: command.nowMs,
              revisionId,
            });
          if (rawResult && typeof rawResult.then === "function") {
            incompatible(
              "Candidate Card summer synchronization must be synchronous."
            );
          }
          cards.push(
            Object.freeze({
              scope,
              ...assertResult(rawResult, revisionId),
            })
          );
        }
        const changedCardCount = cards.filter(
          ({ changed }) => changed
        ).length;
        return Object.freeze({
          leagueId: command.leagueId,
          sourceOperationId: command.sourceOperationId,
          sourceKind: command.sourceKind,
          affectedCardCount: cards.length,
          changedCardCount,
          cards: Object.freeze(cards),
        });
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "synchronizeCandidateCardSummerState",
          tableName: "candidate_cards",
        });
      }
    },
  });
}

module.exports = {
  CANDIDATE_CARD_SUMMER_SOURCE_KINDS,
  createSqliteCandidateCardSummerSynchronizer,
};
