const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, test } = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const BLUEPRINT_PATH = path.join(ROOT, "render.yaml");
const PACKAGE_PATH = path.join(ROOT, "package.json");
const STAGING_ROOT = "/opt/render/project/data/hundo-staging";
const LIVE_CAPABILITY_COMMANDS = Object.freeze([
  Object.freeze([
    "data:discover:sportsdataio-live:staging",
    "node scripts/discover-sportsdataio-live-capability.js",
  ]),
  Object.freeze([
    "data:check:sportsdataio-live:staging",
    "node scripts/check-sportsdataio-live-capability.js",
  ]),
  Object.freeze([
    "data:verify:sportsdataio-live:staging",
    "node scripts/verify-sportsdataio-live-capability-artifact.js",
  ]),
]);

function loadBlueprint() {
  return JSON.parse(fs.readFileSync(BLUEPRINT_PATH, "utf8"));
}

function loadPackageManifest() {
  return JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
}

function environmentByKey(service) {
  return new Map(service.envVars.map((entry) => [entry.key, entry]));
}

describe("M2 gate staging Render blueprint", () => {
  test("defines one manually deployed staging service and dedicated disk", () => {
    const blueprint = loadBlueprint();

    assert.deepEqual(Object.keys(blueprint), ["services"]);
    assert.equal(blueprint.services.length, 1);

    const [service] = blueprint.services;
    assert.equal(service.type, "web");
    assert.equal(service.runtime, "node");
    assert.equal(service.name, "hundo-leago-backend-staging");
    assert.equal(
      service.repo,
      "https://github.com/semitoneharmonies/hundo-leago-backend"
    );
    assert.equal(service.branch, "staging");
    assert.equal(service.plan, "starter");
    assert.equal(service.numInstances, 1);
    assert.equal(service.autoDeployTrigger, "off");
    assert.equal(
      service.buildCommand,
      "npm ci && npm run check && npm test"
    );
    assert.equal(service.startCommand, "npm start");
    assert.equal(service.healthCheckPath, "/api/v1/health/ready");
    assert.deepEqual(service.disk, {
      name: "hundo-leago-staging-disk",
      mountPath: "/opt/render/project/data",
      sizeGB: 5,
    });
  });

  test("keeps all live capability commands exact and outside every deployment lifecycle", () => {
    const packageManifest = loadPackageManifest();
    const blueprint = loadBlueprint();
    const [service] = blueprint.services;

    for (const [scriptName, command] of LIVE_CAPABILITY_COMMANDS) {
      assert.equal(packageManifest.scripts[scriptName], command);
      assert.deepEqual(
        Object.entries(packageManifest.scripts).filter(
          ([, candidate]) => candidate.includes(command.slice(5))
        ),
        [[scriptName, command]]
      );
    }
    assert.equal(Object.hasOwn(service, "preDeployCommand"), false);
    assert.equal(Object.hasOwn(blueprint, "jobs"), false);
    assert.deepEqual(
      blueprint.services.filter((entry) => entry.type !== "web"),
      []
    );

    for (const field of ["buildCommand", "startCommand"]) {
      for (const [scriptName, command] of LIVE_CAPABILITY_COMMANDS) {
        assert.equal(
          service[field].includes(scriptName),
          false,
          `${field} must not run ${scriptName}`
        );
        assert.equal(
          service[field].includes(command.slice(5)),
          false,
          `${field} must not run ${command}`
        );
      }
    }

    const serializedBlueprint = JSON.stringify(blueprint);
    for (const forbidden of LIVE_CAPABILITY_COMMANDS.flatMap(
      ([scriptName, command]) => [scriptName, command, command.slice(5)]
    )) {
      assert.equal(
        serializedBlueprint.includes(forbidden),
        false,
        `${forbidden} must not run from the Render blueprint`
      );
    }
  });

  test("uses staging-only database, compatibility, migration, and backup paths", () => {
    const [service] = loadBlueprint().services;
    const environment = environmentByKey(service);
    const pathKeys = [
      "DATABASE_PATH",
      "BACKUP_LOCAL_DIR",
      "DATA_DIR",
      "LEAGUE_FILE",
      "PLAYERS_FILE",
      "STATS_FILE",
      "STATS_LOCK_FILE",
      "SNAPSHOT_DIR",
      "BACKUPS_DIR",
      "MIGRATION_SOURCE_ROOT",
      "MIGRATION_REPORT_ROOT",
      "SQLITE_BACKUP_ROOT",
      "SPORTSDATAIO_NHL_LIVE_CAPABILITY_ARTIFACT",
    ];

    for (const key of pathKeys) {
      const value = environment.get(key)?.value;
      assert.equal(
        value?.startsWith(`${STAGING_ROOT}/`),
        true,
        `${key} must stay under the staging root`
      );
      assert.equal(
        value.includes("/opt/render/project/data/hundo/"),
        false,
        `${key} must not use the production compatibility root`
      );
    }

    assert.equal(
      environment.get("BACKUP_OBJECT_PREFIX")?.value,
      "hundo-leago/staging/"
    );
    assert.equal(environment.get("APP_ENV")?.value, "staging");
    assert.equal(environment.get("NODE_ENV")?.value, "production");
  });

  test("starts the provider probe with writes, jobs, FAD routes, and email quiesced", () => {
    const [service] = loadBlueprint().services;
    const environment = environmentByKey(service);

    for (const key of [
      "STAGING_MAINTENANCE_HOLD",
      "SCHEDULED_JOBS_ENABLED",
      "FREE_AGENT_DRAFT_ROUTES_ENABLED",
      "ACCOUNT_EMAIL_DELIVERY_ENABLED",
      "DEBUG_ROUTES_ENABLED",
      "BACKUP_SCHEDULE_ENABLED",
      "MATCHUPS_ENABLED",
      "SNAPSHOTS_ENABLED",
      "AUCTIONS_ENABLED",
      "MATCHUPS_DEBUG",
    ]) {
      assert.equal(environment.get(key)?.value, "false", `${key} must be false`);
    }

    assert.equal(environment.get("LEAGUE_WRITE_MODE")?.value, "closed");
    assert.equal(
      environment.get("SESSION_COOKIE_SAME_SITE")?.value,
      "lax"
    );

    assert.equal(environment.get("EMAIL_DELIVERY_MODE")?.value, "capture");
    for (const key of [
      "EMAIL_FROM",
      "EMAIL_REPLY_TO",
      "RESEND_API_KEY",
      "STAGING_EMAIL_RECIPIENT_ALLOWLIST",
    ]) {
      assert.equal(environment.has(key), false, `${key} must be absent`);
    }
    assert.deepEqual(
      service.envVars.filter((entry) =>
        /(?:FAD|FREE_AGENT_DRAFT)/u.test(entry.key)
      ),
      [{
        key: "FREE_AGENT_DRAFT_ROUTES_ENABLED",
        value: "false",
      }]
    );
  });

  test("uses the exact initial live-provider probe configuration without a manifest override", () => {
    const [service] = loadBlueprint().services;
    const environment = environmentByKey(service);

    assert.deepEqual(
      environment.get("SPORTSDATAIO_NHL_LIVE_MODE"),
      {
        key: "SPORTSDATAIO_NHL_LIVE_MODE",
        value: "probe",
      }
    );
    assert.deepEqual(
      environment.get("SPORTSDATAIO_NHL_LIVE_API_KEY"),
      {
        key: "SPORTSDATAIO_NHL_LIVE_API_KEY",
        sync: false,
      }
    );
    assert.deepEqual(
      environment.get(
        "SPORTSDATAIO_NHL_LIVE_CAPABILITY_SECRET"
      ),
      {
        key: "SPORTSDATAIO_NHL_LIVE_CAPABILITY_SECRET",
        generateValue: true,
      }
    );
    assert.deepEqual(
      environment.get(
        "SPORTSDATAIO_NHL_LIVE_CAPABILITY_KEY_VERSION"
      ),
      {
        key: "SPORTSDATAIO_NHL_LIVE_CAPABILITY_KEY_VERSION",
        value: "1",
      }
    );
    assert.deepEqual(
      environment.get(
        "SPORTSDATAIO_NHL_LIVE_CAPABILITY_ARTIFACT"
      ),
      {
        key: "SPORTSDATAIO_NHL_LIVE_CAPABILITY_ARTIFACT",
        value:
          `${STAGING_ROOT}/provider-capability/` +
          "sportsdataio-live-v1.json",
      }
    );
    assert.equal(
      environment.has(
        "SPORTSDATAIO_NHL_LIVE_PROBE_MANIFEST"
      ),
      false
    );
    assert.equal(
      service.envVars.some((entry) =>
        entry.key.includes("PROBE_MANIFEST")
      ),
      false
    );
  });

  test("contains secret references or generated values, never secret literals", () => {
    const [service] = loadBlueprint().services;
    const environment = environmentByKey(service);
    const generatedSecretKeys = [
      "RATE_LIMIT_KEY_SECRET",
      "AUDIT_METADATA_SECRET",
      "ACTION_TOKEN_DELIVERY_KEY",
      "STATS_REFRESH_TOKEN",
      "SPORTSDATAIO_NHL_LIVE_CAPABILITY_SECRET",
    ];
    const providerSecretKeys = [
      "SPORTSDATAIO_NHL_API_KEY",
      "SPORTSDATAIO_NHL_LIVE_API_KEY",
      "BACKUP_OBJECT_ACCESS_KEY_ID",
      "BACKUP_OBJECT_SECRET_ACCESS_KEY",
      "BACKUP_ENCRYPTION_KEY",
    ];

    for (const key of generatedSecretKeys) {
      assert.deepEqual(environment.get(key), {
        key,
        generateValue: true,
      });
    }

    for (const key of providerSecretKeys) {
      assert.deepEqual(environment.get(key), {
        key,
        sync: false,
      });
    }

    assert.equal(
      service.envVars.some(
        (entry) =>
          /(?:SECRET|TOKEN|ACCESS_KEY)/.test(entry.key) &&
          Object.hasOwn(entry, "value")
      ),
      false
    );
  });

  test("requires deployment-specific identity and browser origins at setup", () => {
    const [service] = loadBlueprint().services;
    const environment = environmentByKey(service);

    for (const key of [
      "APP_BUILD_ID",
      "FRONTEND_BUILD_ID",
      "PUBLIC_FRONTEND_ORIGIN",
      "FRONTEND_ORIGINS",
      "BACKUP_OBJECT_ENDPOINT",
      "BACKUP_OBJECT_REGION",
      "BACKUP_OBJECT_BUCKET",
    ]) {
      assert.deepEqual(environment.get(key), {
        key,
        sync: false,
      });
    }
    assert.equal(
      environment.get("APP_ENVIRONMENT_ID")?.value,
      "test:release-qa"
    );
    assert.equal(
      environment.get("DATABASE_ID")?.value,
      "m7-release-qa-fixture"
    );
    assert.equal(
      environment.get("PERSISTENT_DATA_ROOT")?.value,
      "/opt/render/project/data/hundo-staging"
    );
    assert.equal(environment.get("CURRENT_SEASON_LABEL")?.value, "2026");
    assert.equal(
      environment.get("CURRENT_NHL_SEASON_KEY")?.value,
      "20262027"
    );
    assert.equal(
      environment.get("SPORTSDATAIO_NHL_API_ORIGIN")?.value,
      "https://api.sportsdata.io/api/nhl/fantasy"
    );
    assert.equal(
      environment.get(
        "SPORTSDATAIO_NHL_LAST_SEASON_START_YEAR"
      )?.value,
      "2025"
    );
    assert.equal(
      environment.get(
        "SPORTSDATAIO_NHL_LIVE_API_ORIGIN"
      )?.value,
      "https://api.sportsdata.io"
    );
    assert.equal(environment.has("NHL_API_ORIGIN"), false);
  });
});
