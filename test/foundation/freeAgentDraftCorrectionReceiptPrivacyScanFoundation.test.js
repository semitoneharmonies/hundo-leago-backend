"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { describe, test } = require("node:test");

const {
  applyMigrations,
  discoverMigrations,
} = require("../../src/infrastructure/database/migrate");
const {
  projectFreeAgentDraftAllocationResultForPublic,
  projectFreeAgentDraftCorrectionApplyResultForPublic,
  validateFreeAgentDraftCorrectionApplyResult,
} = require("../../src/domain/freeAgentDraft/freeAgentDraftCorrectionPolicy");
const {
  hashCanonicalJsonV1,
  serializeCanonicalJsonV1,
} = require("../../src/domain/leagues/seasonRolloverEvidencePolicy");
const {
  ERROR_CODES,
  assertSafeStagingEnvironment,
  parseArguments,
  runScanCommand,
  scanExitCode,
  scanFreeAgentDraftPublicReceipts,
} = require("../../scripts/scan-fad-public-receipts");

const MIGRATIONS_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "database",
  "migrations"
);
const ENVIRONMENT_ID = "hundo-staging-environment-v1";
const DATABASE_ID = "hundo-staging-database-v1";
const CREATED_AT = "2026-08-21T12:00:00.000Z";
const CREATED_AT_MS = Date.parse(CREATED_AT);

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

const IDS = Object.freeze({
  league: uuid(1), fad: uuid(2), allocation: uuid(3), player: uuid(4),
  team: uuid(5), snapshot: uuid(6), contract: uuid(7), ownership: uuid(8),
  correction: uuid(9), activity: uuid(10), season: uuid(11), actor: uuid(12),
  membership: uuid(13), auction: uuid(14), rollover: uuid(15), recovery: uuid(16),
  t082Redacted: uuid(21), t082Legacy: uuid(22), t082Null: uuid(23),
  t082Malformed: uuid(24), t144Redacted: uuid(31), t144Legacy: uuid(32),
  t144Malformed: uuid(33),
});

function team() {
  return {
    teamId: IDS.team,
    name: "Privacy Team",
    primaryColour: "#112233",
    secondaryColour: "#445566",
    tertiaryColour: "#778899",
    patternTemplate: "mirrored-centre-band",
    logoReference: null,
  };
}

function player() {
  return { playerId: IDS.player, fullName: "Receipt Player", positionGroup: "F" };
}

function afterSummary(overrides = {}) {
  return {
    status: null, team: null, player: null, contractId: null,
    ownershipId: null, auctionId: null, totalValueCents: null,
    termYears: null, aavCents: null, rosterCategory: null, ...overrides,
  };
}

function allocation(overrides = {}) {
  return {
    allocationId: IDS.allocation,
    allocationVersion: 4,
    player: player(),
    status: "automatic_award",
    decisionCode: "corrected",
    rankedOffers: [{
      snapshotEntryId: IDS.snapshot,
      teamId: IDS.team,
      team: team(),
      slotKey: "F01",
      totalValueCents: 600,
      termYears: 2,
      aavCents: 300,
      valid: true,
      validationCode: null,
      rank: 1,
      outcomeCode: "winner",
    }],
    winner: {
      teamId: IDS.team,
      snapshotEntryId: IDS.snapshot,
      contractId: IDS.contract,
      ownershipId: IDS.ownership,
      slotKey: "F01",
      totalValueCents: 600,
      termYears: 2,
      aavCents: 300,
    },
    restricted: null,
    fallback: null,
    draws: [],
    recoveryStatus: null,
    resolvedAtMs: 1_000_000,
    ...overrides,
  };
}

