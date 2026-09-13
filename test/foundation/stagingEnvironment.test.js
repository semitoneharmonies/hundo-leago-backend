const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { describe, test } = require("node:test");

const {
  STAGING_DESCRIPTOR_ERROR_CODES,
  descriptorSha256,
  loadAndValidateStagingDescriptor,
  serializeStagingDescriptor,
  validateStagingDescriptor,
} = require("../../src/infrastructure/database/stagingEnvironment");
const {
  parseArguments,
} = require("../../scripts/db-validate-staging");

const ROOT = path.resolve(__dirname, "..", "..");
const EXAMPLE = path.join(
  ROOT,
  "database",
  "staging-environment.example.json"
);

function readExample() {
  return JSON.parse(fs.readFileSync(EXAMPLE, "utf8"));
}

function hasCode(code) {
  return (error) => error?.code === code;
}

describe("M2-11 isolated staging descriptor", () => {
  test("loads the canonical safe example and reports a stable digest", () => {
    const first = loadAndValidateStagingDescriptor({
      descriptorPath: EXAMPLE,
    });
    const second = loadAndValidateStagingDescriptor({
      descriptorPath: EXAMPLE,
    });
    assert.equal(first.environment, "staging");
    assert.equal(first.applicationAuthority, "json");
    assert.equal(first.sqliteApplicationAuthorityEnabled, false);
    assert.equal(first.productionStorageAccessible, false);
    assert.equal(first.productionSecretsAccessible, false);
    assert.equal(descriptorSha256(first), descriptorSha256(second));
    assert.equal(Object.isFrozen(first.resourceIds), true);
  });

  test("rejects production references, resource reuse, and secret-shaped additions", () => {
    const descriptor = readExample();
    descriptor.resourceIds.disk = "hundo-production-disk";
    assert.throws(
      () => validateStagingDescriptor(descriptor),
      hasCode(STAGING_DESCRIPTOR_ERROR_CODES.isolationInvalid)
    );

    const reused = readExample();
    reused.resourceIds.disk = reused.resourceIds.service;
    assert.throws(
      () => validateStagingDescriptor(reused),
      hasCode(STAGING_DESCRIPTOR_ERROR_CODES.isolationInvalid)
    );

    const secretValue = readExample();
    secretValue.secretValue = "must-never-be-accepted";
    assert.throws(
      () => validateStagingDescriptor(secretValue),
      hasCode(STAGING_DESCRIPTOR_ERROR_CODES.shapeInvalid)
    );
  });

  test("rejects relative, escaping, overlapping, and mixed-style paths", () => {
    const relative = readExample();
    relative.paths.reports = "migration-reports";
    assert.throws(
      () => validateStagingDescriptor(relative),
      hasCode(STAGING_DESCRIPTOR_ERROR_CODES.pathUnsafe)
    );

    const escape = readExample();
    escape.paths.backups = "/srv/elsewhere/staging-backups";
    assert.throws(
      () => validateStagingDescriptor(escape),
      hasCode(STAGING_DESCRIPTOR_ERROR_CODES.pathUnsafe)
    );

    const overlap = readExample();
    overlap.paths.reports = overlap.paths.sourceBundles;
    assert.throws(
      () => validateStagingDescriptor(overlap),
      hasCode(STAGING_DESCRIPTOR_ERROR_CODES.pathUnsafe)
    );

    const mixed = readExample();
    mixed.paths.database =
      "C:\\hundo-leago-staging\\database\\hundo.sqlite3";
    assert.throws(
      () => validateStagingDescriptor(mixed),
      hasCode(STAGING_DESCRIPTOR_ERROR_CODES.pathUnsafe)
    );
  });

  test("rejects an application-authority switch or production access", () => {
    for (const mutation of [
      (value) => { value.applicationAuthority = "sqlite"; },
      (value) => { value.sqliteApplicationAuthorityEnabled = true; },
      (value) => { value.productionStorageAccessible = true; },
      (value) => { value.productionSecretsAccessible = true; },
    ]) {
      const descriptor = readExample();
      mutation(descriptor);
      assert.throws(
        () => validateStagingDescriptor(descriptor),
        hasCode(STAGING_DESCRIPTOR_ERROR_CODES.authorityUnsafe)
      );
    }
  });

  test("requires canonical files and exact CLI arguments", (t) => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "hundo-m2-11-")
    );
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const noncanonical = path.join(root, "descriptor.json");
    fs.writeFileSync(
      noncanonical,
      `${serializeStagingDescriptor(readExample())} `,
      "utf8"
    );
    assert.throws(
      () => loadAndValidateStagingDescriptor({
        descriptorPath: noncanonical,
      }),
      hasCode(STAGING_DESCRIPTOR_ERROR_CODES.noncanonical)
    );
    assert.deepEqual(parseArguments(["--descriptor", EXAMPLE]), {
      descriptorPath: EXAMPLE,
    });
    assert.throws(
      () => parseArguments(["--descriptor", EXAMPLE, "--extra", "x"]),
      hasCode(STAGING_DESCRIPTOR_ERROR_CODES.argumentInvalid)
    );
  });

  test("CLI validates the committed example without exposing secrets", () => {
    const result = spawnSync(process.execPath, [
      path.join(ROOT, "scripts", "db-validate-staging.js"),
      "--descriptor",
      EXAMPLE,
    ], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "valid");
    assert.equal(output.applicationAuthority, "json");
    assert.equal(output.sqliteApplicationAuthorityEnabled, false);
    assert.equal(Object.hasOwn(output, "secretReferences"), false);
  });
});
