const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { describe, test } = require("node:test");

const {
  SOURCE_BUNDLE_FILE_NAME,
  SOURCE_INVENTORY_ERROR_CODES,
  calculateBundleChecksum,
  calculateSourceBundleId,
  canonicalize,
  inventorySourceBundle,
  verifySourceBundle,
} = require("../../src/infrastructure/migration/sourceInventory");
const {
  parseArguments,
  runInventoryCommand,
} = require("../../scripts/db-inventory");

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const INVENTORY_SCRIPT = path.join(
  ROOT_DIRECTORY,
  "scripts",
  "db-inventory.js"
);

function createTemporaryRoot(t, prefix) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), prefix)
  );
  t.after(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  return temporaryRoot;
}

function sha256File(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function sourceFingerprint(filePath) {
  const stat = fs.statSync(filePath, { bigint: true });
  return {
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    sha256: sha256File(filePath),
  };
}

function readManifest(bundleDirectory) {
  return JSON.parse(
    fs.readFileSync(
      path.join(bundleDirectory, SOURCE_BUNDLE_FILE_NAME),
      "utf8"
    )
  );
}

function writeManifest(bundleDirectory, manifest) {
  fs.writeFileSync(
    path.join(bundleDirectory, SOURCE_BUNDLE_FILE_NAME),
    `${canonicalize(manifest)}\n`,
    "utf8"
  );
}

function refreshManifestIdentifiers(manifest) {
  manifest.sourceBundleId =
    calculateSourceBundleId(manifest);
  const {
    bundleChecksum: ignored,
    ...withoutChecksum
  } = manifest;
  manifest.bundleChecksum =
    calculateBundleChecksum(withoutChecksum);
}

function createSimpleBundle(
  temporaryRoot,
  name,
  {
    capturedAtMs = 1_000,
    content = '{"records":[1,2]}\n',
  } = {}
) {
  const sourcePath = path.join(
    temporaryRoot,
    `${name}-source.json`
  );
  fs.writeFileSync(sourcePath, content, "utf8");
  const outputDirectory = path.join(
    temporaryRoot,
    `${name}-bundle`
  );
  const result = inventorySourceBundle({
    sources: [{ label: "source", path: sourcePath }],
    outputDirectory,
    capturedAtMs,
    applicationBuildId: "test-build",
    sourceGitCommit: "0123456789abcdef",
  });
  return {
    ...result,
    sourcePath,
  };
}

function assertInventoryError(code) {
  return (error) => error?.code === code;
}

function temporaryBuildPaths(
  temporaryRoot,
  outputName
) {
  const prefix = `.${outputName}.building-`;
  return fs
    .readdirSync(temporaryRoot)
    .filter((name) => name.startsWith(prefix));
}

function collectRepositoryBundleArtifacts() {
  const artifacts = [];
  const skippedDirectories = new Set([".git", "node_modules"]);

  function walk(directoryPath) {
    for (const entry of fs.readdirSync(directoryPath, {
      withFileTypes: true,
    })) {
      if (entry.isDirectory() && skippedDirectories.has(entry.name)) {
        continue;
      }
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
      } else if (entry.name === SOURCE_BUNDLE_FILE_NAME) {
        artifacts.push(path.relative(ROOT_DIRECTORY, entryPath));
      }
    }
  }

  walk(ROOT_DIRECTORY);
  return artifacts.sort();
}

