const {
  sha256Bytes,
  sha256HexFromBytes,
} = require("../shared/sha256");

const FREE_AGENT_DRAFT_DRAW_ALGORITHM_VERSION = 1;
const FREE_AGENT_DRAFT_DRAW_DOMAIN =
  "hundo-fad-draw-v1";
const MAXIMUM_DRAW_PARTICIPANTS = 65_535;
const MAXIMUM_DRAW_COUNTER = 0xffff_ffff;
const UINT256_RANGE = 1n << 256n;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;

const FREE_AGENT_DRAFT_AUCTION_DRAW_CODES =
  Object.freeze({
    inputInvalid:
      "FAD_AUCTION_DRAW_INPUT_INVALID",
    commitmentMismatch:
      "FAD_AUCTION_DRAW_COMMITMENT_MISMATCH",
    counterExhausted:
      "FAD_AUCTION_DRAW_COUNTER_EXHAUSTED",
  });

class FreeAgentDraftAuctionDrawPolicyError
  extends Error {
  constructor(code, reasonCode) {
    super("The Free Agent Draft auction draw is invalid.");
    this.name =
      "FreeAgentDraftAuctionDrawPolicyError";
    this.code = code;
    this.reasonCode = reasonCode;
  }
}

function failInput(reasonCode) {
  throw new FreeAgentDraftAuctionDrawPolicyError(
    FREE_AGENT_DRAFT_AUCTION_DRAW_CODES.inputInvalid,
    reasonCode
  );
}

function failCommitment() {
  throw new FreeAgentDraftAuctionDrawPolicyError(
    FREE_AGENT_DRAFT_AUCTION_DRAW_CODES
      .commitmentMismatch,
    "commitment_mismatch"
  );
}

function isPlainObject(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (
    prototype === Object.prototype ||
    prototype === null
  );
}

function requireExactObject(value, keys) {
  if (!isPlainObject(value)) {
    failInput("input_invalid");
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some(
      (key, index) => key !== expected[index]
    )
  ) {
    failInput("input_fields_invalid");
  }
}

function stableUuid(value, reasonCode) {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value)
  ) {
    failInput(reasonCode);
  }
  return value;
}

function nonceBytes(value) {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength !== 32
  ) {
    failInput("nonce_bytes_invalid");
  }
  return new Uint8Array(value);
}

function rolloverTimestamp(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    failInput("rollover_at_ms_invalid");
  }
  return value;
}

function commitmentHex(value) {
  if (
    typeof value !== "string" ||
    !HEX_64_PATTERN.test(value)
  ) {
    failInput("commitment_hex_invalid");
  }
  return value;
}

function concatBytes(values) {
  const length = values.reduce(
    (total, value) => total + value.byteLength,
    0
  );
  const result = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}

function bytesToHex(value) {
  return Array.from(value, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function uint16be(value) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(
    0,
    value,
    false
  );
  return bytes;
}

function uint32be(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(
    0,
    value,
    false
  );
  return bytes;
}

function uint64be(value) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(
    0,
    BigInt(value),
    false
  );
  return bytes;
}

function frame(value) {
  return concatBytes([
    uint32be(value.byteLength),
    value,
  ]);
}

const textEncoder = new TextEncoder();
const DRAW_DOMAIN_FRAME = frame(
  textEncoder.encode(FREE_AGENT_DRAFT_DRAW_DOMAIN)
);

function encodeUuid(value, reasonCode) {
  return textEncoder.encode(
    stableUuid(value, reasonCode)
  );
}

function encodeBidIds(value) {
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    value.length > MAXIMUM_DRAW_PARTICIPANTS
  ) {
    failInput("tied_bid_ids_invalid");
  }
  const orderedBidIds = value.map((bidId) =>
    stableUuid(bidId, "tied_bid_id_invalid")
  ).sort();
  if (
    new Set(orderedBidIds).size !==
    orderedBidIds.length
  ) {
    failInput("tied_bid_ids_duplicate");
  }
  return Object.freeze({
    bytes: concatBytes([
      uint16be(orderedBidIds.length),
      ...orderedBidIds.map((bidId) =>
        frame(textEncoder.encode(bidId))
      ),
    ]),
    orderedBidIds: Object.freeze(orderedBidIds),
  });
}

function digestToBigInt(value) {
  let result = 0n;
  for (const byte of value) {
    result = (result << 8n) | BigInt(byte);
  }
  return result;
}

function validateDigest(value) {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength !== 32
  ) {
    failInput("digest_bytes_invalid");
  }
  return value;
}

