const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { describe, test } = require("node:test");

const {
  REPOSITORY_CATALOG,
} = require("../../src/infrastructure/persistence/sqlite/repositoryCatalog");
const {
  RESET_MANIFEST_ERROR_CODES,
  RESET_V1_POST_RESET_TABLE_POLICY,
  assertPolicyCatalogCoverage,
  calculateResetManifestChecksum,
  createResetManifest,
  loadAndValidateResetManifest,
  serializeResetManifest,
  validateResetManifest,
} = require("../../src/infrastructure/migration/resetManifest");
const {
  parseArguments,
  runResetManifestValidationCommand,
} = require("../../scripts/db-validate-reset");

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MANIFEST_PATH = path.join(
  ROOT_DIRECTORY,
  "database",
  "reset-manifests",
  "2026-season-1-reset.json"
);
const VALIDATION_SCRIPT = path.join(
  ROOT_DIRECTORY,
  "scripts",
  "db-validate-reset.js"
);
const VALID_CONTEXT = Object.freeze({
  operatingMode: "OFFSEASON_RESET",
  sourceBundleManifestVersion: 1,
});
const PROTECTED_JSON_FILES = [
  "league-state.json",
  "league.json",
  "league_dump.json",
  "league_with_meta.json",
  "players.json",
];
const REQUIRED_REPOSITORY_JSON_FILES = [
  "league.json",
  "league_with_meta.json",
  "players.json",
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256File(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function fingerprintFiles(relativePaths) {
  return Object.fromEntries(
    relativePaths.map((relativePath) => [
      relativePath,
      sha256File(path.join(ROOT_DIRECTORY, relativePath)),
    ])
  );
}

function presentProtectedJsonFiles() {
  for (const relativePath of REQUIRED_REPOSITORY_JSON_FILES) {
    assert.equal(
      fs.existsSync(path.join(ROOT_DIRECTORY, relativePath)),
      true,
      `${relativePath} must exist in every repository checkout`
    );
  }
  const presentFiles = PROTECTED_JSON_FILES.filter(
    (relativePath) =>
      fs.existsSync(path.join(ROOT_DIRECTORY, relativePath))
  );
  return presentFiles;
}

function createTemporaryRoot(t, prefix) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), prefix)
  );
  t.after(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  return temporaryRoot;
}

function resign(manifest) {
  manifest.checksum =
    calculateResetManifestChecksum(manifest);
  return manifest;
}

function writeManifest(filePath, manifest) {
  fs.writeFileSync(
    filePath,
    serializeResetManifest(manifest),
    "utf8"
  );
}

function assertResetManifestError(code) {
  return (error) => error?.code === code;
}

function collectRepositoryDataArtifacts() {
  const artifacts = [];
  const ignoredDirectories = new Set([".git", "node_modules"]);

  function walk(directoryPath) {
    for (const entry of fs.readdirSync(directoryPath, {
      withFileTypes: true,
    })) {
      if (
        entry.isDirectory() &&
        ignoredDirectories.has(entry.name)
      ) {
        continue;
      }
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }
      if (
        entry.name === "source-bundle.json" ||
        /\.(?:sqlite|sqlite3|db)(?:-(?:wal|shm))?$/i.test(
          entry.name
        )
      ) {
        artifacts.push(
          path.relative(ROOT_DIRECTORY, entryPath)
        );
      }
    }
  }

  walk(ROOT_DIRECTORY);
  return artifacts.sort();
}

