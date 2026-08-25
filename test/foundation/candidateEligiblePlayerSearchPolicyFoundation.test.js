"use strict";

const assert = require("node:assert/strict");
const {
  describe,
  test,
} = require("node:test");

const {
  CANDIDATE_ELIGIBLE_PLAYER_QUERY_INVALID,
  DEFAULT_CANDIDATE_ELIGIBLE_PLAYER_PAGE_SIZE,
  MAXIMUM_CANDIDATE_ELIGIBLE_PLAYER_CURSOR_CODE_POINTS,
  MAXIMUM_CANDIDATE_ELIGIBLE_PLAYER_PAGE_SIZE,
  MAXIMUM_CANDIDATE_ELIGIBLE_PLAYER_QUERY_CODE_POINTS,
  encodeCandidateEligiblePlayerCursor,
  normalizeCandidateEligiblePlayerQuery,
} = require(
  "../../src/domain/freeAgentDraft/candidateEligiblePlayerSearchPolicy"
);

function uuid(value) {
  return `00000000-0000-4000-8000-${String(
    value
  ).padStart(12, "0")}`;
}

const CARD_IDENTITY = Object.freeze({
  leagueId: uuid(1),
  fadId: uuid(2),
  teamId: uuid(3),
});
const PLAYER_ID = uuid(4);

function assertPolicyError(
  callback,
  reasonCode
) {
  assert.throws(callback, (error) => {
    return (
      error?.code ===
        CANDIDATE_ELIGIBLE_PLAYER_QUERY_INVALID &&
      error?.reasonCode === reasonCode
    );
  });
}

