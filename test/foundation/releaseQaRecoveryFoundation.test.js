const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createReleaseQaRuntime,
} = require("../../src/operations/release/createReleaseQaRuntime");
const {
  ReleaseQaRecoveryError,
  rehearseReleaseQaRecovery,
} = require("../../src/operations/release/rehearseReleaseQaRecovery");
const {
  ReleaseQaRecoveryArgumentError,
  runReleaseQaRecoveryCommand,
} = require("../../scripts/rehearse-m7-release-qa-recovery");

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(ROOT_DIRECTORY, "database", "migrations");
const FRONTEND_ORIGIN = "http://127.0.0.1:5173";
const PASSWORD = "M7 Recovery Fixture Password 2026!";

async function runtime(t) {
  const started = await createReleaseQaRuntime({
    frontendOrigin: FRONTEND_ORIGIN,
    leagueWriteMode: "open",
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    password: PASSWORD,
    port: 0,
  });
  t.after(() => started.close());
  return started;
}

test("M7 recovery rehearsal verifies encrypted backup, failure control, clean restore, and cleanup", async (t) => {
  const started = await runtime(t);
  const report = await rehearseReleaseQaRecovery({
    databasePath: started.databasePath,
    fixtureManifestChecksum: started.fixtureManifest.manifestChecksum,
    temporaryRoot: started.temporaryRoot,
  });
  assert.equal(report.backup, "encrypted-private-object-verified");
  assert.equal(report.cleanRestore, "verified-to-new-path");
  assert.equal(report.objectCount, 2);
  assert.equal(report.sourceDatabase, "unchanged");
  assert.equal(report.wrongKeyRestore, "rejected-without-target");
  assert.match(report.reportChecksum, /^[0-9a-f]{64}$/);
  assert.equal(
    fs.existsSync(path.join(started.temporaryRoot, "recovery-rehearsal")),
    false
  );
});

test("M7 recovery rehearsal refuses databases outside its owned release-QA root", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "not-release-qa-"));
  const databasePath = path.join(root, "m7-release-qa.sqlite3");
  fs.writeFileSync(databasePath, "not a database");
  try {
    await assert.rejects(
      rehearseReleaseQaRecovery({
        databasePath,
        fixtureManifestChecksum: "a".repeat(64),
        temporaryRoot: root,
      }),
      (error) => error instanceof ReleaseQaRecoveryError &&
        error.code === "RELEASE_QA_RECOVERY_PATH_UNSAFE"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("M7 recovery command requires a password, emits a safe report, and closes the runtime", async () => {
  await assert.rejects(
    runReleaseQaRecoveryCommand({ env: {} }),
    (error) => error instanceof ReleaseQaRecoveryArgumentError
  );
  let closed = false;
  const output = [];
  const fixtureChecksum = "b".repeat(64);
  const report = Object.freeze({
    reportVersion: 1,
    reportChecksum: "c".repeat(64),
  });
  await runReleaseQaRecoveryCommand({
    env: { M7_RELEASE_QA_PASSWORD: PASSWORD },
    createRuntime: async (options) => {
      assert.equal(options.password, PASSWORD);
      assert.equal(options.port, 0);
      return {
        databasePath: "C:\\fake\\m7-release-qa.sqlite3",
        fixtureManifest: { manifestChecksum: fixtureChecksum },
        temporaryRoot: "C:\\fake",
        async close() { closed = true; },
      };
    },
    rehearseRecovery: async (options) => {
      assert.equal(options.fixtureManifestChecksum, fixtureChecksum);
      return report;
    },
    output: { log: (value) => output.push(value) },
  });
  assert.equal(closed, true);
  assert.equal(output.length, 1);
  assert.equal(output[0].includes(PASSWORD), false);
});
