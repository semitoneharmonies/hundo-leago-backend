"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  FREE_AGENT_DRAFT_CORRECTION_RESOURCE_IDENTITY_CODE,
  FREE_AGENT_DRAFT_CORRECTION_RESOURCE_IDENTITY_DOMAIN,
  FREE_AGENT_DRAFT_CORRECTION_RESOURCE_IDENTITY_SCHEMA_VERSION,
  deriveFreeAgentDraftCorrectionResourceId,
  freeAgentDraftCorrectionResourceIdentityProjection,
  hashFreeAgentDraftCorrectionResourceIdentity,
  serializeFreeAgentDraftCorrectionResourceIdentity,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftCorrectionResourceIdentityPolicy"
);

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(
    12,
    "0"
  )}`;
}

function input(overrides = {}) {
  return {
    leagueId: uuid(1),
    fadId: uuid(2),
    allocationId: uuid(3),
    acceptedFromAllocationVersion: 7,
    targetTeamId: uuid(4),
    resourceType: "contract",
    ...overrides,
  };
}

describe(
  "Free Agent Draft correction resource identity policy",
  () => {
    test("pins the canonical domain, schema, serialization, hash, and UUID vector", () => {
      const value = input();
      assert.deepEqual(
        freeAgentDraftCorrectionResourceIdentityProjection(
          value
        ),
        {
          domain:
            FREE_AGENT_DRAFT_CORRECTION_RESOURCE_IDENTITY_DOMAIN,
          schemaVersion:
            FREE_AGENT_DRAFT_CORRECTION_RESOURCE_IDENTITY_SCHEMA_VERSION,
          leagueId: uuid(1),
          fadId: uuid(2),
          allocationId: uuid(3),
          acceptedFromAllocationVersion: 7,
          targetTeamId: uuid(4),
          resourceType: "contract",
        }
      );
      assert.equal(
        serializeFreeAgentDraftCorrectionResourceIdentity(
          value
        ),
        '{"acceptedFromAllocationVersion":7,"allocationId":"00000000-0000-4000-8000-000000000003","domain":"hundo-leago.fad-allocation-correction-resource-identity","fadId":"00000000-0000-4000-8000-000000000002","leagueId":"00000000-0000-4000-8000-000000000001","resourceType":"contract","schemaVersion":1,"targetTeamId":"00000000-0000-4000-8000-000000000004"}'
      );
      assert.equal(
        hashFreeAgentDraftCorrectionResourceIdentity(value),
        "1f7b6501bc1b25bb4eea610bdb7ceeeac9144968a8e65818e3edcd6afbe93b39"
      );
      assert.equal(
        deriveFreeAgentDraftCorrectionResourceId(value),
        "1f7b6501-bc1b-45bb-8eea-610bdb7ceeea"
      );
    });

    test("changes identity across every scope, version, team, and resource seam", () => {
      const baseline =
        deriveFreeAgentDraftCorrectionResourceId(input());
      for (const changed of [
        input({ leagueId: uuid(11) }),
        input({ fadId: uuid(12) }),
        input({ allocationId: uuid(13) }),
        input({ acceptedFromAllocationVersion: 8 }),
        input({ targetTeamId: uuid(14) }),
        input({ resourceType: "ownership" }),
      ]) {
        assert.notEqual(
          deriveFreeAgentDraftCorrectionResourceId(changed),
          baseline
        );
      }
    });

    test("rejects noncanonical or extended identity inputs", () => {
      for (const value of [
        input({ resourceType: "activity" }),
        input({ acceptedFromAllocationVersion: 0 }),
        input({ targetTeamId: "team" }),
        { ...input(), winner: uuid(99) },
      ]) {
        assert.throws(
          () =>
            deriveFreeAgentDraftCorrectionResourceId(
              value
            ),
          (error) =>
            error.code ===
            FREE_AGENT_DRAFT_CORRECTION_RESOURCE_IDENTITY_CODE
        );
      }
    });
  }
);