describe(
  "Candidate eligible-player search policy",
  () => {
    test(
      "normalizes exact slot-scoped search and default paging",
      () => {
        assert.deepEqual(
          normalizeCandidateEligiblePlayerQuery({
            slotKey: "F01",
            q: "  Connor    McDAVID  ",
          }, CARD_IDENTITY),
          {
            ...CARD_IDENTITY,
            slotKey: "F01",
            q: "connor mcdavid",
            limit:
              DEFAULT_CANDIDATE_ELIGIBLE_PLAYER_PAGE_SIZE,
            cursor: null,
          }
        );
        assert.equal(
          normalizeCandidateEligiblePlayerQuery({
            slotKey: "B04",
            limit:
              String(
                MAXIMUM_CANDIDATE_ELIGIBLE_PLAYER_PAGE_SIZE
              ),
          }, CARD_IDENTITY).limit,
          MAXIMUM_CANDIDATE_ELIGIBLE_PLAYER_PAGE_SIZE
        );
        assert.equal(
          normalizeCandidateEligiblePlayerQuery(
            {
              slotKey: "F01",
              q: "🏒".repeat(
                MAXIMUM_CANDIDATE_ELIGIBLE_PLAYER_QUERY_CODE_POINTS
              ),
            },
            CARD_IDENTITY
          ).q,
          "🏒".repeat(
            MAXIMUM_CANDIDATE_ELIGIBLE_PLAYER_QUERY_CODE_POINTS
          )
        );
      }
    );

    test(
      "rejects unknown, missing, symbolic, malformed, controlled, overlong, and invalid-limit input",
      () => {
        const cases = [
          [null, "query_fields_invalid"],
          [{}, "query_fields_invalid"],
          [
            {
              slotKey: "F01",
              unknown: true,
            },
            "query_fields_invalid",
          ],
          [
            Object.assign(
              {
                slotKey: "F01",
              },
              { [Symbol("hidden")]: true }
            ),
            "query_fields_invalid",
          ],
          [
            {
              slotKey: "F1",
            },
            "slot_key_invalid",
          ],
          [
            {
              slotKey: "F01",
              q: "bad\u0000text",
            },
            "query_invalid",
          ],
          [
            {
              slotKey: "F01",
              q: "x".repeat(
                MAXIMUM_CANDIDATE_ELIGIBLE_PLAYER_QUERY_CODE_POINTS +
                  1
              ),
            },
            "query_invalid",
          ],
          [
            {
              slotKey: "F01",
              q: "🏒".repeat(
                MAXIMUM_CANDIDATE_ELIGIBLE_PLAYER_QUERY_CODE_POINTS +
                  1
              ),
            },
            "query_invalid",
          ],
          [
            {
              slotKey: "F01",
              limit: 0,
            },
            "limit_invalid",
          ],
          [
            {
              slotKey: "F01",
              limit:
                MAXIMUM_CANDIDATE_ELIGIBLE_PLAYER_PAGE_SIZE +
                1,
            },
            "limit_invalid",
          ],
        ];
        for (const [input, reasonCode] of cases) {
          assertPolicyError(
            () =>
              normalizeCandidateEligiblePlayerQuery(
                input,
                CARD_IDENTITY
              ),
            reasonCode
          );
        }
      }
    );

    test(
      "keeps hidden card identity out of the public query and validates the exact route identity separately",
      () => {
        assertPolicyError(
          () =>
            normalizeCandidateEligiblePlayerQuery(
              {
                cardId: uuid(9),
                slotKey: "F01",
              },
              CARD_IDENTITY
            ),
          "query_fields_invalid"
        );
        for (const identity of [
          undefined,
          {
            ...CARD_IDENTITY,
            unknown: true,
          },
          {
            ...CARD_IDENTITY,
            leagueId: "not-a-uuid",
          },
        ]) {
          assertPolicyError(
            () =>
              normalizeCandidateEligiblePlayerQuery(
                { slotKey: "F01" },
                identity
              ),
            "card_identity_invalid"
          );
        }
      }
    );

    test(
      "round-trips a canonical versioned cursor bound to card, slot, query, and limit",
      () => {
        const query =
          normalizeCandidateEligiblePlayerQuery({
            slotKey: "D03",
            q: "  Quinn   Hughes ",
            limit: 25,
          }, CARD_IDENTITY);
        const cursor =
          encodeCandidateEligiblePlayerCursor(
            query,
            {
              sortName: "quinn hughes",
              playerId: PLAYER_ID,
            }
          );
        const decoded =
          normalizeCandidateEligiblePlayerQuery({
            slotKey: "D03",
            q: "quinn hughes",
            limit: "25",
            cursor,
          }, CARD_IDENTITY);
        assert.deepEqual(decoded.cursor, {
          sortName: "quinn hughes",
          playerId: PLAYER_ID,
        });
        assert.ok(
          Array.from(cursor).length <=
            MAXIMUM_CANDIDATE_ELIGIBLE_PLAYER_CURSOR_CODE_POINTS
        );
      }
    );

    test(
      "rejects malformed, noncanonical, stale-version, overlong, and cross-filter cursors",
      () => {
        const query =
          normalizeCandidateEligiblePlayerQuery({
            slotKey: "B01",
            q: "mcdavid",
            limit: 50,
          }, CARD_IDENTITY);
        const cursor =
          encodeCandidateEligiblePlayerCursor(
            query,
            {
              sortName: "connor mcdavid",
              playerId: PLAYER_ID,
            }
          );
        for (const value of [
          "not+base64url",
          "A".repeat(
            MAXIMUM_CANDIDATE_ELIGIBLE_PLAYER_CURSOR_CODE_POINTS +
              1
          ),
          Buffer.from("{}", "utf8").toString(
            "base64url"
          ),
          Buffer.from(
            JSON.stringify({
              filterSha256: "0".repeat(64),
              playerId: PLAYER_ID,
              sortName: "connor mcdavid",
              version: 2,
            }),
            "utf8"
          ).toString("base64url"),
        ]) {
          assertPolicyError(
            () =>
              normalizeCandidateEligiblePlayerQuery({
                slotKey: "B01",
                q: "mcdavid",
                limit: 50,
                cursor: value,
              }, CARD_IDENTITY),
            "cursor_invalid"
          );
        }
        for (const [overrides, identity] of [
          [{}, { ...CARD_IDENTITY, leagueId: uuid(9) }],
          [{}, { ...CARD_IDENTITY, fadId: uuid(9) }],
          [{}, { ...CARD_IDENTITY, teamId: uuid(9) }],
          [{ slotKey: "F01" }, CARD_IDENTITY],
          [{ q: "different" }, CARD_IDENTITY],
          [{ limit: 49 }, CARD_IDENTITY],
        ]) {
          assertPolicyError(
            () =>
              normalizeCandidateEligiblePlayerQuery({
                slotKey: "B01",
                q: "mcdavid",
                limit: 50,
                cursor,
                ...overrides,
              }, identity),
            "cursor_invalid"
          );
        }
      }
    );

    test(
      "rejects noncanonical cursor sort tuples at encoding",
      () => {
        const query =
          normalizeCandidateEligiblePlayerQuery({
            slotKey: "F01",
          }, CARD_IDENTITY);
        assertPolicyError(
          () =>
            encodeCandidateEligiblePlayerCursor(
              query,
              {
                sortName: " Connor McDavid ",
                playerId: PLAYER_ID,
              }
            ),
          "cursor_value_invalid"
        );
        assertPolicyError(
          () =>
            encodeCandidateEligiblePlayerCursor(
              query,
              {
                sortName: "",
                playerId: PLAYER_ID,
              }
            ),
          "cursor_value_invalid"
        );
        assertPolicyError(
          () =>
            encodeCandidateEligiblePlayerCursor(
              query,
              {
                sortName: "connor mcdavid",
                playerId: "not-a-uuid",
              }
            ),
          "cursor_value_invalid"
        );
      }
    );
  }
);
