const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { describe, test } = require("node:test");

const {
  FREE_AGENT_DRAFT_AUCTION_DRAW_CODES,
  FREE_AGENT_DRAFT_DRAW_ALGORITHM_VERSION,
  FreeAgentDraftAuctionDrawPolicyError,
  createFreeAgentDraftAuctionDrawCommitment,
  createFreeAgentDraftAuctionDrawReveal,
  createFreeAgentDraftAuctionNoSelectionReveal,
  selectUnbiasedIndexFromDigestProvider,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftAuctionDrawPolicy"
);
const {
  sha256Bytes,
  sha256HexFromBytes,
} = require("../../src/domain/shared/sha256");

const AUCTION_ID =
  "00000000-0000-4000-8000-000000000001";
const BID_ID_2 =
  "00000000-0000-4000-8000-000000000002";
const BID_ID_3 =
  "00000000-0000-4000-8000-000000000003";
const ROLLOVER_AT_MS = 2_000_000_000;
const NONCE = Uint8Array.from(
  { length: 32 },
  (_, index) => index
);
const NONCE_HEX =
  "000102030405060708090a0b0c0d0e0f" +
  "101112131415161718191a1b1c1d1e1f";
const COMMITMENT_HEX =
  "07ab702222f9107c2b7ee27a9084496b" +
  "290a0c5bad77ca170f01c514b6dc14ba";
const COUNTER_ZERO_DIGEST_HEX =
  "612b34a62a5991be9c92d1250b652d7e" +
  "6bbdb41d8cda4e64246c4fb76cad5596";

