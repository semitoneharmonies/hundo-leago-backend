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
  test("validates the canonical committed policy and classifies every application table exactly once", () => {
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
    const policyTables = [
      ...omittedTables,
      ...protectedTables,
    ];
    const catalogTables = REPOSITORY_CATALOG.map(
      (definition) => definition.tableName
    );

    assert.equal(manifest.manifestId, "2026-season-1-reset-v1");
    assert.equal(manifest.omissionFamilies.length, 12);
    assert.equal(manifest.protectedFamilies.length, 9);
    assert.equal(manifest.neverImportFamilies.length, 1);
    assert.equal(policyTables.length, 76);
    assert.equal(new Set(policyTables).size, 76);
    assert.deepEqual(
      [...policyTables].sort(),
      [...catalogTables].sort()
    );
    assert.deepEqual(
      fs.readFileSync(MANIFEST_PATH),
      manifestBytesBefore
    );
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