function t144Result() {
  return validateFreeAgentDraftCorrectionApplyResult({
    correctionId: IDS.correction,
    allocation: allocation(),
    appliedDeltas: [{
      resourceType: "allocation",
      resourceId: IDS.allocation,
      action: "update",
      beforeVersion: 3,
      afterSummary: afterSummary({
        status: "automatic_award",
        team: team(),
        player: player(),
        contractId: IDS.contract,
        ownershipId: IDS.ownership,
        totalValueCents: 600,
        termYears: 2,
        aavCents: 300,
        rosterCategory: "Active",
      }),
    }, {
      resourceType: "activity",
      resourceId: IDS.activity,
      action: "append",
      beforeVersion: null,
      afterSummary: afterSummary({ status: "appended" }),
    }],
    activityId: IDS.activity,
    completedAtMs: 1_000_001,
  });
}

function t144Row(id, result, overrides = {}) {
  return {
    id,
    league_id: IDS.league,
    season_id: IDS.season,
    fad_id: IDS.fad,
    allocation_id: IDS.allocation,
    player_id: IDS.player,
    idempotency_request_id: uuid(Number(id.slice(-12)) + 100),
    commissioner_correction_id: IDS.correction,
    activity_id: IDS.activity,
    actor_user_id: IDS.actor,
    actor_membership_id: IDS.membership,
    actor_authority: "commissioner",
    accepted_from_allocation_version: 3,
    resulting_allocation_version: 4,
    response_http_status: 200,
    response_json: serializeCanonicalJsonV1(result),
    response_sha256: hashCanonicalJsonV1(result),
    completed_at_ms: 1_000_001,
    version: 1,
    ...overrides,
  };
}

function blocked() {
  return { allowed: false, reasonCode: "PHASE_CLOSED" };
}

function t082Allocation() {
  return allocation({
    status: "correction_required",
    decisionCode: "sole_valid_offer",
    winner: null,
    recoveryStatus: "correction_required",
    resolvedAtMs: null,
  });
}

function t082Response(fadAllocation) {
  return {
    auction: {
      administrativeBids: [],
      auctionId: IDS.auction,
      bidCount: 0,
      capabilities: { adminCancel: blocked(), adminResolve: blocked(), view: blocked() },
      creationCutoffAtMs: 800_000,
      drawCommitment: null,
      eligibleTeams: [team()],
      fadId: IDS.fad,
      fadOrigin: "candidate_tie_restricted",
      fadRolloverId: IDS.rollover,
      leagueId: IDS.league,
      minimumContract: { totalValueCents: 250, termYears: 1, aavCents: 250 },
      openedAtMs: 800_000,
      participatingTeamCount: 1,
      player: player(),
      resolvedAtMs: 1_000_001,
      resolvesAtMs: 900_000,
      result: {
        activityId: null, contractId: null, drawEvidence: null,
        finalAavCents: null, finalContractValueCents: null,
        outcomeCode: "correction_required", ownershipId: null,
        recoveryId: IDS.recovery, resolvedAtMs: 1_000_001,
        submittedAavCents: null, submittedTermYears: null,
        submittedTotalValueCents: null, winningTeam: null,
      },
      seasonId: IDS.season,
      sourceKind: "fad_restricted",
      status: "correction_required",
      targetRolloverAtMs: 1_100_000,
      updatedAtMs: 1_000_001,
      version: 3,
      viewerTeams: [],
    },
    fadAllocation,
    recoveryId: IDS.recovery,
  };
}

function t082NullResponse() {
  const response = t082Response(null);
  return {
    ...response,
    auction: {
      ...response.auction,
      creationCutoffAtMs: null,
      eligibleTeams: [],
      fadId: null,
      fadOrigin: null,
      fadRolloverId: null,
      minimumContract: null,
      result: { ...response.auction.result, outcomeCode: "cancelled", recoveryId: null },
      sourceKind: "ordinary_weekly",
      status: "cancelled",
      targetRolloverAtMs: null,
    },
    recoveryId: null,
  };
}