describe("M2-07 explicit Season 1 reset manifest", () => {
  test("validates the signed policy and explicit post-reset table boundary", () => {
    const manifestBytesBefore = fs.readFileSync(MANIFEST_PATH);
    const manifest = loadAndValidateResetManifest({
      manifestPath: MANIFEST_PATH,
      ...VALID_CONTEXT,
    });
    const omittedTables = manifest.omissionFamilies.flatMap(
      (family) => family.targetTables
    );
    const protectedTables =
      manifest.protectedFamilies.flatMap(
        (family) => family.targetTables
      );
    const signedPolicyTables = [
      ...omittedTables,
      ...protectedTables,
    ];
    const postResetTables =
      RESET_V1_POST_RESET_TABLE_POLICY.map(
        ({ tableName }) => tableName
      );
    const classifiedTables = [
      ...signedPolicyTables,
      ...postResetTables,
    ];
    const catalogTables = REPOSITORY_CATALOG.map(
      (definition) => definition.tableName
    );

    assert.equal(manifest.manifestId, "2026-season-1-reset-v1");
    assert.equal(manifest.omissionFamilies.length, 12);
    assert.equal(manifest.protectedFamilies.length, 9);
    assert.equal(manifest.neverImportFamilies.length, 1);
    assert.equal(manifest.checksum,
      "5a8153bf2554cbd89590b50a7a38a8c9036c737221de83d32ccb6fd2045c0489");
    assert.equal(signedPolicyTables.length, 82);
    assert.equal(new Set(signedPolicyTables).size, 82);
    assert.deepEqual(
      RESET_V1_POST_RESET_TABLE_POLICY,
      [
        {
          tableName: "auction_administration_command_results",
          introducedByMigrationId: 30,
          treatment: "require_empty",
        },
        {
          tableName: "auction_contexts",
          introducedByMigrationId: 26,
          treatment: "require_empty",
        },
        {
          tableName: "candidate_card_entries",
          introducedByMigrationId: 24,
          treatment: "require_empty",
        },
        {
          tableName: "candidate_card_help_command_results",
          introducedByMigrationId: 35,
          treatment: "require_empty",
        },
        {
          tableName: "candidate_card_help_requests",
          introducedByMigrationId: 24,
          treatment: "require_empty",
        },
        {
          tableName: "candidate_card_revision_entry_changes",
          introducedByMigrationId: 50,
          treatment: "require_empty",
        },
        {
          tableName: "candidate_card_revisions",
          introducedByMigrationId: 24,
          treatment: "require_empty",
        },
        {
          tableName: "candidate_card_snapshot_entries",
          introducedByMigrationId: 24,
          treatment: "require_empty",
        },
        {
          tableName: "candidate_card_snapshots",
          introducedByMigrationId: 24,
          treatment: "require_empty",
        },
        {
          tableName: "candidate_cards",
          introducedByMigrationId: 24,
          treatment: "require_empty",
        },
        {
          tableName: "entry_draft_on_clock_trades",
          introducedByMigrationId: 30,
          treatment: "require_empty",
        },
        {
          tableName: "entry_draft_pick_clocks",
          introducedByMigrationId: 30,
          treatment: "require_empty",
        },
        {
          tableName:
            "entry_draft_rollover_bindings",
          introducedByMigrationId: 30,
          treatment: "require_empty",
        },
        {
          tableName: "entry_draft_schedule_operations",
          introducedByMigrationId: 30,
          treatment: "require_empty",
        },
        {
          tableName: "free_agent_draft_allocation_events",
          introducedByMigrationId: 25,
          treatment: "require_empty",
        },
        {
          tableName:
            "free_agent_draft_allocation_correction_command_results",
          introducedByMigrationId: 39,
          treatment: "require_empty",
        },
        {
          tableName:
            "free_agent_draft_auction_participants",
          introducedByMigrationId: 26,
          treatment: "require_empty",
        },
        {
          tableName: "free_agent_draft_draws",
          introducedByMigrationId: 26,
          treatment: "require_empty",
        },
        {
          tableName:
            "free_agent_draft_eligibility_revalidation_occurrences",
          introducedByMigrationId: 36,
          treatment: "require_empty",
        },
        {
          tableName:
            "free_agent_draft_nomination_queue",
          introducedByMigrationId: 30,
          treatment: "require_empty",
        },
        {
          tableName: "free_agent_draft_player_allocations",
          introducedByMigrationId: 25,
          treatment: "require_empty",
        },
        {
          tableName:
            "free_agent_draft_readiness_attempts",
          introducedByMigrationId: 31,
          treatment: "require_empty",
        },
        {
          tableName:
            "free_agent_draft_readiness_corrective_requeues",
          introducedByMigrationId: 33,
          treatment: "require_empty",
        },
        {
          tableName:
            "free_agent_draft_readiness_operations",
          introducedByMigrationId: 30,
          treatment: "require_empty",
        },
        {
          tableName:
            "free_agent_draft_readiness_retry_receipts",
          introducedByMigrationId: 31,
          treatment: "require_empty",
        },
        {
          tableName: "free_agent_draft_recoveries",
          introducedByMigrationId: 25,
          treatment: "require_empty",
        },
        {
          tableName:
            "free_agent_draft_recovery_action_command_results",
          introducedByMigrationId: 39,
          treatment: "require_empty",
        },
        {
          tableName: "free_agent_draft_rollovers",
          introducedByMigrationId: 25,
          treatment: "require_empty",
        },
        {
          tableName: "free_agent_draft_schedule_recoveries",
          introducedByMigrationId: 30,
          treatment: "require_empty",
        },
        {
          tableName:
            "free_agent_draft_schedule_recovery_jobs",
          introducedByMigrationId: 30,
          treatment: "require_empty",
        },
        {
          tableName:
            "free_agent_draft_schedule_recovery_matchups",
          introducedByMigrationId: 30,
          treatment: "require_empty",
        },
        {
          tableName:
            "free_agent_draft_schedule_recovery_weeks",
          introducedByMigrationId: 30,
          treatment: "require_empty",
        },
        {
          tableName:
            "free_agent_draft_setup_exemptions",
          introducedByMigrationId: 23,
          treatment: "require_empty",
        },
        {
          tableName: "free_agent_draft_teams",
          introducedByMigrationId: 24,
          treatment: "require_empty",
        },
        {
          tableName: "free_agent_drafts",
          introducedByMigrationId: 24,
          treatment: "require_empty",
        },
        {
          tableName:
            "matchup_roster_game_exclusion_sets",
          introducedByMigrationId: 30,
          treatment: "require_empty",
        },
        {
          tableName:
            "matchup_roster_game_exclusions",
          introducedByMigrationId: 30,
          treatment: "require_empty",
        },
        {
          tableName: "matchup_schedule_command_results",
          introducedByMigrationId: 30,
          treatment: "require_empty",
        },
        {
          tableName: "matchup_schedule_job_bindings",
          introducedByMigrationId: 30,
          treatment: "require_empty",
        },
        {
          tableName:
            "nhl_game_state_observation_snapshots",
          introducedByMigrationId: 30,
          treatment: "require_empty",
        },
        {
          tableName: "nhl_game_state_observations",
          introducedByMigrationId: 30,
          treatment: "require_empty",
        },
        {
          tableName: "outbox_event_audiences",
          introducedByMigrationId: 27,
          treatment: "require_empty",
        },
        {
          tableName: "player_game_stat_observations",
          introducedByMigrationId: 30,
          treatment: "require_empty",
        },
        {
          tableName: "season_matchup_schedule_generations",
          introducedByMigrationId: 30,
          treatment: "require_empty",
        },
        {
          tableName: "season_rollover_attempts",
          introducedByMigrationId: 30,
          treatment: "require_empty",
        },
        {
          tableName: "season_rollover_items",
          introducedByMigrationId: 29,
          treatment: "require_empty",
        },
        {
          tableName: "season_rollover_occurrences",
          introducedByMigrationId: 30,
          treatment: "require_empty",
        },
        {
          tableName: "season_rollovers",
          introducedByMigrationId: 23,
          treatment: "require_empty",
        },
        {
          tableName: "stat_refresh_player_game_coverage_entries",
          introducedByMigrationId: 30,
          treatment: "require_empty",
        },
        {
          tableName: "stat_refresh_player_game_sets",
          introducedByMigrationId: 30,
          treatment: "require_empty",
        },
      ]
    );
    assert.equal(RESET_V1_POST_RESET_TABLE_POLICY.length, 50);
    assert.equal(classifiedTables.length, 132);
    assert.equal(new Set(classifiedTables).size, 132);
    assert.deepEqual(
      [...classifiedTables].sort(),
      [...catalogTables].sort()
    );
    assert.equal(assertPolicyCatalogCoverage(), true);
    assert.deepEqual(
      fs.readFileSync(MANIFEST_PATH),
      manifestBytesBefore
    );
  });

  test("fails closed for unclassified, duplicate, or overlapping post-reset tables", () => {
    assert.throws(() => {
      assertPolicyCatalogCoverage({
        repositoryCatalog: [
          ...REPOSITORY_CATALOG,
          { tableName: "unclassified_table" },
        ],
      });
    }, /classify every repository table exactly once/i);

    assert.throws(() => {
      assertPolicyCatalogCoverage({
        postResetPolicy: [
          ...RESET_V1_POST_RESET_TABLE_POLICY,
          RESET_V1_POST_RESET_TABLE_POLICY[0],
        ],
      });
    }, /classify every repository table exactly once/i);

    assert.throws(() => {
      assertPolicyCatalogCoverage({
        postResetPolicy: [
          {
            tableName: "seasons",
            introducedByMigrationId: 23,
            treatment: "require_empty",
          },
          RESET_V1_POST_RESET_TABLE_POLICY[1],
        ],
      });
    }, /classify every repository table exactly once/i);
  });

  test("rejects checksum and exact-policy tampering", () => {
    const checksumTamper = clone(createResetManifest());
    checksumTamper.omissionFamilies[0].reason = "changed";
    assert.throws(
      () =>
        validateResetManifest(
          checksumTamper,
          VALID_CONTEXT
        ),
      assertResetManifestError(
        RESET_MANIFEST_ERROR_CODES.checksumMismatch
      )
    );

    const mutations = [
      (manifest) => {
        manifest.omissionFamilies[0].familyId =
          "all_old_data";
      },
      (manifest) => {
        manifest.omissionFamilies[0].targetTables = ["*"];
      },
      (manifest) => {
        manifest.omissionFamilies[0].selectionRule =
          "assume_old";
      },
      (manifest) => {
        manifest.omissionFamilies[0].countTreatment =
          "ignore_count";
      },
      (manifest) => {
        manifest.omissionFamilies[0].reason = "broadened";
      },
      (manifest) => {
        manifest.approval.authority = "unknown";
      },
      (manifest) => {
        manifest.protectedFamilies.pop();
      },
      (manifest) => {
        manifest.omissionFamilies[0].targetTables = [
          "players",
        ];
      },
      (manifest) => {
        manifest.omissionFamilies[1].targetTables.reverse();
      },
    ];

    for (const mutate of mutations) {
      const manifest = clone(createResetManifest());
      mutate(manifest);
      resign(manifest);
      assert.throws(
        () => validateResetManifest(manifest, VALID_CONTEXT),
        assertResetManifestError(
          RESET_MANIFEST_ERROR_CODES.policyMismatch
        )
      );
    }
  });

  test("rejects malformed families, duplicate items, and extra fields", () => {
    const duplicateFamily = clone(createResetManifest());
    duplicateFamily.protectedFamilies[0].familyId =
      duplicateFamily.omissionFamilies[0].familyId;
    resign(duplicateFamily);

    const duplicateTable = clone(createResetManifest());
    duplicateTable.omissionFamilies[0].targetTables.push(
      "seasons"
    );
    resign(duplicateTable);

    const extraField = clone(createResetManifest());
    extraField.resetEverything = true;
    resign(extraField);

    for (const manifest of [
      duplicateFamily,
      duplicateTable,
      extraField,
    ]) {
      assert.throws(
        () => validateResetManifest(manifest, VALID_CONTEXT),
        assertResetManifestError(
          RESET_MANIFEST_ERROR_CODES.shapeInvalid
        )
      );
    }
  });

  test("requires the approved operating mode and source-bundle version", () => {
    const manifest = createResetManifest();

    assert.throws(
      () =>
        validateResetManifest(manifest, {
          ...VALID_CONTEXT,
          operatingMode: "NORMAL",
        }),
      assertResetManifestError(
        RESET_MANIFEST_ERROR_CODES.operatingModeMismatch
      )
    );
    assert.throws(
      () =>
        validateResetManifest(manifest, {
          ...VALID_CONTEXT,
          sourceBundleManifestVersion: 2,
        }),
      assertResetManifestError(
        RESET_MANIFEST_ERROR_CODES.sourceVersionMismatch
      )
    );
    assert.throws(
      () => validateResetManifest(manifest),
      assertResetManifestError(
        RESET_MANIFEST_ERROR_CODES.argumentInvalid
      )
    );
  });

  test("rejects malformed and noncanonical manifest files", (t) => {
    const temporaryRoot = createTemporaryRoot(
      t,
      "hundo-leago-m2-07-files-"
    );
    const malformedPath = path.join(
      temporaryRoot,
      "malformed.json"
    );
    const noncanonicalPath = path.join(
      temporaryRoot,
      "noncanonical.json"
    );
    fs.writeFileSync(malformedPath, "{", "utf8");
    fs.writeFileSync(
      noncanonicalPath,
      ` ${serializeResetManifest(createResetManifest())}`,
      "utf8"
    );

    assert.throws(
      () =>
        loadAndValidateResetManifest({
          manifestPath: malformedPath,
          ...VALID_CONTEXT,
        }),
      assertResetManifestError(
        RESET_MANIFEST_ERROR_CODES.parseFailed
      )
    );
    assert.throws(
      () =>
        loadAndValidateResetManifest({
          manifestPath: noncanonicalPath,
          ...VALID_CONTEXT,
        }),
      assertResetManifestError(
        RESET_MANIFEST_ERROR_CODES.noncanonical
      )
    );
  });

  test("returns defensive immutable results and keeps policy constants isolated", () => {
    const input = clone(createResetManifest());
    const validated = validateResetManifest(
      input,
      VALID_CONTEXT
    );

    assert.equal(Object.isFrozen(validated), true);
    assert.equal(
      Object.isFrozen(validated.omissionFamilies),
      true
    );
    assert.equal(
      Object.isFrozen(
        validated.omissionFamilies[0].targetTables
      ),
      true
    );

    input.omissionFamilies[0].familyId = "mutated_after";
    validated.omissionFamilies[0].familyId = "mutated_result";
    const next = createResetManifest();

    assert.equal(
      validated.omissionFamilies[0].familyId,
      "season_1_season_containers"
    );
    assert.equal(
      next.omissionFamilies[0].familyId,
      "season_1_season_containers"
    );
  });

  test("CLI requires explicit context and emits a content-free validation summary", () => {
    assert.deepEqual(
      parseArguments([
        "--manifest",
        MANIFEST_PATH,
        "--operating-mode",
        "OFFSEASON_RESET",
        "--source-bundle-version",
        "1",
      ]),
      {
        manifestPath: MANIFEST_PATH,
        operatingMode: "OFFSEASON_RESET",
        sourceBundleManifestVersion: 1,
      }
    );
    assert.throws(
      () => parseArguments([]),
      assertResetManifestError(
        RESET_MANIFEST_ERROR_CODES.argumentInvalid
      )
    );
    assert.throws(
      () =>
        parseArguments([
          "--manifest",
          MANIFEST_PATH,
          "--manifest",
          MANIFEST_PATH,
        ]),
      assertResetManifestError(
        RESET_MANIFEST_ERROR_CODES.argumentInvalid
      )
    );

    const lines = [];
    const summary = runResetManifestValidationCommand({
      argv: [
        "--manifest",
        MANIFEST_PATH,
        "--operating-mode",
        "OFFSEASON_RESET",
        "--source-bundle-version",
        "1",
      ],
      output: {
        log(line) {
          lines.push(line);
        },
      },
    });
    assert.equal(summary.status, "valid");
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), summary);
    assert.doesNotMatch(lines[0], /targetTables|reason|players/);

    const spawned = spawnSync(
      process.execPath,
      [
        VALIDATION_SCRIPT,
        "--manifest",
        MANIFEST_PATH,
        "--operating-mode",
        "OFFSEASON_RESET",
        "--source-bundle-version",
        "1",
      ],
      {
        cwd: ROOT_DIRECTORY,
        encoding: "utf8",
      }
    );
    assert.equal(spawned.status, 0, spawned.stderr);
    assert.equal(JSON.parse(spawned.stdout).status, "valid");
  });

  test("validation leaves protected JSON and repository data artifacts unchanged", () => {
    const filesToFingerprint = [
      ...presentProtectedJsonFiles(),
      path.relative(ROOT_DIRECTORY, MANIFEST_PATH),
    ];
    const hashesBefore = fingerprintFiles(filesToFingerprint);
    const artifactsBefore = collectRepositoryDataArtifacts();

    loadAndValidateResetManifest({
      manifestPath: MANIFEST_PATH,
      ...VALID_CONTEXT,
    });

    assert.deepEqual(
      fingerprintFiles(filesToFingerprint),
      hashesBefore
    );
    assert.deepEqual(
      collectRepositoryDataArtifacts(),
      artifactsBefore
    );
    assert.deepEqual(artifactsBefore, []);
  });
});