function selectUnbiasedIndexFromDigestProvider(
  input = {}
) {
  requireExactObject(input, [
    "participantCount",
    "digestForCounter",
  ]);
  const {
    participantCount,
    digestForCounter,
  } = input;
  if (
    !Number.isSafeInteger(participantCount) ||
    participantCount < 2 ||
    participantCount >
      MAXIMUM_DRAW_PARTICIPANTS
  ) {
    failInput("participant_count_invalid");
  }
  if (typeof digestForCounter !== "function") {
    failInput("digest_provider_invalid");
  }

  const count = BigInt(participantCount);
  const threshold =
    (UINT256_RANGE / count) * count;
  for (
    let counter = 0;
    counter <= MAXIMUM_DRAW_COUNTER;
    counter += 1
  ) {
    const digest = validateDigest(
      digestForCounter(counter)
    );
    const value = digestToBigInt(digest);
    if (value < threshold) {
      return Object.freeze({
        counter,
        digestHex: bytesToHex(digest),
        selectedIndex: Number(value % count),
      });
    }
  }

  throw new FreeAgentDraftAuctionDrawPolicyError(
    FREE_AGENT_DRAFT_AUCTION_DRAW_CODES
      .counterExhausted,
    "counter_exhausted"
  );
}

function buildCommitmentBytes({
  auctionId,
  nonce,
}) {
  return concatBytes([
    DRAW_DOMAIN_FRAME,
    frame(
      encodeUuid(auctionId, "auction_id_invalid")
    ),
    frame(nonce),
  ]);
}

function createFreeAgentDraftAuctionDrawCommitment(
  input = {}
) {
  requireExactObject(input, [
    "auctionId",
    "nonceBytes",
  ]);
  const auctionId = stableUuid(
    input.auctionId,
    "auction_id_invalid"
  );
  const nonce = nonceBytes(input.nonceBytes);
  return Object.freeze({
    algorithmVersion:
      FREE_AGENT_DRAFT_DRAW_ALGORITHM_VERSION,
    commitmentHex: sha256HexFromBytes(
      buildCommitmentBytes({
        auctionId,
        nonce,
      })
    ),
  });
}

function assertCommitment({
  auctionId,
  nonce,
  expectedCommitmentHex,
}) {
  const expected = commitmentHex(
    expectedCommitmentHex
  );
  const actual =
    createFreeAgentDraftAuctionDrawCommitment({
      auctionId,
      nonceBytes: nonce,
    }).commitmentHex;
  if (actual !== expected) {
    failCommitment();
  }
  return actual;
}

function createFreeAgentDraftAuctionDrawReveal(
  input = {}
) {
  requireExactObject(input, [
    "auctionId",
    "commitmentHex",
    "nonceBytes",
    "rolloverAtMs",
    "tiedBidIds",
  ]);
  const auctionId = stableUuid(
    input.auctionId,
    "auction_id_invalid"
  );
  const nonce = nonceBytes(input.nonceBytes);
  assertCommitment({
    auctionId,
    nonce,
    expectedCommitmentHex: input.commitmentHex,
  });
  const rolloverAtMs = rolloverTimestamp(
    input.rolloverAtMs
  );
  const {
    bytes: encodedBidIds,
    orderedBidIds,
  } = encodeBidIds(input.tiedBidIds);

  const selection =
    selectUnbiasedIndexFromDigestProvider({
      participantCount: orderedBidIds.length,
      digestForCounter: (counter) =>
        sha256Bytes(
          concatBytes([
            DRAW_DOMAIN_FRAME,
            frame(nonce),
            frame(textEncoder.encode(auctionId)),
            uint64be(rolloverAtMs),
            encodedBidIds,
            uint32be(counter),
          ])
        ),
    });

  return Object.freeze({
    algorithmVersion:
      FREE_AGENT_DRAFT_DRAW_ALGORITHM_VERSION,
    nonceHex: bytesToHex(nonce),
    selectionUsed: true,
    orderedBidIds,
    counter: selection.counter,
    digestHex: selection.digestHex,
    selectedIndex: selection.selectedIndex,
    selectedBidId:
      orderedBidIds[selection.selectedIndex],
  });
}

function createFreeAgentDraftAuctionNoSelectionReveal(
  input = {}
) {
  requireExactObject(input, [
    "auctionId",
    "commitmentHex",
    "nonceBytes",
  ]);
  const auctionId = stableUuid(
    input.auctionId,
    "auction_id_invalid"
  );
  const nonce = nonceBytes(input.nonceBytes);
  assertCommitment({
    auctionId,
    nonce,
    expectedCommitmentHex: input.commitmentHex,
  });
  return Object.freeze({
    algorithmVersion:
      FREE_AGENT_DRAFT_DRAW_ALGORITHM_VERSION,
    nonceHex: bytesToHex(nonce),
    selectionUsed: false,
    orderedBidIds: Object.freeze([]),
    counter: null,
    digestHex: null,
    selectedIndex: null,
    selectedBidId: null,
  });
}

module.exports = {
  FREE_AGENT_DRAFT_AUCTION_DRAW_CODES,
  FREE_AGENT_DRAFT_DRAW_ALGORITHM_VERSION,
  FREE_AGENT_DRAFT_DRAW_DOMAIN,
  FreeAgentDraftAuctionDrawPolicyError,
  createFreeAgentDraftAuctionDrawCommitment,
  createFreeAgentDraftAuctionDrawReveal,
  createFreeAgentDraftAuctionNoSelectionReveal,
  selectUnbiasedIndexFromDigestProvider,
};