function t082Row(id, data, overrides = {}) {
  return {
    id,
    league_id: IDS.league,
    season_id: IDS.season,
    auction_id: IDS.auction,
    bid_id: null,
    idempotency_request_id: uuid(Number(id.slice(-12)) + 200),
    job_run_id: null,
    action: "cancel_auction",
    actor_user_id: IDS.actor,
    actor_membership_id: IDS.membership,
    actor_authority: "commissioner",
    request_sha256: "a".repeat(64),
    precondition_kind: "auction",
    expected_resource_version: 1,
    resulting_resource_version: 3,
    response_http_status: 200,
    response_json: serializeCanonicalJsonV1(data),
    response_sha256: hashCanonicalJsonV1(data),
    created_at_ms: 1_000_001,
    version: 1,
    ...overrides,
  };
}

function fakeDatabase(t082Rows, t144Rows) {
  const statements = [];
  return {
    statements,
    pragma(value) { statements.push(`PRAGMA ${value}`); },
    prepare(sql) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      statements.push(normalized);
      if (normalized === "SELECT total_changes() AS count") {
        return { get: () => ({ count: 7 }) };
      }
      if (normalized.includes("free_agent_draft_allocation_correction_command_results")) {
        return { all: () => t144Rows };
      }
      if (normalized.includes("auction_administration_command_results")) {
        return { all: () => t082Rows };
      }
      throw new Error(`Unexpected scan SQL: ${normalized}`);
    },
  };
}