describe("M2-06 source inventory and bundle hashing", () => {
  test("copies named file and directory sources exactly with safe structural metadata", (t) => {
    const temporaryRoot = createTemporaryRoot(
      t,
      "hundo-leago-m2-06-capture-"
    );
    const leaguePath = path.join(
      temporaryRoot,
      "league-state.json"
    );
    const supportPath = path.join(temporaryRoot, "support");
    const nestedPath = path.join(supportPath, "nested");
    fs.mkdirSync(nestedPath, { recursive: true });
    fs.writeFileSync(
      leaguePath,
      JSON.stringify({
        teams: [{ id: "one" }, { id: "two" }],
        settings: { timezone: "UTC" },
        trades: [],
      }),
      "utf8"
    );
    const playersPath = path.join(
      nestedPath,
      "players.json"
    );
    fs.writeFileSync(
      playersPath,
      JSON.stringify([
        { id: 1 },
        { id: 2 },
        { id: 3 },
      ]),
      "utf8"
    );
    const malformedPath = path.join(
      supportPath,
      "bad.json"
    );
    fs.writeFileSync(malformedPath, '{"broken":', "utf8");
    const notePath = path.join(supportPath, "note.txt");
    fs.writeFileSync(notePath, "safe note\n", "utf8");

    const before = new Map(
      [leaguePath, playersPath, malformedPath, notePath].map(
        (filePath) => [
          filePath,
          sourceFingerprint(filePath),
        ]
      )
    );
    const outputDirectory = path.join(
      temporaryRoot,
      "bundle"
    );
    const result = inventorySourceBundle({
      sources: [
        { label: "support", path: supportPath },
        { label: "league", path: leaguePath },
      ],
      outputDirectory,
      capturedAtMs: 1_234_567,
      applicationBuildId: "build-1",
      sourceGitCommit: "abcdef",
    });
    const { manifest } = result;

    assert.equal(result.bundleDirectory, outputDirectory);
    assert.equal(manifest.manifestVersion, 1);
    assert.equal(manifest.capturedAtMs, 1_234_567);
    assert.equal(manifest.applicationBuildId, "build-1");
    assert.equal(manifest.sourceGitCommit, "abcdef");
    assert.match(
      manifest.sourceBundleId,
      /^source-bundle-v1-[a-f0-9]{64}$/
    );
    assert.match(manifest.bundleChecksum, /^[a-f0-9]{64}$/);
    assert.deepEqual(
      manifest.sources.map(({ label }) => label),
      ["league", "support"]
    );

    const leagueSource = manifest.sources[0];
    assert.equal(
      leagueSource.absolutePath,
      fs.realpathSync.native(leaguePath)
    );
    assert.equal(leagueSource.kind, "file");
    assert.equal(leagueSource.files.length, 1);
    assert.equal(
      leagueSource.files[0].copiedPath,
      "files/league/league-state.json"
    );
    assert.equal(
      leagueSource.files[0].sha256,
      before.get(leaguePath).sha256
    );
    assert.deepEqual(leagueSource.files[0].json, {
      parseStatus: "parsed",
      topLevelShape: "object",
      topLevelArrayCount: null,
      directArrayCounts: {
        teams: 2,
        trades: 0,
      },
      errorCode: null,
    });

    const supportSource = manifest.sources[1];
    assert.equal(supportSource.kind, "directory");
    assert.deepEqual(
      supportSource.files.map(
        ({ sourceRelativePath }) => sourceRelativePath
      ),
      ["bad.json", "nested/players.json", "note.txt"]
    );
    assert.deepEqual(supportSource.files[0].json, {
      parseStatus: "failed",
      topLevelShape: "unknown",
      topLevelArrayCount: null,
      directArrayCounts: {},
      errorCode: "JSON_PARSE_FAILED",
    });
    assert.deepEqual(supportSource.files[1].json, {
      parseStatus: "parsed",
      topLevelShape: "array",
      topLevelArrayCount: 3,
      directArrayCounts: {},
      errorCode: null,
    });
    assert.deepEqual(supportSource.files[2].json, {
      parseStatus: "not_applicable",
      topLevelShape: "not_json",
      topLevelArrayCount: null,
      directArrayCounts: {},
      errorCode: null,
    });

    for (const [sourcePath, fingerprint] of before) {
      assert.deepEqual(
        sourceFingerprint(sourcePath),
        fingerprint
      );
    }
    for (const source of manifest.sources) {
      for (const file of source.files) {
        const copiedPath = path.join(
          outputDirectory,
          ...file.copiedPath.split("/")
        );
        const originalPath =
          source.label === "league"
            ? leaguePath
            : path.join(
                supportPath,
                ...file.sourceRelativePath.split("/")
              );
        assert.deepEqual(
          fs.readFileSync(copiedPath),
          fs.readFileSync(originalPath)
        );
      }
    }

    assert.deepEqual(verifySourceBundle({
      bundleDirectory: outputDirectory,
    }), {
      sourceBundleId: manifest.sourceBundleId,
      bundleChecksum: manifest.bundleChecksum,
      sourceCount: 2,
      fileCount: 4,
      byteSize: manifest.sources.reduce(
        (total, source) => total + source.byteSize,
        0
      ),
    });
    assert.equal(
      fs.readFileSync(
        path.join(
          outputDirectory,
          SOURCE_BUNDLE_FILE_NAME
        ),
        "utf8"
      ),
      `${canonicalize(manifest)}\n`
    );
    assert.deepEqual(
      temporaryBuildPaths(temporaryRoot, "bundle"),
      []
    );
  });

  test("derives a deterministic content ID independent of capture time and changes it with source bytes", (t) => {
    const temporaryRoot = createTemporaryRoot(
      t,
      "hundo-leago-m2-06-determinism-"
    );
    const sourcePath = path.join(temporaryRoot, "source.json");
    fs.writeFileSync(
      sourcePath,
      '{"records":[1,2,3]}\n',
      "utf8"
    );

    const first = inventorySourceBundle({
      sources: [{ label: "source", path: sourcePath }],
      outputDirectory: path.join(temporaryRoot, "first"),
      capturedAtMs: 1_000,
    });
    const second = inventorySourceBundle({
      sources: [{ label: "source", path: sourcePath }],
      outputDirectory: path.join(temporaryRoot, "second"),
      capturedAtMs: 2_000,
    });

    assert.equal(
      first.manifest.sourceBundleId,
      second.manifest.sourceBundleId
    );
    assert.notEqual(
      first.manifest.bundleChecksum,
      second.manifest.bundleChecksum
    );

    fs.writeFileSync(
      sourcePath,
      '{"records":[1,2,3,4]}\n',
      "utf8"
    );
    const changed = inventorySourceBundle({
      sources: [{ label: "source", path: sourcePath }],
      outputDirectory: path.join(temporaryRoot, "changed"),
      capturedAtMs: 2_000,
    });
    assert.notEqual(
      changed.manifest.sourceBundleId,
      first.manifest.sourceBundleId
    );
  });

  test("fails closed for copied-byte, manifest, size, shape, ID, checksum, and extra-file tampering", (t) => {
    const temporaryRoot = createTemporaryRoot(
      t,
      "hundo-leago-m2-06-tamper-"
    );

    const copiedTamper = createSimpleBundle(
      temporaryRoot,
      "copied"
    );
    fs.appendFileSync(
      path.join(
        copiedTamper.bundleDirectory,
        "files",
        "source",
        "copied-source.json"
      ),
      "tamper",
      "utf8"
    );
    assert.throws(
      () => {
        verifySourceBundle({
          bundleDirectory: copiedTamper.bundleDirectory,
        });
      },
      assertInventoryError(
        SOURCE_INVENTORY_ERROR_CODES.bundleInvalid
      )
    );

    const manifestTamper = createSimpleBundle(
      temporaryRoot,
      "manifest"
    );
    const changedCapture = readManifest(
      manifestTamper.bundleDirectory
    );
    changedCapture.capturedAtMs += 1;
    writeManifest(
      manifestTamper.bundleDirectory,
      changedCapture
    );
    assert.throws(
      () => {
        verifySourceBundle({
          bundleDirectory: manifestTamper.bundleDirectory,
        });
      },
      assertInventoryError(
        SOURCE_INVENTORY_ERROR_CODES.bundleInvalid
      )
    );

    const sizeTamper = createSimpleBundle(
      temporaryRoot,
      "size"
    );
    const changedSize = readManifest(
      sizeTamper.bundleDirectory
    );
    changedSize.sources[0].files[0].byteSize += 1;
    refreshManifestIdentifiers(changedSize);
    writeManifest(sizeTamper.bundleDirectory, changedSize);
    assert.throws(
      () => {
        verifySourceBundle({
          bundleDirectory: sizeTamper.bundleDirectory,
        });
      },
      assertInventoryError(
        SOURCE_INVENTORY_ERROR_CODES.bundleInvalid
      )
    );

    const shapeTamper = createSimpleBundle(
      temporaryRoot,
      "shape"
    );
    const changedShape = readManifest(
      shapeTamper.bundleDirectory
    );
    changedShape.sources[0].files[0].json.directArrayCounts
      .records = 99;
    refreshManifestIdentifiers(changedShape);
    writeManifest(shapeTamper.bundleDirectory, changedShape);
    assert.throws(
      () => {
        verifySourceBundle({
          bundleDirectory: shapeTamper.bundleDirectory,
        });
      },
      assertInventoryError(
        SOURCE_INVENTORY_ERROR_CODES.bundleInvalid
      )
    );

    const idTamper = createSimpleBundle(
      temporaryRoot,
      "id"
    );
    const changedId = readManifest(idTamper.bundleDirectory);
    changedId.sourceBundleId =
      "source-bundle-v1-" + "0".repeat(64);
    const {
      bundleChecksum: ignored,
      ...changedIdWithoutChecksum
    } = changedId;
    changedId.bundleChecksum =
      calculateBundleChecksum(changedIdWithoutChecksum);
    writeManifest(idTamper.bundleDirectory, changedId);
    assert.throws(
      () => {
        verifySourceBundle({
          bundleDirectory: idTamper.bundleDirectory,
        });
      },
      assertInventoryError(
        SOURCE_INVENTORY_ERROR_CODES.bundleInvalid
      )
    );

    const checksumTamper = createSimpleBundle(
      temporaryRoot,
      "checksum"
    );
    const changedChecksum = readManifest(
      checksumTamper.bundleDirectory
    );
    changedChecksum.bundleChecksum = "0".repeat(64);
    writeManifest(
      checksumTamper.bundleDirectory,
      changedChecksum
    );
    assert.throws(
      () => {
        verifySourceBundle({
          bundleDirectory: checksumTamper.bundleDirectory,
        });
      },
      assertInventoryError(
        SOURCE_INVENTORY_ERROR_CODES.bundleInvalid
      )
    );

    const extraTamper = createSimpleBundle(
      temporaryRoot,
      "extra"
    );
    fs.writeFileSync(
      path.join(extraTamper.bundleDirectory, "unexpected.txt"),
      "unexpected",
      "utf8"
    );
    assert.throws(
      () => {
        verifySourceBundle({
          bundleDirectory: extraTamper.bundleDirectory,
        });
      },
      assertInventoryError(
        SOURCE_INVENTORY_ERROR_CODES.bundleInvalid
      )
    );
  });

  test("rejects missing, malformed, duplicate, overlapping, existing-output, and unsafe sources before copying", (t) => {
    const temporaryRoot = createTemporaryRoot(
      t,
      "hundo-leago-m2-06-paths-"
    );
    const sourceDirectory = path.join(
      temporaryRoot,
      "source"
    );
    fs.mkdirSync(sourceDirectory);
    const sourceFile = path.join(
      sourceDirectory,
      "source.json"
    );
    fs.writeFileSync(sourceFile, "[]\n", "utf8");

    assert.throws(
      () => {
        inventorySourceBundle({
          sources: [],
          outputDirectory: path.join(
            temporaryRoot,
            "empty"
          ),
          capturedAtMs: 1,
        });
      },
      assertInventoryError(
        SOURCE_INVENTORY_ERROR_CODES.argumentInvalid
      )
    );
    assert.throws(
      () => {
        inventorySourceBundle({
          sources: [
            {
              label: "missing",
              path: path.join(temporaryRoot, "missing.json"),
            },
          ],
          outputDirectory: path.join(
            temporaryRoot,
            "missing"
          ),
          capturedAtMs: 1,
        });
      },
      assertInventoryError(
        SOURCE_INVENTORY_ERROR_CODES.argumentInvalid
      )
    );
    assert.throws(
      () => {
        inventorySourceBundle({
          sources: [
            { label: "Bad Label", path: sourceFile },
          ],
          outputDirectory: path.join(
            temporaryRoot,
            "bad-label"
          ),
          capturedAtMs: 1,
        });
      },
      assertInventoryError(
        SOURCE_INVENTORY_ERROR_CODES.argumentInvalid
      )
    );
    assert.throws(
      () => {
        inventorySourceBundle({
          sources: [
            { label: "same", path: sourceFile },
            { label: "same", path: sourceDirectory },
          ],
          outputDirectory: path.join(
            temporaryRoot,
            "duplicate-label"
          ),
          capturedAtMs: 1,
        });
      },
      assertInventoryError(
        SOURCE_INVENTORY_ERROR_CODES.argumentInvalid
      )
    );
    assert.throws(
      () => {
        inventorySourceBundle({
          sources: [
            { label: "first", path: sourceFile },
            { label: "second", path: sourceFile },
          ],
          outputDirectory: path.join(
            temporaryRoot,
            "duplicate-source"
          ),
          capturedAtMs: 1,
        });
      },
      assertInventoryError(
        SOURCE_INVENTORY_ERROR_CODES.pathUnsafe
      )
    );
    assert.throws(
      () => {
        inventorySourceBundle({
          sources: [
            { label: "parent", path: sourceDirectory },
            { label: "child", path: sourceFile },
          ],
          outputDirectory: path.join(
            temporaryRoot,
            "overlapping-sources"
          ),
          capturedAtMs: 1,
        });
      },
      assertInventoryError(
        SOURCE_INVENTORY_ERROR_CODES.pathUnsafe
      )
    );
    assert.throws(
      () => {
        inventorySourceBundle({
          sources: [
            { label: "source", path: sourceDirectory },
          ],
          outputDirectory: path.join(
            sourceDirectory,
            "bundle"
          ),
          capturedAtMs: 1,
        });
      },
      assertInventoryError(
        SOURCE_INVENTORY_ERROR_CODES.pathUnsafe
      )
    );

    const existingOutput = path.join(
      temporaryRoot,
      "existing"
    );
    fs.mkdirSync(existingOutput);
    assert.throws(
      () => {
        inventorySourceBundle({
          sources: [{ label: "source", path: sourceFile }],
          outputDirectory: existingOutput,
          capturedAtMs: 1,
        });
      },
      assertInventoryError(
        SOURCE_INVENTORY_ERROR_CODES.outputExists
      )
    );
    assert.throws(
      () => {
        inventorySourceBundle({
          sources: [{ label: "source", path: sourceFile }],
          outputDirectory: path.join(
            temporaryRoot,
            "missing-parent",
            "bundle"
          ),
          capturedAtMs: 1,
        });
      },
      assertInventoryError(
        SOURCE_INVENTORY_ERROR_CODES.argumentInvalid
      )
    );

    const symlinkPath = path.join(
      temporaryRoot,
      "source-link.json"
    );
    try {
      fs.symlinkSync(sourceFile, symlinkPath, "file");
      assert.throws(
        () => {
          inventorySourceBundle({
            sources: [
              { label: "link", path: symlinkPath },
            ],
            outputDirectory: path.join(
              temporaryRoot,
              "link-bundle"
            ),
            capturedAtMs: 1,
          });
        },
        assertInventoryError(
          SOURCE_INVENTORY_ERROR_CODES.pathUnsafe
        )
      );
    } catch (error) {
      if (!["EPERM", "EACCES"].includes(error?.code)) {
        throw error;
      }
    }

    assert.equal(
      fs.existsSync(
        path.join(temporaryRoot, "duplicate-source")
      ),
      false
    );
    assert.deepEqual(
      fs.readdirSync(temporaryRoot).filter((name) => {
        return name.includes(".building-");
      }),
      []
    );
  });

  test("detects source changes and removes only owned temporary output after copy or rename failure", (t) => {
    const temporaryRoot = createTemporaryRoot(
      t,
      "hundo-leago-m2-06-cleanup-"
    );
    const sourcePath = path.join(
      temporaryRoot,
      "source.json"
    );
    fs.writeFileSync(sourcePath, '{"records":[]}\n', "utf8");

    const copyOutput = path.join(
      temporaryRoot,
      "copy-failure"
    );
    const beforeCopyFailure = sourceFingerprint(sourcePath);
    assert.throws(
      () => {
        inventorySourceBundle({
          sources: [{ label: "source", path: sourcePath }],
          outputDirectory: copyOutput,
          capturedAtMs: 1,
          copyFile() {
            throw new Error("simulated copy failure");
          },
        });
      },
      assertInventoryError(
        SOURCE_INVENTORY_ERROR_CODES.operationFailed
      )
    );
    assert.deepEqual(
      sourceFingerprint(sourcePath),
      beforeCopyFailure
    );
    assert.equal(fs.existsSync(copyOutput), false);
    assert.deepEqual(
      temporaryBuildPaths(temporaryRoot, "copy-failure"),
      []
    );

    const renameOutput = path.join(
      temporaryRoot,
      "rename-failure"
    );
    assert.throws(
      () => {
        inventorySourceBundle({
          sources: [{ label: "source", path: sourcePath }],
          outputDirectory: renameOutput,
          capturedAtMs: 1,
          renameDirectory() {
            throw new Error("simulated rename failure");
          },
        });
      },
      assertInventoryError(
        SOURCE_INVENTORY_ERROR_CODES.operationFailed
      )
    );
    assert.equal(fs.existsSync(renameOutput), false);
    assert.deepEqual(
      temporaryBuildPaths(
        temporaryRoot,
        "rename-failure"
      ),
      []
    );

    const changedOutput = path.join(
      temporaryRoot,
      "source-changed"
    );
    assert.throws(
      () => {
        inventorySourceBundle({
          sources: [{ label: "source", path: sourcePath }],
          outputDirectory: changedOutput,
          capturedAtMs: 1,
          copyFile(source, target) {
            fs.copyFileSync(source, target);
            fs.appendFileSync(source, "changed", "utf8");
          },
        });
      },
      assertInventoryError(
        SOURCE_INVENTORY_ERROR_CODES.sourceChanged
      )
    );
    assert.equal(fs.existsSync(changedOutput), false);
    assert.deepEqual(
      temporaryBuildPaths(
        temporaryRoot,
        "source-changed"
      ),
      []
    );
  });

  test("requires explicit CLI arguments and creates a verifiable synthetic bundle without exposing contents", (t) => {
    const temporaryRoot = createTemporaryRoot(
      t,
      "hundo-leago-m2-06-cli-"
    );
    const sourcePath = path.join(
      temporaryRoot,
      "source.json"
    );
    const privateMarker = "private-value-not-for-summary";
    fs.writeFileSync(
      sourcePath,
      JSON.stringify({ records: [privateMarker] }),
      "utf8"
    );

    assert.throws(
      () => parseArguments([]),
      assertInventoryError(
        SOURCE_INVENTORY_ERROR_CODES.argumentInvalid
      )
    );
    assert.throws(
      () => {
        parseArguments([
          "--output",
          "one",
          "--output",
          "two",
          "--captured-at-ms",
          "1",
          "--source",
          `source=${sourcePath}`,
        ]);
      },
      assertInventoryError(
        SOURCE_INVENTORY_ERROR_CODES.argumentInvalid
      )
    );
    assert.throws(
      () => {
        parseArguments([
          "--unknown",
          "value",
          "--output",
          "one",
          "--captured-at-ms",
          "1",
          "--source",
          `source=${sourcePath}`,
        ]);
      },
      assertInventoryError(
        SOURCE_INVENTORY_ERROR_CODES.argumentInvalid
      )
    );

    const directOutput = path.join(
      temporaryRoot,
      "direct-bundle"
    );
    const messages = [];
    const directSummary = runInventoryCommand({
      argv: [
        "--output",
        directOutput,
        "--captured-at-ms",
        "1000",
        "--source",
        `source=${sourcePath}`,
        "--build",
        "test-build",
      ],
      output: {
        log(message) {
          messages.push(message);
        },
      },
    });
    assert.equal(directSummary.status, "created");
    assert.equal(messages.length, 1);
    assert.equal(messages[0].includes(privateMarker), false);
    verifySourceBundle({ bundleDirectory: directOutput });

    const processOutput = path.join(
      temporaryRoot,
      "process-bundle"
    );
    const success = spawnSync(
      process.execPath,
      [
        INVENTORY_SCRIPT,
        "--output",
        processOutput,
        "--captured-at-ms",
        "2000",
        "--source",
        `source=${sourcePath}`,
        "--git-commit",
        "abcdef",
      ],
      {
        cwd: ROOT_DIRECTORY,
        encoding: "utf8",
      }
    );
    assert.equal(success.status, 0, success.stderr);
    const processSummary = JSON.parse(success.stdout.trim());
    assert.equal(processSummary.status, "created");
    assert.equal(success.stdout.includes(privateMarker), false);
    assert.equal(success.stderr, "");
    verifySourceBundle({ bundleDirectory: processOutput });

    const missing = spawnSync(
      process.execPath,
      [INVENTORY_SCRIPT],
      {
        cwd: ROOT_DIRECTORY,
        encoding: "utf8",
      }
    );
    assert.equal(missing.status, 1);
    assert.equal(missing.stdout, "");
    assert.equal(
      JSON.parse(missing.stderr.trim()).error.code,
      SOURCE_INVENTORY_ERROR_CODES.argumentInvalid
    );
    assert.equal(missing.stderr.includes(privateMarker), false);
  });

  test("leaves no source bundle or database artifact in the repository", () => {
    assert.deepEqual(collectRepositoryBundleArtifacts(), []);
    const databaseArtifacts = [];
    const databasePattern =
      /\.(?:sqlite3?|db)(?:-(?:wal|shm|journal))?$/i;

    function walk(directoryPath) {
      for (const entry of fs.readdirSync(directoryPath, {
        withFileTypes: true,
      })) {
        if (
          entry.isDirectory() &&
          [".git", "node_modules"].includes(entry.name)
        ) {
          continue;
        }
        const entryPath = path.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
          walk(entryPath);
        } else if (databasePattern.test(entry.name)) {
          databaseArtifacts.push(
            path.relative(ROOT_DIRECTORY, entryPath)
          );
        }
      }
    }

    walk(ROOT_DIRECTORY);
    assert.deepEqual(databaseArtifacts, []);
  });
});