function assertPolicyError(
  callback,
  { code, reasonCode }
) {
  assert.throws(callback, (error) => {
    assert.ok(
      error instanceof
        FreeAgentDraftAuctionDrawPolicyError
    );
    assert.equal(error.code, code);
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
}

describe(
  "Free Agent Draft auction draw policy foundation",
  () => {
    test(
      "hashes arbitrary bytes without changing string-only SHA behavior",
      () => {
        const bytes = Uint8Array.from([
          0x00,
          0xff,
          0x80,
          0x41,
        ]);
        const expected = crypto
          .createHash("sha256")
          .update(bytes)
          .digest("hex");

        assert.equal(
          sha256HexFromBytes(bytes),
          expected
        );
        assert.equal(
          Buffer.from(sha256Bytes(bytes)).toString(
            "hex"
          ),
          expected
        );
        assert.throws(
          () => sha256HexFromBytes("not bytes"),
          /requires a Uint8Array/
        );
      }
    );

    test(
      "matches the approved canonical commitment and exact-tie vector",
      () => {
        const commitment =
          createFreeAgentDraftAuctionDrawCommitment({
            auctionId: AUCTION_ID,
            nonceBytes: NONCE,
          });
        assert.deepEqual(commitment, {
          algorithmVersion:
            FREE_AGENT_DRAFT_DRAW_ALGORITHM_VERSION,
          commitmentHex: COMMITMENT_HEX,
        });

        const reveal =
          createFreeAgentDraftAuctionDrawReveal({
            auctionId: AUCTION_ID,
            commitmentHex: COMMITMENT_HEX,
            nonceBytes: NONCE,
            rolloverAtMs: ROLLOVER_AT_MS,
            tiedBidIds: [BID_ID_3, BID_ID_2],
          });
        assert.deepEqual(reveal, {
          algorithmVersion:
            FREE_AGENT_DRAFT_DRAW_ALGORITHM_VERSION,
          nonceHex: NONCE_HEX,
          selectionUsed: true,
          orderedBidIds: [BID_ID_2, BID_ID_3],
          counter: 0,
          digestHex: COUNTER_ZERO_DIGEST_HEX,
          selectedIndex: 0,
          selectedBidId: BID_ID_2,
        });
        assert.ok(Object.isFrozen(reveal));
        assert.ok(
          Object.isFrozen(reveal.orderedBidIds)
        );
      }
    );

    test(
      "replays from the committed nonce and binds auction, rollover, and bids",
      () => {
        const input = {
          auctionId: AUCTION_ID,
          commitmentHex: COMMITMENT_HEX,
          nonceBytes: NONCE,
          rolloverAtMs: ROLLOVER_AT_MS,
          tiedBidIds: [BID_ID_2, BID_ID_3],
        };
        const first =
          createFreeAgentDraftAuctionDrawReveal(input);
        assert.deepEqual(
          createFreeAgentDraftAuctionDrawReveal(input),
          first
        );
        assert.notEqual(
          createFreeAgentDraftAuctionDrawReveal({
            ...input,
            rolloverAtMs: ROLLOVER_AT_MS + 1,
          }).digestHex,
          first.digestHex
        );
      }
    );

    test(
      "rejects the top of the 256-bit range and accepts the next unbiased value",
      () => {
        const counters = [];
        const result =
          selectUnbiasedIndexFromDigestProvider({
            participantCount: 3,
            digestForCounter: (counter) => {
              counters.push(counter);
              if (counter === 0) {
                return new Uint8Array(32).fill(
                  0xff
                );
              }
              const accepted = new Uint8Array(32);
              accepted[31] = 2;
              return accepted;
            },
          });

        assert.deepEqual(counters, [0, 1]);
        assert.deepEqual(result, {
          counter: 1,
          digestHex:
            "0".repeat(63) + "2",
          selectedIndex: 2,
        });
        assert.ok(Object.isFrozen(result));
      }
    );

    test(
      "reveals a terminal no-selection result without fabricating a draw",
      () => {
        const reveal =
          createFreeAgentDraftAuctionNoSelectionReveal({
            auctionId: AUCTION_ID,
            commitmentHex: COMMITMENT_HEX,
            nonceBytes: NONCE,
          });
        assert.deepEqual(reveal, {
          algorithmVersion:
            FREE_AGENT_DRAFT_DRAW_ALGORITHM_VERSION,
          nonceHex: NONCE_HEX,
          selectionUsed: false,
          orderedBidIds: [],
          counter: null,
          digestHex: null,
          selectedIndex: null,
          selectedBidId: null,
        });
        assert.ok(Object.isFrozen(reveal));
        assert.ok(
          Object.isFrozen(reveal.orderedBidIds)
        );
      }
    );

    test(
      "rejects malformed canonical evidence with stable error codes",
      () => {
        for (const [callback, reasonCode] of [
          [
            () =>
              createFreeAgentDraftAuctionDrawCommitment(
                {
                  auctionId:
                    AUCTION_ID.slice(0, -1) + "A",
                  nonceBytes: NONCE,
                }
              ),
            "auction_id_invalid",
          ],
          [
            () =>
              createFreeAgentDraftAuctionDrawCommitment(
                {
                  auctionId: AUCTION_ID,
                  nonceBytes: NONCE_HEX,
                }
              ),
            "nonce_bytes_invalid",
          ],
          [
            () =>
              createFreeAgentDraftAuctionDrawReveal({
                auctionId: AUCTION_ID,
                commitmentHex: COMMITMENT_HEX,
                nonceBytes: NONCE,
                rolloverAtMs: -1,
                tiedBidIds: [BID_ID_2, BID_ID_3],
              }),
            "rollover_at_ms_invalid",
          ],
          [
            () =>
              createFreeAgentDraftAuctionDrawReveal({
                auctionId: AUCTION_ID,
                commitmentHex: COMMITMENT_HEX,
                nonceBytes: NONCE,
                rolloverAtMs: ROLLOVER_AT_MS,
                tiedBidIds: [BID_ID_2],
              }),
            "tied_bid_ids_invalid",
          ],
          [
            () =>
              createFreeAgentDraftAuctionDrawReveal({
                auctionId: AUCTION_ID,
                commitmentHex: COMMITMENT_HEX,
                nonceBytes: NONCE,
                rolloverAtMs: ROLLOVER_AT_MS,
                tiedBidIds: [BID_ID_2, BID_ID_2],
              }),
            "tied_bid_ids_duplicate",
          ],
          [
            () =>
              selectUnbiasedIndexFromDigestProvider({
                participantCount: 2,
                digestForCounter: () =>
                  new Uint8Array(31),
              }),
            "digest_bytes_invalid",
          ],
        ]) {
          assertPolicyError(callback, {
            code:
              FREE_AGENT_DRAFT_AUCTION_DRAW_CODES
                .inputInvalid,
            reasonCode,
          });
        }

        assertPolicyError(
          () =>
            createFreeAgentDraftAuctionNoSelectionReveal(
              {
                auctionId: AUCTION_ID,
                commitmentHex: "0".repeat(64),
                nonceBytes: NONCE,
              }
            ),
          {
            code:
              FREE_AGENT_DRAFT_AUCTION_DRAW_CODES
                .commitmentMismatch,
            reasonCode: "commitment_mismatch",
          }
        );
      }
    );
  }
);