function sha(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function createCommandTarget(t) {
  const persistentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-fad-scan-"));
  const databasePath = path.join(persistentRoot, "receipts.sqlite");
  const database = new Database(databasePath);
  applyMigrations({
    database,
    migrations: discoverMigrations({ migrationsDirectory: MIGRATIONS_DIRECTORY }),
    applicationBuildId: "fad-public-receipt-scan-foundation",
    now: () => CREATED_AT_MS,
  });
  const metadata = database.prepare(`
    INSERT INTO application_metadata (
      metadata_key, metadata_value, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?)
  `);
  metadata.run("database_created_at", CREATED_AT, CREATED_AT_MS, CREATED_AT_MS);
  metadata.run("database_id", DATABASE_ID, CREATED_AT_MS, CREATED_AT_MS);
  metadata.run("environment_id", ENVIRONMENT_ID, CREATED_AT_MS, CREATED_AT_MS);
  database.pragma("foreign_keys = OFF");
  database.exec(`
    DROP TRIGGER auction_administration_command_results_valid_insert;
    DROP TRIGGER free_agent_draft_allocation_correction_results_valid_insert;
  `);
  const auctionRow = t082Row(IDS.t082Legacy, t082Response(t082Allocation()));
  database.prepare(`
    INSERT INTO auction_administration_command_results (
      id, league_id, season_id, auction_id, bid_id, idempotency_request_id,
      job_run_id, action, actor_user_id, actor_membership_id, actor_authority,
      request_sha256, precondition_kind, expected_resource_version,
      resulting_resource_version, response_http_status, response_json,
      response_sha256, created_at_ms, version
    ) VALUES (
      @id, @league_id, @season_id, @auction_id, @bid_id, @idempotency_request_id,
      @job_run_id, @action, @actor_user_id, @actor_membership_id, @actor_authority,
      @request_sha256, @precondition_kind, @expected_resource_version,
      @resulting_resource_version, @response_http_status, @response_json,
      @response_sha256, @created_at_ms, @version
    )
  `).run(auctionRow);
  const correctionRow = t144Row(IDS.t144Legacy, t144Result());
  database.prepare(`
    INSERT INTO free_agent_draft_allocation_correction_command_results (
      id, league_id, season_id, fad_id, allocation_id, player_id,
      idempotency_request_id, commissioner_correction_id, activity_id,
      actor_user_id, actor_membership_id, actor_authority,
      accepted_from_allocation_version, resulting_allocation_version,
      preview_json, preview_fingerprint, request_json, request_sha256,
      response_http_status, response_json, response_sha256, completed_at_ms, version
    ) VALUES (
      @id, @league_id, @season_id, @fad_id, @allocation_id, @player_id,
      @idempotency_request_id, @commissioner_correction_id, @activity_id,
      @actor_user_id, @actor_membership_id, @actor_authority,
      @accepted_from_allocation_version, @resulting_allocation_version,
      '{}', @preview_fingerprint, '{}', @request_sha256,
      @response_http_status, @response_json, @response_sha256, @completed_at_ms, @version
    )
  `).run({
    ...correctionRow,
    preview_fingerprint: "b".repeat(64),
    request_sha256: hashCanonicalJsonV1({}),
  });
  database.close();
  t.after(() => fs.rmSync(persistentRoot, { recursive: true, force: true }));
  return {
    databasePath,
    persistentRoot,
    argv: ["--database", databasePath, "--environment", "staging", "--persistent-root", persistentRoot],
    env: {
      APP_ENV: "staging",
      APP_ENVIRONMENT_ID: ENVIRONMENT_ID,
      DATABASE_ID,
      DATABASE_PATH: databasePath,
      PERSISTENT_DATA_ROOT: persistentRoot,
    },
  };
}

describe("FAD public-receipt privacy scan foundation", () => {
  test("classifies both receipt families and proves no writes or monetary output", () => {
    const full082 = t082Allocation();
    const redacted082 = projectFreeAgentDraftAllocationResultForPublic(full082);
    const partial082 = {
      ...full082,
      rankedOffers: [{ ...full082.rankedOffers[0], totalValueCents: null }],
    };
    const full144 = t144Result();
    const redacted144 = projectFreeAgentDraftCorrectionApplyResultForPublic(full144);
    const database = fakeDatabase([
      t082Row(IDS.t082Redacted, t082Response(redacted082)),
      t082Row(IDS.t082Legacy, t082Response(full082)),
      t082Row(IDS.t082Null, t082NullResponse()),
      t082Row(IDS.t082Malformed, t082Response(partial082)),
    ], [
      t144Row(IDS.t144Redacted, redacted144),
      t144Row(IDS.t144Legacy, full144),
      t144Row(IDS.t144Malformed, redacted144, { response_sha256: "0".repeat(64) }),
    ]);

    const result = scanFreeAgentDraftPublicReceipts(database);
    assert.equal(result.safeForPublicReplay, false);
    assert.deepEqual(result.totalChanges, { before: 7, after: 7, delta: 0 });
    assert.deepEqual(result.counts, {
      totalReceipts: 7,
      malformedUnsafeReceipts: 2,
      t082: {
        totalReceipts: 4,
        redactedReceipts: 1,
        legacyFullMoneySafelyReprojectableReceipts: 1,
        nullOrNoFadAllocationReceipts: 1,
        malformedUnsafeReceipts: 1,
      },
      t144: {
        totalReceipts: 3,
        redactedReceipts: 1,
        legacyFullMoneySafelyReprojectableReceipts: 1,
        malformedUnsafeReceipts: 1,
      },
    });
    assert.equal(scanExitCode(result), 1);
    assert.equal(
      result.findings.t082.legacyFullMoneySafelyReprojectable[0].reasonCode,
      "T082_LEGACY_FULL_MONEY_SAFELY_REPROJECTABLE"
    );
    assert.equal(
      result.findings.t082.nullOrNoFadAllocation[0].reasonCode,
      "T082_NO_FAD_ALLOCATION"
    );
    assert.equal(
      result.findings.t082.malformedUnsafe[0].reasonCode,
      "T082_PUBLIC_PROJECTION_UNSAFE"
    );
    assert.equal(
      result.findings.t144.legacyFullMoneySafelyReprojectable[0].reasonCode,
      "T144_LEGACY_FULL_MONEY_SAFELY_REPROJECTABLE"
    );
    assert.equal(
      result.findings.t144.malformedUnsafe[0].reasonCode,
      "T144_STORED_RECEIPT_INVALID"
    );
    assert.equal(database.statements.some((sql) =>
      /\b(?:INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE)\b/iu.test(sql)), false);
    assert.doesNotMatch(JSON.stringify(result),
      /totalValueCents|termYears|aavCents|minimumTotalValueCents/u);
    for (const family of Object.values(result.findings)) {
      for (const entries of Object.values(family)) {
        for (const entry of entries) {
          assert.match(entry.reasonCode, /^[A-Z0-9_]+$/u);
          for (const [field, value] of Object.entries(entry)) {
            if (field !== "reasonCode") {
              assert.match(value,
                /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
            }
          }
        }
      }
    }
  });

  test("requires exact staging arguments, bindings, and package commands", () => {
    const databasePath = path.resolve("C:\\staging\\hundo.sqlite3");
    const persistentRoot = path.resolve("C:\\staging");
    const options = parseArguments([
      "--database", databasePath, "--environment", "staging",
      "--persistent-root", persistentRoot,
    ]);
    assert.deepEqual(assertSafeStagingEnvironment(options, {
      APP_ENV: "staging",
      DATABASE_PATH: databasePath,
      PERSISTENT_DATA_ROOT: persistentRoot,
      APP_ENVIRONMENT_ID: "hundo-staging-01",
      DATABASE_ID: "hundo-staging-db-01",
    }), { databaseId: "hundo-staging-db-01", environmentId: "hundo-staging-01" });
    assert.throws(() => parseArguments([
      "--database", databasePath, "--environment", "production",
      "--persistent-root", persistentRoot,
    ]), { code: ERROR_CODES.argumentInvalid });
    assert.throws(() => assertSafeStagingEnvironment(options, {
      APP_ENV: "production",
      DATABASE_PATH: databasePath,
      PERSISTENT_DATA_ROOT: persistentRoot,
      APP_ENVIRONMENT_ID: "hundo-staging-01",
      DATABASE_ID: "hundo-staging-db-01",
    }), { code: ERROR_CODES.environmentUnsafe });
    const packageJson = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, "..", "..", "package.json"), "utf8"));
    assert.equal(packageJson.scripts["db:scan:fad-public-receipts:staging"],
      "node scripts/scan-fad-public-receipts.js");
    assert.equal(packageJson.scripts["db:scan:fad-correction-receipts:staging"],
      packageJson.scripts["db:scan:fad-public-receipts:staging"]);
  });

  test("runs both families against the exact physical staging identity without writes", (t) => {
    const target = createCommandTarget(t);
    const beforeSha = sha(target.databasePath);
    const lines = [];
    const result = runScanCommand({
      argv: target.argv,
      env: target.env,
      output: { log: (line) => lines.push(line) },
    });
    assert.equal(result.safeForPublicReplay, true);
    assert.equal(scanExitCode(result), 0);
    assert.equal(result.counts.totalReceipts, 2);
    assert.equal(result.counts.t082.legacyFullMoneySafelyReprojectableReceipts, 1);
    assert.equal(result.counts.t144.legacyFullMoneySafelyReprojectableReceipts, 1);
    assert.deepEqual(result.totalChanges, { before: 0, after: 0, delta: 0 });
    assert.deepEqual(result.databaseIdentity, {
      environmentId: ENVIRONMENT_ID,
      databaseId: DATABASE_ID,
      schemaVersion: 54,
    });
    assert.deepEqual(JSON.parse(lines[0]), result);
    assert.doesNotMatch(lines[0],
      /totalValueCents|termYears|aavCents|minimumTotalValueCents|:\s*(?:600|300)\b/u);
    assert.equal(sha(target.databasePath), beforeSha);
    assert.throws(() => runScanCommand({
      argv: target.argv,
      env: { ...target.env, DATABASE_ID: "different-staging-database" },
      output: { log() {} },
    }), { code: ERROR_CODES.identityMismatch });
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hundo-fad-scan-other-"));
    t.after(() => fs.rmSync(otherRoot, { recursive: true, force: true }));
    assert.throws(() => runScanCommand({
      argv: ["--database", target.databasePath, "--environment", "staging",
        "--persistent-root", otherRoot],
      env: { ...target.env, PERSISTENT_DATA_ROOT: otherRoot },
      output: { log() {} },
    }), { code: ERROR_CODES.targetUnsafe });
    assert.equal(sha(target.databasePath), beforeSha);
  });
});
