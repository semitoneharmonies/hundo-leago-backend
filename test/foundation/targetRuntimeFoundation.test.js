const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");
const express = require("express");

const {
  TARGET_ENDPOINTS,
  TARGET_ROUTER_KEYS,
  createTargetApplication,
  createTargetRuntime,
  openTargetRuntime,
  selectTargetRouterKey,
} = require("../../src/bootstrap/createTargetRuntime");
const {
  buildMatchupOccurrenceKey,
} = require("../../src/domain/matchups/matchupJobPolicy");
const {
  createEmptySocketRelated,
  createSocketEventEnvelope,
} = require("../../src/domain/leagues/socketInvalidation");
const {
  createSecurityFoundations,
} = require("../../src/bootstrap/createSecurityFoundations");
const {
  createTargetHttpServer,
} = require("../../src/bootstrap/createTargetHttpServer");
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  applyMigrations,
  discoverMigrations,
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  PROVIDER_NAME: SPORTSDATAIO_PLAYER_IDENTITY_PROVIDER_NAME,
} = require("../../src/infrastructure/sportsdataio/SportsDataIoNhlAdapter");
const {
  MINIMUM_CURRENT_SEASON_PLAYER_COUNT,
  PROVIDER_NAME: SPORTSDATAIO_LIVE_PROVIDER_NAME,
} = require("../../src/infrastructure/sportsdataio/SportsDataIoLiveNhlAdapter");
const {
  createScryptPasswordHasher,
} = require("../../src/infrastructure/security/createScryptPasswordHasher");
const {
  createTestAccount,
} = require("../helpers/createTestAccount");
const {
  seedFixture,
} = require("../../src/operations/release/createReleaseQaFixture");
const {
  fixtureId,
} = require("../../src/operations/release/releaseQaFixtureContract");
const {
  createResetMigrationReportFixture,
} = require(
  "../helpers/createResetMigrationReportFixture"
);

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const NOW_MS = Date.parse("2026-07-22T12:00:00.000Z");
const PUBLIC_FRONTEND_ORIGIN = "https://staging.hundoleago.com";
const SPORTSDATAIO_LIVE_API_KEY =
  "target-runtime-live-provider-secret";
const TRACKED_COMPATIBILITY_FILES = Object.freeze([
  "league.json",
  "league_with_meta.json",
  "players.json",
]);

function securityEnv({ configured = true } = {}) {
  return {
    APP_ENV: configured ? "staging" : "local",
    NODE_ENV: configured ? "production" : "development",
    ...(configured ? { APP_BUILD_ID: "m3-19-test-build" } : {}),
    LOG_LEVEL: configured ? "info" : "debug",
    ...(configured
      ? { SESSION_COOKIE_SAME_SITE: "lax" }
      : {}),
    PUBLIC_FRONTEND_ORIGIN: configured
      ? PUBLIC_FRONTEND_ORIGIN
      : "http://localhost:5173",
    FRONTEND_ORIGINS: configured
      ? PUBLIC_FRONTEND_ORIGIN
      : "http://localhost:5173",
    EMAIL_DELIVERY_MODE: "capture",
    ...(configured
      ? {
          RATE_LIMIT_KEY_SECRET:
            "m3-19-rate-limit-secret-material-0123456789",
          AUDIT_METADATA_SECRET:
            "m3-19-audit-secret-material-9876543210",
          ACTION_TOKEN_DELIVERY_KEY: Buffer.alloc(32, 0x5a).toString(
            "base64url"
          ),
        }
      : {}),
  };
}

function foundations(options) {
  return createSecurityFoundations({
    env: securityEnv(options),
    now: () => NOW_MS,
    loggerSink() {},
  });
}

function createDatabase(t, { migrated = true } = {}) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-m3-19-runtime-")
  );
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "target.sqlite3"),
    environment: "test",
  });
  if (migrated) {
    migrateDatabase({
      database: connection.database,
      migrationsDirectory: MIGRATIONS_DIRECTORY,
      applicationBuildId: "m3-19-test-build",
      now: () => NOW_MS,
    });
  }
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  return connection.database;
}

function createOwnedTargetRuntime(t, prefix) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const databasePath = path.join(temporaryRoot, "target.sqlite3");
  const seedConnection = openDatabase({
    databasePath,
    environment: "test",
  });
  migrateDatabase({
    database: seedConnection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m3-19-test-build",
    now: () => NOW_MS,
  });
  seedConnection.database.close();
  const runtime = openTargetRuntime({
    ...runtimeOptions(undefined),
    databasePath,
    environment: "test",
  });
  t.after(() => {
    runtime.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  return runtime;
}

function runtimeOptions(database, overrides = {}) {
  return {
    database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    securityFoundations: foundations(),
    currentSeason: {
      label: "2026",
      nhlSeasonKey: "20262027",
    },
    networkSourceResolver() {
      return "198.51.100.0/24";
    },
    ...overrides,
  };
}

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function verifiedSportsDataIoLiveNhl({
  apiKey = SPORTSDATAIO_LIVE_API_KEY,
  verification = Object.freeze({
    status: "verified",
    evidenceId: uuid(80_001),
    evidenceSha256: "b".repeat(64),
    issuedAtMs: NOW_MS - 1_000,
    expiresAtMs: NOW_MS - 1_000 + 86_400_000,
    verifiedAtMs: NOW_MS,
  }),
  ...overrides
} = {}) {
  const descriptor = {
    mode: "required",
    enabled: true,
    verified: true,
    origin: "https://api.sportsdata.io",
    nhlSeasonKey: "20262027",
    capabilityKeyVersion: 7,
    probeNhlSeasonKey: "20252026",
    probeKind: "historical_offseason",
    probeManifestSha256: "c".repeat(64),
    verification,
    ...overrides,
  };
  Object.defineProperty(descriptor, "apiKey", {
    configurable: false,
    enumerable: false,
    value: apiKey,
    writable: false,
  });
  return Object.freeze(descriptor);
}

function seedComposedMatchupOccurrenceScope(database, base) {
  const startsAtMs = NOW_MS - 7_200_000;
  const scope = Object.freeze({
    leagueId: uuid(base),
    seasonId: uuid(base + 1),
    weekId: uuid(base + 2),
    scheduleOperationId: uuid(base + 3),
    userId: uuid(base + 4),
    membershipId: uuid(base + 5),
    teamId: uuid(base + 6),
    assignmentId: uuid(base + 7),
    readinessId: uuid(base + 8),
    fadId: uuid(base + 9),
    runId: uuid(base + 10),
    bindingId: uuid(base + 11),
    replacementScheduleOperationId: uuid(base + 12),
    startsAtMs,
    baselineAtMs: startsAtMs + 3_600_000,
    locksAtMs: startsAtMs + 10_800_000,
    endsAtMs: startsAtMs + 604_800_000,
  });
  database.prepare(`
    INSERT INTO leagues (
      id, name, name_normalized, status, timezone,
      commissioner_membership_id, current_season_id,
      created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, 'active', 'America/Vancouver',
      NULL, NULL, 1, 1, 1)
  `).run(
    scope.leagueId,
    `Occurrence ${base}`,
    `occurrence ${base}`
  );
  database.prepare(`
    INSERT INTO users (
      id, email_normalized, email_display, display_name,
      display_name_normalized, status, created_at_ms,
      updated_at_ms, version
    ) VALUES (?, ?, ?, ?, ?, 'active', 1, 1, 1)
  `).run(
    scope.userId,
    `occurrence-${base}@example.test`,
    `occurrence-${base}@example.test`,
    `Occurrence ${base}`,
    `occurrence ${base}`
  );
  database.prepare(`
    INSERT INTO seasons (
      id, league_id, label, nhl_season_key, status,
      regular_season_starts_at_ms,
      regular_season_ends_at_ms,
      fantasy_playoffs_start_at_ms,
      fantasy_playoffs_end_at_ms,
      created_at_ms, updated_at_ms, version,
      free_agent_draft_completed_at_ms
    ) VALUES (?, ?, '2026-27', '20262027', 'active',
      ?, ?, ?, ?, 1, 1, 1, NULL)
  `).run(
    scope.seasonId,
    scope.leagueId,
    scope.startsAtMs,
    scope.endsAtMs + 20 * 604_800_000,
    scope.endsAtMs + 16 * 604_800_000,
    scope.endsAtMs + 20 * 604_800_000
  );
  database.prepare(`
    INSERT INTO league_memberships (
      id, league_id, user_id, permission_category, status,
      joined_at_ms, ended_at_ms, created_at_ms,
      updated_at_ms, version
    ) VALUES (?, ?, ?, 'commissioner', 'active',
      1, NULL, 1, 1, 1)
  `).run(
    scope.membershipId,
    scope.leagueId,
    scope.userId
  );
  database.prepare(`
    INSERT INTO teams (
      id, league_id, name, name_normalized, status,
      primary_colour, secondary_colour, logo_reference,
      created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, ?, 'active', NULL, NULL, NULL,
      1, 1, 1)
  `).run(
    scope.teamId,
    scope.leagueId,
    `Occurrence Team ${base}`,
    `occurrence team ${base}`
  );
  database.prepare(`
    INSERT INTO team_manager_assignments (
      id, league_id, team_id, user_id, membership_id,
      assigned_by_user_id, replaces_assignment_id, status,
      assigned_at_ms, accepted_at_ms, ended_at_ms, version
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'accepted',
      1, 1, NULL, 1)
  `).run(
    scope.assignmentId,
    scope.leagueId,
    scope.teamId,
    scope.userId,
    scope.membershipId,
    scope.userId
  );
  database.prepare(`
    UPDATE leagues
    SET commissioner_membership_id = ?,
        current_season_id = ?,
        updated_at_ms = 2,
        version = 2
    WHERE id = ?
  `).run(
    scope.membershipId,
    scope.seasonId,
    scope.leagueId
  );
  database.prepare(`
    INSERT INTO matchup_weeks (
      id, league_id, season_id, week_key, sequence,
      starts_at_ms, baseline_at_ms, locks_at_ms,
      ends_at_ms, rolls_over_at_ms, status,
      created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, '2026-W01', 1, ?, ?, ?, ?, ?,
      'scheduled', 3, 3, 1)
  `).run(
    scope.weekId,
    scope.leagueId,
    scope.seasonId,
    scope.startsAtMs,
    scope.baselineAtMs,
    scope.locksAtMs,
    scope.endsAtMs,
    scope.endsAtMs
  );
  database.prepare(`
    INSERT INTO matchup_operations (
      id, league_id, season_id, matchup_week_id,
      matchup_id, actor_user_id, operation_type, status,
      reason, metadata_json, started_at_ms, completed_at_ms
    ) VALUES (?, ?, ?, NULL, NULL, ?, 'schedule_generate',
      'succeeded', NULL, NULL, 3, 4)
  `).run(
    scope.scheduleOperationId,
    scope.leagueId,
    scope.seasonId,
    scope.userId
  );
  database.prepare(`
    INSERT INTO season_matchup_schedule_generations (
      league_id, season_id, schedule_version,
      schedule_operation_id, week_one_matchup_week_id,
      week_one_starts_at_ms, status, created_at_ms,
      superseded_at_ms, version
    ) VALUES (?, ?, 1, ?, ?, ?, 'current', 4, NULL, 1)
  `).run(
    scope.leagueId,
    scope.seasonId,
    scope.scheduleOperationId,
    scope.weekId,
    scope.startsAtMs
  );
  const candidateDeadlineAtMs =
    scope.startsAtMs - 604_800_000;
  const openedAtMs =
    candidateDeadlineAtMs - 200_000_000;
  const readinessOccurrenceKey =
    `fad-readiness:${base}`;
  database.prepare(`
    INSERT INTO free_agent_draft_readiness_operations (
      id, league_id, season_id, readiness_occurrence_key,
      trigger_kind, entry_draft_id, setup_exemption_id,
      job_run_id, status, attempt_count, lease_owner,
      lease_token, lease_expires_at_ms, blockers_json,
      matchup_schedule_version_before,
      matchup_schedule_version_after, schedule_recovery_id,
      created_fad_id, reminder_job_run_id, deadline_job_run_id,
      cards_opened_activity_id, cards_opened_outbox_event_id,
      started_at_ms, next_retry_at_ms, terminal_at_ms,
      created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, ?, 'no_draft_inaugural', NULL, NULL,
      NULL, 'running', 1, NULL, NULL, NULL, '[]', NULL,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL,
      NULL, ?, ?, 1)
  `).run(
    scope.readinessId,
    scope.leagueId,
    scope.seasonId,
    readinessOccurrenceKey,
    openedAtMs,
    openedAtMs,
    openedAtMs
  );
  database.prepare(`
    INSERT INTO free_agent_drafts (
      id, league_id, season_id, readiness_operation_id,
      readiness_occurrence_key, first_matchup_week_id,
      current_competition_first_matchup_week_id,
      schedule_recovery_id, participating_team_count, status,
      setup_path, entry_draft_id, setup_exemption_id,
      prior_season_rollover_id, no_draft_reason,
      opening_authority, opened_at_ms, help_opens_at_ms,
      candidate_deadline_at_ms, first_matchup_starts_at_ms,
      deadline_locked_at_ms, allocation_completed_at_ms,
      completed_at_ms, created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1, 'cards_open',
      'no_draft_inaugural', NULL, NULL, NULL,
      'inaugural test path', 'system', ?, ?, ?, ?, NULL,
      NULL, NULL, ?, ?, 1)
  `).run(
    scope.fadId,
    scope.leagueId,
    scope.seasonId,
    scope.readinessId,
    readinessOccurrenceKey,
    scope.weekId,
    scope.weekId,
    openedAtMs,
    candidateDeadlineAtMs - 172_800_000,
    candidateDeadlineAtMs,
    scope.startsAtMs,
    openedAtMs,
    openedAtMs
  );
  return scope;
}

function completeComposedMatchupOccurrenceFad(database, scope) {
  const completedAtMs = scope.startsAtMs - 1;
  const deadlineAtMs =
    scope.startsAtMs - 604_800_000;
  database.prepare(`
    UPDATE free_agent_drafts
    SET status = 'completed',
        deadline_locked_at_ms = ?,
        allocation_completed_at_ms = ?,
        completed_at_ms = ?,
        updated_at_ms = ?,
        version = version + 1
    WHERE league_id = ? AND id = ?
  `).run(
    deadlineAtMs,
    deadlineAtMs + 1,
    completedAtMs,
    completedAtMs,
    scope.leagueId,
    scope.fadId
  );
  database.prepare(`
    UPDATE seasons
    SET free_agent_draft_completed_at_ms = ?,
        updated_at_ms = ?,
        version = version + 1
    WHERE league_id = ? AND id = ?
  `).run(
    completedAtMs,
    completedAtMs,
    scope.leagueId,
    scope.seasonId
  );
}

function scheduleComposedBaselineOccurrence(runtime, scope) {
  const jobType = "matchup:baseline";
  const command = Object.freeze({
    runId: scope.runId,
    bindingId: scope.bindingId,
    leagueId: scope.leagueId,
    seasonId: scope.seasonId,
    jobType,
    occurrenceKey: buildMatchupOccurrenceKey({
      jobType,
      leagueId: scope.leagueId,
      seasonId: scope.seasonId,
      weekId: scope.weekId,
      scheduleOperationId:
        scope.scheduleOperationId,
      scheduleVersion: 1,
      scheduledForMs: scope.baselineAtMs,
    }),
    weekId: scope.weekId,
    scheduleOperationId: scope.scheduleOperationId,
    scheduleVersion: 1,
    owningMatchupId: null,
    scheduledForMs: scope.baselineAtMs,
    nowMs: 5,
  });
  runtime.repositories.matchupJobs.schedule(command);
  return command;
}

function instrumentComposedMatchupClaim(database) {
  const transaction = database.transaction.bind(database);
  let afterClaim = null;
  database.transaction = (operation) => {
    const composedTransaction = transaction(operation);
    const invoke = (mode, args) => {
      const result = mode === null
        ? composedTransaction(...args)
        : composedTransaction[mode](...args);
      if (
        afterClaim !== null &&
        result?.acquired === true &&
        result?.occurrenceExecution
      ) {
        const callback = afterClaim;
        afterClaim = null;
        callback();
      }
      return result;
    };
    const wrapped = (...args) => invoke(null, args);
    for (const mode of ["deferred", "immediate", "exclusive"]) {
      wrapped[mode] = (...args) => invoke(mode, args);
    }
    return wrapped;
  };
  return Object.freeze({
    afterNextClaim(callback) {
      assert.equal(afterClaim, null);
      assert.equal(typeof callback, "function");
      afterClaim = callback;
    },
    restore() {
      database.transaction = transaction;
    },
  });
}

function supersedeComposedMatchupGeneration(database, scope) {
  const changedAtMs = NOW_MS - 1;
  database.transaction(() => {
    assert.equal(
      database.prepare(`
      UPDATE season_matchup_schedule_generations
        SET status = 'superseded',
            superseded_at_ms = ?,
            version = version + 1
        WHERE league_id = ? AND season_id = ?
          AND status = 'current'
      `).run(
        changedAtMs,
        scope.leagueId,
        scope.seasonId
      ).changes,
      1
    );
    assert.equal(
      database.prepare(`
        UPDATE matchup_weeks
        SET starts_at_ms = ?, baseline_at_ms = ?,
            locks_at_ms = ?, ends_at_ms = ?,
            rolls_over_at_ms = ?, updated_at_ms = ?,
            version = version + 1
        WHERE league_id = ? AND season_id = ? AND id = ?
      `).run(
        scope.startsAtMs,
        scope.baselineAtMs,
        scope.locksAtMs,
        scope.endsAtMs,
        scope.endsAtMs,
        changedAtMs,
        scope.leagueId,
        scope.seasonId,
        scope.weekId
      ).changes,
      1
    );
    database.prepare(`
      INSERT INTO matchup_operations (
        id, league_id, season_id, matchup_week_id,
        matchup_id, actor_user_id, operation_type, status,
        reason, metadata_json, started_at_ms, completed_at_ms
      ) VALUES (?, ?, ?, NULL, NULL, ?, 'schedule_generate',
        'succeeded', NULL, NULL, ?, ?)
    `).run(
      scope.replacementScheduleOperationId,
      scope.leagueId,
      scope.seasonId,
      scope.userId,
      changedAtMs - 1,
      changedAtMs
    );
    database.prepare(`
      INSERT INTO season_matchup_schedule_generations (
        league_id, season_id, schedule_version,
        schedule_operation_id, week_one_matchup_week_id,
        week_one_starts_at_ms, status, created_at_ms,
        superseded_at_ms, version
      ) VALUES (?, ?, 2, ?, ?, ?, 'current', ?, NULL, 1)
    `).run(
      scope.leagueId,
      scope.seasonId,
      scope.replacementScheduleOperationId,
      scope.weekId,
      scope.startsAtMs,
      changedAtMs
    );
  }).immediate();
}

function seedLiveStatisticsCatalog(database) {
  const providerTotals = Array.from(
    { length: MINIMUM_CURRENT_SEASON_PLAYER_COUNT },
    (_, index) => ({
      PlayerID: 100_000 + index,
      Season: 2027,
      SeasonType: 1,
      Games: 0,
      Goals: 0,
      Assists: 0,
    })
  );
  const insertPlayer = database.prepare(
    "INSERT INTO players " +
      "(id, first_name, last_name, full_name, birth_date, status, " +
      "created_at_ms, updated_at_ms, version) " +
      "VALUES (@id, 'Player', @lastName, @fullName, '2000-01-01', " +
      "'active', @nowMs, @nowMs, 1)"
  );
  const insertExternalId = database.prepare(
    "INSERT INTO player_external_ids " +
      "(id, player_id, provider, external_value, created_at_ms) " +
      "VALUES (@id, @playerId, @provider, @externalValue, @nowMs)"
  );
  database.transaction(() => {
    for (let index = 0; index < providerTotals.length; index += 1) {
      const playerId = uuid(20_000 + index);
      insertPlayer.run({
        id: playerId,
        lastName: String(index + 1),
        fullName: `Player ${index + 1}`,
        nowMs: NOW_MS,
      });
      insertExternalId.run({
        id: uuid(30_000 + index),
        playerId,
        provider: SPORTSDATAIO_PLAYER_IDENTITY_PROVIDER_NAME,
        externalValue: String(providerTotals[index].PlayerID),
        nowMs: NOW_MS,
      });
    }
  }).immediate();
  return providerTotals;
}

function seedPlayerGameCoverageScope(
  database,
  { base, playerId, weekStatus }
) {
  const leagueId = uuid(base);
  const seasonId = uuid(base + 1);
  const teamId = uuid(base + 2);
  const weekId = uuid(base + 3);
  database.prepare(
    "INSERT INTO leagues " +
      "(id, name, name_normalized, status, timezone, created_at_ms, " +
      "updated_at_ms, version) VALUES (?, ?, ?, 'active', " +
      "'America/Vancouver', 1, 1, 1)"
  ).run(
    leagueId,
    `Coverage ${base}`,
    `coverage ${base}`
  );
  database.prepare(
    "INSERT INTO seasons " +
      "(id, league_id, label, nhl_season_key, status, created_at_ms, " +
      "updated_at_ms, version) VALUES (?, ?, ?, '20262027', " +
      "'active', 1, 1, 1)"
  ).run(seasonId, leagueId, `Season ${base}`);
  database.prepare(
    "INSERT INTO teams " +
      "(id, league_id, name, name_normalized, status, created_at_ms, " +
      "updated_at_ms, version) VALUES (?, ?, ?, ?, 'active', 1, 1, 1)"
  ).run(
    teamId,
    leagueId,
    `Coverage Team ${base}`,
    `coverage team ${base}`
  );
  database.prepare(
    "INSERT INTO matchup_weeks " +
      "(id, league_id, season_id, week_key, sequence, starts_at_ms, " +
      "baseline_at_ms, locks_at_ms, ends_at_ms, rolls_over_at_ms, " +
      "status, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, 'regular-01', 1, 100, 101, 102, 200, 201, " +
      "?, 1, 1, 1)"
  ).run(weekId, leagueId, seasonId, weekStatus);
  database.prepare(
    "INSERT INTO player_ownerships " +
      "(id, league_id, season_id, player_id, team_id, ownership_kind, " +
      "roster_category, position_group, slot_number, " +
      "acquired_transaction_type, created_at_ms, updated_at_ms, version) " +
      "VALUES (?, ?, ?, ?, ?, 'Rostered', 'Active', 'F', NULL, " +
      "'coverage_test', 1, 1, 1)"
  ).run(uuid(base + 4), leagueId, seasonId, playerId, teamId);
}

function seedTwoLeagueProfileScenario(runtime) {
  const repositories = runtime.repositories.context.repositories;
  const managerUserId = uuid(1101);
  const otherUserId = uuid(1102);
  const visibleLeagueId = uuid(1201);
  const hiddenLeagueId = uuid(1202);
  const managerMembershipId = uuid(1301);
  const otherMembershipId = uuid(1302);
  const teamId = uuid(1401);
  const hiddenTeamId = uuid(1402);

  for (const [id, email, displayName] of [
    [managerUserId, "manager@m3-19.test", "M3 Manager"],
    [otherUserId, "other@m3-19.test", "Other Commissioner"],
  ]) {
    repositories.users.insert({
      id,
      email_normalized: email,
      email_display: email,
      display_name: displayName,
      display_name_normalized: displayName.toLowerCase(),
      status: "active",
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });
  }
  for (const [id, name] of [
    [visibleLeagueId, "Visible League"],
    [hiddenLeagueId, "Hidden League"],
  ]) {
    repositories.leagues.insert({
      id,
      name,
      name_normalized: name.toLowerCase(),
      status: "active",
      timezone: "America/Vancouver",
      commissioner_membership_id: null,
      current_season_id: null,
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });
  }
  repositories.league_memberships.insert({
    id: managerMembershipId,
    league_id: visibleLeagueId,
    user_id: managerUserId,
    permission_category: "manager",
    status: "active",
    joined_at_ms: NOW_MS,
    ended_at_ms: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  repositories.league_memberships.insert({
    id: otherMembershipId,
    league_id: hiddenLeagueId,
    user_id: otherUserId,
    permission_category: "commissioner",
    status: "active",
    joined_at_ms: NOW_MS,
    ended_at_ms: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  repositories.leagues.updateVersioned({
    key: hiddenLeagueId,
    expectedVersion: 1,
    changes: {
      commissioner_membership_id: otherMembershipId,
      updated_at_ms: NOW_MS,
    },
  });
  repositories.teams.insert({
    id: teamId,
    league_id: visibleLeagueId,
    name: "Target Owls",
    name_normalized: "target owls",
    status: "active",
    primary_colour: null,
    secondary_colour: null,
    logo_reference: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  repositories.teams.insert({
    id: hiddenTeamId,
    league_id: hiddenLeagueId,
    name: "Hidden Ravens",
    name_normalized: "hidden ravens",
    status: "active",
    primary_colour: null,
    secondary_colour: null,
    logo_reference: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  repositories.team_manager_assignments.insert({
    id: uuid(1501),
    league_id: visibleLeagueId,
    team_id: teamId,
    user_id: managerUserId,
    membership_id: managerMembershipId,
    assigned_by_user_id: otherUserId,
    status: "accepted",
    assigned_at_ms: NOW_MS,
    accepted_at_ms: NOW_MS,
    ended_at_ms: null,
    version: 1,
  });
  repositories.team_manager_assignments.insert({
    id: uuid(1502),
    league_id: hiddenLeagueId,
    team_id: hiddenTeamId,
    user_id: otherUserId,
    membership_id: otherMembershipId,
    assigned_by_user_id: otherUserId,
    status: "accepted",
    assigned_at_ms: NOW_MS,
    accepted_at_ms: NOW_MS,
    ended_at_ms: null,
    version: 1,
  });
  const session = runtime.services.sessionService.issueForUser({
    userId: managerUserId,
  });
  return Object.freeze({
    hiddenLeagueId,
    hiddenTeamId,
    managerUserId,
    session,
    teamId,
    visibleLeagueId,
  });
}

function seedCommissionerInvitationScenario(runtime) {
  const repositories = runtime.repositories.context.repositories;
  const commissionerUserId = uuid(2101);
  const invitedUserId = uuid(2102);
  const leagueId = uuid(2201);
  const commissionerMembershipId = uuid(2301);
  for (const [id, email, displayName] of [
    [commissionerUserId, "commissioner@m3-19.test", "M3 Commissioner"],
    [invitedUserId, "invitee@m3-19.test", "Invited Manager"],
  ]) {
    repositories.users.insert({
      id,
      email_normalized: email,
      email_display: email,
      display_name: displayName,
      display_name_normalized: displayName.toLowerCase(),
      status: "active",
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });
  }
  repositories.leagues.insert({
    id: leagueId,
    name: "Commissioner League",
    name_normalized: "commissioner league",
    status: "setup",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  repositories.league_settings.insert({
    league_id: leagueId,
    salary_cap_cents: 10000,
    trade_deadline_at_ms: null,
    maximum_teams: 20,
    active_forward_slots: 12,
    active_defence_slots: 6,
    bench_slots: 4,
    maximum_bench_aav_cents: 400,
    injured_reserve_slots: 4,
    prospect_slots_unlimited: 1,
    scoring_rule_version: 1,
    standings_rule_version: 1,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  repositories.league_memberships.insert({
    id: commissionerMembershipId,
    league_id: leagueId,
    user_id: commissionerUserId,
    permission_category: "commissioner",
    status: "active",
    joined_at_ms: NOW_MS,
    ended_at_ms: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  repositories.leagues.updateVersioned({
    key: leagueId,
    expectedVersion: 1,
    changes: {
      commissioner_membership_id: commissionerMembershipId,
      updated_at_ms: NOW_MS,
    },
  });
  return Object.freeze({
    commissionerSession: runtime.services.sessionService.issueForUser({
      userId: commissionerUserId,
    }),
    commissionerUserId,
    invitedSession: runtime.services.sessionService.issueForUser({
      userId: invitedUserId,
    }),
    invitedUserId,
    leagueId,
  });
}

function seedComposedLeagueStartScenario(
  runtime,
  { teamCount = 4, unselectedTeamColours = false, leagueId = uuid(91_003) } = {}
) {
  const repositories = runtime.repositories.context.repositories;
  const commissionerUserId = uuid(91_001);
  const commissionerMembershipId = uuid(91_002);
  const seasonId = uuid(91_004);
  const managerUserIds = Array.from(
    { length: teamCount },
    (_, index) => uuid(91_010 + index)
  );
  const managerMembershipIds = Array.from(
    { length: teamCount },
    (_, index) => uuid(91_020 + index)
  );
  const teamIds = Array.from(
    { length: teamCount },
    (_, index) => uuid(91_030 + index)
  );
  const assignmentIds = Array.from(
    { length: teamCount },
    (_, index) => uuid(91_040 + index)
  );
  const createdAtMs = NOW_MS - 10_000;

  for (const [id, email, displayName] of [
    [
      commissionerUserId,
      "fad-runtime-commissioner@example.test",
      "FAD Runtime Commissioner",
    ],
    ...managerUserIds.map((id, index) => [
      id,
      `fad-runtime-manager-${index + 1}@example.test`,
      `FAD Runtime Manager ${index + 1}`,
    ]),
  ]) {
    repositories.users.insert({
      id,
      email_normalized: email,
      email_display: email,
      display_name: displayName,
      display_name_normalized: displayName.toLowerCase(),
      status: "active",
      created_at_ms: createdAtMs,
      updated_at_ms: createdAtMs,
      version: 1,
    });
  }
  repositories.leagues.insert({
    id: leagueId,
    name: "FAD Runtime Launch League",
    name_normalized: "fad runtime launch league",
    status: "setup",
    timezone: "America/Vancouver",
    commissioner_membership_id: null,
    current_season_id: null,
    created_at_ms: createdAtMs,
    updated_at_ms: createdAtMs,
    version: 1,
  });
  repositories.league_settings.insert({
    league_id: leagueId,
    salary_cap_cents: 10000,
    trade_deadline_at_ms: NOW_MS + 90 * 86_400_000,
    maximum_teams: 20,
    active_forward_slots: 12,
    active_defence_slots: 6,
    bench_slots: 4,
    maximum_bench_aav_cents: 400,
    injured_reserve_slots: 4,
    prospect_slots_unlimited: 1,
    scoring_rule_version: 1,
    standings_rule_version: 1,
    created_at_ms: createdAtMs,
    updated_at_ms: createdAtMs,
    version: 1,
  });
  repositories.seasons.insert({
    id: seasonId,
    league_id: leagueId,
    label: "2026",
    nhl_season_key: "20262027",
    status: "planned",
    regular_season_starts_at_ms: null,
    regular_season_ends_at_ms: null,
    fantasy_playoffs_start_at_ms: null,
    fantasy_playoffs_end_at_ms: null,
    free_agent_draft_completed_at_ms: null,
    created_at_ms: createdAtMs,
    updated_at_ms: createdAtMs,
    version: 1,
  });
  repositories.league_memberships.insert({
    id: commissionerMembershipId,
    league_id: leagueId,
    user_id: commissionerUserId,
    permission_category: "commissioner",
    status: "active",
    joined_at_ms: createdAtMs,
    ended_at_ms: null,
    created_at_ms: createdAtMs,
    updated_at_ms: createdAtMs,
    version: 1,
  });
  const league = repositories.leagues.updateVersioned({
    key: leagueId,
    expectedVersion: 1,
    changes: {
      commissioner_membership_id: commissionerMembershipId,
      current_season_id: seasonId,
      updated_at_ms: NOW_MS - 5_000,
    },
  });
  for (let index = 0; index < teamIds.length; index += 1) {
    repositories.league_memberships.insert({
      id: managerMembershipIds[index],
      league_id: leagueId,
      user_id: managerUserIds[index],
      permission_category: "manager",
      status: "active",
      joined_at_ms: createdAtMs,
      ended_at_ms: null,
      created_at_ms: createdAtMs,
      updated_at_ms: createdAtMs,
      version: 1,
    });
    repositories.teams.insert({
      id: teamIds[index],
      league_id: leagueId,
      name: `FAD Runtime Team ${index + 1}`,
      name_normalized: `fad runtime team ${index + 1}`,
      status: "setup",
      primary_colour: unselectedTeamColours ? null : "#102030",
      secondary_colour: unselectedTeamColours ? null : "#f0a020",
      tertiary_colour: null,
      pattern_template: "even-two",
      logo_reference: null,
      created_at_ms: createdAtMs,
      updated_at_ms: createdAtMs,
      version: 1,
    });
    repositories.team_manager_assignments.insert({
      id: assignmentIds[index],
      league_id: leagueId,
      team_id: teamIds[index],
      user_id: managerUserIds[index],
      membership_id: managerMembershipIds[index],
      assigned_by_user_id: commissionerUserId,
      replaces_assignment_id: null,
      status: "accepted",
      assigned_at_ms: createdAtMs,
      accepted_at_ms: createdAtMs,
      ended_at_ms: null,
      version: 1,
    });
  }
  const session = runtime.services.sessionService.issueForUser({
    userId: commissionerUserId,
  });
  return Object.freeze({
    commissionerUserId,
    expectedLeagueVersion: league.version,
    leagueId,
    seasonId,
    session,
    teamIds,
  });
}

function seedComposedResetOriginalEvidence(
  runtime,
  scenario
) {
  const repositories =
    runtime.repositories.context.repositories;
  const createdAtMs = NOW_MS - 10_000;
  repositories.platform_roles.insert({
    id: uuid(91_050),
    user_id: scenario.commissionerUserId,
    role: "platform_administrator",
    status: "active",
    granted_by_user_id: scenario.commissionerUserId,
    granted_at_ms: createdAtMs,
    ended_at_ms: null,
    version: 1,
  });
  repositories.idempotency_requests.insert({
    id: uuid(91_051),
    league_id: scenario.leagueId,
    actor_user_id: scenario.commissionerUserId,
    operation:
      "admin.league.bootstrap_reset_original.v1",
    client_key: "4".repeat(64),
    request_hash: "1".repeat(64),
    status: "completed",
    result_type: "league",
    result_id: scenario.leagueId,
    created_at_ms: createdAtMs,
    completed_at_ms: createdAtMs,
    expires_at_ms: createdAtMs + 86_400_000,
  });
  repositories.league_activity.insert({
    id: uuid(91_052),
    league_id: scenario.leagueId,
    season_id: scenario.seasonId,
    event_type: "league_created",
    actor_user_id: scenario.commissionerUserId,
    actor_authority: "platform_administrator",
    team_id: null,
    player_id: null,
    related_type: "league",
    related_id: scenario.leagueId,
    display_summary:
      "FAD Runtime Launch League was created in Setup.",
    reason: null,
    metadata_json:
      '{"leagueStatus":"setup","seasonStatus":"planned"}',
    occurred_at_ms: createdAtMs,
  });
  repositories.security_audit_events.insert({
    id: uuid(91_053),
    event_type:
      "system_bootstrap.reset_original_league_created",
    outcome: "success",
    actor_user_id: scenario.commissionerUserId,
    target_user_id: null,
    league_id: scenario.leagueId,
    session_id: null,
    request_correlation_id: null,
    reason_code: "closed_write_reset_handoff",
    network_key_version: null,
    network_metadata_digest: null,
    client_metadata_json: null,
    unknown_account_digest: null,
    occurred_at_ms: createdAtMs,
  });
  repositories.migration_reports.insert(
    createResetMigrationReportFixture({
      id: uuid(91_054),
      leagueId: scenario.leagueId,
      bundleCharacter: "3",
      startedAtMs: createdAtMs + 1,
      completedAtMs: createdAtMs + 1,
      createdAtMs: createdAtMs + 1,
    })
  );
}

async function startRuntimeApp(t, runtime) {
  const server = runtime.app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  );
  return `http://127.0.0.1:${server.address().port}`;
}

function createTargetSocket(runtime, session) {
  return {
    data: {},
    disconnected: false,
    handshake: {
      headers: {
        origin: PUBLIC_FRONTEND_ORIGIN,
        cookie:
          `${runtime.transport.sessionCookie.name}=` +
          session.rawSessionToken,
      },
    },
    rooms: new Set(["target-socket"]),
    async join(room) {
      this.rooms.add(room);
    },
    async leave(room) {
      this.rooms.delete(room);
    },
    disconnect(force) {
      this.disconnected = force === true;
      this.rooms.clear();
    },
  };
}

function runSocketMiddleware(middleware, socket) {
  return new Promise((resolve) => {
    middleware(socket, (error) => resolve(error));
  });
}

function browserHeaders(extra = {}) {
  return {
    Origin: PUBLIC_FRONTEND_ORIGIN,
    "Content-Type": "application/json",
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    ...extra,
  };
}

function concretePath(path) {
  return path
    .replace(":leagueId", "00000000-0000-4000-8000-000000000001")
    .replace(":teamId", "00000000-0000-4000-8000-000000000002")
    .replace(":playerId", "00000000-0000-4000-8000-000000000005")
    .replace(":fadId", "00000000-0000-4000-8000-000000000006")
    .replace(":invitationId", "00000000-0000-4000-8000-000000000003")
    .replace(":assignmentId", "00000000-0000-4000-8000-000000000004");
}

function createMarkerRouters() {
  return Object.freeze(
    Object.fromEntries(
      TARGET_ROUTER_KEYS.map((routerKey) => [
        routerKey,
        (request, response) => response.status(200).json({ routerKey }),
      ])
    )
  );
}

function installedTargetEndpoints(routers) {
  return Object.entries(routers).flatMap(([routerKey, router]) =>
    router.stack.flatMap((layer) => {
      if (!layer.route) return [];
      return Object.entries(layer.route.methods)
        .filter(([, enabled]) => enabled)
        .map(([method]) => ({
          method: method.toUpperCase(),
          path: layer.route.path,
          routerKey,
        }));
    })
  );
}

describe("M3-19 exact target endpoint dispatch", () => {
  test("declares 193 unique method/path contracts across the exact router set", () => {
    assert.equal(TARGET_ENDPOINTS.length, 193);
    assert.equal(
      new Set(TARGET_ENDPOINTS.map(({ method, path }) => `${method} ${path}`))
        .size,
      193
    );
    assert.deepEqual(TARGET_ROUTER_KEYS, [
      "accountProfile",
      "accountRegistration",
      "accountSession",
      "activityNotification",
      "auction",
      "auctionReveal",
      "auctionTiming",
      "candidateCard",
      "commissionerAssignment",
      "commissionerCorrection",
      "correctionReversal",
      "entryDraft",
      "fadDeadlineControl",
      "freeAgentDraft",
      "guidedLeagueReset",
      "leagueAuctionSchedule",
      "leagueCalendar",
      "leagueCommunication",
      "leagueHelp",
      "leagueInvitation",
      "leagueLifecycle",
      "leagueManagement",
      "leagueMembership",
      "leaguePause",
      "leaguePickRepair",
      "leagueRead",
      "leagueScoring",
      "matchup",
      "platformAdministration",
      "player",
      "playerCatalogue",
      "playerInjury",
      "publicRoster",
      "rosterAction",
      "standingsFinalization",
      "statisticsOperations",
      "team",
      "teamManagerAssignment",
      "teamProfile",
      "trade",
      "tradeDeadlineChange",
      "tradeRecovery",
    ]);
  });

  test("selects exactly one intended router for every endpoint and preflight", () => {
    for (const endpoint of TARGET_ENDPOINTS) {
      const path = concretePath(endpoint.path);
      assert.equal(
        selectTargetRouterKey(endpoint.method, path),
        endpoint.routerKey,
        `${endpoint.method} ${endpoint.path}`
      );
      assert.equal(
        selectTargetRouterKey("OPTIONS", path, endpoint.method),
        endpoint.routerKey,
        `OPTIONS ${endpoint.path} -> ${endpoint.method}`
      );
    }
    assert.equal(selectTargetRouterKey("GET", "/api/v1/unknown"), null);
    assert.equal(
      selectTargetRouterKey(
        "POST",
        "/api/v1/leagues/not-a-uuid/teams/not-a-uuid/logo"
      ),
      null
    );
  });

  test("exposes no manual FAD readiness preview, opening, handoff, or Entry Draft completion command", () => {
    const forbidden = [
      [
        "POST",
        "/api/v1/leagues/:leagueId/free-agent-drafts/readiness/previews",
      ],
      [
        "POST",
        "/api/v1/leagues/:leagueId/free-agent-drafts/openings",
      ],
      [
        "POST",
        "/api/v1/leagues/:leagueId/free-agent-drafts/readiness/handoffs",
      ],
      [
        "POST",
        "/api/v1/leagues/:leagueId/entry-drafts/:draftId/complete",
      ],
    ];
    for (const [method, path] of forbidden) {
      assert.equal(
        TARGET_ENDPOINTS.some(
          (endpoint) =>
            endpoint.method === method &&
            endpoint.path === path
        ),
        false,
        `${method} ${path}`
      );
      assert.equal(
        selectTargetRouterKey(
          method,
          concretePath(path)
        ),
        null,
        `${method} ${path}`
      );
    }
  });

  test("requires the exact router set and creates an application without listening", () => {
    assert.throws(
      () => createTargetApplication({ routers: {} }),
      /exact target router set/
    );
    const app = createTargetApplication({
      routers: createMarkerRouters(),
      expressModule: express,
    });
    assert.equal(typeof app, "function");
    assert.equal(app.listen instanceof Function, true);
    assert.equal(app._router, undefined);
    assert.throws(
      () => createTargetApplication({
        routers: createMarkerRouters(),
        freeAgentDraftRoutesEnabled: "false",
        expressModule: express,
      }),
      /exact Free Agent Draft route exposure boolean/
    );
  });

  test("fails closed for all 31 dedicated FAD routes and preflights while preserving shared auction routes", async (t) => {
    const fadEndpoints = TARGET_ENDPOINTS.filter(({ routerKey }) =>
      ["candidateCard", "freeAgentDraft", "fadDeadlineControl"].includes(routerKey)
    );
    const auctionEndpoints = TARGET_ENDPOINTS.filter(
      ({ routerKey }) => routerKey === "auction"
    );
    assert.equal(fadEndpoints.length, 31);
    assert.equal(auctionEndpoints.length > 0, true);

    const writeGatePaths = [];
    let dedicatedRouterCalls = 0;
    const markerRouters = {
      ...createMarkerRouters(),
      candidateCard(request, response) {
        dedicatedRouterCalls += 1;
        response.status(200).json({ routerKey: "candidateCard" });
      },
      freeAgentDraft(request, response) {
        dedicatedRouterCalls += 1;
        response.status(200).json({ routerKey: "freeAgentDraft" });
      },
    };
    const app = createTargetApplication({
      routers: markerRouters,
      freeAgentDraftRoutesEnabled: false,
      leagueWriteGate(request, response, next) {
        writeGatePaths.push(request.path);
        next();
      },
      expressModule: express,
    });
    const baseUrl = await startRuntimeApp(t, { app });
    function resolveEndpointPath(endpointPath) {
      return endpointPath.replace(/:[^/]+/gu, uuid(9191));
    }

    for (const endpoint of fadEndpoints) {
      const url = new URL(resolveEndpointPath(endpoint.path), baseUrl);
      const response = await fetch(url, { method: endpoint.method });
      assert.equal(
        response.status,
        404,
        `${endpoint.method} ${endpoint.path}`
      );
      assert.equal(
        (await response.text()).includes("routerKey"),
        false,
        `${endpoint.method} ${endpoint.path} must not return a route body`
      );
      const preflight = await fetch(url, {
        method: "OPTIONS",
        headers: {
          "Access-Control-Request-Method": endpoint.method,
          Origin: PUBLIC_FRONTEND_ORIGIN,
        },
      });
      assert.equal(preflight.status, 404, `OPTIONS ${endpoint.path}`);
      assert.equal(
        (await preflight.text()).includes("routerKey"),
        false,
        `OPTIONS ${endpoint.path} must not return a route body`
      );
      assert.equal(
        preflight.headers.has("access-control-allow-origin"),
        false,
        `OPTIONS ${endpoint.path} must remain unexposed`
      );
    }
    assert.equal(dedicatedRouterCalls, 0);
    assert.deepEqual(writeGatePaths, []);

    for (const endpoint of auctionEndpoints) {
      const url = new URL(resolveEndpointPath(endpoint.path), baseUrl);
      const response = await fetch(url, { method: endpoint.method });
      assert.equal(
        response.status,
        200,
        `${endpoint.method} ${endpoint.path}`
      );
      assert.deepEqual(await response.json(), { routerKey: "auction" });
      const preflight = await fetch(url, {
        method: "OPTIONS",
        headers: {
          "Access-Control-Request-Method": endpoint.method,
          Origin: PUBLIC_FRONTEND_ORIGIN,
        },
      });
      assert.equal(preflight.status, 200, `OPTIONS ${endpoint.path}`);
      assert.deepEqual(await preflight.json(), { routerKey: "auction" });
    }
    assert.equal(writeGatePaths.length, auctionEndpoints.length * 2);
  });

  test("keeps dedicated FAD routes enabled by default for local and test runtimes", async (t) => {
    const app = createTargetApplication({
      routers: createMarkerRouters(),
      expressModule: express,
    });
    const baseUrl = await startRuntimeApp(t, { app });
    const url = new URL(
      `/api/v1/leagues/${uuid(9192)}/free-agent-drafts/navigation`,
      baseUrl
    );
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      routerKey: "freeAgentDraft",
    });
    const preflight = await fetch(url, {
      method: "OPTIONS",
      headers: {
        "Access-Control-Request-Method": "GET",
        Origin: PUBLIC_FRONTEND_ORIGIN,
      },
    });
    assert.equal(preflight.status, 200);
    assert.deepEqual(await preflight.json(), {
      routerKey: "freeAgentDraft",
    });
  });

  test("makes the target runtime the deployment entrypoint without compatibility startup", () => {
    const productionEntrypoint = fs.readFileSync(
      path.join(ROOT_DIRECTORY, "server.js"),
      "utf8"
    );
    assert.equal(productionEntrypoint.includes("startBackendProcess"), true);
    assert.equal(productionEntrypoint.includes("startTargetProcess"), false);
    for (const forbidden of ["createCompatibilityRuntime", "startBackgroundJobs"]) {
      assert.equal(productionEntrypoint.includes(forbidden), false, forbidden);
    }
  });
});

describe("M3-19 exact-schema target dependency composition", () => {
  test("composes completed NHL statistics separately and projects only the configured season", async (t) => {
    const database = createDatabase(t);
    const rows = seedLiveStatisticsCatalog(database);
    const insert = database.prepare("INSERT INTO player_external_ids (id,player_id,provider,external_value,created_at_ms) VALUES (?,?,'nhl',?,1)");
    rows.forEach((row, i) => insert.run(uuid(90_000+i), uuid(20_000+i), String(row.PlayerID)));
    let fetches = 0;
    const options = runtimeOptions(database, { nhlCompletedStatisticsEnabled: true, nhlFetchImplementation: async (url) => {
      fetches += 1;
      assert.match(String(url), /api\.nhle\.com\/stats\/rest\/en\/game/);
      return { ok: true, json: async () => ({ total: 1, data: [{ id: 2026020001, season: 20262027, gameType: 2, easternStartTime: "2026-10-10T19:00:00", homeTeamId: 13, visitingTeamId: 16, gameStateId: 1 }] }) };
    } });
    const runtime = createTargetRuntime(options);
    const names = runtime.services.league.scheduledJobs.map(({ name }) => name);
    assert.ok(names.includes("nhl_completed_statistics"));
    assert.ok(!names.includes("matchup_occurrences"));
    assert.equal(fetches, 0);
    const result = await runtime.services.league.statistics.refresh();
    assert.equal(result.playerCount, rows.length);
    assert.equal(fetches, 1);
    const detail = runtime.repositories.players.findDetailById(uuid(20_000));
    assert.equal(detail.statistics_provider, "nhl-completed-games");
    assert.equal(detail.statistics_nhl_season_key, "20262027");
    assert.ok(createTargetRuntime({ ...options, matchupProcessingEnabled: true }).services.league.scheduledJobs.some(({ name }) => name === "matchup_occurrences"));
    assert.throws(() => createTargetRuntime({ ...options, matchupProcessingLeagueIds: [] }), /canonical league IDs/);
    assert.ok(createTargetRuntime({ ...options, matchupProcessingEnabled: true, matchupProcessingLeagueIds: [uuid(1)] }).services.league.scheduledJobs.some(({ name }) => name === "matchup_occurrences"));
    assert.throws(() => createTargetRuntime({ ...options, sportsDataIoLiveNhl: verifiedSportsDataIoLiveNhl() }), /one explicit NHL source/);
  });
  test("constructs every repository, service, router, and socket boundary without writes or listening", (t) => {
    const database = createDatabase(t);
    const before = database.serialize();
    const options = runtimeOptions(database);
    const runtime = createTargetRuntime(options);
    assert.equal(runtime.migrationState.status, "exact");
    assert.equal(runtime.migrationState.userVersion, 84);
    assert.equal(
      typeof runtime.services.league.auctionResolution.resolveDue,
      "function"
    );
    assert.deepEqual(
      Object.keys(runtime.transport.routers).sort(),
      TARGET_ROUTER_KEYS
    );
    assert.equal(typeof runtime.services.account.signIn.signIn, "function");
    assert.equal(
      typeof runtime.services.accountEmail.deliveryService.deliverDue,
      "function"
    );
    assert.equal(
      typeof runtime.services.accountEmail.job.start,
      "function"
    );
    assert.equal(runtime.services.accountEmail.job.isStarted(), false);
    assert.equal(typeof runtime.repositories.auctions.startAuction, "function");
    assert.deepEqual(
      Object.keys(
        runtime.repositories
          .freeAgentDraftAuctionStartWriter
      ),
      ["findStartContext", "startOrQueue"]
    );
    assert.equal(
      typeof runtime.repositories.tradeProposals.loadFoundationState,
      "function"
    );
    assert.equal(
      typeof runtime.repositories.tradeProposals.readDetail,
      "function"
    );
    assert.equal(typeof runtime.repositories.auctionBids.putBid, "function");
    assert.equal(
      typeof runtime.repositories.auctionReads.listAuctions,
      "function"
    );
    assert.equal(
      typeof runtime.repositories.auctionReads.readAuction,
      "function"
    );
    assert.equal(
      typeof runtime.repositories.auctionResolutions.loadCandidate,
      "function"
    );
    assert.equal(typeof runtime.services.league.auction.list, "function");
    assert.equal(typeof runtime.services.league.auction.read, "function");
    assert.equal(typeof runtime.services.league.auction.start, "function");
    assert.equal(
      typeof runtime.services.league.tradeProposalFoundation.preview,
      "function"
    );
    assert.equal(typeof runtime.services.league.tradeRead.read, "function");
    assert.equal(
      typeof runtime.services.league.tradeProposalCreation.create,
      "function"
    );
    assert.equal(
      typeof runtime.services.league.tradeProposalLifecycle.respond,
      "function"
    );
    assert.equal(
      typeof runtime.services.league.tradeAcceptancePreview.preview,
      "function"
    );
    assert.equal(
      typeof runtime.services.league.tradeAcceptance.accept,
      "function"
    );
    assert.equal(
      typeof runtime.services.league.tradeProposalExpiry.run,
      "function"
    );
    assert.equal(runtime.services.league.tradeProposalExpiry.isRunning(), false);
    assert.equal(typeof runtime.services.league.auction.putMine, "function");
    assert.equal(
      "putAsCommissioner" in runtime.services.league.auction,
      false
    );
    assert.equal(
      typeof runtime.services.league
        .auctionAdministration.editBid,
      "function"
    );
    assert.equal(
      typeof runtime.services.league.auctionResolutionDecision.decideDue,
      "function"
    );
    assert.equal(typeof runtime.services.league.teamProfile.update, "function");
    assert.equal(typeof runtime.services.league.publicRoster.read, "function");
    assert.equal(typeof runtime.services.players.list, "function");
    assert.equal(typeof runtime.services.players.read, "function");
    assert.equal(typeof runtime.services.leaguePlayers.list, "function");
    assert.equal(typeof runtime.services.leaguePlayers.read, "function");
    assert.equal(typeof runtime.services.league.matchup.listWeeks, "function");
    assert.equal(typeof runtime.services.league.matchup.rebuildStandings, "function");
    assert.equal(
      typeof runtime.services.league
        .matchupSchedule.shiftWeekOne,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .standingsFinalization.finalize,
      "function"
    );
    assert.equal(
      typeof runtime.services.league.start.start,
      "function"
    );
    assert.equal(
      typeof runtime.services.league.tradeDeadline
        .record,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .entryDraftSchedule.schedule,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .lifecycleTransition.transition,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .seasonRolloverJob.run,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .freeAgentDraftReadiness
        .executeClaimedReadiness,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .freeAgentDraftReadinessJob.run,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .freeAgentDraftRead.navigation,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .freeAgentDraftRead.overview,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .freeAgentDraftRead.readiness,
      "function"
    );
    for (const method of [
      "publishedCardSummaries",
      "publishedCardHistory",
      "allocationResults",
    ]) {
      assert.equal(
        typeof runtime.services.league
          .freeAgentDraftRead[method],
        "function"
      );
    }
    assert.equal(
      typeof runtime.services.league
        .freeAgentDraftReadinessRetry.retry,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .freeAgentDraftRecoveryRead.recovery,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .freeAgentDraftRecoveryAction.accept,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .freeAgentDraftCorrectionPreview.preview,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .freeAgentDraftAllocationCorrection.apply,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .freeAgentDraftDeadlineReminder
        .executeClaimedReminder,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .freeAgentDraftDeadlineReminderJob.run,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .freeAgentDraftDeadline
        .executeClaimedDeadline,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .freeAgentDraftDeadlineJob.run,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .freeAgentDraftAllocationLifecycle
        .coordinateRoot,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .freeAgentDraftAllocationLifecycleJob.run,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .freeAgentDraftAllocationCycleJob.run,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .freeAgentDraftAuctionResolution
        .executeClaimedResolution,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .freeAgentDraftAuctionResolution
        .coordinateCommittedResolution,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .freeAgentDraftAuctionResolutionJob.run,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .freeAgentDraftRestrictedActivation
        .executeClaimedActivation,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .freeAgentDraftRestrictedActivationJob.run,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .freeAgentDraftFallbackActivation
        .executeClaimedActivation,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .freeAgentDraftFallbackActivationJob.run,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .freeAgentDraftQueuedNominationActivation
        .executeClaimedActivation,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .freeAgentDraftQueuedNominationActivation
        .recordClaimedFailure,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .freeAgentDraftQueuedNominationActivationJob.run,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .freeAgentDraftRollover.executeClaimedRollover,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .freeAgentDraftRollover.recordClaimedFailure,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .freeAgentDraftRolloverJob.run,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .freeAgentDraftCompletion
        .executeClaimedCompletion,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .freeAgentDraftCompletionJob.run,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .candidateCards.privateCard,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .candidateAllocation
        .executeClaimedAllocation,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .candidateAllocationJob.run,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .candidateCards.eligiblePlayers,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .candidateCards.previewRevision,
      "function"
    );
    for (const method of [
      "addCandidate",
      "editCandidate",
      "moveEntry",
      "removeCandidate",
      "requestHelp",
    ]) {
      assert.equal(
        typeof runtime.services.league
          .candidateCards[method],
        "function"
      );
    }
    assert.equal(
      typeof runtime.repositories
        .candidateCards.readPrivateCurrent,
      "function"
    );
    assert.equal(
      typeof runtime.repositories
        .candidateAllocations.findAllocation,
      "function"
    );
    assert.equal(
      typeof runtime.repositories
        .candidateAllocations.resolvePending,
      "function"
    );
    assert.equal(
      typeof runtime.repositories
        .candidateCards
        .readEligiblePlayersCurrent,
      "function"
    );
    assert.equal(
      typeof runtime.repositories
        .candidateCards
        .previewRevisionCurrent,
      "function"
    );
    assert.equal(
      typeof runtime.repositories
        .candidateCards.mutateCurrent,
      "function"
    );
    assert.equal(
      typeof runtime.repositories
        .candidateCards.requestHelpCurrent,
      "function"
    );
    assert.equal(
      typeof runtime.repositories
        .candidateCards.synchronizeSummerStateCurrent,
      "function"
    );
    assert.equal(
      typeof runtime.repositories
        .candidateCardSummerSynchronizer.synchronize,
      "function"
    );
    assert.equal(
      typeof runtime.repositories
        .candidateEligibilityRevalidationWriter
        .executeClaimed,
      "function"
    );
    assert.equal(
      typeof runtime.repositories
        .freeAgentDraftEligibilityDeadlineReconciler
        .reconcileInCurrentTransaction,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .candidateEligibilityRevalidation
        .executeClaimedEligibilityRevalidation,
      "function"
    );
    assert.equal(
      typeof runtime.services.league
        .candidateEligibilityRevalidationJob.run,
      "function"
    );
    assert.equal(
      typeof runtime.repositories.contracts.createNormal,
      "function"
    );
    assert.equal(
      typeof runtime.repositories.leaguePlayerOwnership
        .replaceCurrentPositionCorrection,
      "function"
    );
    assert.equal(
      typeof runtime.repositories.prospectDecisions.signFantasyElc,
      "function"
    );
    for (const [method, path] of [
      [
        "GET",
        "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/recovery",
      ],
      [
        "POST",
        "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/recovery/actions",
      ],
      [
        "POST",
        "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/allocations/:allocationId/correction-previews",
      ],
      [
        "POST",
        "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/allocations/:allocationId/corrections",
      ],
    ]) {
      assert.equal(
        TARGET_ENDPOINTS.some(
          (endpoint) =>
            endpoint.method === method &&
            endpoint.path === path &&
            endpoint.routerKey === "freeAgentDraft"
        ),
        true
      );
    }
    assert.equal(
      typeof runtime.repositories.retentions.create,
      "function"
    );
    for (const [method, path] of [
      [
        "GET",
        "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId/private",
      ],
      [
        "GET",
        "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId/eligible-players",
      ],
      [
        "POST",
        "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId/revision-previews",
      ],
      [
        "PUT",
        "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId",
      ],
      [
        "PUT",
        "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId/slots/:slotKey/candidate",
      ],
      [
        "PATCH",
        "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId/entries/:entryId",
      ],
      [
        "POST",
        "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId/entries/:entryId/move",
      ],
      [
        "DELETE",
        "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId/entries/:entryId",
      ],
      [
        "POST",
        "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId/help-requests",
      ],
    ]) {
      assert.equal(
        TARGET_ENDPOINTS.some(
          (endpoint) =>
            endpoint.method === method &&
            endpoint.path === path &&
            endpoint.routerKey === "candidateCard"
        ),
        true
      );
    }
    assert.equal(
      typeof runtime.repositories
        .entryDraftSchedule.readScheduleContext,
      "function"
    );
    assert.equal(
      typeof runtime.repositories
        .leagueLifecycleTransition
        .findRolloverBindingByOccurrence,
      "function"
    );
    assert.equal(
      typeof runtime.repositories
        .seasonRolloverJobs.listDueRolloverBindings,
      "function"
    );
    assert.equal(
      typeof runtime.transport.routers.entryDraft,
      "function"
    );
    assert.equal(
      typeof runtime.transport.routers.freeAgentDraft,
      "function"
    );
    assert.equal(
      typeof runtime.transport.routers.candidateCard,
      "function"
    );
    assert.deepEqual(
      runtime.services.league.scheduledJobs.map(
        ({ name }) => name
      ),
      [
        "entry_draft_rollover",
        "free_agent_draft_readiness",
        "free_agent_draft_eligibility_revalidation",
        "free_agent_draft_deadline_reminder",
        "free_agent_draft_deadline",
        "free_agent_draft_allocation_cycle",
        "free_agent_draft_auction_resolution",
        "free_agent_draft_restricted_activation",
        "free_agent_draft_fallback_activation",
        "free_agent_draft_queued_nomination_activation",
        "free_agent_draft_rollover_finalization",
        "auction_resolution",
        "free_agent_draft_completion",
        "trade_expiry",
        "league_outbox",
      ]
    );
    assert.equal(
      typeof runtime.repositories.leagueStart
        .findStartContext,
      "function"
    );
    assert.deepEqual(
      Object.keys(
        runtime.repositories
          .freeAgentDraftReadinessHandoffWriter
      ),
      ["write"]
    );
    assert.equal(
      typeof runtime.repositories
        .freeAgentDraftRead
        .readOpeningPreflightContext,
      "function"
    );
    for (const method of [
      "readPublishedCardSummaries",
      "readPublishedCardHistory",
      "readAllocationResults",
    ]) {
      assert.equal(
        typeof runtime.repositories
          .freeAgentDraftRead[method],
        "function"
      );
    }
    assert.equal(
      typeof runtime.repositories
        .freeAgentDraftRecoveryRead.readRecovery,
      "function"
    );
    assert.equal(
      typeof runtime.repositories
        .freeAgentDraftCorrectionPreview
        .previewAllocationCorrection,
      "function"
    );
    for (const method of [
      "findAllocationCorrectionReplay",
      "applyAllocationCorrection",
    ]) {
      assert.equal(
        typeof runtime.repositories
          .freeAgentDraftAllocationCorrections[method],
        "function"
      );
    }
    for (const method of [
      "findRecoveryActionReplay",
      "acceptRecoveryAction",
    ]) {
      assert.equal(
        typeof runtime.repositories
          .freeAgentDraftRecoveryActions[method],
        "function"
      );
    }
    assert.equal(
      typeof runtime.repositories
        .freeAgentDraftLifecycle.commitOpening,
      "function"
    );
    assert.equal(
      typeof runtime.repositories
        .freeAgentDraftLifecycle
        .blockReadinessOperation,
      "function"
    );
    assert.equal(
      typeof runtime.repositories
        .freeAgentDraftJobs.listDue,
      "function"
    );
    assert.equal(
      typeof runtime.repositories
        .freeAgentDraftJobs.claim,
      "function"
    );
    assert.equal(
      typeof runtime.repositories
        .freeAgentDraftDeadlineReminderWriter
        .executeClaimed,
      "function"
    );
    assert.equal(
      typeof runtime.repositories
        .freeAgentDraftDeadlineWriter.executeClaimed,
      "function"
    );
    assert.equal(
      typeof runtime.repositories
        .freeAgentDraftAllocationLifecycleWriter
        .listCandidates,
      "function"
    );
    for (const method of [
      "listDue",
      "claimDue",
      "findResolution",
      "executeClaimed",
      "recordFailure",
    ]) {
      assert.equal(
        typeof runtime.repositories
          .freeAgentDraftAuctionResolutionWriter[method],
        "function"
      );
    }
    for (const repositoryName of [
      "freeAgentDraftRestrictedActivationWriter",
      "freeAgentDraftFallbackActivationWriter",
    ]) {
      for (const method of [
        "findActivation",
        "executeClaimed",
      ]) {
        assert.equal(
          typeof runtime.repositories[repositoryName][method],
          "function"
        );
      }
    }
    for (const method of [
      "findActivation",
      "executeClaimed",
      "recordFailure",
    ]) {
      assert.equal(
        typeof runtime.repositories
          .freeAgentDraftQueuedNominationActivationWriter[method],
        "function"
      );
    }
    assert.deepEqual(
      Object.keys(
        runtime.repositories.freeAgentDraftRolloverWriter
      ),
      [
        "ensurePendingJobs",
        "findFinalization",
        "executeClaimed",
        "recordFailure",
      ]
    );
    assert.equal(
      typeof runtime.repositories
        .restrictedNoImprovementFallbackWriter
        .openFallback,
      "function"
    );
    assert.equal(
      typeof runtime.repositories
        .freeAgentDraftCompletionWriter
        .listCandidates,
      "function"
    );
    assert.equal(
      typeof runtime.repositories
        .freeAgentDraftTransitionWriter
        .beforeTransition,
      "function"
    );
    assert.equal(
      typeof runtime.repositories
        .freeAgentDraftTransitionWriter
        .afterTransition,
      "function"
    );
    assert.equal(
      typeof runtime.repositories
        .leagueTradeDeadline.findContext,
      "function"
    );
    assert.equal(
      typeof runtime.repositories
        .standingsFinalization
        .readFinalizationContext,
      "function"
    );
    assert.equal(
      typeof runtime.transport.routers
        .standingsFinalization,
      "function"
    );
    assert.equal(typeof runtime.repositories.matchupRead.readSchedule, "function");
    assert.equal(typeof runtime.repositories.players.listPage, "function");
    assert.equal(
      typeof runtime.repositories.statistics
        .readPlayerGameCoverageRequirements,
      "function"
    );
    assert.equal(
      typeof runtime.repositories.statistics.completeLiveRefresh,
      "function"
    );
    assert.equal(
      typeof runtime.repositories.lateLockCoordinator
        .listEligibleLateLocks,
      "function"
    );
    assert.equal(
      typeof runtime.services.league.lateLockCoordinator
        .coordinateCommittedRoster,
      "function"
    );
    assert.equal(
      typeof runtime.services.league.lateLockCoordinator
        .retryEligibleLateLocks,
      "function"
    );
    assert.equal(
      typeof runtime.repositories.leaguePlayers.listByPlayerIds,
      "function"
    );
    assert.equal(
      runtime.securityConfig,
      options.securityFoundations.config
    );
    assert.equal(typeof runtime.socketRooms.middleware, "function");
    assert.equal(typeof runtime.app.listen, "function");
    assert.equal(before.equals(database.serialize()), true);
  });

  test("composes the six-team reset-original T-036 activation without an inaugural readiness handoff", (t) => {
    const database = createDatabase(t);
    const runtime = createTargetRuntime(runtimeOptions(database));
    const scenario = seedComposedLeagueStartScenario(runtime, {
      teamCount: 6,
    });
    seedComposedResetOriginalEvidence(runtime, scenario);
    const authenticated =
      runtime.services.sessionService.resolveWithoutActivity(
        scenario.session.rawSessionToken
      );

    const result = runtime.services.league.start.start({
      leagueId: scenario.leagueId,
      input: {},
      expectedLeagueVersion:
        scenario.expectedLeagueVersion,
      idempotencyKey:
        "target-runtime-reset-original-start",
      authenticated,
    });

    assert.equal(result.replayed, false);
    assert.equal(result.code, "LEAGUE_STARTED");
    assert.equal(result.league.status, "active");
    assert.equal(result.league.currentSeason.status, "active");
    assert.equal(result.activatedTeamCount, 6);
    assert.deepEqual(
      database
        .prepare(
          `SELECT
             (SELECT COUNT(*)
              FROM free_agent_draft_readiness_operations) AS operations,
             (SELECT COUNT(*)
              FROM job_runs
              WHERE job_type = 'fad_readiness') AS jobs,
             (SELECT COUNT(*)
              FROM free_agent_draft_setup_exemptions
              WHERE league_id = @leagueId
                AND season_id = @seasonId) AS exemptions`
        )
        .get({
          leagueId: scenario.leagueId,
          seasonId: scenario.seasonId,
        }),
      { operations: 0, jobs: 0, exemptions: 0 }
    );
  });

  test("composes the ordinary ten-team T-036 readiness handoff without changing its response contract", (t) => {
    const database = createDatabase(t);
    const runtime = createTargetRuntime(runtimeOptions(database));
    const scenario = seedComposedLeagueStartScenario(runtime, {
      teamCount: 10,
    });
    const authenticated =
      runtime.services.sessionService.resolveWithoutActivity(
        scenario.session.rawSessionToken
      );
    assert.equal(authenticated.valid, true);
    assert.deepEqual(
      database
        .prepare(
          `SELECT
             (SELECT COUNT(*)
              FROM free_agent_draft_readiness_operations) AS operations,
             (SELECT COUNT(*)
              FROM job_runs
              WHERE job_type = 'fad_readiness') AS jobs`
        )
        .get(),
      { operations: 0, jobs: 0 }
    );

    const result = runtime.services.league.start.start({
      leagueId: scenario.leagueId,
      input: {},
      expectedLeagueVersion:
        scenario.expectedLeagueVersion,
      idempotencyKey: "target-runtime-fad-readiness-handoff",
      authenticated,
    });

    assert.equal(result.replayed, false);
    assert.deepEqual(Object.keys(result), [
      "code",
      "league",
      "activatedTeamCount",
      "startedAtMs",
    ]);
    assert.deepEqual(result, {
      code: "LEAGUE_STARTED",
      league: {
        id: scenario.leagueId,
        name: "FAD Runtime Launch League",
        status: "active",
        timezone: "America/Vancouver",
        version: scenario.expectedLeagueVersion + 1,
        currentSeason: {
          id: scenario.seasonId,
          label: "2026",
          nhlSeasonKey: "20262027",
          status: "active",
          version: 2,
        },
      },
      activatedTeamCount: 10,
      startedAtMs: NOW_MS,
    });
    const readiness = database
      .prepare(
        `SELECT *
         FROM free_agent_draft_readiness_operations
         WHERE league_id = ? AND season_id = ?`
      )
      .get(scenario.leagueId, scenario.seasonId);
    assert.equal(readiness.trigger_kind, "no_draft_inaugural");
    assert.equal(readiness.entry_draft_id, null);
    assert.equal(readiness.setup_exemption_id, null);
    assert.equal(readiness.status, "pending");
    assert.equal(readiness.attempt_count, 0);
    assert.equal(readiness.created_at_ms, NOW_MS);
    assert.equal(readiness.updated_at_ms, NOW_MS);
    assert.equal(readiness.version, 1);
    const job = database
      .prepare(
        `SELECT * FROM job_runs
         WHERE league_id = ? AND season_id = ?
           AND job_type = 'fad_readiness'`
      )
      .get(scenario.leagueId, scenario.seasonId);
    assert.equal(job.id, readiness.job_run_id);
    assert.equal(
      job.occurrence_key,
      readiness.readiness_occurrence_key
    );
    assert.equal(job.status, "pending");
    assert.equal(job.attempt_count, 0);
    assert.equal(job.scheduled_for_ms, NOW_MS);
    assert.equal(job.created_at_ms, NOW_MS);
    assert.equal(job.updated_at_ms, NOW_MS);
    assert.equal(job.version, 1);
    assert.equal(TARGET_ENDPOINTS.length, 193);
  });

  for (const dailyStaging of [false, true]) test(`runs FAD readiness through the composed target runtime and opens every Candidate Card atomically (daily staging: ${dailyStaging})`, async (t) => {
    const database = createDatabase(t);
    const runtime = createTargetRuntime({ ...runtimeOptions(database), stagingDailyAuctionsEnabled: dailyStaging });
    const scenario = seedComposedLeagueStartScenario(runtime, { unselectedTeamColours: dailyStaging });
    const authenticated =
      runtime.services.sessionService.resolveWithoutActivity(
        scenario.session.rawSessionToken
      );
    assert.equal(authenticated.valid, true);

    const started = runtime.services.league.start.start({
      leagueId: scenario.leagueId,
      input: {},
      expectedLeagueVersion:
        scenario.expectedLeagueVersion,
      idempotencyKey:
        "target-runtime-fad-readiness-opening",
      authenticated,
    });
    const firstWeekStartsAtMs = Date.parse(
      "2026-10-12T07:00:00.000Z"
    );
    const candidateDeadlineAtMs = Date.parse(
      "2026-10-05T07:00:00.000Z"
    );
    const schedule =
      runtime.services.league.matchupSchedule.generate({
        leagueId: scenario.leagueId,
        seasonId: scenario.seasonId,
        expectedSeasonVersion:
          started.league.currentSeason.version,
        input: {
          nhlRegularSeasonStartsAtMs: Date.parse(
            "2026-10-06T07:00:00.000Z"
          ),
          nhlRegularSeasonEndsAtMs: Date.parse(
            "2027-04-12T07:00:00.000Z"
          ),
          fantasyPlayoffsStartAtMs: Date.parse(
            "2027-03-15T07:00:00.000Z"
          ),
          fantasyPlayoffsEndAtMs: Date.parse(
            "2027-04-12T07:00:00.000Z"
          ),
          firstWeekStartsAtMs,
          ...(dailyStaging ? { draftTiming: { candidateDeadlineAtMs,
            rolloverTimesAtMs: Array.from({ length: 7 }, (_, index) => candidateDeadlineAtMs + (index + 1) * 86400000),
          } } : {}),
          confirmed: true,
        },
        idempotencyKey:
          "target-runtime-fad-readiness-schedule",
        authenticated,
      });
    assert.equal(
      schedule.firstWeekStartsAtMs,
      firstWeekStartsAtMs
    );

    const pauseService=runtime.services.league.leaguePause;
    const pauseInput={action:'pause',reason:'Inspect readiness before opening cards'};
    const pausePreview=pauseService.preview({leagueId:scenario.leagueId,authenticated,input:pauseInput});
    pauseService.apply({leagueId:scenario.leagueId,authenticated,input:{...pauseInput,confirmed:true,previewHash:pausePreview.previewHash},idempotencyKey:'pause-fad-readiness'});
    const pausedBytes=database.serialize();
    const pausedRun=await runtime.services.league.freeAgentDraftReadinessJob.run();
    assert.equal(pausedRun.due,0);assert.deepEqual(database.serialize(),pausedBytes);
    const resumeInput={action:'resume',reason:'Readiness checked; open the cards'};
    const resumePreview=pauseService.preview({leagueId:scenario.leagueId,authenticated,input:resumeInput});
    pauseService.apply({leagueId:scenario.leagueId,authenticated,input:{...resumeInput,confirmed:true,previewHash:resumePreview.previewHash},idempotencyKey:'resume-fad-readiness'});
    const summary = await runtime.services.league
      .freeAgentDraftReadinessJob.run();
    assert.equal(summary.status, "succeeded");
    assert.equal(summary.due, 1);
    assert.equal(summary.acquired, 1);
    assert.equal(summary.succeeded, 1);
    assert.equal(summary.blocked, 0);
    assert.equal(summary.failed, 0);
    assert.equal(summary.skipped, 0);

    const beforeProgress = database.serialize();
    const progress = runtime.services.league.communications.readiness({
      leagueId: scenario.leagueId, authenticated,
    });
    assert.equal(progress.total, 4);
    assert.equal(progress.empty, 4);
    assert.equal(progress.complete, 0);
    const management=runtime.services.league.leagueManagement.readiness({leagueId:scenario.leagueId,authenticated});
    assert.equal(management.summary.unfinishedCards,4);
    assert.equal(management.summary.missingManagers,0);
    assert.equal(management.teams.every(team=>team.cardStatus==='empty'),true);
    assert.equal(management.teams.every(team=>team.roster.requiredNow===false),true);
    assert.deepEqual(progress.cards.map(card => card.teamId).sort(), [...scenario.teamIds].sort());
    for (const card of progress.cards) {
      assert.deepEqual(Object.keys(card).sort(), ["displayName", "status", "teamId", "teamName", "userId"]);
      assert.equal(typeof card.displayName, "string");
      assert.equal(card.status, "empty");
    }
    const reminder = runtime.services.league.communications.preview({
      leagueId: scenario.leagueId, authenticated,
      input: { kind: "reminder", title: "Finish your card", body: "Please save a complete card.",
        audience: "unfinished_cards", pinned: false, expiresAtMs: null, notify: true },
    });
    assert.equal(reminder.recipientCount, 4);
    assert.deepEqual(database.serialize(), beforeProgress);

    const readiness = database.prepare(`
      SELECT status, attempt_count, created_fad_id,
             reminder_job_run_id, deadline_job_run_id,
             lease_owner, lease_token, lease_expires_at_ms,
             matchup_schedule_version_before,
             matchup_schedule_version_after,
             schedule_recovery_id, terminal_at_ms, version
      FROM free_agent_draft_readiness_operations
      WHERE league_id = ? AND season_id = ?
    `).get(scenario.leagueId, scenario.seasonId);
    assert.equal(readiness.status, "succeeded");
    assert.equal(readiness.attempt_count, 1);
    assert.notEqual(readiness.created_fad_id, null);
    assert.notEqual(readiness.reminder_job_run_id, null);
    assert.notEqual(readiness.deadline_job_run_id, null);
    assert.equal(readiness.lease_owner, null);
    assert.equal(readiness.lease_token, null);
    assert.equal(readiness.lease_expires_at_ms, null);
    assert.equal(
      readiness.matchup_schedule_version_before,
      1
    );
    assert.equal(
      readiness.matchup_schedule_version_after,
      1
    );
    assert.equal(readiness.schedule_recovery_id, null);
    assert.equal(readiness.terminal_at_ms, NOW_MS);
    assert.equal(readiness.version, 3);
    if (dailyStaging) {
      assert.equal(database.prepare('SELECT count(*) n FROM teams WHERE league_id=? AND primary_colour IS NULL AND secondary_colour IS NULL').get(scenario.leagueId).n, 4);
    }
    assert.deepEqual(
      database.prepare(`
        SELECT status, attempt_count
        FROM job_runs
        WHERE league_id = ? AND season_id = ?
          AND job_type = 'fad_readiness'
      `).get(scenario.leagueId, scenario.seasonId),
      { status: "succeeded", attempt_count: 1 }
    );
    assert.deepEqual(
      database.prepare(`
        SELECT status, participating_team_count,
               opened_at_ms, help_opens_at_ms,
               candidate_deadline_at_ms,
               first_matchup_starts_at_ms
        FROM free_agent_drafts
        WHERE league_id = ? AND season_id = ?
      `).get(scenario.leagueId, scenario.seasonId),
      {
        status: "cards_open",
        participating_team_count: 4,
        opened_at_ms: NOW_MS,
        help_opens_at_ms:
          candidateDeadlineAtMs - 48 * 60 * 60 * 1000,
        candidate_deadline_at_ms: candidateDeadlineAtMs,
        first_matchup_starts_at_ms: firstWeekStartsAtMs,
      }
    );
    assert.deepEqual(
      database.prepare(`
        SELECT
          (SELECT COUNT(*)
           FROM free_agent_draft_teams
           WHERE league_id = ? AND fad_id = ?) AS participants,
          (SELECT COUNT(*)
           FROM candidate_cards
           WHERE league_id = ? AND fad_id = ?) AS cards,
          (SELECT COUNT(*)
           FROM candidate_card_revisions
           WHERE league_id = ? AND fad_id = ?) AS revisions,
          (SELECT COUNT(*)
           FROM free_agent_draft_rollovers
           WHERE league_id = ? AND fad_id = ?) AS rollovers,
          (SELECT COUNT(*)
           FROM notifications
           WHERE league_id = ?
             AND event_type = 'fad_cards_opened'
             AND related_record_id = ?) AS notifications
      `).get(
        scenario.leagueId,
        readiness.created_fad_id,
        scenario.leagueId,
        readiness.created_fad_id,
        scenario.leagueId,
        readiness.created_fad_id,
        scenario.leagueId,
        readiness.created_fad_id,
        scenario.leagueId,
        readiness.created_fad_id
      ),
      {
        participants: 4,
        cards: 4,
        revisions: 4,
        rollovers: 7,
        notifications: 4,
      }
    );
    assert.deepEqual(
      database.prepare(`
        SELECT job_type, COUNT(*) AS count
        FROM job_runs
        WHERE league_id = ? AND season_id = ?
          AND job_type IN (
            'fad_deadline_reminder',
            'fad_deadline',
            'fad_rollover'
          )
          AND status = 'pending'
        GROUP BY job_type
        ORDER BY job_type
      `).all(scenario.leagueId, scenario.seasonId),
      [
        { job_type: "fad_deadline", count: 1 },
        {
          job_type: "fad_deadline_reminder",
          count: 1,
        },
        { job_type: "fad_rollover", count: 7 },
      ]
    );
    const managerUserId = database
      .prepare(`
        SELECT user_id AS userId
        FROM team_manager_assignments
        WHERE league_id = ? AND team_id = ?
          AND status = 'accepted'
          AND ended_at_ms IS NULL
      `)
      .get(
        scenario.leagueId,
        scenario.teamIds[0]
      ).userId;
    const managerSession =
      runtime.services.sessionService.issueForUser({
        userId: managerUserId,
      });
    const baseUrl = await startRuntimeApp(t, runtime);
    const cookie = (session) =>
      `${runtime.transport.sessionCookie.name}=` +
      session.rawSessionToken;
    const readWithoutWrites = async (
      relativePath,
      session
    ) => {
      const beforeBytes = database.serialize();
      const beforeChanges = database
        .prepare(
          "SELECT total_changes() AS count"
        )
        .get().count;
      const response = await fetch(
        new URL(relativePath, baseUrl),
        {
          headers: browserHeaders({
            Cookie: cookie(session),
          }),
        }
      );
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get("cache-control"),
        "private, no-store"
      );
      assert.equal(
        beforeBytes.equals(database.serialize()),
        true
      );
      assert.equal(
        database
          .prepare(
            "SELECT total_changes() AS count"
          )
          .get().count,
        beforeChanges
      );
      return body;
    };

    const beforeAnonymous = database.serialize();
    const anonymous = await fetch(
      new URL(
        `/api/v1/leagues/${scenario.leagueId}` +
          "/free-agent-drafts/navigation",
        baseUrl
      ),
      { headers: browserHeaders() }
    );
    assert.equal(anonymous.status, 401);
    assert.equal(
      anonymous.headers.get("cache-control"),
      "private, no-store"
    );
    assert.equal(
      beforeAnonymous.equals(database.serialize()),
      true
    );

    const navigation = await readWithoutWrites(
      `/api/v1/leagues/${scenario.leagueId}` +
        "/free-agent-drafts/navigation",
      managerSession
    );
    assert.equal(
      navigation.data.fadId,
      readiness.created_fad_id
    );
    assert.equal(
      navigation.data.seasonId,
      scenario.seasonId
    );
    assert.equal(navigation.data.phase, "cards_open");
    if (dailyStaging) {
      assert.equal(navigation.data.managedCards[0].team.primaryColour, '#16324f');
      assert.equal(navigation.data.managedCards[0].team.secondaryColour, '#f7f7f7');
    }
    assert.equal(
      navigation.data.showMainNavigation,
      true
    );
    assert.deepEqual(
      navigation.data.managedCards.map(
        ({ teamId }) => teamId
      ),
      [scenario.teamIds[0]]
    );
    assert.deepEqual(
      navigation.data.rosterLinks.map(
        ({ mode, teamId }) => ({ mode, teamId })
      ),
      [
        {
          mode: "private_card",
          teamId: scenario.teamIds[0],
        },
      ]
    );
    for (const key of [
      "entries",
      "helpMessage",
      "offers",
      "slots",
    ]) {
      assert.equal(
        key in navigation.data.managedCards[0],
        false
      );
    }
    const navigationJson = JSON.stringify(
      navigation.data
    );
    for (const competitorTeamId of
      scenario.teamIds.slice(1)) {
      assert.equal(
        navigationJson.includes(competitorTeamId),
        false
      );
    }

    const readinessRead = await readWithoutWrites(
      `/api/v1/leagues/${scenario.leagueId}` +
        "/free-agent-drafts/readiness" +
        `?seasonId=${scenario.seasonId}`,
      scenario.session
    );
    assert.equal(readinessRead.data.status, "succeeded");
    assert.equal(
      readinessRead.data.resultFadId,
      readiness.created_fad_id
    );
    assert.equal(
      readinessRead.data.initialRollovers.length,
      7
    );
    assert.equal(
      readinessRead.data.teamProjections.length,
      4
    );
    assert.deepEqual(readinessRead.data.blockers, []);
    assert.deepEqual(
      readinessRead.data.retryReadiness,
      {
        allowed: false,
        reasonCode: "RECOVERY_NOT_AVAILABLE",
      }
    );

    const overview = await readWithoutWrites(
      `/api/v1/leagues/${scenario.leagueId}` +
        `/free-agent-drafts/${readiness.created_fad_id}`,
      managerSession
    );
    assert.equal(overview.data.status, "cards_open");
    assert.equal(overview.data.phase, "cards_open");
    assert.deepEqual(overview.data.counts, {
      participatingTeams: 4,
      cardsLocked: null,
      allocationsPending: null,
      allocationsAutomatic: null,
      restrictedPending: null,
      restrictedFallbackPending: null,
      rapidAuctionsOpen: null,
      rolloversPersisted: null,
      rolloversCompleted: null,
      recoveriesOpen: null,
    });
    assert.deepEqual(
      overview.data.viewer.managedCards.map(
        ({ teamId }) => teamId
      ),
      [scenario.teamIds[0]]
    );
    assert.deepEqual(
      overview.data.viewer.commissionerCards,
      []
    );
    assert.deepEqual(
      overview.data.viewer.queuedNominations,
      []
    );
    assert.deepEqual(overview.data.capabilities, {
      viewPublishedCards: {
        allowed: false,
        reasonCode: "PHASE_CLOSED",
      },
      viewRecovery: {
        allowed: false,
        reasonCode: "NOT_AUTHORIZED",
      },
      completeRecoveryAction: {
        allowed: false,
        reasonCode: "NOT_AUTHORIZED",
      },
    });
    const overviewJson = JSON.stringify(overview.data);
    for (const competitorTeamId of
      scenario.teamIds.slice(1)) {
      assert.equal(
        overviewJson.includes(competitorTeamId),
        false
      );
    }
    const beforeNoop = database.serialize();
    const noopSummary = await runtime.services.league
      .freeAgentDraftReadinessJob.run();
    assert.equal(noopSummary.status, "succeeded");
    assert.equal(noopSummary.due, 0);
    assert.equal(noopSummary.acquired, 0);
    assert.equal(noopSummary.succeeded, 0);
    assert.equal(noopSummary.blocked, 0);
    assert.equal(noopSummary.failed, 0);
    assert.equal(noopSummary.skipped, 0);
    assert.equal(
      beforeNoop.equals(database.serialize()),
      true
    );
    assert.deepEqual(database.pragma("integrity_check"), [
      { integrity_check: "ok" },
    ]);
  });

  for (const delayedWorker of [false, true]) test("holds unfinished cards at the target and fences commissioner processing (delayed worker: " + delayedWorker + ")", async (t) => {
    const database = createDatabase(t);
    let currentTimeMs = NOW_MS;
    const runtime = createTargetRuntime(
      runtimeOptions(database, {
        securityFoundations:
          createSecurityFoundations({
            env: securityEnv(),
            now: () => currentTimeMs,
            loggerSink() {},
          }),
      })
    );
    const scenario = seedComposedLeagueStartScenario(runtime);
    const authenticated =
      runtime.services.sessionService.resolveWithoutActivity(
        scenario.session.rawSessionToken
      );
    const started = runtime.services.league.start.start({
      leagueId: scenario.leagueId,
      input: {},
      expectedLeagueVersion:
        scenario.expectedLeagueVersion,
      idempotencyKey:
        "target-runtime-fad-deadline-start",
      authenticated,
    });
    const firstWeekStartsAtMs = Date.parse(
      "2026-10-12T07:00:00.000Z"
    );
    runtime.services.league.matchupSchedule.generate({
      leagueId: scenario.leagueId,
      seasonId: scenario.seasonId,
      expectedSeasonVersion:
        started.league.currentSeason.version,
      input: {
        nhlRegularSeasonStartsAtMs: Date.parse(
          "2026-10-06T07:00:00.000Z"
        ),
        nhlRegularSeasonEndsAtMs: Date.parse(
          "2027-04-12T07:00:00.000Z"
        ),
        fantasyPlayoffsStartAtMs: Date.parse(
          "2027-03-15T07:00:00.000Z"
        ),
        fantasyPlayoffsEndAtMs: Date.parse(
          "2027-04-12T07:00:00.000Z"
        ),
        firstWeekStartsAtMs,
        confirmed: true,
      },
      idempotencyKey:
        "target-runtime-fad-deadline-schedule",
      authenticated,
    });
    const opening = await runtime.services.league
      .freeAgentDraftReadinessJob.run();
    assert.equal(opening.succeeded, 1);

    const draft = database.prepare(`
      SELECT id, candidate_deadline_at_ms
      FROM free_agent_drafts
      WHERE league_id = ? AND season_id = ?
    `).get(scenario.leagueId, scenario.seasonId);
    const reminderJob = database.prepare(`
      SELECT id, scheduled_for_ms
      FROM job_runs
      WHERE league_id = ? AND season_id = ?
        AND job_type = 'fad_deadline_reminder'
    `).get(scenario.leagueId, scenario.seasonId);

    currentTimeMs = reminderJob.scheduled_for_ms - 1;
    const beforeReminder = database.serialize();
    const earlyReminder = await runtime.services.league
      .freeAgentDraftDeadlineReminderJob.run();
    assert.equal(earlyReminder.due, 0);
    assert.equal(
      beforeReminder.equals(database.serialize()),
      true
    );

    currentTimeMs = reminderJob.scheduled_for_ms;
    const reminder = await runtime.services.league
      .freeAgentDraftDeadlineReminderJob.run();
    assert.deepEqual(
      {
        status: reminder.status,
        due: reminder.due,
        acquired: reminder.acquired,
        succeeded: reminder.succeeded,
        failed: reminder.failed,
        skipped: reminder.skipped,
      },
      {
        status: "succeeded",
        due: 1,
        acquired: 1,
        succeeded: 1,
        failed: 0,
        skipped: 0,
      }
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM notifications
        WHERE league_id = ?
          AND event_type = 'fad_deadline_approaching'
          AND related_record_id = ?
      `).get(scenario.leagueId, draft.id).count,
      4
    );

    currentTimeMs = draft.candidate_deadline_at_ms - 1;
    const beforeDeadline = database.serialize();
    const earlyDeadline = await runtime.services.league
      .freeAgentDraftDeadlineJob.run();
    assert.equal(earlyDeadline.due, 0);
    assert.equal(
      beforeDeadline.equals(database.serialize()),
      true
    );

    currentTimeMs = draft.candidate_deadline_at_ms;
    const cardsBeforeHold = database.prepare("SELECT * FROM candidate_cards WHERE fad_id=? ORDER BY id").all(draft.id);
    const held = await runtime.services.league.freeAgentDraftDeadlineJob.run();
    assert.equal(held.failed, 0);
    assert.equal(held.held, 1);
    assert.equal(held.succeeded, 0);
    assert.deepEqual(database.prepare("SELECT * FROM candidate_cards WHERE fad_id=? ORDER BY id").all(draft.id), cardsBeforeHold);
    assert.equal(database.prepare("SELECT status FROM free_agent_drafts WHERE id=?").get(draft.id).status, "cards_open");
    assert.equal(database.prepare("SELECT COUNT(*) n FROM candidate_card_snapshots WHERE fad_id=?").get(draft.id).n, 0);
    const afterHold = database.serialize();
    assert.equal((await runtime.services.league.freeAgentDraftDeadlineJob.run()).due, 0);
    assert.deepEqual(database.serialize(), afterHold);
    const controlService = runtime.services.league.fadDeadlineControl;
    const controlScope = { leagueId: scenario.leagueId, fadId: draft.id, authenticated };
    const state = controlService.read(controlScope);
    assert.equal(state.held, true);
    assert.equal(state.total, 4);
    assert.equal(state.complete, 0);
    assert.equal(state.canProceed, true);
    assert.equal(state.unfinishedTeams.length, 4);
    const futureDue = runtime.repositories.freeAgentDraftJobs.listDue({
      nowMs: draft.candidate_deadline_at_ms + 10 * 86_400_000, limit: 100,
    });
    assert.equal(futureDue.some(job => ["fad_deadline", "fad_rollover", "fad_completion"].includes(job.jobType)), false);
    const review = controlService.preview({ ...controlScope, input: { reason: "Proceed with the league's agreement" } });
    assert.deepEqual(database.serialize(), afterHold);
    const confirmation = { ...controlScope, input: { reason: review.reason, previewHash: review.previewHash, confirmed: true },
      idempotencyKey: "target-fad-manual-proceed-01" };
    assert.equal(controlService.proceed(confirmation).replayed, false);
    const afterConfirmation = database.serialize();
    assert.equal(controlService.proceed(confirmation).replayed, true);
    assert.deepEqual(database.serialize(), afterConfirmation);
    if (delayedWorker) {
      currentTimeMs = database.prepare("SELECT MIN(rolls_over_at_ms) n FROM free_agent_draft_rollovers WHERE fad_id=?").get(draft.id).n - 3_600_000;
      const lateAttempt = await runtime.services.league.freeAgentDraftDeadlineJob.run();
      assert.equal(lateAttempt.held, 1);
      assert.equal(lateAttempt.failed, 0);
      assert.equal(controlService.read(controlScope).held, true);
      assert.equal(controlService.read(controlScope).canProceed, false);
      assert.deepEqual(database.prepare("SELECT * FROM candidate_cards WHERE fad_id=? ORDER BY id").all(draft.id), cardsBeforeHold);
      assert.equal(database.prepare("SELECT COUNT(*) n FROM candidate_card_snapshots WHERE fad_id=?").get(draft.id).n, 0);
      return;
    }
    const deadline = await runtime.services.league
      .freeAgentDraftDeadlineJob.run();
    assert.deepEqual(
      {
        status: deadline.status,
        due: deadline.due,
        acquired: deadline.acquired,
        succeeded: deadline.succeeded,
        failed: deadline.failed,
        skipped: deadline.skipped,
      },
      {
        status: "succeeded",
        due: 1,
        acquired: 1,
        succeeded: 1,
        failed: 0,
        skipped: 0,
      }
    );
    assert.deepEqual(
      database.prepare(`
        SELECT status, deadline_locked_at_ms,
               allocation_completed_at_ms
        FROM free_agent_drafts
        WHERE id = ?
      `).get(draft.id),
      {
        status: "deadline_locked",
        deadline_locked_at_ms:
          draft.candidate_deadline_at_ms,
        allocation_completed_at_ms: null,
      }
    );
    assert.deepEqual(
      database.prepare(`
        SELECT
          (SELECT COUNT(*) FROM candidate_cards
           WHERE fad_id = ?
             AND status = 'locked_incomplete') AS locked_cards,
          (SELECT COUNT(*) FROM candidate_card_revisions
           WHERE fad_id = ?
             AND action = 'deadline_locked') AS lock_revisions,
          (SELECT COUNT(*) FROM candidate_card_snapshots
           WHERE fad_id = ?) AS snapshots,
          (SELECT COUNT(*) FROM candidate_card_snapshot_entries
           WHERE fad_id = ?) AS snapshot_entries,
          (SELECT COUNT(*) FROM free_agent_draft_player_allocations
           WHERE fad_id = ?) AS allocations,
          (SELECT COUNT(*) FROM job_runs
           WHERE league_id = ? AND season_id = ?
             AND job_type = 'fad_allocation') AS allocation_jobs
      `).get(
        draft.id,
        draft.id,
        draft.id,
        draft.id,
        draft.id,
        scenario.leagueId,
        scenario.seasonId
      ),
      {
        locked_cards: 4,
        lock_revisions: 4,
        snapshots: 4,
        snapshot_entries: 88,
        allocations: 0,
        allocation_jobs: 0,
      }
    );
    const terminalDeadlineJob = database.prepare(`
      SELECT status, completed_at_ms, result_json
      FROM job_runs
      WHERE league_id = ? AND season_id = ?
        AND job_type = 'fad_deadline'
    `).get(scenario.leagueId, scenario.seasonId);
    assert.equal(terminalDeadlineJob.status, "succeeded");
    assert.equal(
      terminalDeadlineJob.completed_at_ms,
      draft.candidate_deadline_at_ms
    );
    assert.equal(
      JSON.parse(terminalDeadlineJob.result_json).code,
      "FAD_DEADLINE_PUBLISHED"
    );
    const allocationLifecycle = await runtime.services.league
      .freeAgentDraftAllocationLifecycleJob.run();
    assert.deepEqual(allocationLifecycle, {
      job: "free-agent-drafts:allocation-lifecycle:target",
      status: "succeeded",
      scanned: 1,
      startedAllocating: 0,
      enteredRapid: 1,
      waiting: 0,
      replayed: 0,
      skipped: 0,
      failed: 0,
    });
    assert.deepEqual(
      database.prepare(`
        SELECT status, allocation_completed_at_ms
        FROM free_agent_drafts
        WHERE id = ?
      `).get(draft.id),
      {
        status: "rapid",
        allocation_completed_at_ms:
          draft.candidate_deadline_at_ms,
      }
    );
    const automaticNotifications = database.prepare(`
      SELECT user_id, message_data_json
      FROM notifications
      WHERE league_id = ?
        AND event_type = 'fad_automatic_result'
        AND related_record_id = ?
      ORDER BY user_id ASC
    `).all(scenario.leagueId, draft.id);
    assert.equal(automaticNotifications.length, 4);
    for (const notification of automaticNotifications) {
      assert.deepEqual(
        JSON.parse(notification.message_data_json),
        {
          leagueId: scenario.leagueId,
          seasonId: scenario.seasonId,
          fadId: draft.id,
          teamId: scenario.teamIds.find((teamId) =>
            database.prepare(`
              SELECT 1
              FROM team_manager_assignments
              WHERE league_id = ?
                AND team_id = ?
                AND user_id = ?
                AND status = 'accepted'
                AND ended_at_ms IS NULL
            `).get(
              scenario.leagueId,
              teamId,
              notification.user_id
            )
          ),
          automaticWins: 0,
          losses: 0,
          restrictedPending: 0,
          invalidOffers: 0,
          destination: {
            kind: "fad_results",
            leagueId: scenario.leagueId,
            fadId: draft.id,
          },
        }
      );
    }
    const beforeRapidReplay = database.serialize();
    assert.deepEqual(
      await runtime.services.league
        .freeAgentDraftAllocationLifecycleJob.run(),
      {
        job: "free-agent-drafts:allocation-lifecycle:target",
        status: "succeeded",
        scanned: 0,
        startedAllocating: 0,
        enteredRapid: 0,
        waiting: 0,
        replayed: 0,
        skipped: 0,
        failed: 0,
      }
    );
    assert.equal(
      beforeRapidReplay.equals(database.serialize()),
      true
    );
    const published = runtime.services.league
      .freeAgentDraftRead.publishedCardSummaries({
        leagueId: scenario.leagueId,
        fadId: draft.id,
        authenticated,
        query: {},
      });
    assert.equal(published.data.length, 4);
    assert.deepEqual(database.pragma("integrity_check"), [
      { integrity_check: "ok" },
    ]);
  });

  test('auction timing HTTP controls enforce private commissioner and admin review with safe retries', async t => {
    const database = createDatabase(t), runtime = createTargetRuntime(runtimeOptions(database));
    const scenario = seedComposedLeagueStartScenario(runtime), repositories = runtime.repositories.context.repositories;
    const commissioner = runtime.services.sessionService.issueForUser({ userId: scenario.commissionerUserId });
    const authenticated = runtime.services.sessionService.resolveWithoutActivity(commissioner.rawSessionToken);
    runtime.services.league.start.start({ leagueId:scenario.leagueId,input:{},expectedLeagueVersion:scenario.expectedLeagueVersion,
      idempotencyKey:'auction-timing-league-start',authenticated });
    const playerId=uuid(995001),auctionId=uuid(995002),oldClose=NOW_MS+86400000;
    repositories.players.insert({id:playerId,first_name:'Clock',last_name:'Fixture',full_name:'Clock Fixture',birth_date:null,status:'active',
      created_at_ms:NOW_MS,updated_at_ms:NOW_MS,version:1});
    repositories.auctions.insert({id:auctionId,league_id:scenario.leagueId,season_id:scenario.seasonId,player_id:playerId,status:'open',
      opened_at_ms:NOW_MS,resolves_at_ms:oldClose,opened_by_user_id:scenario.commissionerUserId,created_at_ms:NOW_MS,updated_at_ms:NOW_MS,version:1});
    repositories.auction_contexts.insert({id:auctionId,league_id:scenario.leagueId,season_id:scenario.seasonId,auction_id:auctionId,source_kind:'ordinary_weekly',
      fad_id:null,fad_rollover_id:null,fad_allocation_id:null,created_at_ms:NOW_MS});
    const managerId=database.prepare("SELECT user_id FROM team_manager_assignments WHERE league_id=? AND user_id<>? AND status='accepted' LIMIT 1").get(scenario.leagueId,scenario.commissionerUserId).user_id;
    const manager=runtime.services.sessionService.issueForUser({userId:managerId}),origin=await startRuntimeApp(t,runtime);
    const url=origin+'/api/v1/leagues/'+scenario.leagueId+'/auctions/'+auctionId+'/timing';
    const headersFor=s=>browserHeaders({Cookie:runtime.transport.sessionCookie.name+'='+s.rawSessionToken,'X-CSRF-Token':s.rawCsrfToken});
    const headers=headersFor(commissioner),proposed={closesAtMs:oldClose+3600000,reason:'Managers requested more time'};
    const before=database.serialize();
    assert.equal((await fetch(url,{headers:browserHeaders()})).status,401);
    assert.equal((await fetch(url,{headers:headersFor(manager)})).status,403);
    assert.equal((await fetch(url+'/preview',{method:'POST',headers:{...headers,'X-CSRF-Token':'bad'},body:JSON.stringify(proposed)})).status,403);
    assert.equal((await fetch(url.replace(auctionId,uuid(995003)),{headers})).status,404);
    const read=await fetch(url,{headers}); assert.equal(read.status,200); assert.match(read.headers.get('cache-control'),/no-store/);
    const status=(await read.json()).data; assert.equal(status.canEdit,true);
    assert.deepEqual(Object.keys(status).sort(),['leagueId','auctionId','timeZone','closesAtMs','playoffsAtMs','seasonEndsAtMs','serverNowMs','canEdit','blockedReason','history'].sort());
    const previewResponse=await fetch(url+'/preview',{method:'POST',headers,body:JSON.stringify(proposed)});
    assert.equal(previewResponse.status,200,JSON.stringify(await previewResponse.clone().json()));
    const preview=(await previewResponse.json()).data;
    assert.deepEqual(database.serialize(),before);
    const body={...proposed,confirmed:true,previewHash:preview.previewHash},applyHeaders={...headers,'Idempotency-Key':'auction-timing-http'};
    const applied=await fetch(url+'/apply',{method:'POST',headers:applyHeaders,body:JSON.stringify(body)});
    assert.equal(applied.status,200,JSON.stringify(await applied.json()));
    const after=database.serialize();
    assert.equal((await (await fetch(url+'/apply',{method:'POST',headers:applyHeaders,body:JSON.stringify(body)})).json()).data.replayed,true);
    assert.deepEqual(database.serialize(),after);
    assert.equal((await fetch(url+'/apply',{method:'POST',headers:{...applyHeaders,'Idempotency-Key':'stale-timing-http'},body:JSON.stringify({...body,closesAtMs:body.closesAtMs+1})})).status,409);
    repositories.platform_roles.insert({id:uuid(995004),user_id:managerId,role:'platform_administrator',status:'active',granted_by_user_id:null,
      granted_at_ms:NOW_MS,ended_at_ms:null,version:1});
    const adminHeaders=headersFor(manager),shorter={closesAtMs:oldClose+1800000,reason:'Administrator confirms revised time'};
    const adminPreview=await fetch(url+'/preview',{method:'POST',headers:adminHeaders,body:JSON.stringify(shorter)});
    const adminReview=(await adminPreview.json()).data; assert.equal(adminPreview.status,200); assert.equal(adminReview.shortened,true);
    const adminApply=await fetch(url+'/apply',{method:'POST',headers:{...adminHeaders,'Idempotency-Key':'admin-auction-time'},body:JSON.stringify({...shorter,confirmed:true,previewHash:adminReview.previewHash})});
    assert.equal(adminApply.status,200,JSON.stringify(await adminApply.json()));
    assert.equal(database.prepare("SELECT COUNT(*) n FROM auction_timing_changes WHERE actor_authority='platform_administrator'").get().n,1);
    assert.equal((await (await fetch(url,{headers})).json()).data.history.length,2);
    assert.deepEqual(database.pragma('foreign_key_check'),[]); assert.equal(database.pragma('integrity_check',{simple:true}),'ok');
  });

  test('league pause and resume preserve records and clocks, reject stale work and require current HTTP authority',async t=>{
    const database=createDatabase(t);let time=NOW_MS;
    const runtime=createTargetRuntime(runtimeOptions(database,{securityFoundations:createSecurityFoundations({env:securityEnv(),now:()=>time,loggerSink(){}})}));
    const scenario=seedComposedLeagueStartScenario(runtime),jobId=uuid(985001),other=uuid(985002);
    const repos=runtime.repositories.context.repositories;
    repos.leagues.insert({id:other,name:'Unpaused league',name_normalized:'unpaused league',status:'setup',timezone:'America/Vancouver',commissioner_membership_id:null,current_season_id:null,created_at_ms:NOW_MS,updated_at_ms:NOW_MS,version:1});
    const insertJob=database.prepare(`INSERT INTO job_runs(id,league_id,season_id,job_type,occurrence_key,scheduled_for_ms,status,attempt_count,created_at_ms,updated_at_ms,version)
      VALUES(?,?,?,'fixture:pause',?,?,'pending',0,?,?,1)`);
    insertJob.run(jobId,scenario.leagueId,scenario.seasonId,'pause-main',NOW_MS+500,NOW_MS,NOW_MS);
    insertJob.run(uuid(985003),other,null,'pause-other',NOW_MS,NOW_MS,NOW_MS);
    const managerId=database.prepare("SELECT user_id FROM team_manager_assignments WHERE league_id=? AND user_id<>? AND status='accepted' LIMIT 1").get(scenario.leagueId,scenario.commissionerUserId).user_id;
    const commissioner=runtime.services.sessionService.issueForUser({userId:scenario.commissionerUserId}),manager=runtime.services.sessionService.issueForUser({userId:managerId});
    const origin=await startRuntimeApp(t,runtime),url=origin+'/api/v1/leagues/'+scenario.leagueId+'/management/pause';
    const headersFor=s=>browserHeaders({Cookie:runtime.transport.sessionCookie.name+'='+s.rawSessionToken,'X-CSRF-Token':s.rawCsrfToken}),headers=headersFor(commissioner);
    const post=(suffix,body,h=headers)=>fetch(url+suffix,{method:'POST',headers:h,body:JSON.stringify(body)});
    const proposed={action:'pause',reason:'Review a timing issue before competition continues'},before=database.serialize();
    assert.equal((await fetch(url,{headers:browserHeaders()})).status,401);assert.equal((await fetch(url,{headers:headersFor(manager)})).status,403);
    assert.equal((await fetch(url+'/status',{headers:headersFor(manager)})).status,200);
    assert.equal((await fetch(url.replace(scenario.leagueId,other),{headers})).status,404);
    assert.equal((await post('/preview',proposed,{...headers,'X-CSRF-Token':'bad'})).status,403);
    assert.equal((await post('/preview',proposed,headersFor(manager))).status,403);
    const previewResponse=await post('/preview',proposed);assert.equal(previewResponse.status,200,JSON.stringify(await previewResponse.clone().json()));
    const preview=(await previewResponse.json()).data;assert.equal(preview.impacts.pendingJobs,1);assert.equal(preview.overdue,false);assert.deepEqual(database.serialize(),before);
    const body={...proposed,confirmed:true,previewHash:preview.previewHash},applyHeaders={...headers,'Idempotency-Key':'league-pause-http'};
    database.prepare("UPDATE job_runs SET status='running',lease_owner='fixture',lease_expires_at_ms=?,attempt_count=1,version=version+1 WHERE id=?").run(NOW_MS+1000,jobId);
    assert.equal((await post('/apply',body,applyHeaders)).status,409);
    database.prepare("UPDATE job_runs SET status='pending',lease_owner=NULL,lease_expires_at_ms=NULL,attempt_count=0,version=1 WHERE id=?").run(jobId);
    database.exec("CREATE TRIGGER test_pause_failure BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'synthetic notice failure'); END");
    const failBefore=database.serialize();assert.equal((await post('/apply',body,applyHeaders)).status,500);assert.deepEqual(database.serialize(),failBefore);database.exec('DROP TRIGGER test_pause_failure');
    const tables=database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name);
    const rows=()=>Object.fromEntries(tables.map(name=>[name,database.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all()])),protectedBefore=rows();
    const applied=await post('/apply',body,applyHeaders);assert.equal(applied.status,200,JSON.stringify(await applied.clone().json()));
    const changed=new Set(['leagues','league_freezes','league_management_actions','league_activity','notifications','outbox_events','outbox_event_audiences']);
    const after=rows();for(const table of tables)if(!changed.has(table))assert.deepEqual(after[table],protectedBefore[table],table);
    assert.equal(database.prepare('SELECT status FROM leagues WHERE id=?').get(scenario.leagueId).status,'frozen');
    const bytes=database.serialize();assert.equal((await(await post('/apply',body,applyHeaders)).json()).data.replayed,true);assert.deepEqual(database.serialize(),bytes);
    assert.throws(()=>database.prepare("UPDATE job_runs SET status='running' WHERE id=?").run(jobId),/paused/);
    assert.throws(()=>database.prepare(`INSERT INTO job_runs(id,league_id,season_id,job_type,occurrence_key,scheduled_for_ms,status,created_at_ms,updated_at_ms)
      VALUES(?,?,?,'fixture:paused','must-not-claim',?,'running',?,?)`).run(uuid(985004),scenario.leagueId,scenario.seasonId,NOW_MS,NOW_MS,NOW_MS),/paused/);
    database.prepare("UPDATE job_runs SET status='running' WHERE id=?").run(uuid(985003));
    const rosterResponse=await fetch(origin+'/api/v1/leagues/'+scenario.leagueId+'/teams/'+scenario.teamIds[0]+'/roster/'+uuid(985005)+'/move',{
      method:'POST',headers,body:JSON.stringify({destinationCategory:'Bench',expectedVersion:1,confirmedIllegal:true})});
    assert.equal(rosterResponse.status,409);assert.equal((await rosterResponse.json()).error.code,'LEAGUE_COMPETITION_PAUSED');
    const resumeInput={action:'resume',reason:'Timing reviewed; continue using saved deadlines'};
    const oldPreview=(await(await post('/preview',resumeInput)).json()).data;time=NOW_MS+1000;
    assert.equal((await post('/apply',{...resumeInput,confirmed:true,previewHash:oldPreview.previewHash},{...headers,'Idempotency-Key':'league-resume-stale'})).status,409);
    const resumePreview=(await(await post('/preview',resumeInput)).json()).data;assert.equal(resumePreview.impacts.dueJobs,1);assert.equal(resumePreview.overdue,true);
    const resumeBody={...resumeInput,confirmed:true,previewHash:resumePreview.previewHash},resumeHeaders={...headers,'Idempotency-Key':'league-resume-http'};
    const resume=await post('/apply',resumeBody,resumeHeaders);assert.equal(resume.status,200,JSON.stringify(await resume.clone().json()));
    assert.equal(database.prepare('SELECT status FROM leagues WHERE id=?').get(scenario.leagueId).status,'setup');
    assert.equal(database.prepare('SELECT scheduled_for_ms FROM job_runs WHERE id=?').get(jobId).scheduled_for_ms,NOW_MS+500);
    assert.equal(database.prepare('SELECT status FROM league_freezes WHERE league_id=?').get(scenario.leagueId).status,'ended');
    assert.equal((await(await post('/apply',resumeBody,resumeHeaders)).json()).data.replayed,true);
    database.prepare("UPDATE job_runs SET status='running' WHERE id=?").run(jobId);assert.deepEqual(database.pragma('foreign_key_check'),[]);
    database.prepare("INSERT INTO platform_roles(id,user_id,role,status,granted_by_user_id,granted_at_ms,ended_at_ms,version) VALUES(?,?,'platform_administrator','active',?,?,NULL,1)").run(uuid(985006),managerId,scenario.commissionerUserId,NOW_MS);
    assert.equal((await fetch(url,{headers:headersFor(manager)})).status,200);
    database.prepare("UPDATE platform_roles SET status='ended',ended_at_ms=?,version=version+1 WHERE id=?").run(time,uuid(985006));assert.equal((await fetch(url,{headers:headersFor(manager)})).status,403);
  });

  test('missing pick repair migrates populated records, previews owners and commits atomically through authenticated HTTP',async t=>{
    const database=createDatabase(t,{migrated:false}),migrations=discoverMigrations({migrationsDirectory:MIGRATIONS_DIRECTORY});
    const migrate=list=>applyMigrations({database,migrations:list,applicationBuildId:'pick-repair-test',now:()=>NOW_MS});
    migrate(migrations.filter(m=>m.id<=78));
    const oldDir=path.join(path.dirname(database.name),'pick-repair-schema78');fs.mkdirSync(oldDir);
    for(const m of migrations.filter(m=>m.id<=78))fs.copyFileSync(path.join(MIGRATIONS_DIRECTORY,m.fileName),path.join(oldDir,m.fileName));
    let runtime=createTargetRuntime(runtimeOptions(database,{migrationsDirectory:oldDir}));
    const scenario=seedComposedLeagueStartScenario(runtime),draftId=uuid(986002),otherLeague=uuid(986003);
    const repos=runtime.repositories.context.repositories;
    repos.leagues.insert({id:otherLeague,name:'Other repair league',name_normalized:'other repair league',status:'setup',timezone:'America/Vancouver',commissioner_membership_id:null,current_season_id:null,created_at_ms:NOW_MS,updated_at_ms:NOW_MS,version:1});
    repos.entry_drafts.insert({id:draftId,league_id:scenario.leagueId,season_id:scenario.seasonId,status:'setup',rounds:4,pick_clock_seconds:300,starts_at_ms:null,completed_at_ms:null,created_by_user_id:scenario.commissionerUserId,created_at_ms:NOW_MS,updated_at_ms:NOW_MS,version:1});
    for(let round=1;round<=4;round++)for(let team=0;team<4;team++){
      if(round===4&&team===3)continue;
      repos.draft_picks.insert({id:uuid(986010+round*10+team),league_id:scenario.leagueId,draft_id:draftId,target_season_id:scenario.seasonId,round_number:round,position_number:team+1,
        original_team_id:scenario.teamIds[team],current_owner_team_id:scenario.teamIds[1],status:'unused',selection_id:null,created_at_ms:NOW_MS,updated_at_ms:NOW_MS,version:1});
    }
    const tables=database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations','application_metadata') ORDER BY name").all().map(r=>r.name);
    const rows=()=>Object.fromEntries(tables.map(name=>[name,database.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all()]));
    const original=rows(),objects=database.prepare("SELECT name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name").all();
    migrate(migrations.filter(m=>m.id<=79));assert.deepEqual(rows(),original);
    for(const row of objects)assert.equal(database.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(row.name).sql,row.sql);
    migrate(migrations);
    runtime=createTargetRuntime(runtimeOptions(database));
    const commissioner=runtime.services.sessionService.issueForUser({userId:scenario.commissionerUserId});
    const managerId=database.prepare("SELECT user_id FROM team_manager_assignments WHERE league_id=? AND user_id<>? AND status='accepted' LIMIT 1").get(scenario.leagueId,scenario.commissionerUserId).user_id;
    const manager=runtime.services.sessionService.issueForUser({userId:managerId}),origin=await startRuntimeApp(t,runtime);
    const url=origin+'/api/v1/leagues/'+scenario.leagueId+'/management/picks',headersFor=s=>browserHeaders({Cookie:runtime.transport.sessionCookie.name+'='+s.rawSessionToken,'X-CSRF-Token':s.rawCsrfToken});
    const headers=headersFor(commissioner),before=database.serialize();
    assert.equal((await fetch(url,{headers:browserHeaders()})).status,401);assert.equal((await fetch(url,{headers:headersFor(manager)})).status,403);
    assert.equal((await fetch(url.replace(scenario.leagueId,otherLeague),{headers})).status,404);
    const get=await fetch(url,{headers});assert.equal(get.status,200,JSON.stringify(await get.clone().json()));
    const read=(await get.json()).data;assert.equal(read.drafts[0].missing.length,1);assert.equal(read.drafts[0].missing[0].round,4);
    const proposed={draftId,owners:[{teamId:scenario.teamIds[3],round:4,ownerTeamId:scenario.teamIds[1]}],reason:'Restore the omitted fourth-round pick to its agreed owner'};
    const post=(suffix,body,h=headers)=>fetch(url+suffix,{method:'POST',headers:h,body:JSON.stringify(body)});
    assert.equal((await post('/preview',proposed,{...headers,'X-CSRF-Token':'bad'})).status,403);
    assert.equal((await post('/preview',proposed,headersFor(manager))).status,403);
    assert.equal((await post('/preview',{...proposed,owners:[]})).status,409);
    const response=await post('/preview',proposed);assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
    const preview=(await response.json()).data;assert.equal(preview.preservedCount,15);assert.equal(preview.additions[0].ownerTeamId,scenario.teamIds[1]);assert.deepEqual(database.serialize(),before);
    const body={...proposed,confirmed:true,previewHash:preview.previewHash},writeHeaders={...headers,'Idempotency-Key':'pick-repair-http'};
    database.exec("CREATE TRIGGER test_pick_failure BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'synthetic notice failure'); END");
    const failureBefore=database.serialize();assert.equal((await post('/apply',body,writeHeaders)).status,500);assert.deepEqual(database.serialize(),failureBefore);database.exec('DROP TRIGGER test_pick_failure');
    const protectedBefore=rows(),applied=await post('/apply',body,writeHeaders);assert.equal(applied.status,200,JSON.stringify(await applied.clone().json()));
    const changed=new Set(['draft_picks','draft_pick_ownership_events','entry_drafts','leagues','league_activity','notifications','outbox_event_audiences','outbox_events']);
    const afterRows=rows();for(const table of tables)if(!changed.has(table))assert.deepEqual(afterRows[table],protectedBefore[table],table);
    for(const pick of original.draft_picks)assert.deepEqual(database.prepare('SELECT * FROM draft_picks WHERE id=?').get(pick.id),pick);
    const added=database.prepare('SELECT * FROM draft_picks WHERE original_team_id=? AND round_number=4 AND draft_id=?').get(scenario.teamIds[3],draftId);
    assert.equal(added.current_owner_team_id,scenario.teamIds[1]);assert.equal(added.status,'unused');assert.equal(added.position_number,4);
    assert.equal(database.prepare('SELECT count(*) AS n FROM draft_pick_ownership_events WHERE draft_pick_id=?').get(added.id).n,1);
    const bytes=database.serialize();assert.equal((await(await post('/apply',body,writeHeaders)).json()).data.replayed,true);assert.deepEqual(database.serialize(),bytes);
    assert.equal((await post('/apply',{...body,reason:'Different correction'},writeHeaders)).status,409);
    assert.equal((await post('/apply',body,{...headers,'Idempotency-Key':'new-stale-pick-key'})).status,409);
    assert.throws(()=>database.exec("UPDATE league_management_actions SET reason='altered'"),/immutable/);
    assert.throws(()=>database.exec('DELETE FROM league_management_actions'),/immutable/);assert.deepEqual(database.pragma('foreign_key_check'),[]);
    const history=(await(await fetch(origin+'/api/v1/leagues/'+scenario.leagueId+'/management/history?kind=pick_repair',{headers})).json()).data;
    assert.equal(history.changes.length,1);assert.equal(history.changes[0].after.added[0].ownerName,preview.additions[0].ownerName);
    database.prepare("INSERT INTO platform_roles(id,user_id,role,status,granted_by_user_id,granted_at_ms,ended_at_ms,version) VALUES(?,?,'platform_administrator','active',?,?,NULL,1)").run(uuid(986600),managerId,scenario.commissionerUserId,NOW_MS);
    assert.equal((await fetch(url,{headers:headersFor(manager)})).status,200);
    database.prepare("UPDATE platform_roles SET status='ended',ended_at_ms=?,version=version+1 WHERE id=?").run(NOW_MS,uuid(986600));
    assert.equal((await fetch(url,{headers:headersFor(manager)})).status,403);
  });

  test('management reports are readonly, scoped, searchable before pagination and exclude private contents',async t=>{
    const database=createDatabase(t),runtime=createTargetRuntime(runtimeOptions(database)),scenario=seedComposedLeagueStartScenario(runtime);
    const repositories=runtime.repositories.context.repositories,otherLeague=uuid(987001),draftId=uuid(987002);
    repositories.leagues.insert({id:otherLeague,name:'Other private league',name_normalized:'other private league',status:'setup',timezone:'America/Vancouver',commissioner_membership_id:null,current_season_id:null,created_at_ms:NOW_MS,updated_at_ms:NOW_MS,version:1});
    repositories.entry_drafts.insert({id:draftId,league_id:scenario.leagueId,season_id:scenario.seasonId,status:'setup',rounds:4,pick_clock_seconds:300,starts_at_ms:null,completed_at_ms:null,created_by_user_id:scenario.commissionerUserId,created_at_ms:NOW_MS,updated_at_ms:NOW_MS,version:1});
    for(let round=1;round<=4;round++)for(let team=0;team<scenario.teamIds.length;team++){
      if(round===4&&team===3)continue;
      repositories.draft_picks.insert({id:uuid(987010+round*10+team),league_id:scenario.leagueId,draft_id:draftId,target_season_id:scenario.seasonId,
        round_number:round,position_number:team+1,original_team_id:scenario.teamIds[team],current_owner_team_id:scenario.teamIds[team===0?1:team],status:'unused',selection_id:null,created_at_ms:NOW_MS,updated_at_ms:NOW_MS,version:1});
    }
    database.prepare("UPDATE team_manager_assignments SET status='ended',ended_at_ms=?,version=version+1 WHERE league_id=? AND team_id=? AND status='accepted'").run(NOW_MS,scenario.leagueId,scenario.teamIds[3]);
    const insert=database.prepare('INSERT INTO commissioner_corrections(id,league_id,season_id,feature,feature_record_id,actor_user_id,reason,before_snapshot_json,after_snapshot_json,corrected_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?)');
    for(let i=0;i<52;i++)insert.run(uuid(987100+i),scenario.leagueId,scenario.seasonId,'roster',uuid(987500+i),scenario.commissionerUserId,i===0?'Specialneedle correction':'Reviewed correction '+i,
      JSON.stringify({privateCanary:'DO_NOT_EXPORT_BID_999'}),JSON.stringify({candidateCanary:'DO_NOT_EXPORT_CARD_PLAYER'}),NOW_MS);
    insert.run(uuid(987201),otherLeague,null,'roster',uuid(987202),scenario.commissionerUserId,'Other league secret reason','{}','{}',NOW_MS);
    insert.run(uuid(987203),scenario.leagueId,scenario.seasonId,'auction',uuid(987204),scenario.commissionerUserId,'Hidden auction bid editing','{}','{}',NOW_MS);
    for(let i=0;i<101;i++)database.prepare(`INSERT INTO job_runs(id,league_id,season_id,job_type,occurrence_key,scheduled_for_ms,status,attempt_count,created_at_ms,updated_at_ms,version)
      VALUES(?,?,?,'fixture:report',?,?,'failed',1,?,?,1)`).run(uuid(987700+i),scenario.leagueId,scenario.seasonId,'failed-report-'+i,NOW_MS,NOW_MS,NOW_MS);
    const commissioner=runtime.services.sessionService.issueForUser({userId:scenario.commissionerUserId});
    const managerId=database.prepare("SELECT user_id FROM team_manager_assignments WHERE league_id=? AND user_id<>? AND status='accepted' LIMIT 1").get(scenario.leagueId,scenario.commissionerUserId).user_id;
    const manager=runtime.services.sessionService.issueForUser({userId:managerId}),origin=await startRuntimeApp(t,runtime);
    const base=origin+'/api/v1/leagues/'+scenario.leagueId+'/management/',headersFor=s=>browserHeaders({Cookie:runtime.transport.sessionCookie.name+'='+s.rawSessionToken,'X-CSRF-Token':s.rawCsrfToken});
    const headers=headersFor(commissioner),before=database.serialize();
    for(const endpoint of ['readiness','history','export','recovery','season-preview']){
      assert.equal((await fetch(base+endpoint,{headers:browserHeaders()})).status,401);
      assert.equal((await fetch(base+endpoint,{headers:headersFor(manager)})).status,403);
      assert.equal((await fetch((base+endpoint).replace(scenario.leagueId,otherLeague),{headers})).status,404);
    }
    const read=await fetch(base+'readiness',{headers});assert.equal(read.status,200,JSON.stringify(await read.clone().json()));assert.match(read.headers.get('cache-control'),/no-store/);
    const readiness=(await read.json()).data;assert.equal(readiness.summary.teams,4);assert.equal(readiness.summary.missingManagers,1);
    assert.equal(readiness.summary.missingPicks,1);assert.equal(readiness.missingPicks[0].teamId,scenario.teamIds[3]);assert.equal(readiness.missingPicks[0].round,4);
    assert.equal(readiness.summary.illegalRosters,0);assert.equal(readiness.teams[0].roster.legal,false);assert.equal(readiness.teams[0].roster.requiredNow,false);
    assert.equal(readiness.summary.operations,101);assert.equal(readiness.operations.length,100);assert.equal(Object.hasOwn(readiness.operations[0],'total'),false);
    const seasonResponse=await fetch(base+'season-preview',{headers});assert.equal(seasonResponse.status,200,JSON.stringify(await seasonResponse.clone().json()));
    const seasonPreview=(await seasonResponse.json()).data;assert.equal(seasonPreview.readOnly,true);assert.equal(seasonPreview.source.id,scenario.seasonId);assert.ok(seasonPreview.issues.includes('SOURCE_DRAFT_UNFINISHED'));
    const recoveryResponse=await fetch(base+'recovery',{headers});assert.equal(recoveryResponse.status,200,JSON.stringify(await recoveryResponse.clone().json()));
    const recovery=(await recoveryResponse.json()).data;assert.equal(recovery.operationCount,101);assert.equal(recovery.operations.length,100);assert.equal(recovery.seasonId,scenario.seasonId);assert.deepEqual(recovery.trades,[]);
    const historyResponse=await fetch(base+'history',{headers});assert.equal(historyResponse.status,200,JSON.stringify(await historyResponse.clone().json()));
    const history=(await historyResponse.json()).data;assert.equal(history.changes.length,50);assert.equal(history.page.hasMore,true);
    const next=(await(await fetch(base+'history?cursor='+history.page.nextCursor,{headers})).json()).data;
    assert.equal(next.changes.length,2);assert.equal(next.page.hasMore,false);assert.equal(new Set([...history.changes,...next.changes].map(c=>c.id)).size,52);
    const filtered=(await(await fetch(base+'history?q=SPECIALNEEDLE',{headers})).json()).data;assert.equal(filtered.changes.length,1);
    assert.equal((await fetch(base+'history?q=different&cursor='+history.page.nextCursor,{headers})).status,400);
    assert.equal((await fetch(base+'history?kind=unknown',{headers})).status,400);
    assert.equal((await(await fetch(base+'history?q=DO_NOT_EXPORT',{headers})).json()).data.changes.length,0);
    const exported=await fetch(base+'export',{headers});assert.equal(exported.status,200,JSON.stringify(await exported.clone().json()));
    const data=(await exported.json()).data;assert.equal(data.format,'hundo-league-export-v1');assert.equal(data.picks.length,15);
    assert.equal(data.teams.length,4);assert.equal(data.picks.find(p=>p.originalTeamId===scenario.teamIds[0]).ownerTeamId,scenario.teamIds[1]);
    assert.deepEqual(Object.keys(data).sort(),['excluded','format','generatedAtMs','league','leagueId','notice','picks','results','rosters','scope','season','teams']);
    for(const output of [readiness,history,next,data,recovery,seasonPreview])assert.doesNotMatch(JSON.stringify(output),/DO_NOT_EXPORT|Other league secret|Hidden auction bid/);
    assert.deepEqual(database.serialize(),before);assert.deepEqual(database.pragma('foreign_key_check'),[]);
    database.prepare("INSERT INTO platform_roles(id,user_id,role,status,granted_by_user_id,granted_at_ms,ended_at_ms,version) VALUES(?,?,'platform_administrator','active',?,?,NULL,1)").run(uuid(987600),managerId,scenario.commissionerUserId,NOW_MS);
    assert.equal((await fetch(base+'export',{headers:headersFor(manager)})).status,200);
    database.prepare("UPDATE platform_roles SET status='ended',ended_at_ms=?,version=version+1 WHERE id=?").run(NOW_MS,uuid(987600));
    assert.equal((await fetch(base+'export',{headers:headersFor(manager)})).status,403);
  });

  test('league scoring HTTP preserves existing rows, audits reviewed changes and applies league weights before pagination',async t=>{
    const {defaultScoringWeights,emptyScoringStats,calculateExpandedScore}=require('../../src/domain/statistics/expandedScoringPolicy');
    const {createLeagueScoringRuleReader}=require('../../src/infrastructure/persistence/sqlite/leagueScoringRules');
    const database=createDatabase(t,{migrated:false}),migrations=discoverMigrations({migrationsDirectory:MIGRATIONS_DIRECTORY});
    const migrate=list=>applyMigrations({database,migrations:list,applicationBuildId:'scoring-test',now:()=>NOW_MS});
    migrate(migrations.filter(m=>m.id<=77));
    const oldDir=path.join(path.dirname(database.name),'scoring-schema77');fs.mkdirSync(oldDir);
    for(const m of migrations.filter(m=>m.id<=77))fs.copyFileSync(path.join(MIGRATIONS_DIRECTORY,m.fileName),path.join(oldDir,m.fileName));
    let time=NOW_MS;
    const options={securityFoundations:createSecurityFoundations({env:securityEnv(),now:()=>time,loggerSink(){}}),
      nhlCompletedStatisticsEnabled:true,expandedScoringEnabled:true,nhlFetchImplementation:async()=>{throw Error('Network forbidden in scoring fixtures');}};
    let runtime=createTargetRuntime(runtimeOptions(database,{...options,migrationsDirectory:oldDir}));
    const scenario=seedComposedLeagueStartScenario(runtime);
    const tables=database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations','application_metadata') ORDER BY name").all().map(r=>r.name);
    const rows=()=>Object.fromEntries(tables.map(name=>[name,database.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all()]));
    const priorRows=rows(),objects=database.prepare("SELECT name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name").all();
    migrate(migrations.filter(m=>m.id<=78));assert.deepEqual(rows(),priorRows);
    for(const row of objects)assert.equal(database.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(row.name).sql,row.sql);
    migrate(migrations);
    runtime=createTargetRuntime(runtimeOptions(database,options));
    const sourceId=uuid(988001),refreshId=uuid(988002),firstId=uuid(988003),secondId=uuid(988004);
    database.prepare("INSERT INTO stat_sources(id,provider,status,created_at_ms,updated_at_ms,version) VALUES(?,'nhl-completed-games','active',?,?,1)").run(sourceId,NOW_MS,NOW_MS);
    database.prepare("INSERT INTO stat_refreshes(id,stat_source_id,nhl_season_key,source_version,status,started_at_ms,completed_at_ms,player_count,error_code,metadata_json,version) VALUES(?,?,'20262027','scoring-fixture','succeeded',?,?,2,NULL,NULL,1)").run(refreshId,sourceId,NOW_MS,NOW_MS);
    database.prepare("INSERT INTO expanded_stat_refreshes(refresh_id,scoring_rule_version,evidence_sha256,total_count,observation_count) VALUES(?,'expanded-2026-v1',?,2,0)").run(refreshId,'a'.repeat(64));
    for(const [index,playerId,name,hits,goals]of [[0,firstId,'Hit Leader',20,0],[1,secondId,'Goal Leader',0,1]]){
      database.prepare("INSERT INTO players(id,first_name,last_name,full_name,birth_date,status,created_at_ms,updated_at_ms,version) VALUES(?,?,?,?,NULL,'active',?,?,1)").run(playerId,name.split(' ')[0],'Leader',name,NOW_MS,NOW_MS);
      database.prepare("INSERT INTO player_source_state(id,player_id,provider,source_position,normalized_position,nhl_team_abbreviation,active,source_version,effective_at_ms,created_at_ms) VALUES(?,?,'scoring-fixture','F','F','VAN',1,'fixture',?,?)").run(uuid(988010+index),playerId,NOW_MS,NOW_MS);
      const totalId=uuid(988020+index),stats={...emptyScoringStats(),hits,evenStrengthGoals:goals};
      const points=calculateExpandedScore(stats,'F').fantasyPointsHundredths;
      database.prepare("INSERT INTO player_stat_totals(id,stat_source_id,refresh_id,nhl_season_key,player_id,games_played,goals,assists,nhl_points,fantasy_points_hundredths,source_updated_at_ms,created_at_ms) VALUES(?,?,?,'20262027',?,1,?,0,?,?,?,?)").run(totalId,sourceId,refreshId,playerId,goals,goals,points,NOW_MS,NOW_MS);
      database.prepare('INSERT INTO expanded_stat_totals(total_id,refresh_id,provider_player_id,stats_json,forward_fp_hundredths,defence_fp_hundredths) VALUES(?,?,?,?,?,?)').run(totalId,refreshId,String(index+1),JSON.stringify(stats),points,calculateExpandedScore(stats,'D').fantasyPointsHundredths);
    }
    const commissioner=runtime.services.sessionService.issueForUser({userId:scenario.commissionerUserId});
    const managerId=database.prepare("SELECT user_id FROM team_manager_assignments WHERE league_id=? AND user_id<>? AND status='accepted' LIMIT 1").get(scenario.leagueId,scenario.commissionerUserId).user_id;
    const manager=runtime.services.sessionService.issueForUser({userId:managerId}),origin=await startRuntimeApp(t,runtime);
    const url=origin+'/api/v1/leagues/'+scenario.leagueId+'/scoring',playersUrl=origin+'/api/v1/leagues/'+scenario.leagueId+'/players?sort=fantasyPoints&limit=1';
    const headersFor=s=>browserHeaders({Cookie:runtime.transport.sessionCookie.name+'='+s.rawSessionToken,'X-CSRF-Token':s.rawCsrfToken});
    const headers=headersFor(commissioner),weights=defaultScoringWeights();weights.F.hits=5;weights.D.hits=10;
    const input={weights,effectiveWeekSequence:1,comparisonWeekId:null,reason:'Managers voted to reduce hits'};
    const before=database.serialize();
    assert.equal((await fetch(url,{headers:browserHeaders()})).status,401);
    assert.equal((await fetch(url,{headers:headersFor(manager)})).status,403);
    assert.equal((await fetch(url+'/rules',{headers:headersFor(manager)})).status,200);
    assert.equal((await fetch(url.replace(scenario.leagueId,uuid(988999)),{headers})).status,404);
    assert.equal((await fetch(url+'/preview',{method:'POST',headers:{...headers,'X-CSRF-Token':'bad'},body:JSON.stringify(input)})).status,403);
    const oldPlayers=await fetch(playersUrl,{headers});assert.equal(oldPlayers.status,200,JSON.stringify(await oldPlayers.clone().json()));
    assert.equal((await oldPlayers.json()).data[0].id,firstId);
    const previewResponse=await fetch(url+'/preview',{method:'POST',headers,body:JSON.stringify(input)});
    assert.equal(previewResponse.status,200,JSON.stringify(await previewResponse.clone().json()));
    const preview=(await previewResponse.json()).data;assert.match(previewResponse.headers.get('cache-control'),/no-store/);
    assert.equal(preview.changes.length,2);assert.deepEqual(database.serialize(),before);
    const body={...input,confirmed:true,previewHash:preview.previewHash},applyHeaders={...headers,'Idempotency-Key':'league-scoring-http'};
    database.exec("CREATE TRIGGER test_scoring_failure BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'synthetic notice failure'); END");
    const failBytes=database.serialize();assert.equal((await fetch(url+'/apply',{method:'POST',headers:applyHeaders,body:JSON.stringify(body)})).status,500);
    assert.deepEqual(database.serialize(),failBytes);database.exec('DROP TRIGGER test_scoring_failure');
    const applied=await fetch(url+'/apply',{method:'POST',headers:applyHeaders,body:JSON.stringify(body)});
    assert.equal(applied.status,200,JSON.stringify(await applied.clone().json()));
    const bytes=database.serialize();assert.equal((await(await fetch(url+'/apply',{method:'POST',headers:applyHeaders,body:JSON.stringify(body)})).json()).data.replayed,true);
    assert.deepEqual(database.serialize(),bytes);
    const pageResponse=await fetch(playersUrl,{headers});assert.equal(pageResponse.status,200,JSON.stringify(await pageResponse.clone().json()));
    const page=await pageResponse.json();assert.equal(page.data[0].id,secondId);
    const next=(await(await fetch(playersUrl+'&cursor='+page.page.nextCursor,{headers})).json()).data;
    assert.equal(next[0].id,firstId);assert.equal(next[0].statistics.fantasyPointsHundredths,100);
    assert.equal(next[0].statistics.scoringWeights.F.hits,5);
    const global=(await(await fetch(origin+'/api/v1/players/'+firstId,{headers})).json()).data;
    assert.equal(global.statistics.fantasyPointsHundredths,400);assert.equal(global.statistics.scoringWeights,undefined);
    const publicRules=(await(await fetch(url+'/rules',{headers:headersFor(manager)})).json()).data;
    assert.equal(publicRules.current.weights.F.hits,5);assert.equal(publicRules.rules[0].reason,undefined);
    assert.equal(createLeagueScoringRuleReader(database)(uuid(988999)),null);
    assert.throws(()=>database.exec('DELETE FROM league_scoring_rules'),/immutable/);
    assert.deepEqual(database.pragma('foreign_key_check'),[]);assert.equal(database.pragma('integrity_check',{simple:true}),'ok');
  });

  test('recurring auction schedule HTTP enforces authority, current previews and atomic repeat-safe confirmation',async t=>{
    const database=createDatabase(t);let time=NOW_MS;
    const runtime=createTargetRuntime(runtimeOptions(database,{securityFoundations:createSecurityFoundations({env:securityEnv(),now:()=>time,loggerSink(){}})}));
    const scenario=seedComposedLeagueStartScenario(runtime);
    const commissioner=runtime.services.sessionService.issueForUser({userId:scenario.commissionerUserId});
    const managerId=database.prepare("SELECT user_id FROM team_manager_assignments WHERE league_id=? AND user_id<>? AND status='accepted' LIMIT 1").get(scenario.leagueId,scenario.commissionerUserId).user_id;
    const manager=runtime.services.sessionService.issueForUser({userId:managerId}),origin=await startRuntimeApp(t,runtime);
    const url=origin+'/api/v1/leagues/'+scenario.leagueId+'/calendar/auction-schedule';
    const headersFor=s=>browserHeaders({Cookie:runtime.transport.sessionCookie.name+'='+s.rawSessionToken,'X-CSRF-Token':s.rawCsrfToken});
    const headers=headersFor(commissioner),input={closeWeekday:6,closeMinuteOfDay:1125,creationCutoffMinutes:90,reason:'Managers chose a later closing time'};
    const before=database.serialize();
    assert.equal((await fetch(url,{headers:browserHeaders()})).status,401);
    assert.equal((await fetch(url,{headers:headersFor(manager)})).status,403);
    assert.equal((await fetch(url.replace(scenario.leagueId,uuid(997001)),{headers})).status,404);
    assert.equal((await fetch(url+'/preview',{method:'POST',headers:{...headers,'X-CSRF-Token':'bad'},body:JSON.stringify(input)})).status,403);
    const read=await fetch(url,{headers});assert.equal(read.status,200);assert.match(read.headers.get('cache-control'),/no-store/);
    const status=(await read.json()).data;assert.equal(status.schedule,null);
    const review=await fetch(url+'/preview',{method:'POST',headers,body:JSON.stringify(input)});
    assert.equal(review.status,200,JSON.stringify(await review.clone().json()));const preview=(await review.json()).data;
    assert.deepEqual(database.serialize(),before);
    const body={...input,confirmed:true,previewHash:preview.previewHash},applyHeaders={...headers,'Idempotency-Key':'weekly-http-apply'};
    database.exec("CREATE TRIGGER test_schedule_failure BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'synthetic notice failure'); END");
    const failBytes=database.serialize();
    assert.equal((await fetch(url+'/apply',{method:'POST',headers:applyHeaders,body:JSON.stringify(body)})).status,500);
    assert.deepEqual(database.serialize(),failBytes);database.exec('DROP TRIGGER test_schedule_failure');
    const applied=await fetch(url+'/apply',{method:'POST',headers:applyHeaders,body:JSON.stringify(body)});
    assert.equal(applied.status,200,JSON.stringify(await applied.clone().json()));
    const bytes=database.serialize();
    assert.equal((await(await fetch(url+'/apply',{method:'POST',headers:applyHeaders,body:JSON.stringify(body)})).json()).data.replayed,true);
    assert.deepEqual(database.serialize(),bytes);
    const current=(await(await fetch(url,{headers})).json()).data;assert.equal(current.revision,1);assert.equal(current.history.length,1);
    assert.equal(current.schedule.creationCutoffMinutes,90);
    const next={...input,creationCutoffMinutes:0},fresh=await fetch(url+'/preview',{method:'POST',headers,body:JSON.stringify(next)});
    const nextPreview=(await fresh.json()).data;
    time=nextPreview.window.newAuctionCutoffAtMs;
    const renewedHeaders=headersFor(runtime.services.sessionService.issueForUser({userId:scenario.commissionerUserId}));
    assert.equal((await fetch(url+'/apply',{method:'POST',headers:{...renewedHeaders,'Idempotency-Key':'elapsed-weekly-review'},body:JSON.stringify({...next,confirmed:true,previewHash:nextPreview.previewHash})})).status,409);
    assert.equal(database.prepare('SELECT count(*) n FROM league_auction_schedule_changes').get().n,1);
    assert.deepEqual(database.pragma('foreign_key_check'),[]);
  });

  test('season calendar migration and HTTP edits preserve records and move only the reviewed pending work',async t=>{
    const database=createDatabase(t,{migrated:false});
    const migrations=discoverMigrations({migrationsDirectory:MIGRATIONS_DIRECTORY});
    const migrate=list=>applyMigrations({database,migrations:list,applicationBuildId:'calendar-test',now:()=>NOW_MS});
    migrate(migrations.filter(m=>m.id<=75));
    const legacy=path.join(path.dirname(database.name),'calendar-schema75');fs.mkdirSync(legacy);
    for(const m of migrations.filter(m=>m.id<=75))fs.copyFileSync(path.join(MIGRATIONS_DIRECTORY,m.fileName),path.join(legacy,m.fileName));
    let runtime=createTargetRuntime(runtimeOptions(database,{migrationsDirectory:legacy}));
    const scenario=seedComposedLeagueStartScenario(runtime),authenticated=runtime.services.sessionService.resolveWithoutActivity(scenario.session.rawSessionToken);
    const started=runtime.services.league.start.start({leagueId:scenario.leagueId,input:{},expectedLeagueVersion:scenario.expectedLeagueVersion,idempotencyKey:'calendar-season-start',authenticated});
    runtime.services.league.matchupSchedule.generate({leagueId:scenario.leagueId,seasonId:scenario.seasonId,expectedSeasonVersion:started.league.currentSeason.version,
      input:{nhlRegularSeasonStartsAtMs:Date.parse('2026-10-06T07:00:00Z'),nhlRegularSeasonEndsAtMs:Date.parse('2027-04-12T07:00:00Z'),
        fantasyPlayoffsStartAtMs:Date.parse('2027-03-15T07:00:00Z'),fantasyPlayoffsEndAtMs:Date.parse('2027-04-12T07:00:00Z'),
        firstWeekStartsAtMs:Date.parse('2026-10-12T07:00:00Z'),confirmed:true},idempotencyKey:'calendar-season-schedule',authenticated});
    const tables=database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations','application_metadata') ORDER BY name").all().map(r=>r.name);
    const rows=()=>Object.fromEntries(tables.map(name=>[name,database.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all()]));
    const beforeMigration=rows(),objects=database.prepare("SELECT name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name").all();
    migrate(migrations.filter(m=>m.id<=76));assert.deepEqual(rows(),beforeMigration);
    for(const row of objects)assert.equal(database.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(row.name).sql,row.sql);
    const migrated=database.serialize();migrate(migrations.filter(m=>m.id<=76));assert.deepEqual(database.serialize(),migrated);
    migrate(migrations);
    runtime=createTargetRuntime(runtimeOptions(database));
    const draftBoundState=runtime.services.league.leagueCalendar.read({leagueId:scenario.leagueId,authenticated});
    assert.match(draftBoundState.blockedReason,/unfinished Free Agent Draft/);
    const guardedBytes=database.serialize();
    assert.throws(()=>runtime.services.league.leagueCalendar.preview({leagueId:scenario.leagueId,authenticated,
      input:{calendar:{...draftBoundState.calendar,fantasyPlayoffsEndAtMs:draftBoundState.calendar.fantasyPlayoffsEndAtMs-86400000},weeks:[],reason:'Attempt to change draft-bound calendar'}}),{code:'LEAGUE_CALENDAR_CONFLICT'});
    assert.deepEqual(database.serialize(),guardedBytes);
    assert.equal((await runtime.services.league.freeAgentDraftReadinessJob.run()).succeeded,1);
    // Set up completed-FAD competition state; this test exercises calendar
    // permissions/jobs, while composed deadline/award/completion suites test FAD.
    const draft=database.prepare('SELECT id,first_matchup_starts_at_ms FROM free_agent_drafts WHERE league_id=?').get(scenario.leagueId);
    const forwardGuard=database.prepare("SELECT sql FROM sqlite_schema WHERE name='free_agent_drafts_forward_update'").get().sql;
    database.exec('DROP TRIGGER free_agent_drafts_forward_update');
    completeComposedMatchupOccurrenceFad(database,{leagueId:scenario.leagueId,seasonId:scenario.seasonId,fadId:draft.id,startsAtMs:draft.first_matchup_starts_at_ms});
    database.exec(forwardGuard);
    const commissioner=runtime.services.sessionService.issueForUser({userId:scenario.commissionerUserId});
    const managerId=database.prepare("SELECT user_id FROM team_manager_assignments WHERE league_id=? AND user_id<>? AND status='accepted' LIMIT 1").get(scenario.leagueId,scenario.commissionerUserId).user_id;
    const manager=runtime.services.sessionService.issueForUser({userId:managerId}),origin=await startRuntimeApp(t,runtime);
    const url=origin+'/api/v1/leagues/'+scenario.leagueId+'/calendar/season';
    const headersFor=s=>browserHeaders({Cookie:runtime.transport.sessionCookie.name+'='+s.rawSessionToken,'X-CSRF-Token':s.rawCsrfToken});
    const headers=headersFor(commissioner),beforeRead=database.serialize();
    assert.equal((await fetch(url,{headers:browserHeaders()})).status,401);
    assert.equal((await fetch(url,{headers:headersFor(manager)})).status,403);
    assert.equal((await fetch(url.replace(scenario.leagueId,uuid(996900)),{headers})).status,404);
    const read=await fetch(url,{headers});assert.equal(read.status,200,JSON.stringify(await read.clone().json()));
    assert.match(read.headers.get('cache-control'),/no-store/);
    const current=(await read.json()).data,week=current.weeks[1],oldLock=week.locksAtMs;
    const input={calendar:{...current.calendar,fantasyPlayoffsEndAtMs:current.calendar.fantasyPlayoffsEndAtMs-86400000},
      weeks:[{...week,locksAtMs:oldLock+3600000}],reason:'League agreed to revised lock and playoff dates'};
    assert.equal((await fetch(url+'/preview',{method:'POST',headers:{...headers,'X-CSRF-Token':'bad'},body:JSON.stringify(input)})).status,403);
    const review=await fetch(url+'/preview',{method:'POST',headers,body:JSON.stringify(input)});
    assert.equal(review.status,200,JSON.stringify(await review.clone().json()));
    const preview=(await review.json()).data;assert.equal(preview.pendingJobs,1);
    assert.deepEqual(preview.changes[0].fields,['locksAtMs']);assert.deepEqual(database.serialize(),beforeRead);
    assert.ok(!JSON.stringify(preview).includes('bidder'));assert.ok(!JSON.stringify(preview).includes('candidate_player'));
    const body={...input,confirmed:true,previewHash:preview.previewHash},applyHeaders={...headers,'Idempotency-Key':'calendar-season-apply'};
    database.exec("CREATE TRIGGER test_calendar_failure BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'calendar fixture failure'); END");
    const beforeFailure=database.serialize();
    assert.equal((await fetch(url+'/apply',{method:'POST',headers:applyHeaders,body:JSON.stringify(body)})).status,500);
    assert.deepEqual(database.serialize(),beforeFailure);database.exec('DROP TRIGGER test_calendar_failure');
    const beforeApply=rows(),applied=await fetch(url+'/apply',{method:'POST',headers:applyHeaders,body:JSON.stringify(body)});
    assert.equal(applied.status,200,JSON.stringify(await applied.clone().json()));const receipt=(await applied.json()).data;
    const allowed=new Set(['leagues','seasons','matchup_weeks','job_runs','league_activity','notifications','outbox_events','outbox_event_audiences']);
    const afterApply=rows();for(const name of tables)if(!allowed.has(name))assert.deepEqual(afterApply[name],beforeApply[name],name);
    assert.equal(database.prepare('SELECT locks_at_ms FROM matchup_weeks WHERE id=?').get(week.id).locks_at_ms,oldLock+3600000);
    const jobs=runtime.repositories.leagueCalendar.state(scenario.leagueId).jobs;
    const job=jobs.find(j=>j.weekId===week.id&&j.job_type==='matchup:lock');
    assert.equal(job.scheduled_for_ms,oldLock+3600000);assert.ok(job.occurrence_key.endsWith(':'+job.scheduled_for_ms));
    const bytes=database.serialize();
    assert.equal((await(await fetch(url+'/apply',{method:'POST',headers:applyHeaders,body:JSON.stringify(body)})).json()).data.replayed,true);
    assert.deepEqual(database.serialize(),bytes);
    assert.equal((await fetch(url+'/apply',{method:'POST',headers:{...applyHeaders,'Idempotency-Key':'stale-calendar-change'},body:JSON.stringify(body)})).status,400);
    assert.throws(()=>database.prepare('DELETE FROM league_calendar_changes WHERE id=?').run(receipt.id));
    assert.equal((await(await fetch(url,{headers})).json()).data.history.length,1);
    const adminId=uuid(996901);
    runtime.repositories.context.repositories.platform_roles.insert({id:adminId,user_id:managerId,role:'platform_administrator',status:'active',granted_by_user_id:null,granted_at_ms:NOW_MS,ended_at_ms:null,version:1});
    assert.equal((await fetch(url,{headers:headersFor(manager)})).status,200);
    database.prepare("UPDATE platform_roles SET status='ended',ended_at_ms=?,version=version+1 WHERE id=?").run(NOW_MS,adminId);
    assert.equal((await fetch(url,{headers:headersFor(manager)})).status,403);
    assert.deepEqual(database.pragma('foreign_key_check'),[]);assert.equal(database.pragma('integrity_check',{simple:true}),'ok');
  });

  test('trade calendar HTTP controls enforce current commissioner and admin authority without hidden writes',async t=>{
    const database=createDatabase(t);
    const runtime=createTargetRuntime(runtimeOptions(database)),scenario=seedComposedLeagueStartScenario(runtime);
    const origin=await startRuntimeApp(t,runtime);
    const url=new URL('/api/v1/leagues/'+scenario.leagueId+'/calendar/trade-deadline',origin);
    const commissioner=runtime.services.sessionService.issueForUser({userId:scenario.commissionerUserId});
    const managerId=database.prepare("SELECT user_id FROM team_manager_assignments WHERE league_id=? AND user_id<>? AND status='accepted' LIMIT 1").get(scenario.leagueId,scenario.commissionerUserId).user_id;
    const manager=runtime.services.sessionService.issueForUser({userId:managerId});
    const headersFor=s=>browserHeaders({Cookie:runtime.transport.sessionCookie.name+'='+s.rawSessionToken,'X-CSRF-Token':s.rawCsrfToken});
    const headers=headersFor(commissioner),input={tradeDeadlineAtMs:NOW_MS+3*86400000,reason:'Adjust the season trade deadline'};
    const before=database.serialize();
    assert.equal((await fetch(url,{headers:browserHeaders()})).status,401);
    assert.equal((await fetch(url,{headers:headersFor(manager)})).status,403);
    assert.equal((await fetch(url+'/preview',{method:'POST',headers:{...headers,'X-CSRF-Token':'bad'},body:JSON.stringify(input)})).status,403);
    const missing=new URL('/api/v1/leagues/'+uuid(994000)+'/calendar/trade-deadline',origin);
    assert.equal((await fetch(missing,{headers})).status,404);
    const read=await fetch(url,{headers});assert.equal(read.status,200);assert.match(read.headers.get('cache-control'),/no-store/);
    const status=(await read.json()).data;assert.equal(status.canEdit,true);
    assert.deepEqual(Object.keys(status).sort(),['leagueId','seasonId','timeZone','tradeDeadlineAtMs','serverNowMs','canEdit','blockedReason','history'].sort());
    const previewResponse=await fetch(url+'/preview',{method:'POST',headers,body:JSON.stringify(input)});
    assert.equal(previewResponse.status,200);const preview=(await previewResponse.json()).data;
    assert.deepEqual(database.serialize(),before);
    const body={...input,confirmed:true,previewHash:preview.previewHash},applyHeaders={...headers,'Idempotency-Key':'calendar-trade-http'};
    const applied=await fetch(url+'/apply',{method:'POST',headers:applyHeaders,body:JSON.stringify(body)});
    const result=await applied.json();assert.equal(applied.status,200,JSON.stringify(result));
    const after=database.serialize();
    const repeated=await fetch(url+'/apply',{method:'POST',headers:applyHeaders,body:JSON.stringify(body)});
    assert.equal((await repeated.json()).data.replayed,true);assert.deepEqual(database.serialize(),after);
    assert.equal((await fetch(url+'/apply',{method:'POST',headers:{...applyHeaders,'Idempotency-Key':'calendar-stale-http'},body:JSON.stringify({...body,tradeDeadlineAtMs:input.tradeDeadlineAtMs+86400000})})).status,409);
    assert.throws(()=>database.prepare('DELETE FROM league_trade_deadline_changes WHERE id=?').run(result.data.id));
    const notices=database.prepare("SELECT message_data_json FROM notifications WHERE event_type='league_trade_deadline_changed' AND league_id=?").all(scenario.leagueId);
    assert.ok(notices.length>0);for(const row of notices)assert.deepEqual(Object.keys(JSON.parse(row.message_data_json)).sort(),['leagueId','message','tradeDeadlineAtMs']);
    const auth=runtime.services.sessionService.resolveWithoutActivity(commissioner.rawSessionToken),league=database.prepare('SELECT version FROM leagues WHERE id=?').get(scenario.leagueId);
    runtime.services.league.start.start({leagueId:scenario.leagueId,input:{},expectedLeagueVersion:league.version,idempotencyKey:'calendar-start-http',authenticated:auth});
    runtime.repositories.context.repositories.platform_roles.insert({id:uuid(994001),user_id:managerId,role:'platform_administrator',status:'active',granted_by_user_id:null,granted_at_ms:NOW_MS,ended_at_ms:null,version:1});
    const adminHeaders=headersFor(manager),adminInput={tradeDeadlineAtMs:input.tradeDeadlineAtMs+86400000,reason:'Administrator updates active league'};
    const adminPreview=await fetch(url+'/preview',{method:'POST',headers:adminHeaders,body:JSON.stringify(adminInput)});
    assert.equal(adminPreview.status,200);const adminReview=(await adminPreview.json()).data;
    const adminApply=await fetch(url+'/apply',{method:'POST',headers:{...adminHeaders,'Idempotency-Key':'calendar-admin-http'},body:JSON.stringify({...adminInput,confirmed:true,previewHash:adminReview.previewHash})});
    assert.equal(adminApply.status,200,JSON.stringify(await adminApply.json()));
    assert.equal(database.prepare('SELECT count(*) n FROM league_trade_deadline_changes WHERE actor_authority=?').get('platform_administrator').n,1);
    const finalRead=await fetch(url,{headers:adminHeaders});assert.equal((await finalRead.json()).data.history.length,2);
    assert.deepEqual(database.pragma('foreign_key_check'),[]);assert.equal(database.pragma('integrity_check',{simple:true}),'ok');
  });

  test('active FAD auction clocks preserve private bids and original receipts through extension, shortening and resolution', async t => {
    const database=createDatabase(t);let time=NOW_MS;
    const runtime=createTargetRuntime(runtimeOptions(database,{securityFoundations:createSecurityFoundations({env:securityEnv(),now:()=>time,loggerSink(){}})}));
    const scenario=seedComposedLeagueStartScenario(runtime),repositories=runtime.repositories.context.repositories;
    const authenticated=runtime.services.sessionService.resolveWithoutActivity(scenario.session.rawSessionToken);
    const started=runtime.services.league.start.start({leagueId:scenario.leagueId,input:{},expectedLeagueVersion:scenario.expectedLeagueVersion,idempotencyKey:'active-dates-start',authenticated});
    runtime.services.league.matchupSchedule.generate({leagueId:scenario.leagueId,seasonId:scenario.seasonId,expectedSeasonVersion:started.league.currentSeason.version,
      input:{nhlRegularSeasonStartsAtMs:Date.parse('2026-10-06T07:00:00Z'),nhlRegularSeasonEndsAtMs:Date.parse('2027-04-12T07:00:00Z'),fantasyPlayoffsStartAtMs:Date.parse('2027-03-15T07:00:00Z'),fantasyPlayoffsEndAtMs:Date.parse('2027-04-12T07:00:00Z'),firstWeekStartsAtMs:Date.parse('2026-10-12T07:00:00Z'),confirmed:true},idempotencyKey:'active-dates-schedule',authenticated});
    assert.equal((await runtime.services.league.freeAgentDraftReadinessJob.run()).succeeded,1);
    const draft=database.prepare('SELECT * FROM free_agent_drafts WHERE league_id=?').get(scenario.leagueId);
    const scope={leagueId:scenario.leagueId,fadId:draft.id,authenticated},timing=runtime.services.league.fadTiming;
    time=draft.candidate_deadline_at_ms-259200000;
    assert.equal((await runtime.services.league.freeAgentDraftDeadlineReminderJob.run()).succeeded,1);
    time=draft.candidate_deadline_at_ms;
    assert.equal((await runtime.services.league.freeAgentDraftDeadlineJob.run()).held,1);
    const proceed=runtime.services.league.fadDeadlineControl.preview({...scope,input:{reason:'Proceed with saved cards'}});
    runtime.services.league.fadDeadlineControl.proceed({...scope,input:{confirmed:true,reason:proceed.reason,previewHash:proceed.previewHash},idempotencyKey:'active-dates-proceed'});
    assert.equal((await runtime.services.league.freeAgentDraftDeadlineJob.run()).succeeded,1);
    assert.equal((await runtime.services.league.freeAgentDraftAllocationLifecycleJob.run()).enteredRapid,1);
    const teamId=scenario.teamIds[0],managerId=database.prepare("SELECT user_id FROM team_manager_assignments WHERE team_id=? AND status='accepted' AND ended_at_ms IS NULL").get(teamId).user_id;
    const managerSession=runtime.services.sessionService.issueForUser({userId:managerId});
    const manager=runtime.services.sessionService.resolveWithoutActivity(managerSession.rawSessionToken);
    repositories.players.insert({id:uuid(996000),first_name:'Clock',last_name:'Fixture',full_name:'Private clock fixture',birth_date:null,status:'active',created_at_ms:NOW_MS,updated_at_ms:NOW_MS,version:1});
    repositories.league_player_positions.insert({id:uuid(996010),league_id:scenario.leagueId,player_id:uuid(996000),position_group:'F',reason:'Synthetic timing check',corrected_by_user_id:scenario.commissionerUserId,effective_at_ms:NOW_MS,ended_at_ms:null,version:1});
    time++;
    const directCommand={leagueId:scenario.leagueId,authenticated:manager,input:{teamId,playerId:uuid(996000),aavCents:300,termYears:2,bindingIllegalityConfirmed:true},idempotencyKey:'active-timing-direct'};
    const direct=runtime.services.league.auction.start(directCommand),auctionId=direct.auction.auctionId;
    assert.equal(direct.kind,'auction_opened');
    // Ordinary reads remain private even for commissioners. Each deliberate
    // reveal is scoped, confirmed and audited without changing auction state.
    const privateRead=runtime.services.league.auction.read({leagueId:scenario.leagueId,auctionId,authenticated});
    assert.deepEqual(privateRead.administrativeBids,[]);
    const revealService=runtime.services.league.auctionReveal;
    const revealInput={bidId:null,confirmed:true,reason:'Review a reported accidental bid'};
    const revealCommand={leagueId:scenario.leagueId,auctionId,authenticated,input:revealInput,idempotencyKey:'private-bid-records'};
    const privateBefore=database.serialize();
    assert.throws(()=>revealService.reveal({...revealCommand,input:{...revealInput,confirmed:false}}),{code:'PRIVATE_REVEAL_INVALID'});
    assert.deepEqual(database.serialize(),privateBefore);
    const reveal=revealService.reveal(revealCommand);
    assert.equal(reveal.auction.administrativeBids.length,1);assert.equal(reveal.terms,null);
    const revealedBid=reveal.auction.administrativeBids[0];
    assert.equal(Object.hasOwn(revealedBid,'aavCents'),false);
    const revealedBytes=database.serialize();
    assert.equal(revealService.reveal(revealCommand).revealId,reveal.revealId);
    assert.deepEqual(database.serialize(),revealedBytes);
    const terms=revealService.reveal({...revealCommand,input:{...revealInput,bidId:revealedBid.bidId},idempotencyKey:'private-bid-terms'});
    assert.equal(terms.terms.totalValueCents,600);assert.equal(terms.terms.termYears,2);
    const privateAgain=runtime.services.league.auction.read({leagueId:scenario.leagueId,auctionId,authenticated});
    assert.deepEqual(privateAgain.administrativeBids,[],'Revealing never changes subsequent GET behavior');
    assert.equal(database.prepare('SELECT COUNT(*) n FROM league_private_reveals').get().n,2);
    assert.throws(()=>database.prepare('UPDATE league_private_reveals SET reason=?').run('altered private history'));
    assert.throws(()=>database.prepare('DELETE FROM league_private_reveals').run());
    const initial=timing.read(scope),oldClose=initial.rolloverTimesAtMs[0];
    assert.equal(initial.roundDates[0].canEdit,true,initial.roundDates[0].blockedReason);
    const input={deadlineAtMs:initial.deadlineAtMs,rolloverTimesAtMs:initial.rolloverTimesAtMs.map((at,i)=>i===0?at+3600000:at),reason:'Give managers one extra hour'};
    const origin=await startRuntimeApp(t,runtime),url=origin+'/api/v1/leagues/'+scenario.leagueId+'/free-agent-drafts/'+draft.id+'/deadline-control/timing';
    const commissionerSession=runtime.services.sessionService.issueForUser({userId:scenario.commissionerUserId});
    const headers=browserHeaders({Cookie:runtime.transport.sessionCookie.name+'='+commissionerSession.rawSessionToken,'X-CSRF-Token':commissionerSession.rawCsrfToken});
    const revealUrl=origin+'/api/v1/leagues/'+scenario.leagueId+'/auctions/'+auctionId+'/administration/reveal';
    const otherManagerId=database.prepare("SELECT user_id FROM team_manager_assignments WHERE league_id=? AND user_id<>? AND status='accepted' LIMIT 1").get(scenario.leagueId,scenario.commissionerUserId).user_id;
    const otherSession=runtime.services.sessionService.issueForUser({userId:otherManagerId});
    const noRevealWrites=database.serialize();
    const revealHeaders={...headers,'Idempotency-Key':'private-http-review'};
    assert.equal((await fetch(revealUrl,{method:'POST',headers:{...revealHeaders,'X-CSRF-Token':'bad'},body:JSON.stringify(revealInput)})).status,403);
    assert.equal((await fetch(revealUrl,{method:'POST',headers:browserHeaders({Cookie:runtime.transport.sessionCookie.name+'='+otherSession.rawSessionToken,
      'X-CSRF-Token':otherSession.rawCsrfToken,'Idempotency-Key':'manager-private-review'}),body:JSON.stringify(revealInput)})).status,403);
    assert.equal((await fetch(revealUrl.replace(auctionId,uuid(996100)),{method:'POST',headers:revealHeaders,body:JSON.stringify(revealInput)})).status,404);
    assert.deepEqual(database.serialize(),noRevealWrites);
    const httpReveal=await fetch(revealUrl,{method:'POST',headers:revealHeaders,body:JSON.stringify(revealInput)});
    assert.equal(httpReveal.status,200,JSON.stringify(await httpReveal.clone().json()));assert.match(httpReveal.headers.get('cache-control'),/no-store/);
    assert.equal((await httpReveal.json()).data.auction.administrativeBids.length,1);
    const pauseService=runtime.services.league.leaguePause,pauseInput={action:'pause',reason:'Review an active auction clock'};
    const pausePreview=pauseService.preview({...scope,input:pauseInput});
    pauseService.apply({...scope,input:{...pauseInput,confirmed:true,previewHash:pausePreview.previewHash},idempotencyKey:'pause-active-auction-clock'});
    const before=database.serialize(),read=await fetch(url,{headers});
    assert.equal(read.status,200);assert.equal((await read.json()).data.canEditActiveAuctions,true);
    const response=await fetch(url+'/preview',{method:'POST',headers,body:JSON.stringify(input)});
    assert.equal(response.status,200);const preview=(await response.json()).data;
    assert.equal(preview.affectedAuctions,1);
    assert.equal(JSON.stringify(preview).includes(auctionId),false,'Only a count and public dates are returned');
    assert.deepEqual(database.serialize(),before);
    const command={...scope,input:{...input,confirmed:true,previewHash:preview.previewHash},idempotencyKey:'active-timing-extension'};
    const names=database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('auctions','free_agent_drafts','free_agent_draft_rollovers','job_runs','fad_timing_changes','fad_auction_clock_changes','league_activity','notifications','outbox_events','outbox_event_audiences') ORDER BY name").all().map(r=>r.name);
    const rows=()=>Object.fromEntries(names.map(name=>[name,database.prepare('SELECT * FROM '+name+' ORDER BY rowid').all()]));
    const preserved=rows(),firstBid=database.prepare('SELECT * FROM auction_bids WHERE auction_id=?').get(auctionId);
    const {createSqliteFadTimingRepository}=require('../../src/infrastructure/persistence/sqlite/SqliteFadTimingRepository');
    const {planTimingChange}=require('../../src/domain/freeAgentDraft/fadTimingChangePolicy');
    const timingRepository=createSqliteFadTimingRepository({database}),rawState=timingRepository.state(scenario.leagueId,draft.id);
    for(const tamper of [p=>p.auctionChanges[0].closesAtMs++,p=>p.auctionChanges[0].auction.version++,
      p=>p.auctionChanges[0].cutoffAtMs++,p=>p.auctionChanges[0].afterJob.id=uuid(996050),
      p=>delete p.auctionChanges[0].afterJob.version,p=>delete p.auctionChanges[0].afterJob.scheduled_for_ms,
      p=>p.auctionChanges=[],p=>p.afterRollovers[0].opens_at_ms++,
    ]) {
      const plan=planTimingChange(rawState,input,time);tamper(plan);
      assert.throws(()=>timingRepository.transaction(()=>timingRepository.apply({state:rawState,plan,actorUserId:scenario.commissionerUserId,
        authority:'commissioner',clientKey:'forged-active-timing',requestHash:'f'.repeat(64),nowMs:time})));
      assert.deepEqual(database.serialize(),before);
    }
    database.exec("CREATE TEMP TRIGGER active_timing_failure BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'active timing injected failure'); END");
    assert.throws(()=>timing.apply(command),{code:'REPOSITORY_CONSTRAINT'});
    database.exec('DROP TRIGGER active_timing_failure');assert.deepEqual(database.serialize(),before);
    database.exec("CREATE TEMP TRIGGER active_timing_outbox_failure BEFORE INSERT ON outbox_events BEGIN SELECT RAISE(ABORT,'active outbox injected failure'); END");
    assert.throws(()=>timing.apply(command),{code:'REPOSITORY_CONSTRAINT'});
    database.exec('DROP TRIGGER active_timing_outbox_failure');assert.deepEqual(database.serialize(),before);
    const applied=await fetch(url+'/apply',{method:'POST',headers:{...headers,'Idempotency-Key':command.idempotencyKey},body:JSON.stringify(command.input)});
    const result=await applied.json();assert.equal(applied.status,200,JSON.stringify(result));assert.equal(result.data.accepted,true);
    assert.deepEqual(rows(),preserved);
    const updateSignal=database.prepare("SELECT * FROM outbox_events WHERE aggregate_id=? AND event_type='auction.changed' ORDER BY rowid DESC LIMIT 1").get(auctionId);
    const signal=JSON.parse(updateSignal.payload_json);
    assert.equal(signal.related.auctionId,auctionId);assert.equal(signal.related.fadId,draft.id);
    assert.equal(signal.version,database.prepare('SELECT version FROM auctions WHERE id=?').get(auctionId).version);
    assert.deepEqual(database.prepare('SELECT audience_kind,team_id,user_id FROM outbox_event_audiences WHERE outbox_event_id=?').all(updateSignal.id),[{audience_kind:'league',team_id:null,user_id:null}]);
    const resumeInput={action:'resume',reason:'Active auction schedule reviewed'},resumePreview=pauseService.preview({...scope,input:resumeInput});
    pauseService.apply({...scope,input:{...resumeInput,confirmed:true,previewHash:resumePreview.previewHash},idempotencyKey:'resume-active-auction-clock'});
    const current=database.serialize();assert.equal(timing.apply(command).replayed,true);assert.deepEqual(database.serialize(),current);
    assert.equal(runtime.services.league.auction.start(directCommand).auction.resolvesAtMs,oldClose+3600000);
    assert.deepEqual(database.serialize(),current,'Original start receipt replay remains read-only');
    assert.throws(()=>database.prepare('UPDATE fad_auction_clock_changes SET closes_at_ms=closes_at_ms+1').run());
    assert.throws(()=>database.prepare('DELETE FROM fad_auction_clock_changes').run());
    assert.throws(()=>database.prepare('UPDATE auction_contexts SET created_at_ms=created_at_ms+1 WHERE auction_id=?').run(auctionId));
    assert.throws(()=>database.prepare('UPDATE auctions SET resolves_at_ms=resolves_at_ms+1,version=version+1 WHERE id=?').run(auctionId));
    time=oldClose+1;
    assert.equal((await runtime.services.league.freeAgentDraftAuctionResolutionJob.run()).due,0);
    assert.equal((await runtime.services.league.freeAgentDraftRolloverJob.run()).due,0);
    const bidCommand={leagueId:scenario.leagueId,auctionId,authenticated:manager,input:{teamId,aavCents:350,termYears:2,bindingIllegalityConfirmed:true},
      expectedBidVersion:firstBid.version,idempotencyKey:'bid-after-old-fad-close'};
    runtime.services.league.auction.putMine(bidCommand);
    const edited=database.prepare('SELECT * FROM auction_bids WHERE id=?').get(firstBid.id);
    assert.equal(edited.first_submitted_at_ms,firstBid.first_submitted_at_ms);
    const shorter={...input,rolloverTimesAtMs:initial.rolloverTimesAtMs.map((at,i)=>i===0?oldClose+1800000:at),reason:'Use the agreed final closing time'};
    const review=timing.preview({...scope,input:shorter});
    timing.apply({...scope,input:{...shorter,confirmed:true,previewHash:review.previewHash},idempotencyKey:'active-timing-shortening'});
    assert.equal(database.prepare('SELECT COUNT(*) n FROM fad_auction_clock_changes WHERE auction_id=?').get(auctionId).n,2);
    const beforeReplay=database.serialize();
    assert.equal(runtime.services.league.auction.start(directCommand).auction.resolvesAtMs,oldClose+1800000);
    runtime.services.league.auction.putMine(bidCommand);
    assert.deepEqual(database.serialize(),beforeReplay);
    time=oldClose+1800000;
    assert.equal(timing.read(scope).canReschedule,false,'Overdue rounds must resolve first');
    assert.throws(()=>runtime.services.league.auction.putMine({...bidCommand,input:{...bidCommand.input,aavCents:400},
      expectedBidVersion:edited.version,idempotencyKey:'bid-at-new-fad-close'}),{reasonCode:'AUCTION_BID_WINDOW_CLOSED'});
    const finalPause=pauseService.preview({...scope,input:pauseInput});
    pauseService.apply({...scope,input:{...pauseInput,confirmed:true,previewHash:finalPause.previewHash},idempotencyKey:'pause-due-auction-clock'});
    const pausedState=database.serialize();
    assert.equal((await runtime.services.league.freeAgentDraftAuctionResolutionJob.run()).due,0);
    assert.equal((await runtime.services.league.freeAgentDraftRolloverJob.run()).due,0);
    assert.deepEqual(database.serialize(),pausedState);
    const finalResume=pauseService.preview({...scope,input:resumeInput});assert.equal(finalResume.impacts.dueAuctions,1);
    pauseService.apply({...scope,input:{...resumeInput,confirmed:true,previewHash:finalResume.previewHash},idempotencyKey:'resume-due-auction-clock'});
    const resolved=await runtime.services.league.freeAgentDraftAuctionResolutionJob.run();
    assert.equal(resolved.succeeded,1,JSON.stringify(resolved));
    const rolled=await runtime.services.league.freeAgentDraftRolloverJob.run();assert.equal(rolled.succeeded,1,JSON.stringify(rolled));
    assert.equal((await runtime.services.league.freeAgentDraftAuctionResolutionJob.run()).due,0);
    assert.equal(database.prepare('SELECT COUNT(*) n FROM auction_resolutions WHERE auction_id=?').get(auctionId).n,1);
    assert.equal(database.prepare('SELECT status FROM auctions WHERE id=?').get(auctionId).status,'resolved');
    const finished=database.serialize();
    const finalAuction=runtime.services.league.auction.read({leagueId:scenario.leagueId,auctionId,authenticated:manager});
    assert.equal(finalAuction.resolvesAtMs,time);
    assert.deepEqual(runtime.services.league.auction.start(directCommand).auction,finalAuction);
    assert.equal(timing.apply(command).replayed,true);assert.deepEqual(database.serialize(),finished);
    assert.equal(timing.read(scope).roundDates[0].canEdit,false);
    const resetPause=pauseService.preview({...scope,input:pauseInput});pauseService.apply({...scope,input:{...pauseInput,confirmed:true,previewHash:resetPause.previewHash},idempotencyKey:'pause-populated-reset-rehearsal'});
    database.prepare("UPDATE outbox_events SET status='published',published_at_ms=?,updated_at_ms=?,version=version+1 WHERE league_id=? AND status='pending'").run(time,time,scenario.leagueId);
    const populatedBytes=database.serialize(),resetProof=require('../../src/operations/guidedLeagueReset').rehearse(database,scenario.leagueId,scenario.commissionerUserId,time);
    assert.equal(resetProof.recoveryVerified,true);assert.ok(resetProof.manifest.clear.find(g=>g.label==='Saved bids').count>0);assert.ok(resetProof.manifest.clear.find(g=>g.label==='Contracts').count>0);assert.deepEqual(database.serialize(),populatedBytes);

    assert.deepEqual(database.pragma('foreign_key_check'),[]);assert.equal(database.pragma('integrity_check',{simple:true}),'ok');
  });

  test('reschedules unused rapid rounds atomically while accepted auctions and queued receipts remain intact', async t => {
    const database=createDatabase(t);let time=NOW_MS;
    const runtime=createTargetRuntime(runtimeOptions(database,{securityFoundations:createSecurityFoundations({env:securityEnv(),now:()=>time,loggerSink(){}})}));
    const scenario=seedComposedLeagueStartScenario(runtime),repositories=runtime.repositories.context.repositories;
    const authenticated=runtime.services.sessionService.resolveWithoutActivity(scenario.session.rawSessionToken);
    const started=runtime.services.league.start.start({leagueId:scenario.leagueId,input:{},expectedLeagueVersion:scenario.expectedLeagueVersion,idempotencyKey:'rapid-dates-start',authenticated});
    runtime.services.league.matchupSchedule.generate({leagueId:scenario.leagueId,seasonId:scenario.seasonId,expectedSeasonVersion:started.league.currentSeason.version,
      input:{nhlRegularSeasonStartsAtMs:Date.parse('2026-10-06T07:00:00Z'),nhlRegularSeasonEndsAtMs:Date.parse('2027-04-12T07:00:00Z'),fantasyPlayoffsStartAtMs:Date.parse('2027-03-15T07:00:00Z'),fantasyPlayoffsEndAtMs:Date.parse('2027-04-12T07:00:00Z'),firstWeekStartsAtMs:Date.parse('2026-10-12T07:00:00Z'),confirmed:true},idempotencyKey:'rapid-dates-schedule',authenticated});
    assert.equal((await runtime.services.league.freeAgentDraftReadinessJob.run()).succeeded,1);
    const draft=database.prepare('SELECT * FROM free_agent_drafts WHERE league_id=?').get(scenario.leagueId);
    const scope={leagueId:scenario.leagueId,fadId:draft.id,authenticated},timing=runtime.services.league.fadTiming;
    time=draft.candidate_deadline_at_ms-259200000;
    assert.equal((await runtime.services.league.freeAgentDraftDeadlineReminderJob.run()).succeeded,1);
    time=draft.candidate_deadline_at_ms;
    assert.equal((await runtime.services.league.freeAgentDraftDeadlineJob.run()).held,1);
    const proceed=runtime.services.league.fadDeadlineControl.preview({...scope,input:{reason:'Proceed with saved cards'}});
    runtime.services.league.fadDeadlineControl.proceed({...scope,input:{confirmed:true,reason:proceed.reason,previewHash:proceed.previewHash},idempotencyKey:'rapid-dates-proceed'});
    assert.equal((await runtime.services.league.freeAgentDraftDeadlineJob.run()).succeeded,1);
    assert.equal((await runtime.services.league.freeAgentDraftAllocationLifecycleJob.run()).enteredRapid,1);
    const teamId=scenario.teamIds[0],managerId=database.prepare("SELECT user_id FROM team_manager_assignments WHERE team_id=? AND status='accepted' AND ended_at_ms IS NULL").get(teamId).user_id;
    const managerSession=runtime.services.sessionService.issueForUser({userId:managerId});
    const manager=runtime.services.sessionService.resolveWithoutActivity(managerSession.rawSessionToken);
    for(let i=0;i<2;i++) {
      repositories.players.insert({id:uuid(997000+i),first_name:'Timing',last_name:String(i),full_name:'Private timing player '+i,birth_date:null,status:'active',created_at_ms:NOW_MS,updated_at_ms:NOW_MS,version:1});
      repositories.league_player_positions.insert({id:uuid(997010+i),league_id:scenario.leagueId,player_id:uuid(997000+i),position_group:'F',reason:'Synthetic timing check',corrected_by_user_id:scenario.commissionerUserId,effective_at_ms:NOW_MS,ended_at_ms:null,version:1});
    }
    time++;
    const directCommand={leagueId:scenario.leagueId,authenticated:manager,input:{teamId,playerId:uuid(997000),aavCents:300,termYears:2,bindingIllegalityConfirmed:true},idempotencyKey:'rapid-timing-direct'};
    const direct=runtime.services.league.auction.start(directCommand);
    assert.equal(direct.kind,'auction_opened');
    const initial=timing.read(scope),staleInput={deadlineAtMs:initial.deadlineAtMs,rolloverTimesAtMs:initial.rolloverTimesAtMs.map((at,i)=>i===1?at+3600000:at),reason:'Move unused second round'};
    assert.equal(initial.canReschedule,true,initial.blockedReason);
    const stale=timing.preview({...scope,input:staleInput});
    time=database.prepare('SELECT creation_cutoff_at_ms FROM free_agent_draft_rollovers WHERE fad_id=? AND sequence=1').get(draft.id).creation_cutoff_at_ms;
    const queueCommand={...directCommand,input:{...directCommand.input,playerId:uuid(997001)},idempotencyKey:'rapid-timing-queued'};
    const queued=runtime.services.league.auction.start(queueCommand);
    assert.equal(queued.kind,'nomination_queued');
    assert.throws(()=>timing.apply({...scope,input:{...staleInput,confirmed:true,previewHash:stale.previewHash},idempotencyKey:'rapid-stale-preview'}),{code:'FAD_TIMING_PREVIEW_CHANGED'});
    const status=timing.read(scope);
    assert.equal(status.canEditDeadline,false);assert.equal(status.roundDates[1].canEdit,false);
    const input={deadlineAtMs:status.deadlineAtMs,rolloverTimesAtMs:status.rolloverTimesAtMs.map((at,i)=>i===3?at+3600000:at),reason:'Move the unused fourth round'};
    const origin=await startRuntimeApp(t,runtime),url=origin+'/api/v1/leagues/'+scenario.leagueId+'/free-agent-drafts/'+draft.id+'/deadline-control/timing';
    const commissionerSession=runtime.services.sessionService.issueForUser({userId:scenario.commissionerUserId});
    const headers=browserHeaders({Cookie:runtime.transport.sessionCookie.name+'='+commissionerSession.rawSessionToken,'X-CSRF-Token':commissionerSession.rawCsrfToken});
    const beforeRead=database.serialize();
    const read=await fetch(url,{headers});assert.equal(read.status,200);assert.match(read.headers.get('cache-control'),/no-store/);
    const publicStatus=(await read.json()).data;
    assert.deepEqual(Object.keys(publicStatus).sort(),['leagueId','fadId','deadlineAtMs','weekOneAtMs','serverNowMs','held','rolloverTimesAtMs','canReschedule','blockedReason','canEditDeadline','canEditActiveAuctions','roundDates','reminderAlreadySent'].sort());
    const response=await fetch(url+'/preview',{method:'POST',headers,body:JSON.stringify(input)});
    assert.equal(response.status,200);const preview=(await response.json()).data;
    assert.deepEqual(database.serialize(),beforeRead);
    const command={...scope,input:{...input,confirmed:true,previewHash:preview.previewHash},idempotencyKey:'rapid-dates-apply'};
    const names=database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('free_agent_drafts','free_agent_draft_rollovers','job_runs','fad_timing_changes','league_activity','notifications') ORDER BY name").all().map(r=>r.name);
    const preserved=()=>Object.fromEntries(names.map(name=>[name,database.prepare('SELECT * FROM '+name+' ORDER BY rowid').all()]));
    const prior=preserved(),oldRounds=database.prepare('SELECT * FROM free_agent_draft_rollovers WHERE fad_id=? ORDER BY sequence').all(draft.id);
    const timingRepository=runtime.repositories.fadTiming;
    const rawState=timingRepository.state(scenario.leagueId,draft.id);
    const {planTimingChange}=require('../../src/domain/freeAgentDraft/fadTimingChangePolicy');
    // Database guards must reject forged audit plans independently of service validation.
    for(const tamper of [
      p=>p.afterRoot.candidate_deadline_at_ms++,
      p=>p.afterRoot.help_opens_at_ms++,
      p=>{const times=JSON.parse(p.afterRoot.initial_rollover_times_json);times[0]++;p.afterRoot.initial_rollover_times_json=JSON.stringify(times);},
      p=>p.afterRollovers[0].creation_cutoff_at_ms++,
      p=>{p.afterJobs.find(j=>j.job_type==='fad_deadline').occurrence_key='forged-completed-receipt';},
    ]) {
      const plan=planTimingChange(rawState,input,time);tamper(plan);
      assert.throws(()=>timingRepository.transaction(()=>timingRepository.apply({state:rawState,plan,actorUserId:scenario.commissionerUserId,
        authority:'commissioner',clientKey:'forged-rapid-timing',requestHash:'f'.repeat(64),nowMs:time})));
      assert.deepEqual(database.serialize(),beforeRead);
    }
    database.exec("CREATE TEMP TRIGGER rapid_timing_failure BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'rapid timing injected failure'); END");
    assert.throws(()=>timing.apply(command),{code:'REPOSITORY_CONSTRAINT'});
    database.exec('DROP TRIGGER rapid_timing_failure');assert.deepEqual(database.serialize(),beforeRead);
    const applied=await fetch(url+'/apply',{method:'POST',headers:{...headers,'Idempotency-Key':command.idempotencyKey},body:JSON.stringify(command.input)});
    const result=await applied.json();assert.equal(applied.status,200,JSON.stringify(result));
    assert.deepEqual(preserved(),prior);
    const after=database.serialize();assert.equal(timing.apply(command).replayed,true);assert.deepEqual(database.serialize(),after);
    const newRounds=database.prepare('SELECT * FROM free_agent_draft_rollovers WHERE fad_id=? ORDER BY sequence').all(draft.id);
    for(const i of [0,1,2,5,6])assert.deepEqual(newRounds[i],oldRounds[i]);
    assert.equal(newRounds[4].opens_at_ms,input.rolloverTimesAtMs[3]);
    assert.equal(runtime.services.league.auction.start(queueCommand).queuedNomination.resolvesAtMs,queued.queuedNomination.resolvesAtMs);
    assert.equal(runtime.services.league.auction.start(directCommand).auction.auctionId,direct.auction.auctionId);
    assert.throws(()=>database.prepare('UPDATE free_agent_draft_rollovers SET rolls_over_at_ms=rolls_over_at_ms+1,version=version+1 WHERE id=?').run(newRounds[3].id));
    // The regular worker must follow the revised occurrence, not its old date.
    for(let i=0;i<3;i++) {
      time=newRounds[i].rolls_over_at_ms;
      await runtime.services.league.freeAgentDraftQueuedNominationActivationJob.run();
      await runtime.services.league.freeAgentDraftAuctionResolutionJob.run();
      const rolled=await runtime.services.league.freeAgentDraftRolloverJob.run();
      assert.equal(rolled.succeeded,1,JSON.stringify(rolled));
    }
    time=oldRounds[3].rolls_over_at_ms;
    assert.equal((await runtime.services.league.freeAgentDraftRolloverJob.run()).due,0);
    time=newRounds[3].rolls_over_at_ms;
    assert.equal((await runtime.services.league.freeAgentDraftRolloverJob.run()).succeeded,1);
    assert.equal((await runtime.services.league.freeAgentDraftRolloverJob.run()).due,0);
    assert.deepEqual(database.pragma('foreign_key_check'),[]);assert.equal(database.pragma('integrity_check',{simple:true}),'ok');
  });

  test('changes FAD cutoff gaps through authenticated preview with atomic preservation and timing compatibility', async t => {
    const database=createDatabase(t);let time=NOW_MS;
    const runtime=createTargetRuntime(runtimeOptions(database,{securityFoundations:createSecurityFoundations({env:securityEnv(),now:()=>time,loggerSink(){}})}));
    const scenario=seedComposedLeagueStartScenario(runtime);
    const authenticated=runtime.services.sessionService.resolveWithoutActivity(scenario.session.rawSessionToken);
    const started=runtime.services.league.start.start({leagueId:scenario.leagueId,input:{},expectedLeagueVersion:scenario.expectedLeagueVersion,idempotencyKey:'cutoff-start',authenticated});
    runtime.services.league.matchupSchedule.generate({leagueId:scenario.leagueId,seasonId:scenario.seasonId,expectedSeasonVersion:started.league.currentSeason.version,
      input:{nhlRegularSeasonStartsAtMs:Date.parse('2026-10-06T07:00:00Z'),nhlRegularSeasonEndsAtMs:Date.parse('2027-04-12T07:00:00Z'),fantasyPlayoffsStartAtMs:Date.parse('2027-03-15T07:00:00Z'),fantasyPlayoffsEndAtMs:Date.parse('2027-04-12T07:00:00Z'),firstWeekStartsAtMs:Date.parse('2026-10-12T07:00:00Z'),confirmed:true},idempotencyKey:'cutoff-schedule',authenticated});
    assert.equal((await runtime.services.league.freeAgentDraftReadinessJob.run()).succeeded,1);
    const draft=database.prepare('SELECT * FROM free_agent_drafts WHERE league_id=?').get(scenario.leagueId);
    const scope={leagueId:scenario.leagueId,fadId:draft.id,authenticated},cutoff=runtime.services.league.fadAuctionCutoff;
    const origin=await startRuntimeApp(t,runtime),url=new URL('/api/v1/leagues/'+scenario.leagueId+'/free-agent-drafts/'+draft.id+'/deadline-control/auction-cutoff',origin);
    const manager=database.prepare("SELECT user_id FROM team_manager_assignments WHERE league_id=? AND user_id<>? AND status='accepted' LIMIT 1").get(scenario.leagueId,scenario.commissionerUserId);
    const session=runtime.services.sessionService.issueForUser({userId:scenario.commissionerUserId}),managerSession=runtime.services.sessionService.issueForUser({userId:manager.user_id});
    const headersFor=s=>browserHeaders({Cookie:runtime.transport.sessionCookie.name+'='+s.rawSessionToken,'X-CSRF-Token':s.rawCsrfToken});
    const headers=headersFor(session),input={gapMinutes:30,reason:'Allow nominations closer to closing'};
    const before=database.serialize();
    assert.equal((await fetch(url,{headers:browserHeaders()})).status,401);
    assert.equal((await fetch(url,{headers:headersFor(managerSession)})).status,403);
    assert.equal((await fetch(url+'/preview',{method:'POST',headers:{...headers,'X-CSRF-Token':'invalid'},body:JSON.stringify(input)})).status,403);
    const read=await fetch(url,{headers});assert.equal(read.status,200);assert.match(read.headers.get('cache-control'),/no-store/);
    assert.deepEqual(Object.keys((await read.json()).data).sort(),['leagueId','fadId','gapMinutes','canEdit','blockedReason','serverNowMs','rounds'].sort());
    const previewResponse=await fetch(url+'/preview',{method:'POST',headers,body:JSON.stringify(input)});
    assert.equal(previewResponse.status,200);const preview=(await previewResponse.json()).data;
    assert.equal(preview.changes.length,7);assert.equal(preview.retained.length,0);
    assert.deepEqual(database.serialize(),before,'Reads, previews and denied requests cannot write');
    const tables=['free_agent_drafts','job_runs','candidate_cards','candidate_card_entries','free_agent_draft_readiness_operations','season_matchup_schedule_generations','teams','contracts','auctions','auction_bids','auction_contexts','free_agent_draft_nomination_queue'];
    const rows=()=>Object.fromEntries(tables.map(name=>[name,database.prepare('SELECT * FROM '+name).all()]));
    const preserved=rows(),command={...scope,input:{...input,confirmed:true,previewHash:preview.previewHash},idempotencyKey:'cutoff-apply-01'};
    database.exec("CREATE TEMP TRIGGER cutoff_test_failure BEFORE UPDATE ON free_agent_draft_rollovers BEGIN SELECT RAISE(ABORT,'injected cutoff rollback'); END");
    assert.throws(()=>cutoff.apply(command),/injected cutoff rollback/);
    database.exec('DROP TRIGGER cutoff_test_failure');assert.deepEqual(database.serialize(),before);
    const applyResponse=await fetch(url+'/apply',{method:'POST',headers:{...headers,'Idempotency-Key':command.idempotencyKey},body:JSON.stringify(command.input)});
    const result=await applyResponse.json();assert.equal(applyResponse.status,200,JSON.stringify(result));
    assert.equal(result.data.accepted,true);assert.equal(cutoff.read(scope).gapMinutes,30);assert.deepEqual(rows(),preserved);
    const applied=database.serialize();assert.equal(cutoff.apply(command).replayed,true);assert.deepEqual(database.serialize(),applied);
    assert.throws(()=>cutoff.apply({...command,input:{...command.input,reason:'Different reason'}}),{code:'FAD_CUTOFF_CONFLICT'});
    assert.throws(()=>database.prepare('DELETE FROM fad_auction_cutoff_changes WHERE id=?').run(result.data.id));
    assert.throws(()=>database.prepare('UPDATE free_agent_draft_rollovers SET creation_cutoff_at_ms=creation_cutoff_at_ms-1,version=version+1 WHERE fad_id=?').run(draft.id));
    const timing=runtime.services.league.fadTiming,old=timing.read(scope),dates={deadlineAtMs:old.deadlineAtMs+60000,rolloverTimesAtMs:old.rolloverTimesAtMs,reason:'Move the card target'};
    const review=timing.preview({...scope,input:dates});timing.apply({...scope,input:{...dates,confirmed:true,previewHash:review.previewHash},idempotencyKey:'cutoff-retimed-01'});
    for(const round of database.prepare('SELECT * FROM free_agent_draft_rollovers WHERE fad_id=?').all(draft.id))assert.equal(round.creation_cutoff_at_ms,round.rolls_over_at_ms-1800000);
    time=dates.deadlineAtMs;
    assert.equal((await runtime.services.league.freeAgentDraftDeadlineJob.run()).held,1);
    const proceed=runtime.services.league.fadDeadlineControl.preview({...scope,input:{reason:'Proceed with saved cards'}});
    runtime.services.league.fadDeadlineControl.proceed({...scope,input:{confirmed:true,reason:proceed.reason,previewHash:proceed.previewHash},idempotencyKey:'cutoff-proceed-01'});
    assert.equal((await runtime.services.league.freeAgentDraftDeadlineJob.run()).succeeded,1);
    assert.equal((await runtime.services.league.freeAgentDraftAllocationLifecycleJob.run()).enteredRapid,1);
    time=old.rolloverTimesAtMs[0];
    assert.equal(cutoff.read(scope).canEdit,false,'Overdue rounds must finish first');
    const rolled=await runtime.services.league.freeAgentDraftRolloverJob.run();assert.equal(rolled.succeeded,1,JSON.stringify(rolled));
    assert.equal(cutoff.read(scope).canEdit,true);
    const rapidInput={gapMinutes:120,reason:'Adjust during rapid auctions'},rapidPreview=cutoff.preview({...scope,input:rapidInput});
    assert.equal(rapidPreview.retained.length,1);
    cutoff.apply({...scope,input:{...rapidInput,confirmed:true,previewHash:rapidPreview.previewHash},idempotencyKey:'cutoff-rapid-02'});
    assert.deepEqual(database.pragma('foreign_key_check'),[]);assert.equal(database.pragma('integrity_check',{simple:true}),'ok');
  });

  for (const reminderSent of [false, true]) test('reschedules open FAD clocks atomically and preserves cards (sent reminder: ' + reminderSent + ')', async t => {
    const database = createDatabase(t);
    let time = NOW_MS;
    const runtime = createTargetRuntime(runtimeOptions(database, { securityFoundations:
      createSecurityFoundations({ env: securityEnv(), now: () => time, loggerSink() {} }) }));
    const scenario = seedComposedLeagueStartScenario(runtime);
    const authenticated = runtime.services.sessionService.resolveWithoutActivity(scenario.session.rawSessionToken);
    const started = runtime.services.league.start.start({ leagueId: scenario.leagueId, input: {},
      expectedLeagueVersion: scenario.expectedLeagueVersion, idempotencyKey: 'timing-start', authenticated });
    runtime.services.league.matchupSchedule.generate({ leagueId: scenario.leagueId, seasonId: scenario.seasonId,
      expectedSeasonVersion: started.league.currentSeason.version,
      input: { nhlRegularSeasonStartsAtMs: Date.parse('2026-10-06T07:00:00Z'), nhlRegularSeasonEndsAtMs: Date.parse('2027-04-12T07:00:00Z'),
        fantasyPlayoffsStartAtMs: Date.parse('2027-03-15T07:00:00Z'), fantasyPlayoffsEndAtMs: Date.parse('2027-04-12T07:00:00Z'),
        firstWeekStartsAtMs: Date.parse('2026-10-12T07:00:00Z'), confirmed: true }, idempotencyKey: 'timing-schedule', authenticated });
    assert.equal((await runtime.services.league.freeAgentDraftReadinessJob.run()).succeeded, 1);
    const draft = database.prepare('SELECT * FROM free_agent_drafts WHERE league_id=?').get(scenario.leagueId);
    const scope = { leagueId: scenario.leagueId, fadId: draft.id, authenticated };
    const timing = runtime.services.league.fadTiming;
    if (reminderSent) {
      time = draft.candidate_deadline_at_ms - 259_200_000;
      assert.equal((await runtime.services.league.freeAgentDraftDeadlineReminderJob.run()).succeeded, 1);
      time = draft.candidate_deadline_at_ms;
      assert.equal((await runtime.services.league.freeAgentDraftDeadlineJob.run()).held, 1);
    }
    const pauseInput={action:'pause',reason:'Keep competition paused during schedule review'},pauseService=runtime.services.league.leaguePause;
    const pausePreview=pauseService.preview({...scope,input:pauseInput});
    pauseService.apply({...scope,input:{...pauseInput,confirmed:true,previewHash:pausePreview.previewHash},idempotencyKey:'pause-timing-review'});
    assert.equal(runtime.repositories.freeAgentDraftJobs.listDue({nowMs:draft.first_matchup_starts_at_ms,limit:100}).length,0);
    const protectedTables = ['candidate_cards','candidate_card_entries','candidate_card_revisions','candidate_card_help_requests',
      'free_agent_draft_readiness_operations','season_matchup_schedule_generations','matchup_weeks','teams','contracts'];
    const preserved = () => Object.fromEntries(protectedTables.map(name => [name,database.prepare('SELECT * FROM ' + name).all()]));
    const beforeRows = preserved();
    const current = timing.read(scope);
    assert.equal(current.canReschedule, true);
    const input = { deadlineAtMs: draft.candidate_deadline_at_ms + 3_600_000,
      rolloverTimesAtMs: current.rolloverTimesAtMs.map((at,i) => i===0 ? at + 3_600_000 : at), reason: 'Managers need more time' };
    let httpUrl, httpHeaders;
    if (reminderSent) {
      const origin = await startRuntimeApp(t,runtime);
      httpUrl = new URL('/api/v1/leagues/'+scenario.leagueId+'/free-agent-drafts/'+draft.id+'/deadline-control/timing',origin);
      const commissionerSession = runtime.services.sessionService.issueForUser({userId:scenario.commissionerUserId});
      const managerId=database.prepare("SELECT user_id FROM team_manager_assignments WHERE league_id=? AND user_id<>? AND status='accepted' LIMIT 1").get(scenario.leagueId,scenario.commissionerUserId).user_id;
      const managerSession=runtime.services.sessionService.issueForUser({userId:managerId});
      const headersFor=s=>browserHeaders({Cookie:runtime.transport.sessionCookie.name+'='+s.rawSessionToken,'X-CSRF-Token':s.rawCsrfToken});
      httpHeaders=headersFor(commissionerSession);
      const untouched=database.serialize();
      assert.equal((await fetch(httpUrl,{headers:browserHeaders()})).status,401);
      assert.equal((await fetch(httpUrl,{headers:headersFor(managerSession)})).status,403);
      assert.equal((await fetch(httpUrl+'/preview',{method:'POST',headers:{...httpHeaders,'X-CSRF-Token':'invalid'},body:JSON.stringify(input)})).status,403);
      const readResponse=await fetch(httpUrl,{headers:httpHeaders});
      assert.equal(readResponse.status,200);assert.match(readResponse.headers.get('cache-control'),/no-store/);
      assert.deepEqual(Object.keys((await readResponse.json()).data).sort(),['blockedReason','canReschedule','canEditDeadline','canEditActiveAuctions','roundDates','deadlineAtMs','fadId','held','leagueId','reminderAlreadySent','rolloverTimesAtMs','serverNowMs','weekOneAtMs'].sort());
      const httpPreview=await fetch(httpUrl+'/preview',{method:'POST',headers:httpHeaders,body:JSON.stringify(input)});
      assert.equal(httpPreview.status,200,JSON.stringify(await httpPreview.json()));
      assert.deepEqual(database.serialize(),untouched,'HTTP reads, denied writes and previews cannot change state');
    }
    const before = database.serialize();
    const review = timing.preview({ ...scope,input });
    assert.deepEqual(database.serialize(), before, 'Timing read and preview are read-only');
    assert.equal(JSON.stringify(review).includes('before_jobs_json'), false);
    const command = { ...scope,input: { ...input,confirmed:true,previewHash:review.previewHash },idempotencyKey:'timing-apply-01' };
    database.exec("CREATE TEMP TRIGGER fail_timing_test BEFORE UPDATE ON free_agent_drafts WHEN NEW.candidate_deadline_at_ms<>OLD.candidate_deadline_at_ms BEGIN SELECT RAISE(ABORT,'injected rollback'); END");
    assert.throws(() => timing.apply(command), /injected rollback/);
    database.exec('DROP TRIGGER fail_timing_test');
    assert.deepEqual(database.serialize(),before,'Failure after job and round updates rolls back all changes');
    const applied = httpUrl ? (await (await fetch(httpUrl+'/apply',{method:'POST',headers:{...httpHeaders,'Idempotency-Key':command.idempotencyKey},body:JSON.stringify(command.input)})).json()).data : timing.apply(command);
    assert.equal(applied.replayed,false);
    assert.deepEqual(preserved(),beforeRows);
    assert.equal(timing.read(scope).held,false);
    const after = database.serialize();
    assert.equal(timing.apply(command).replayed,true);
    assert.deepEqual(database.serialize(),after);
    assert.throws(() => timing.apply({ ...command,input:{...command.input,reason:'A different reason'} }),{code:'FAD_TIMING_CONFLICT'});
    assert.throws(() => timing.apply({ ...command,idempotencyKey:'timing-stale-02' }),{code:'FAD_TIMING_PREVIEW_CHANGED'});
    const updated = database.prepare('SELECT * FROM free_agent_drafts WHERE id=?').get(draft.id);
    assert.equal(updated.candidate_deadline_at_ms,input.deadlineAtMs);
    assert.equal(updated.version,draft.version+1);
    assert.throws(() => database.prepare('UPDATE free_agent_drafts SET candidate_deadline_at_ms=candidate_deadline_at_ms+60000,help_opens_at_ms=help_opens_at_ms+60000,version=version+1 WHERE id=?').run(draft.id));
    assert.throws(() => database.prepare('DELETE FROM fad_timing_changes WHERE id=?').run(applied.id));
    if (reminderSent) {
      const currentTiming=timing.read(scope);
      const rounds=currentTiming.rolloverTimesAtMs;
      const next={...input,rolloverTimesAtMs:rounds.map((at,i)=>i<5?rounds[i+1]:i===5?Math.floor((at+rounds[6])/2):at),reason:'Adjust the planned round cadence'};
      const nextReview=timing.preview({...scope,input:next});
      timing.apply({...scope,input:{...next,confirmed:true,previewHash:nextReview.previewHash},idempotencyKey:'timing-repeat-02'});
      assert.deepEqual(timing.read(scope).rolloverTimesAtMs,next.rolloverTimesAtMs,'A round can take a later round’s old clock without collisions');
      assert.deepEqual(preserved(),beforeRows);
      assert.equal(database.prepare('SELECT COUNT(*) n FROM fad_timing_changes WHERE fad_id=?').get(draft.id).n,2);
    }
    const jobs = database.prepare("SELECT * FROM job_runs WHERE league_id=? AND job_type IN ('fad_deadline','fad_deadline_reminder','fad_rollover')").all(scenario.leagueId);
    const resumeInput={action:'resume',reason:'Timing changes reviewed'},resumePreview=pauseService.preview({...scope,input:resumeInput});
    pauseService.apply({...scope,input:{...resumeInput,confirmed:true,previewHash:resumePreview.previewHash},idempotencyKey:'resume-timing-review'});
    const oldReminder = jobs.find(j=>j.job_type==='fad_deadline_reminder');
    if (reminderSent) assert.equal(oldReminder.status,'succeeded');
    else {
      time = oldReminder.scheduled_for_ms;
      assert.equal((await runtime.services.league.freeAgentDraftDeadlineReminderJob.run()).succeeded,1);
    }
    time = draft.candidate_deadline_at_ms;
    assert.equal((await runtime.services.league.freeAgentDraftDeadlineJob.run()).due,0);
    time = input.deadlineAtMs;
    assert.equal((await runtime.services.league.freeAgentDraftDeadlineJob.run()).held,1);
    const proceed = runtime.services.league.fadDeadlineControl.preview({...scope,input:{reason:'Proceed after extension'}});
    runtime.services.league.fadDeadlineControl.proceed({...scope,input:{confirmed:true,reason:proceed.reason,previewHash:proceed.previewHash},idempotencyKey:'timing-proceed-01'});
    const locked = await runtime.services.league.freeAgentDraftDeadlineJob.run();
    assert.equal(locked.succeeded,1,JSON.stringify(locked));
    assert.equal(runtime.repositories.freeAgentDraftJobs.listDue({nowMs:updated.first_matchup_starts_at_ms,limit:100})
      .filter(j=>j.jobType==='fad_rollover').length,7);
    const allocation=await runtime.services.league.freeAgentDraftAllocationLifecycleJob.run();
    assert.equal(allocation.enteredRapid,1,JSON.stringify(allocation));
    time=timing.read(scope).rolloverTimesAtMs[0];
    const rollover=await runtime.services.league.freeAgentDraftRolloverJob.run();
    assert.equal(rollover.succeeded,1,JSON.stringify(rollover));
    assert.equal(timing.read(scope).canReschedule,true);
    assert.equal(timing.read(scope).canEditDeadline,false);
    assert.deepEqual(database.pragma('foreign_key_check'),[]);
    assert.equal(database.pragma('integrity_check',{simple:true}),'ok');
  });

  test('upgrades unscheduled Goon preparation without changing records, timing defaults or manager card access',async t=>{
    const database=createDatabase(t,{migrated:false});
    const migrations=discoverMigrations({migrationsDirectory:MIGRATIONS_DIRECTORY});
    const migrate=list=>applyMigrations({database,migrations:list,applicationBuildId:'goon-compatibility',now:()=>NOW_MS});
    migrate(migrations.filter(m=>m.id<=66));
    const legacy=path.join(path.dirname(database.name),'released-goon-schema66');fs.mkdirSync(legacy);
    for(const m of migrations.filter(m=>m.id<=66))fs.copyFileSync(path.join(MIGRATIONS_DIRECTORY,m.fileName),path.join(legacy,m.fileName));
    let runtime=createTargetRuntime(runtimeOptions(database,{migrationsDirectory:legacy}));
    const scenario=seedComposedLeagueStartScenario(runtime,{leagueId:'48e59cfb-b12d-4dfb-ae1a-4d8b3512ef03'});
    const authenticated=runtime.services.sessionService.resolveWithoutActivity(scenario.session.rawSessionToken);
    const started=runtime.services.league.start.start({leagueId:scenario.leagueId,input:{},expectedLeagueVersion:scenario.expectedLeagueVersion,idempotencyKey:'goon-compatibility-start',authenticated});
    runtime.services.league.matchupSchedule.generate({leagueId:scenario.leagueId,seasonId:scenario.seasonId,
      expectedSeasonVersion:started.league.currentSeason.version,input:{nhlRegularSeasonStartsAtMs:Date.parse('2026-10-06T07:00:00Z'),
        nhlRegularSeasonEndsAtMs:Date.parse('2027-04-12T07:00:00Z'),fantasyPlayoffsStartAtMs:Date.parse('2027-03-15T07:00:00Z'),
        fantasyPlayoffsEndAtMs:Date.parse('2027-04-12T07:00:00Z'),firstWeekStartsAtMs:Date.parse('2026-10-12T07:00:00Z'),confirmed:true},
      idempotencyKey:'goon-compatibility-schedule',authenticated});
    assert.equal((await runtime.services.league.freeAgentDraftReadinessJob.run()).succeeded,1);
    const draft=database.prepare('SELECT * FROM free_agent_drafts WHERE league_id=?').get(scenario.leagueId);
    // Arrange a disposable schema66 preparation fixture. This is never an application reset path.
    const triggers=database.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all();
    database.transaction(()=>{
      for(const row of triggers)database.exec('DROP TRIGGER "'+row.name+'"');
      database.prepare("UPDATE job_runs SET status='skipped',started_at_ms=?,completed_at_ms=? WHERE league_id=? AND job_type IN ('fad_deadline','fad_deadline_reminder','fad_rollover','fad_completion')").run(NOW_MS,NOW_MS,scenario.leagueId);
      for(const round of database.prepare('SELECT id FROM free_agent_draft_rollovers WHERE league_id=? ORDER BY sequence DESC').all(scenario.leagueId))
        database.prepare('DELETE FROM free_agent_draft_rollovers WHERE league_id=? AND id=?').run(scenario.leagueId,round.id);
      database.prepare(`UPDATE free_agent_drafts SET first_matchup_week_id=NULL,current_competition_first_matchup_week_id=NULL,
        candidate_deadline_at_ms=NULL,first_matchup_starts_at_ms=NULL,initial_rollover_times_json=NULL,help_opens_at_ms=opened_at_ms,
        auction_creation_cutoff_minutes=0,rollover_interval_minutes=15 WHERE id=?`).run(draft.id);
      for(const row of triggers)database.exec(row.sql);
    })();
    assert.deepEqual(database.pragma('foreign_key_check'),[]);
    const tables=database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations','application_metadata') ORDER BY name").all();
    const rows=()=>tables.map(({name})=>({name,rows:database.prepare('SELECT * FROM "'+name+'"').all()}));
    const before=rows();migrate(migrations);assert.deepEqual(rows(),before);
    const migrated=database.serialize();migrate(migrations);assert.deepEqual(database.serialize(),migrated);
    runtime=createTargetRuntime(runtimeOptions(database));
    const scope={leagueId:scenario.leagueId,fadId:draft.id,authenticated};
    const settings=runtime.services.league.goonDraftSettings.read(scope);
    assert.equal(settings.auctionCreationCutoffMinutes,0);assert.equal(settings.rolloverIntervalMinutes,15);assert.equal(settings.editable,true);
    const overview=runtime.services.league.freeAgentDraftRead.overview(scope);
    assert.equal(overview.candidateDeadlineAtMs,null);assert.equal(overview.phase,'cards_open');
    const {createFadAuctionCutoffClock}=require('../../src/infrastructure/persistence/sqlite/fadAuctionCutoffClock');
    assert.equal(createFadAuctionCutoffClock(database).gap(scope),0);
    assert.deepEqual(database.serialize(),migrated,'Read-only compatibility checks cannot schedule anything');
    const teamId=scenario.teamIds[0],managerId=database.prepare("SELECT user_id FROM team_manager_assignments WHERE team_id=? AND status='accepted'").get(teamId).user_id;
    const session=runtime.services.sessionService.issueForUser({userId:managerId});
    const manager=runtime.services.sessionService.resolveWithoutActivity(session.rawSessionToken);
    const playerId=uuid(995500),r=runtime.repositories.context.repositories;
    r.players.insert({id:playerId,first_name:'Synthetic',last_name:'Goon',full_name:'Synthetic Goon',birth_date:null,status:'active',created_at_ms:NOW_MS,updated_at_ms:NOW_MS,version:1});
    r.league_player_positions.insert({id:uuid(995501),league_id:scope.leagueId,player_id:playerId,position_group:'F',reason:'Synthetic Goon fixture',corrected_by_user_id:scenario.commissionerUserId,effective_at_ms:NOW_MS,ended_at_ms:null,version:1});
    const card=runtime.services.league.candidateCards.privateCard({...scope,teamId,authenticated:manager});
    const saved=runtime.services.league.candidateCards.addCandidate({...scope,teamId,authenticated:manager,slotKey:'F01',
      input:{playerId,aavCents:300,termYears:2},expectedCardVersion:card.cardVersion,idempotencyKey:'unscheduled-card-add'});
    assert.equal(saved.httpStatus,201);
    assert.equal(database.prepare('SELECT candidate_deadline_at_ms FROM free_agent_drafts WHERE id=?').get(draft.id).candidate_deadline_at_ms,null);
    assert.deepEqual(database.pragma('foreign_key_check'),[]);
  });

  for (const heldFirst of [false, true]) test(heldFirst
    ? "saves all manager cards during a hold but waits for explicit processing"
    : "automatically locks complete cards at the target without processing early", async t => {
    const database = createDatabase(t, { migrated: false });
    const migrations = discoverMigrations({ migrationsDirectory: MIGRATIONS_DIRECTORY });
    const migrate = list => applyMigrations({ database, migrations: list, applicationBuildId: "soft-deadline-test", now: () => NOW_MS });
    migrate(migrations.filter(m => m.id <= 67));
    const legacyMigrationsDirectory = path.join(path.dirname(database.name), "schema-66-migrations");
    fs.mkdirSync(legacyMigrationsDirectory);
    for (const migration of migrations.filter(m => m.id <= 67)) {
      fs.copyFileSync(path.join(MIGRATIONS_DIRECTORY, migration.fileName), path.join(legacyMigrationsDirectory, migration.fileName));
    }
    let time = NOW_MS;
    const buildRuntime = () => createTargetRuntime(runtimeOptions(database, {
      migrationsDirectory: database.pragma("user_version", { simple: true }) < 68 ? legacyMigrationsDirectory : MIGRATIONS_DIRECTORY,
      securityFoundations:
      createSecurityFoundations({ env: securityEnv(), now: () => time, loggerSink() {} }) }));
    let runtime = buildRuntime();
    const scenario = seedComposedLeagueStartScenario(runtime);
    const authenticated = runtime.services.sessionService.resolveWithoutActivity(scenario.session.rawSessionToken);
    const started = runtime.services.league.start.start({ leagueId: scenario.leagueId, input: {},
      expectedLeagueVersion: scenario.expectedLeagueVersion, idempotencyKey: "soft-deadline-start", authenticated });
    runtime.services.league.matchupSchedule.generate({
      leagueId: scenario.leagueId, seasonId: scenario.seasonId, expectedSeasonVersion: started.league.currentSeason.version,
      input: { nhlRegularSeasonStartsAtMs: Date.parse("2026-10-06T07:00:00Z"),
        nhlRegularSeasonEndsAtMs: Date.parse("2027-04-12T07:00:00Z"),
        fantasyPlayoffsStartAtMs: Date.parse("2027-03-15T07:00:00Z"),
        fantasyPlayoffsEndAtMs: Date.parse("2027-04-12T07:00:00Z"),
        firstWeekStartsAtMs: Date.parse("2026-10-12T07:00:00Z"), confirmed: true },
      idempotencyKey: "soft-deadline-schedule", authenticated });
    assert.equal((await runtime.services.league.freeAgentDraftReadinessJob.run()).succeeded, 1);
    const tableNames = database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations','application_metadata') ORDER BY name").all().map(r => r.name);
    const rows = () => Object.fromEntries(tableNames.map(name => [name, database.prepare('SELECT * FROM "' + name + '"').all()]));
    const preserved = rows();
    const triggers = database.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all();
    migrate(migrations.filter(m => m.id <= 68));
    assert.deepEqual(rows(), preserved, "Schema 67 must preserve every pre-existing league, card, clock and job row");
    const changedTriggers = triggers.filter(row => database.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(row.name).sql !== row.sql);
    assert.deepEqual(changedTriggers.map(r => r.name).sort(), [
      "candidate_card_entries_open_insert", "candidate_card_entries_open_update", "candidate_card_revisions_authority_insert",
    ]);
    for (const prior of changedTriggers) {
      const updated = database.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(prior.name).sql;
      const restored = updated.replace(/NEW\.(created_by_authority|last_edited_by_authority|actor_authority) IN \('system', 'manager'\)/,
        "NEW.$1 = 'system'");
      assert.equal(restored, prior.sql, "All other database permission guards must remain intact");
    }
    const schema67Rows = rows();
    const schema67Triggers = database.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all();
    migrate(migrations.filter(m=>m.id<=69));
    assert.deepEqual(rows(),schema67Rows,'Schema 68 must preserve existing records');
    assert.deepEqual(schema67Triggers.filter(row=>database.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(row.name).sql!==row.sql).map(row=>row.name).sort(),
      ['free_agent_draft_rollovers_forward_update','free_agent_drafts_deadline_allocation_barrier','free_agent_drafts_forward_update','free_agent_drafts_initial_timing_immutable']);
    for (const trigger of schema67Triggers.filter(r=>['free_agent_drafts_forward_update','free_agent_draft_rollovers_forward_update','free_agent_drafts_initial_timing_immutable'].includes(r.name))) {
      const updated=database.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(trigger.name).sql;
      assert.equal(updated.slice(updated.indexOf('\nBEGIN')),trigger.sql.slice(trigger.sql.indexOf('\nBEGIN')),'Existing transition guards remain verbatim');
    }
    const schema68Rows=rows(),schema68Objects=database.prepare("SELECT name,sql FROM sqlite_schema WHERE type IN ('table','trigger','view')").all();
    migrate(migrations.filter(m=>m.id<=72));
    assert.deepEqual(rows(),schema68Rows,'Schema 69 must preserve every existing card, round and job');
    assert.deepEqual(schema68Objects.filter(row=>database.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(row.name).sql!==row.sql).map(r=>r.name).sort(),
      ['free_agent_draft_nomination_queue_forward_update','free_agent_draft_rollovers','free_agent_draft_rollovers_forward_update','free_agent_draft_rollovers_goon_cutoff_insert']);
    migrate(migrations);
    const migratedBytes = database.serialize();
    migrate(migrations);
    assert.deepEqual(database.serialize(), migratedBytes);
    runtime = buildRuntime();
    const draft = database.prepare("SELECT * FROM free_agent_drafts WHERE league_id=?").get(scenario.leagueId);
    const scope = { leagueId: scenario.leagueId, fadId: draft.id, authenticated };
    const controls = runtime.services.league.fadDeadlineControl;
    let stalePreview;
    if (heldFirst) {
      time = draft.candidate_deadline_at_ms;
      assert.equal((await runtime.services.league.freeAgentDraftDeadlineJob.run()).held, 1);
      stalePreview = controls.preview({ ...scope, input: { reason: "Process the saved cards" } });
    }
    const repositories = runtime.repositories.context.repositories;
    for (let index = 0; index < 18; index += 1) {
      repositories.players.insert({ id: uuid(98_000 + index), first_name: "Private", last_name: String(index),
        full_name: "Private candidate " + index, birth_date: null, status: "active", created_at_ms: NOW_MS, updated_at_ms: NOW_MS, version: 1 });
      repositories.league_player_positions.insert({ id: uuid(98_100 + index), league_id: scenario.leagueId,
        player_id: uuid(98_000 + index), position_group: index < 12 ? "F" : "D",
        reason: "Soft deadline fixture", corrected_by_user_id: scenario.commissionerUserId,
        effective_at_ms: NOW_MS, ended_at_ms: null, version: 1 });
    }
    const managerSessions = [];
    for (const teamId of scenario.teamIds) {
      const managerId = database.prepare("SELECT user_id FROM team_manager_assignments WHERE team_id=? AND status='accepted' AND ended_at_ms IS NULL").get(teamId).user_id;
      const session = runtime.services.sessionService.issueForUser({ userId: managerId });
      managerSessions.push(session);
      const manager = runtime.services.sessionService.resolveWithoutActivity(session.rawSessionToken);
      for (let index = 0; index < 18; index += 1) {
        const added = runtime.services.league.candidateCards.addCandidate({ authenticated: manager, leagueId: scenario.leagueId,
          fadId: draft.id, teamId, slotKey: (index < 12 ? "F" : "D") + String(index < 12 ? index + 1 : index - 11).padStart(2, "0"),
          input: { playerId: uuid(98_000 + index), aavCents: 300, termYears: 2 }, expectedCardVersion: index + 1,
          idempotencyKey: "soft-deadline-add-" + teamId + "-" + index });
        assert.equal(added.httpStatus, 201);
        assert.equal(added.data.card.cardVersion, index + 2);
      }
    }
    assert.equal(controls.read(scope).complete, 4);
    assert.equal(database.prepare("SELECT COUNT(*) n FROM candidate_cards WHERE status='open' AND completeness_code='complete'").get().n, 4);
    if (heldFirst) {
      assert.throws(() => controls.proceed({ ...scope,
        input: { confirmed: true, reason: stalePreview.reason, previewHash: stalePreview.previewHash },
        idempotencyKey: "soft-deadline-stale-preview" }), { code: "FAD_DEADLINE_CONTROL_PREVIEW_CHANGED" });
      const saved = database.serialize();
      assert.equal((await runtime.services.league.freeAgentDraftDeadlineJob.run()).due, 0);
      assert.deepEqual(database.serialize(), saved, "Saving the final card must not bypass an existing hold");
      const baseUrl = await startRuntimeApp(t, runtime);
      const url = new URL("/api/v1/leagues/" + scenario.leagueId + "/free-agent-drafts/" + draft.id + "/deadline-control", baseUrl);
      const commissionerSession = runtime.services.sessionService.issueForUser({ userId: scenario.commissionerUserId });
      const headersFor = session => browserHeaders({ Cookie: runtime.transport.sessionCookie.name + "=" + session.rawSessionToken,
        "X-CSRF-Token": session.rawCsrfToken });
      const headers = headersFor(commissionerSession);
      const beforeRead = database.serialize();
      assert.equal((await fetch(url, { headers: browserHeaders() })).status, 401);
      const managerOnlySession = managerSessions.find(session => session.userId !== scenario.commissionerUserId) || managerSessions[1];
      assert.equal((await fetch(url, { headers: headersFor(managerOnlySession) })).status, 403);
      const readResponse = await fetch(url, { headers });
      assert.equal(readResponse.status, 200);
      const status = await readResponse.json();
      assert.equal(status.data.complete, 4);
      assert.equal(JSON.stringify(status).includes("Private candidate"), false);
      assert.match(readResponse.headers.get("cache-control"), /no-store/);
      assert.equal((await fetch(url + "/preview", { method: "POST", headers: { ...headers, "X-CSRF-Token": "invalid" },
        body: JSON.stringify({ reason: "All cards are now ready" }) })).status, 403);
      const response = await fetch(url + "/preview", { method: "POST", headers, body: JSON.stringify({ reason: "All cards are now ready" }) });
      const review = await response.json();
      assert.equal(response.status, 200, JSON.stringify(review));
      assert.deepEqual(database.serialize(), beforeRead, "Reads, rejected requests and preview must not write");
      const command = { method: "POST", headers: { ...headers, "Idempotency-Key": "soft-deadline-confirm" },
        body: JSON.stringify({ confirmed: true, reason: review.data.reason, previewHash: review.data.previewHash }) };
      const confirmed = await fetch(url + "/proceed", command);
      assert.equal(confirmed.status, 200, JSON.stringify(await confirmed.json()));
      const afterConfirm = database.serialize();
      assert.equal((await (await fetch(url + "/proceed", command)).json()).data.replayed, true);
      assert.deepEqual(database.serialize(), afterConfirm);
    } else {
      const oldTarget = draft.candidate_deadline_at_ms;
      const timing = runtime.services.league.fadTiming;
      const initial = timing.read(scope);
      const input = { deadlineAtMs: oldTarget + 3_600_000, rolloverTimesAtMs: initial.rolloverTimesAtMs,
        reason: 'Move the complete-card target' };
      const review = timing.preview({...scope,input});
      const beforeCards=database.prepare('SELECT * FROM candidate_card_entries ORDER BY id').all();
      timing.apply({...scope,input:{...input,confirmed:true,previewHash:review.previewHash},idempotencyKey:'timing-all-ready-01'});
      assert.deepEqual(database.prepare('SELECT * FROM candidate_card_entries ORDER BY id').all(),beforeCards);
      time=oldTarget;
      assert.equal((await runtime.services.league.freeAgentDraftDeadlineJob.run()).due,0);
      draft.candidate_deadline_at_ms=input.deadlineAtMs;
      time = draft.candidate_deadline_at_ms - 1;
      const before = database.serialize();
      assert.equal((await runtime.services.league.freeAgentDraftDeadlineJob.run()).due, 0);
      assert.deepEqual(database.serialize(), before);
      time = draft.candidate_deadline_at_ms;
    }
    const result = await runtime.services.league.freeAgentDraftDeadlineJob.run();
    assert.equal(result.failed, 0);
    assert.equal(result.succeeded, 1, JSON.stringify(result));
    assert.equal(database.prepare("SELECT COUNT(*) n FROM candidate_card_snapshots WHERE fad_id=?").get(draft.id).n, 4);
    assert.equal(database.prepare("SELECT COUNT(*) n FROM candidate_cards WHERE fad_id=? AND status='open'").get(draft.id).n, 0);
    const locked = database.serialize();
    assert.equal((await runtime.services.league.freeAgentDraftDeadlineJob.run()).due, 0);
    assert.deepEqual(database.serialize(), locked);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    assert.equal(database.pragma("integrity_check", { simple: true }), "ok");
  });

  test("commits and exactly replays one Candidate add through the composed target runtime", async (t) => {
    const database = createDatabase(t);
    let currentTimeMs = NOW_MS;
    const runtime = createTargetRuntime(
      runtimeOptions(database, {
        securityFoundations:
          createSecurityFoundations({
            env: securityEnv(),
            now: () => currentTimeMs,
            loggerSink() {},
          }),
      })
    );
    const scenario = seedComposedLeagueStartScenario(runtime);
    const commissioner =
      runtime.services.sessionService.resolveWithoutActivity(
        scenario.session.rawSessionToken
      );
    assert.equal(commissioner.valid, true);

    const started = runtime.services.league.start.start({
      leagueId: scenario.leagueId,
      input: {},
      expectedLeagueVersion:
        scenario.expectedLeagueVersion,
      idempotencyKey:
        "target-runtime-candidate-add-start",
      authenticated: commissioner,
    });
    const firstWeekStartsAtMs = Date.parse(
      "2026-10-12T07:00:00.000Z"
    );
    runtime.services.league.matchupSchedule.generate({
      leagueId: scenario.leagueId,
      seasonId: scenario.seasonId,
      expectedSeasonVersion:
        started.league.currentSeason.version,
      input: {
        nhlRegularSeasonStartsAtMs: Date.parse(
          "2026-10-06T07:00:00.000Z"
        ),
        nhlRegularSeasonEndsAtMs: Date.parse(
          "2027-04-12T07:00:00.000Z"
        ),
        fantasyPlayoffsStartAtMs: Date.parse(
          "2027-03-15T07:00:00.000Z"
        ),
        fantasyPlayoffsEndAtMs: Date.parse(
          "2027-04-12T07:00:00.000Z"
        ),
        firstWeekStartsAtMs,
        confirmed: true,
      },
      idempotencyKey:
        "target-runtime-candidate-add-schedule",
      authenticated: commissioner,
    });
    const opening = await runtime.services.league
      .freeAgentDraftReadinessJob.run();
    assert.equal(opening.status, "succeeded");
    assert.equal(opening.succeeded, 1);

    const cardScope = database
      .prepare(`
        SELECT
          fad.id AS fad_id,
          card.id AS card_id,
          card.version AS card_version,
          assignment.user_id AS manager_user_id,
          assignment.membership_id AS manager_membership_id
        FROM free_agent_drafts AS fad
        JOIN candidate_cards AS card
          ON card.league_id = fad.league_id
         AND card.season_id = fad.season_id
         AND card.fad_id = fad.id
        JOIN team_manager_assignments AS assignment
          ON assignment.league_id = card.league_id
         AND assignment.team_id = card.team_id
         AND assignment.status = 'accepted'
         AND assignment.ended_at_ms IS NULL
        WHERE fad.league_id = @leagueId
          AND fad.season_id = @seasonId
          AND card.team_id = @teamId
      `)
      .get({
        leagueId: scenario.leagueId,
        seasonId: scenario.seasonId,
        teamId: scenario.teamIds[0],
      });
    assert.equal(cardScope.card_version, 1);

    const playerId = uuid(91_100);
    const repositories =
      runtime.repositories.context.repositories;
    repositories.players.insert({
      id: playerId,
      first_name: "Candidate",
      last_name: "Runtime",
      full_name: "Candidate Runtime",
      birth_date: null,
      status: "active",
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });
    repositories.league_player_positions.insert({
      id: uuid(91_101),
      league_id: scenario.leagueId,
      player_id: playerId,
      position_group: "F",
      reason: "Composed Candidate mutation fixture",
      corrected_by_user_id:
        scenario.commissionerUserId,
      effective_at_ms: NOW_MS,
      ended_at_ms: null,
      version: 1,
    });
    const managerSession =
      runtime.services.sessionService.issueForUser({
        userId: cardScope.manager_user_id,
      });
    const manager =
      runtime.services.sessionService.resolveWithoutActivity(
        managerSession.rawSessionToken
      );
    assert.equal(manager.valid, true);

    const baseline = database
      .prepare(`
        SELECT
          (SELECT COUNT(*) FROM league_activity) AS activity,
          (SELECT COUNT(*) FROM notifications) AS notifications
      `)
      .get();
    const command = {
      authenticated: manager,
      leagueId: scenario.leagueId,
      fadId: cardScope.fad_id,
      teamId: scenario.teamIds[0],
      slotKey: "F01",
      input: {
        playerId,
        aavCents: 300,
        termYears: 2,
      },
      expectedCardVersion: 1,
      idempotencyKey:
        "target-runtime-candidate-add-exact-replay",
    };
    const first = runtime.services.league.candidateCards
      .addCandidate(command);
    assert.equal(first.httpStatus, 201);
    assert.equal(first.data.card.cardVersion, 2);
    assert.equal(
      first.data.card.leagueId,
      scenario.leagueId
    );
    assert.equal(first.data.card.fadId, cardScope.fad_id);
    assert.equal(
      first.data.card.teamId,
      scenario.teamIds[0]
    );
    assert.equal(first.data.card.cardId, cardScope.card_id);
    assert.equal(
      first.data.card.slots.find(
        ({ slotKey }) => slotKey === "F01"
      ).entryId,
      first.data.changedEntryId
    );

    assert.deepEqual(
      database
        .prepare(`
          SELECT version, completeness_code,
                 filled_mandatory_count, missing_mandatory_count
          FROM candidate_cards
          WHERE league_id = @leagueId AND id = @cardId
        `)
        .get({
          leagueId: scenario.leagueId,
          cardId: cardScope.card_id,
        }),
      {
        version: 2,
        completeness_code: "incomplete",
        filled_mandatory_count: 1,
        missing_mandatory_count: 17,
      }
    );
    assert.deepEqual(
      database
        .prepare(`
          SELECT action, resulting_card_version,
                 affected_entry_id, player_id,
                 actor_user_id, actor_membership_id,
                 actor_authority
          FROM candidate_card_revisions
          WHERE league_id = @leagueId AND id = @revisionId
        `)
        .get({
          leagueId: scenario.leagueId,
          revisionId: first.data.revisionId,
        }),
      {
        action: "candidate_added",
        resulting_card_version: 2,
        affected_entry_id: first.data.changedEntryId,
        player_id: playerId,
        actor_user_id: cardScope.manager_user_id,
        actor_membership_id:
          cardScope.manager_membership_id,
        actor_authority: "manager",
      }
    );
    assert.deepEqual(
      database
        .prepare(`
          SELECT entry_kind, player_id,
                 requested_slot_group, requested_slot_number,
                 proposed_total_value_cents,
                 proposed_term_years, proposed_aav_cents,
                 eligibility_status, version
          FROM candidate_card_entries
          WHERE league_id = @leagueId AND id = @entryId
        `)
        .get({
          leagueId: scenario.leagueId,
          entryId: first.data.changedEntryId,
        }),
      {
        entry_kind: "candidate",
        player_id: playerId,
        requested_slot_group: "F",
        requested_slot_number: 1,
        proposed_total_value_cents: 600,
        proposed_term_years: 2,
        proposed_aav_cents: 300,
        eligibility_status: "valid",
        version: 1,
      }
    );
    assert.deepEqual(
      database
        .prepare(`
          SELECT status, result_type, result_id,
                 operation, client_key
          FROM idempotency_requests
          WHERE league_id = @leagueId
            AND actor_user_id = @actorUserId
            AND operation = 'candidate_card.add'
            AND client_key = @clientKey
        `)
        .get({
          leagueId: scenario.leagueId,
          actorUserId: cardScope.manager_user_id,
          clientKey: command.idempotencyKey,
        }),
      {
        status: "completed",
        result_type: "candidate_card_revision",
        result_id: first.data.revisionId,
        operation: "candidate_card.add",
        client_key: command.idempotencyKey,
      }
    );
    const outbox = database
      .prepare(`
        SELECT id, event_type, aggregate_type,
               aggregate_id, payload_json, status,
               available_at_ms, created_at_ms
        FROM outbox_events
        WHERE league_id = @leagueId
          AND event_type = 'candidate_card.changed'
          AND aggregate_id = @cardId
        ORDER BY json_extract(payload_json, '$.version'), id
      `)
      .all({
        leagueId: scenario.leagueId,
        cardId: cardScope.card_id,
      });
    assert.equal(outbox.length, 2);
    const openingOutbox = outbox[0];
    const mutationOutbox = outbox[1];
    assert.notEqual(openingOutbox.id, first.data.revisionId);
    assert.equal(mutationOutbox.id, first.data.revisionId);
    for (const [row, version] of [
      [openingOutbox, 1],
      [mutationOutbox, 2],
    ]) {
      assert.deepEqual(
        {
          event_type: row.event_type,
          aggregate_type: row.aggregate_type,
          aggregate_id: row.aggregate_id,
          status: row.status,
          available_at_ms: row.available_at_ms,
          created_at_ms: row.created_at_ms,
        },
        {
          event_type: "candidate_card.changed",
          aggregate_type: "candidate_card",
          aggregate_id: cardScope.card_id,
          status: "pending",
          available_at_ms: NOW_MS,
          created_at_ms: NOW_MS,
        }
      );
      assert.deepEqual(
        JSON.parse(row.payload_json),
        createSocketEventEnvelope({
          eventId: row.id,
          type: "candidate_card.changed",
          leagueId: scenario.leagueId,
          resourceId: cardScope.card_id,
          version,
          reasonCode: "card_changed",
          occurredAt: NOW_MS,
          related: createEmptySocketRelated({
            fadId: cardScope.fad_id,
            teamId: scenario.teamIds[0],
            cardId: cardScope.card_id,
          }),
        })
      );
      assert.deepEqual(
        database
          .prepare(`
            SELECT audience_kind, team_id, user_id
            FROM outbox_event_audiences
            WHERE league_id = @leagueId
              AND outbox_event_id = @eventId
          `)
          .all({
            leagueId: scenario.leagueId,
            eventId: row.id,
          }),
        [
          {
            audience_kind: "team",
            team_id: scenario.teamIds[0],
            user_id: null,
          },
        ]
      );
    }
    assert.deepEqual(
      database
        .prepare(`
          SELECT
            (SELECT COUNT(*) FROM league_activity) AS activity,
            (SELECT COUNT(*) FROM notifications) AS notifications
        `)
        .get(),
      baseline
    );

    const beforeReplay = database.serialize();
    const beforeReplayChanges = database
      .prepare("SELECT total_changes() AS count")
      .get().count;
    const replay = runtime.services.league.candidateCards
      .addCandidate(command);
    assert.deepEqual(replay, first);
    assert.equal(beforeReplay.equals(database.serialize()), true);
    assert.equal(
      database
        .prepare("SELECT total_changes() AS count")
        .get().count,
      beforeReplayChanges
    );
    assert.equal(
      database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM outbox_events
          WHERE league_id = @leagueId
            AND event_type = 'candidate_card.changed'
            AND aggregate_id = @cardId
        `)
        .get({
          leagueId: scenario.leagueId,
          cardId: cardScope.card_id,
        }).count,
      2
    );

    const lifecycleDraft = database.prepare(`
      SELECT id, candidate_deadline_at_ms
      FROM free_agent_drafts
      WHERE league_id = ? AND season_id = ?
    `).get(scenario.leagueId, scenario.seasonId);
    currentTimeMs = lifecycleDraft.candidate_deadline_at_ms;
    const overdueReminder = await runtime.services.league
      .freeAgentDraftDeadlineReminderJob.run();
    assert.equal(overdueReminder.skipped, 1);
    const manualScope = { leagueId: scenario.leagueId, fadId: lifecycleDraft.id, authenticated: commissioner };
    const manualPreview = runtime.services.league.fadDeadlineControl.preview({ ...manualScope, input: { reason: "Process this partial-card allocation fixture" } });
    runtime.services.league.fadDeadlineControl.proceed({ ...manualScope,
      input: { confirmed: true, previewHash: manualPreview.previewHash, reason: manualPreview.reason },
      idempotencyKey: "candidate-fixture-process-partial" });
    const deadline = await runtime.services.league
      .freeAgentDraftDeadlineJob.run();
    assert.equal(deadline.succeeded, 1);
    assert.deepEqual(
      await runtime.services.league
        .freeAgentDraftAllocationCycleJob.run(),
      {
        job: "free-agent-drafts:allocation-cycle:target",
        status: "succeeded",
        before: {
          job: "free-agent-drafts:allocation-lifecycle:target",
          status: "succeeded",
          scanned: 1,
          startedAllocating: 1,
          enteredRapid: 0,
          waiting: 0,
          replayed: 0,
          skipped: 0,
          failed: 0,
        },
        allocation: {
          job: "free-agent-drafts:allocations:target",
          status: "succeeded",
          due: 1,
          acquired: 1,
          succeeded: 1,
          correctionRequired: 0,
          failed: 0,
          skipped: 0,
        },
        after: {
          job: "free-agent-drafts:allocation-lifecycle:target",
          status: "succeeded",
          scanned: 1,
          startedAllocating: 0,
          enteredRapid: 1,
          waiting: 0,
          replayed: 0,
          skipped: 0,
          failed: 0,
        },
      }
    );
    assert.deepEqual(
      database.prepare(`
        SELECT status, allocation_completed_at_ms
        FROM free_agent_drafts
        WHERE id = ?
      `).get(lifecycleDraft.id),
      {
        status: "rapid",
        allocation_completed_at_ms:
          lifecycleDraft.candidate_deadline_at_ms,
      }
    );
    assert.deepEqual(
      database.prepare(`
        SELECT status, decision_code, player_id,
               winning_team_id
        FROM free_agent_draft_player_allocations
        WHERE fad_id = ?
      `).get(lifecycleDraft.id),
      {
        status: "automatic_award",
        decision_code: "sole_valid_offer",
        player_id: playerId,
        winning_team_id: scenario.teamIds[0],
      }
    );
    assert.deepEqual(
      database.prepare(`
        SELECT current_team_id, player_id, status,
               original_total_value_cents,
               original_term_years, aav_cents,
               acquisition_source_type
        FROM contracts
        WHERE league_id = ? AND player_id = ?
      `).get(scenario.leagueId, playerId),
      {
        current_team_id: scenario.teamIds[0],
        player_id: playerId,
        status: "active",
        original_total_value_cents: 600,
        original_term_years: 2,
        aav_cents: 300,
        acquisition_source_type:
          "free_agent_draft_allocation",
      }
    );
    assert.deepEqual(
      database.prepare(`
        SELECT team_id, player_id, ownership_kind,
               roster_category, position_group,
               slot_number
        FROM player_ownerships
        WHERE league_id = ? AND player_id = ?
      `).get(scenario.leagueId, playerId),
      {
        team_id: scenario.teamIds[0],
        player_id: playerId,
        ownership_kind: "Rostered",
        roster_category: "Active",
        position_group: "F",
        slot_number: 1,
      }
    );
    const resultNotifications = database.prepare(`
      SELECT message_data_json
      FROM notifications
      WHERE league_id = ?
        AND event_type = 'fad_automatic_result'
        AND related_record_id = ?
    `).all(scenario.leagueId, lifecycleDraft.id);
    assert.equal(resultNotifications.length, 4);
    assert.equal(
      resultNotifications
        .map(({ message_data_json: message }) =>
          JSON.parse(message)
        )
        .find(({ teamId }) =>
          teamId === scenario.teamIds[0]
        ).automaticWins,
      1
    );
    const publishedResults = runtime.services.league
      .freeAgentDraftRead.allocationResults({
        leagueId: scenario.leagueId,
        fadId: lifecycleDraft.id,
        authenticated: commissioner,
        query: { teamId: scenario.teamIds[0] },
      });
    assert.equal(publishedResults.data.length, 1);
    assert.equal(
      publishedResults.data[0].status,
      "signed"
    );
    assert.deepEqual(publishedResults.data[0], {
      player: {
        playerId,
        fullName: "Candidate Runtime",
        positionGroup: "F",
      },
      status: "signed",
      offer: null,
      tieAuctionId: null,
    });
  });

  test("commits and exactly replays one Candidate help request through the composed target runtime", async (t) => {
    const database = createDatabase(t);
    let currentNowMs = NOW_MS;
    const securityFoundations = createSecurityFoundations({
      env: securityEnv(),
      now: () => currentNowMs,
      loggerSink() {},
    });
    const runtime = createTargetRuntime(
      runtimeOptions(database, { securityFoundations })
    );
    const scenario = seedComposedLeagueStartScenario(runtime);
    const commissioner =
      runtime.services.sessionService.resolveWithoutActivity(
        scenario.session.rawSessionToken
      );
    assert.equal(commissioner.valid, true);

    const started = runtime.services.league.start.start({
      leagueId: scenario.leagueId,
      input: {},
      expectedLeagueVersion: scenario.expectedLeagueVersion,
      idempotencyKey: "target-runtime-candidate-help-start",
      authenticated: commissioner,
    });
    runtime.services.league.matchupSchedule.generate({
      leagueId: scenario.leagueId,
      seasonId: scenario.seasonId,
      expectedSeasonVersion: started.league.currentSeason.version,
      input: {
        nhlRegularSeasonStartsAtMs: Date.parse(
          "2026-10-06T07:00:00.000Z"
        ),
        nhlRegularSeasonEndsAtMs: Date.parse(
          "2027-04-12T07:00:00.000Z"
        ),
        fantasyPlayoffsStartAtMs: Date.parse(
          "2027-03-15T07:00:00.000Z"
        ),
        fantasyPlayoffsEndAtMs: Date.parse(
          "2027-04-12T07:00:00.000Z"
        ),
        firstWeekStartsAtMs: Date.parse(
          "2026-10-12T07:00:00.000Z"
        ),
        confirmed: true,
      },
      idempotencyKey: "target-runtime-candidate-help-schedule",
      authenticated: commissioner,
    });
    const opening = await runtime.services.league
      .freeAgentDraftReadinessJob.run();
    assert.equal(opening.status, "succeeded");
    assert.equal(opening.succeeded, 1);

    const cardScope = database
      .prepare(`
        SELECT
          fad.id AS fad_id,
          fad.help_opens_at_ms,
          fad.candidate_deadline_at_ms,
          card.id AS card_id,
          assignment.user_id AS manager_user_id
        FROM free_agent_drafts AS fad
        JOIN candidate_cards AS card
          ON card.league_id = fad.league_id
         AND card.season_id = fad.season_id
         AND card.fad_id = fad.id
        JOIN team_manager_assignments AS assignment
          ON assignment.league_id = card.league_id
         AND assignment.team_id = card.team_id
         AND assignment.status = 'accepted'
         AND assignment.ended_at_ms IS NULL
        WHERE fad.league_id = @leagueId
          AND fad.season_id = @seasonId
          AND card.team_id = @teamId
      `)
      .get({
        leagueId: scenario.leagueId,
        seasonId: scenario.seasonId,
        teamId: scenario.teamIds[0],
      });
    currentNowMs = cardScope.help_opens_at_ms;
    assert.equal(
      currentNowMs < cardScope.candidate_deadline_at_ms,
      true
    );
    const managerSession =
      runtime.services.sessionService.issueForUser({
        userId: cardScope.manager_user_id,
      });
    const manager =
      runtime.services.sessionService.resolveWithoutActivity(
        managerSession.rawSessionToken
      );
    assert.equal(manager.valid, true);

    const baseline = database
      .prepare(`
        SELECT
          (SELECT COUNT(*) FROM league_activity) AS activity,
          (SELECT COUNT(*) FROM security_audit_events) AS audit,
          (SELECT COUNT(*) FROM notifications) AS notifications,
          (SELECT COUNT(*) FROM outbox_events) AS outbox
      `)
      .get();
    const command = {
      authenticated: manager,
      leagueId: scenario.leagueId,
      fadId: cardScope.fad_id,
      teamId: scenario.teamIds[0],
      input: { message: "Please help me finish my card." },
      idempotencyKey: "target-runtime-candidate-help-exact-replay",
    };
    const first = runtime.services.league.candidateCards
      .requestHelp(command);
    assert.equal(first.httpStatus, 201);
    assert.equal(first.data.leagueId, scenario.leagueId);
    assert.equal(first.data.seasonId, scenario.seasonId);
    assert.equal(first.data.fadId, cardScope.fad_id);
    assert.equal(first.data.cardId, cardScope.card_id);
    assert.equal(first.data.teamId, scenario.teamIds[0]);
    assert.equal(first.data.status, "active");
    assert.equal(
      first.data.message,
      "Please help me finish my card."
    );
    assert.equal(
      first.data.requestedByUserId,
      cardScope.manager_user_id
    );
    assert.equal(first.data.version, 1);

    assert.deepEqual(
      database
        .prepare(`
          SELECT id, status, message, requested_by_user_id,
                 requested_at_ms, expires_at_ms, version
          FROM candidate_card_help_requests
          WHERE league_id = @leagueId AND id = @helpRequestId
        `)
        .get({
          leagueId: scenario.leagueId,
          helpRequestId: first.data.helpRequestId,
        }),
      {
        id: first.data.helpRequestId,
        status: "active",
        message: "Please help me finish my card.",
        requested_by_user_id: cardScope.manager_user_id,
        requested_at_ms: currentNowMs,
        expires_at_ms: cardScope.candidate_deadline_at_ms,
        version: 1,
      }
    );
    assert.deepEqual(
      database
        .prepare(`
          SELECT response_http_status, response_json,
                 requested_by_display_name
          FROM candidate_card_help_command_results
          WHERE league_id = @leagueId
            AND help_request_id = @helpRequestId
        `)
        .get({
          leagueId: scenario.leagueId,
          helpRequestId: first.data.helpRequestId,
        }),
      {
        response_http_status: 201,
        response_json: JSON.stringify(first.data),
        requested_by_display_name:
          first.data.requestedByDisplayName,
      }
    );
    const after = database
      .prepare(`
        SELECT
          (SELECT COUNT(*) FROM league_activity) AS activity,
          (SELECT COUNT(*) FROM security_audit_events) AS audit,
          (SELECT COUNT(*) FROM notifications) AS notifications,
          (SELECT COUNT(*) FROM outbox_events) AS outbox
      `)
      .get();
    assert.deepEqual(after, {
      activity: baseline.activity,
      audit: baseline.audit + 1,
      notifications: baseline.notifications + 1,
      outbox: baseline.outbox + 2,
    });
    const helpNotification = database
      .prepare(`
        SELECT id, user_id, message_data_json, created_at_ms, version
        FROM notifications
        WHERE league_id = @leagueId
          AND event_type = 'fad_help_requested'
      `)
      .get({ leagueId: scenario.leagueId });
    assert.equal(
      helpNotification.user_id,
      scenario.commissionerUserId
    );
    assert.deepEqual(
      JSON.parse(helpNotification.message_data_json),
      {
        leagueId: scenario.leagueId,
        seasonId: scenario.seasonId,
        fadId: cardScope.fad_id,
        teamId: scenario.teamIds[0],
        cardId: cardScope.card_id,
        helpRequestId: first.data.helpRequestId,
        requestingUserId: cardScope.manager_user_id,
        requestingDisplayName:
          first.data.requestedByDisplayName,
        destination: {
          kind: "private_card",
          leagueId: scenario.leagueId,
          fadId: cardScope.fad_id,
          teamId: scenario.teamIds[0],
          cardId: cardScope.card_id,
        },
      }
    );
    assert.doesNotMatch(
      helpNotification.message_data_json,
      /Please help me finish my card\./
    );
    const notificationPublication = database
      .prepare(`
        SELECT id, payload_json
        FROM outbox_events
        WHERE league_id = @leagueId
          AND event_type = 'notification.created'
          AND aggregate_type = 'notification'
          AND aggregate_id = @notificationId
      `)
      .get({
        leagueId: scenario.leagueId,
        notificationId: helpNotification.id,
      });
    assert.deepEqual(
      JSON.parse(notificationPublication.payload_json),
      createSocketEventEnvelope({
        eventId: notificationPublication.id,
        type: "notification.created",
        leagueId: scenario.leagueId,
        resourceId: helpNotification.id,
        version: helpNotification.version,
        reasonCode: "notification_created",
        occurredAt: helpNotification.created_at_ms,
        related: createEmptySocketRelated({
          fadId: cardScope.fad_id,
          teamId: scenario.teamIds[0],
          cardId: cardScope.card_id,
        }),
      })
    );
    assert.deepEqual(
      database
        .prepare(`
          SELECT audience_kind, team_id, user_id
          FROM outbox_event_audiences
          WHERE league_id = @leagueId
            AND outbox_event_id = @outboxEventId
        `)
        .all({
          leagueId: scenario.leagueId,
          outboxEventId: notificationPublication.id,
        }),
      [
        {
          audience_kind: "user",
          team_id: null,
          user_id: scenario.commissionerUserId,
        },
      ]
    );
    assert.deepEqual(
      database
        .prepare(`
          SELECT audience_kind, team_id, user_id
          FROM outbox_event_audiences
          WHERE league_id = @leagueId
            AND outbox_event_id = @helpRequestId
          ORDER BY audience_kind DESC, COALESCE(team_id, user_id)
        `)
        .all({
          leagueId: scenario.leagueId,
          helpRequestId: first.data.helpRequestId,
        }),
      [
        {
          audience_kind: "user",
          team_id: null,
          user_id: scenario.commissionerUserId,
        },
        {
          audience_kind: "team",
          team_id: scenario.teamIds[0],
          user_id: null,
        },
      ]
    );

    const beforeReplay = database.serialize();
    const beforeReplayChanges = database
      .prepare("SELECT total_changes() AS count")
      .get().count;
    const replay = runtime.services.league.candidateCards
      .requestHelp(command);
    assert.deepEqual(replay, first);
    assert.equal(beforeReplay.equals(database.serialize()), true);
    assert.equal(
      database.prepare("SELECT total_changes() AS count").get().count,
      beforeReplayChanges
    );
  });

  test("retries one blocked FAD readiness occurrence through T-128 and replays its immutable receipt after later worker attempts and terminal success", async (t) => {
    const database = createDatabase(t);
    let currentNowMs = NOW_MS;
    const securityFoundations =
      createSecurityFoundations({
        env: securityEnv(),
        now: () => currentNowMs,
        loggerSink() {},
      });
    const runtime = createTargetRuntime(
      runtimeOptions(database, {
        securityFoundations,
      })
    );
    const scenario =
      seedComposedLeagueStartScenario(runtime);
    const authenticated =
      runtime.services.sessionService.resolveWithoutActivity(
        scenario.session.rawSessionToken
      );
    assert.equal(authenticated.valid, true);
    const started = runtime.services.league.start.start({
      leagueId: scenario.leagueId,
      input: {},
      expectedLeagueVersion:
        scenario.expectedLeagueVersion,
      idempotencyKey:
        "target-runtime-fad-readiness-blocked",
      authenticated,
    });

    const firstAttempt = await runtime.services.league
      .freeAgentDraftReadinessJob.run();
    assert.deepEqual(
      {
        due: firstAttempt.due,
        acquired: firstAttempt.acquired,
        succeeded: firstAttempt.succeeded,
        blocked: firstAttempt.blocked,
        failed: firstAttempt.failed,
      },
      {
        due: 1,
        acquired: 1,
        succeeded: 0,
        blocked: 1,
        failed: 0,
      }
    );
    const blocked = database.prepare(`
      SELECT id, status,
             attempt_count AS attemptCount,
             job_run_id AS jobRunId,
             readiness_occurrence_key AS occurrenceKey,
             next_retry_at_ms AS nextRetryAtMs,
             version
      FROM free_agent_draft_readiness_operations
      WHERE league_id = ? AND season_id = ?
    `).get(scenario.leagueId, scenario.seasonId);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.attemptCount, 1);
    assert.equal(blocked.version, 3);
    assert.ok(blocked.nextRetryAtMs > NOW_MS);
    assert.deepEqual(
      database.prepare(`
        SELECT status,
               attempt_count AS attemptCount,
               last_error_code AS lastErrorCode,
               completed_at_ms AS completedAtMs,
               version
        FROM job_runs
        WHERE league_id = ? AND id = ?
      `).get(scenario.leagueId, blocked.jobRunId),
      {
        status: "failed",
        attemptCount: 1,
        lastErrorCode: "FAD_READINESS_BLOCKED",
        completedAtMs: NOW_MS,
        version: 3,
      }
    );

    currentNowMs = NOW_MS + 1;
    const baseUrl = await startRuntimeApp(t, runtime);
    const retryUrl = new URL(
      `/api/v1/leagues/${scenario.leagueId}` +
        "/free-agent-drafts/readiness/retries",
      baseUrl
    );
    const cookie =
      `${runtime.transport.sessionCookie.name}=` +
      scenario.session.rawSessionToken;
    const retryBody = {
      seasonId: scenario.seasonId,
      readinessOperationId: blocked.id,
      confirmation:
        "RETRY FREE AGENT DRAFT READINESS",
    };
    const retryHeaders = (overrides = {}) =>
      browserHeaders({
        Cookie: cookie,
        "X-CSRF-Token":
          scenario.session.rawCsrfToken,
        "If-Match": '"3"',
        "Idempotency-Key":
          "target-runtime-fad-readiness-retry",
        ...overrides,
      });
    const assertRejectedWithoutWrites = async ({
      expectedCode,
      expectedDetails,
      expectedStatus,
      headers,
      body,
    }) => {
      const beforeBytes = database.serialize();
      const beforeChanges = database
        .prepare(
          "SELECT total_changes() AS count"
        )
        .get().count;
      const response = await fetch(retryUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const responseBody = await response.json();
      assert.equal(response.status, expectedStatus);
      assert.equal(
        response.headers.get("cache-control"),
        "private, no-store"
      );
      assert.equal(responseBody.error.code, expectedCode);
      assert.deepEqual(
        responseBody.error.details,
        expectedDetails
      );
      assert.equal(
        beforeBytes.equals(database.serialize()),
        true
      );
      assert.equal(
        database
          .prepare(
            "SELECT total_changes() AS count"
          )
          .get().count,
        beforeChanges
      );
    };

    const beforeReadiness = database.serialize();
    const readinessResponse = await fetch(
      new URL(
        `/api/v1/leagues/${scenario.leagueId}` +
          "/free-agent-drafts/readiness" +
          `?seasonId=${scenario.seasonId}`,
        baseUrl
      ),
      {
        headers: browserHeaders({ Cookie: cookie }),
      }
    );
    const readinessBody =
      await readinessResponse.json();
    assert.equal(readinessResponse.status, 200);
    assert.equal(
      readinessResponse.headers.get("cache-control"),
      "private, no-store"
    );
    assert.equal(readinessBody.data.status, "blocked");
    assert.equal(
      readinessBody.data.operationVersion,
      3
    );
    assert.deepEqual(
      readinessBody.data.blockers.map(
        ({ code }) => code
      ),
      ["MATCHUP_SCHEDULE_MISSING"]
    );
    assert.deepEqual(
      readinessBody.data.initialRollovers,
      []
    );
    assert.deepEqual(
      readinessBody.data.retryReadiness,
      { allowed: true, reasonCode: null }
    );
    assert.equal(
      beforeReadiness.equals(database.serialize()),
      true
    );

    await assertRejectedWithoutWrites({
      expectedCode: "CSRF_INVALID",
      expectedStatus: 403,
      expectedDetails: undefined,
      headers: retryHeaders({
        "X-CSRF-Token": "invalid",
        "Idempotency-Key":
          "target-runtime-fad-readiness-csrf",
      }),
      body: retryBody,
    });
    await assertRejectedWithoutWrites({
      expectedCode: "FREE_AGENT_DRAFT_INPUT_INVALID",
      expectedStatus: 400,
      expectedDetails: undefined,
      headers: retryHeaders({
        "Idempotency-Key":
          "target-runtime-fad-readiness-input",
      }),
      body: { ...retryBody, openingTime: NOW_MS },
    });
    await assertRejectedWithoutWrites({
      expectedCode:
        "FAD_READINESS_PRECONDITION_FAILED",
      expectedStatus: 412,
      expectedDetails: {
        currentVersion: 3,
        refetch: true,
      },
      headers: retryHeaders({
        "If-Match": '"2"',
        "Idempotency-Key":
          "target-runtime-fad-readiness-stale",
      }),
      body: retryBody,
    });

    const acceptedResponse = await fetch(retryUrl, {
      method: "POST",
      headers: retryHeaders(),
      body: JSON.stringify(retryBody),
    });
    const accepted = await acceptedResponse.json();
    assert.equal(acceptedResponse.status, 202);
    assert.equal(
      acceptedResponse.headers.get("cache-control"),
      "private, no-store"
    );
    assert.deepEqual(
      {
        leagueId: accepted.data.leagueId,
        seasonId: accepted.data.seasonId,
        readinessOperationId:
          accepted.data.readinessOperationId,
        acceptedFromVersion:
          accepted.data.acceptedFromVersion,
        resultingReadinessVersion:
          accepted.data.resultingReadinessVersion,
        retryAttemptNumber:
          accepted.data.retryAttemptNumber,
        jobRunId: accepted.data.jobRunId,
        occurrenceKey: accepted.data.occurrenceKey,
        acceptedAtMs: accepted.data.acceptedAtMs,
        status: accepted.data.status,
      },
      {
        leagueId: scenario.leagueId,
        seasonId: scenario.seasonId,
        readinessOperationId: blocked.id,
        acceptedFromVersion: 3,
        resultingReadinessVersion: 4,
        retryAttemptNumber: 2,
        jobRunId: blocked.jobRunId,
        occurrenceKey: blocked.occurrenceKey,
        acceptedAtMs: currentNowMs,
        status: "accepted",
      }
    );
    assert.match(
      accepted.data.retryReceiptId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    );
    assert.equal(
      typeof accepted.meta.requestId,
      "string"
    );
    assert.deepEqual(
      database.prepare(`
        SELECT status,
               attempt_count AS attemptCount,
               next_retry_at_ms AS nextRetryAtMs,
               version
        FROM free_agent_draft_readiness_operations
        WHERE league_id = ? AND id = ?
      `).get(scenario.leagueId, blocked.id),
      {
        status: "blocked",
        attemptCount: 1,
        nextRetryAtMs: currentNowMs,
        version: 4,
      }
    );
    assert.deepEqual(
      database.prepare(`
        SELECT status,
               attempt_count AS attemptCount,
               next_attempt_at_ms AS nextAttemptAtMs,
               completed_at_ms AS completedAtMs,
               last_error_code AS lastErrorCode,
               version
        FROM job_runs
        WHERE league_id = ? AND id = ?
      `).get(scenario.leagueId, blocked.jobRunId),
      {
        status: "pending",
        attemptCount: 1,
        nextAttemptAtMs: currentNowMs,
        completedAtMs: null,
        lastErrorCode: null,
        version: 4,
      }
    );
    const receipt = database.prepare(`
      SELECT response_http_status AS responseHttpStatus,
             response_json AS responseJson,
             response_sha256 AS responseSha256
      FROM free_agent_draft_readiness_retry_receipts
      WHERE league_id = ?
        AND readiness_operation_id = ?
    `).get(scenario.leagueId, blocked.id);
    assert.equal(receipt.responseHttpStatus, 202);
    assert.deepEqual(
      JSON.parse(receipt.responseJson),
      accepted.data
    );
    assert.match(
      receipt.responseSha256,
      /^[a-f0-9]{64}$/u
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM idempotency_requests
        WHERE league_id = ?
          AND operation =
            'free_agent_draft.readiness.retry.v1'
      `).get(scenario.leagueId).count,
      1
    );

    const laterAttempt = await runtime.services.league
      .freeAgentDraftReadinessJob.run();
    assert.deepEqual(
      {
        due: laterAttempt.due,
        acquired: laterAttempt.acquired,
        blocked: laterAttempt.blocked,
        failed: laterAttempt.failed,
      },
      { due: 1, acquired: 1, blocked: 1, failed: 0 }
    );
    assert.deepEqual(
      database.prepare(`
        SELECT status,
               attempt_count AS attemptCount,
               version
        FROM free_agent_draft_readiness_operations
        WHERE league_id = ? AND id = ?
      `).get(scenario.leagueId, blocked.id),
      { status: "blocked", attemptCount: 2, version: 6 }
    );
    assert.deepEqual(
      database.prepare(`
        SELECT status,
               attempt_count AS attemptCount,
               last_error_code AS lastErrorCode,
               version
        FROM job_runs
        WHERE league_id = ? AND id = ?
      `).get(scenario.leagueId, blocked.jobRunId),
      {
        status: "failed",
        attemptCount: 2,
        lastErrorCode: "FAD_READINESS_BLOCKED",
        version: 6,
      }
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM free_agent_draft_readiness_attempts
        WHERE league_id = ?
          AND readiness_operation_id = ?
      `).get(scenario.leagueId, blocked.id).count,
      2
    );

    const beforeReplay = database.serialize();
    const changesBeforeReplay = database
      .prepare(
        "SELECT total_changes() AS count"
      )
      .get().count;
    const replayResponse = await fetch(retryUrl, {
      method: "POST",
      headers: retryHeaders(),
      body: JSON.stringify(retryBody),
    });
    const replay = await replayResponse.json();
    assert.equal(replayResponse.status, 202);
    assert.equal(
      replayResponse.headers.get("cache-control"),
      "private, no-store"
    );
    assert.deepEqual(replay.data, accepted.data);
    assert.notEqual(
      replay.meta.requestId,
      accepted.meta.requestId
    );
    assert.equal(
      beforeReplay.equals(database.serialize()),
      true
    );
    assert.equal(
      database
        .prepare(
          "SELECT total_changes() AS count"
        )
        .get().count,
      changesBeforeReplay
    );
    assert.deepEqual(
      database.prepare(`
        SELECT
          (SELECT COUNT(*)
           FROM free_agent_draft_readiness_retry_receipts
           WHERE league_id = ?) AS receipts,
          (SELECT COUNT(*)
           FROM idempotency_requests
           WHERE league_id = ?
             AND operation =
               'free_agent_draft.readiness.retry.v1') AS idempotency,
          (SELECT version
           FROM free_agent_draft_readiness_operations
           WHERE league_id = ? AND id = ?) AS readinessVersion
      `).get(
        scenario.leagueId,
        scenario.leagueId,
        scenario.leagueId,
        blocked.id
      ),
      {
        receipts: 1,
        idempotency: 1,
        readinessVersion: 6,
      }
    );

    currentNowMs = NOW_MS + 2;
    const firstWeekStartsAtMs = Date.parse(
      "2026-10-12T07:00:00.000Z"
    );
    const schedule =
      runtime.services.league.matchupSchedule.generate({
        leagueId: scenario.leagueId,
        seasonId: scenario.seasonId,
        expectedSeasonVersion:
          started.league.currentSeason.version,
        input: {
          nhlRegularSeasonStartsAtMs: Date.parse(
            "2026-10-06T07:00:00.000Z"
          ),
          nhlRegularSeasonEndsAtMs: Date.parse(
            "2027-04-12T07:00:00.000Z"
          ),
          fantasyPlayoffsStartAtMs: Date.parse(
            "2027-03-15T07:00:00.000Z"
          ),
          fantasyPlayoffsEndAtMs: Date.parse(
            "2027-04-12T07:00:00.000Z"
          ),
          firstWeekStartsAtMs,
          confirmed: true,
        },
        idempotencyKey:
          "target-runtime-fad-readiness-terminal-schedule",
        authenticated,
      });
    assert.equal(
      schedule.firstWeekStartsAtMs,
      firstWeekStartsAtMs
    );
    const terminalAttempt = await runtime.services.league
      .freeAgentDraftReadinessJob.run();
    assert.deepEqual(
      {
        due: terminalAttempt.due,
        acquired: terminalAttempt.acquired,
        succeeded: terminalAttempt.succeeded,
        blocked: terminalAttempt.blocked,
        failed: terminalAttempt.failed,
      },
      {
        due: 1,
        acquired: 1,
        succeeded: 1,
        blocked: 0,
        failed: 0,
      }
    );
    const terminalReadiness = database.prepare(`
      SELECT status,
             attempt_count AS attemptCount,
             created_fad_id AS createdFadId,
             terminal_at_ms AS terminalAtMs,
             version
      FROM free_agent_draft_readiness_operations
      WHERE league_id = ? AND id = ?
    `).get(scenario.leagueId, blocked.id);
    assert.equal(terminalReadiness.status, "succeeded");
    assert.equal(terminalReadiness.attemptCount, 3);
    assert.notEqual(terminalReadiness.createdFadId, null);
    assert.equal(
      terminalReadiness.terminalAtMs,
      currentNowMs
    );

    const beforeTerminalReplay = database.serialize();
    const changesBeforeTerminalReplay = database
      .prepare(
        "SELECT total_changes() AS count"
      )
      .get().count;
    const terminalReplayResponse = await fetch(retryUrl, {
      method: "POST",
      headers: retryHeaders(),
      body: JSON.stringify(retryBody),
    });
    const terminalReplay =
      await terminalReplayResponse.json();
    assert.equal(terminalReplayResponse.status, 202);
    assert.equal(
      terminalReplayResponse.headers.get("cache-control"),
      "private, no-store"
    );
    assert.deepEqual(terminalReplay.data, accepted.data);
    assert.notEqual(
      terminalReplay.meta.requestId,
      accepted.meta.requestId
    );
    assert.notEqual(
      terminalReplay.meta.requestId,
      replay.meta.requestId
    );
    assert.equal(
      beforeTerminalReplay.equals(database.serialize()),
      true
    );
    assert.equal(
      database
        .prepare(
          "SELECT total_changes() AS count"
        )
        .get().count,
      changesBeforeTerminalReplay
    );
    assert.deepEqual(
      database.prepare(`
        SELECT response_http_status AS responseHttpStatus,
               response_json AS responseJson,
               response_sha256 AS responseSha256,
               version
        FROM free_agent_draft_readiness_retry_receipts
        WHERE league_id = ?
          AND readiness_operation_id = ?
      `).get(scenario.leagueId, blocked.id),
      {
        responseHttpStatus: 202,
        responseJson: receipt.responseJson,
        responseSha256: receipt.responseSha256,
        version: 1,
      }
    );
    assert.deepEqual(database.pragma("integrity_check"), [
      { integrity_check: "ok" },
    ]);
  });

  test("runs current matchup occurrences and skips superseded execution through the composed guards", async (t) => {
    const database = createDatabase(t);
    const currentScope = seedComposedMatchupOccurrenceScope(
      database,
      60_000
    );
    const supersededScope = seedComposedMatchupOccurrenceScope(
      database,
      61_000
    );
    database.exec("DROP TRIGGER free_agent_drafts_forward_update");
    completeComposedMatchupOccurrenceFad(database, currentScope);
    completeComposedMatchupOccurrenceFad(database, supersededScope);
    const claimInstrumentation =
      instrumentComposedMatchupClaim(database);
    const runtime = createTargetRuntime(runtimeOptions(database));
    claimInstrumentation.restore();

    scheduleComposedBaselineOccurrence(runtime, currentScope);
    const currentResult =
      await runtime.services.league.matchupOccurrenceJob.run();
    assert.equal(currentResult.status, "succeeded");
    assert.equal(currentResult.due, 1);
    assert.equal(currentResult.acquired, 1);
    assert.equal(currentResult.succeeded, 1);
    assert.equal(currentResult.failed, 0);
    assert.equal(currentResult.skipped, 0);
    assert.deepEqual(
      database.prepare(`
        SELECT status
        FROM matchup_weeks
        WHERE league_id = ? AND season_id = ? AND id = ?
      `).get(
        currentScope.leagueId,
        currentScope.seasonId,
        currentScope.weekId
      ),
      { status: "baseline_ready" }
    );
    assert.deepEqual(
      database.prepare(`
        SELECT status
        FROM job_runs
        WHERE id = ?
      `).get(currentScope.runId),
      { status: "succeeded" }
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM matchup_operations
        WHERE league_id = ? AND season_id = ?
          AND matchup_week_id = ?
          AND operation_type = 'week_transition'
      `).get(
        currentScope.leagueId,
        currentScope.seasonId,
        currentScope.weekId
      ).count,
      1
    );

    scheduleComposedBaselineOccurrence(runtime, supersededScope);
    claimInstrumentation.afterNextClaim(
      () =>
        supersedeComposedMatchupGeneration(
          database,
          supersededScope
        )
    );
    const supersededResult =
      await runtime.services.league.matchupOccurrenceJob.run();
    assert.equal(supersededResult.status, "succeeded");
    assert.equal(supersededResult.due, 1);
    assert.equal(supersededResult.acquired, 1);
    assert.equal(supersededResult.succeeded, 0);
    assert.equal(supersededResult.failed, 0);
    assert.equal(supersededResult.skipped, 1);
    assert.deepEqual(
      database.prepare(`
        SELECT status
        FROM matchup_weeks
        WHERE league_id = ? AND season_id = ? AND id = ?
      `).get(
        supersededScope.leagueId,
        supersededScope.seasonId,
        supersededScope.weekId
      ),
      { status: "scheduled" }
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM matchup_operations
        WHERE league_id = ? AND season_id = ?
          AND matchup_week_id = ?
          AND operation_type = 'week_transition'
      `).get(
        supersededScope.leagueId,
        supersededScope.seasonId,
        supersededScope.weekId
      ).count,
      0
    );

    assert.deepEqual(
      database.prepare(`
        SELECT status, result_json AS resultJson
        FROM job_runs
        WHERE id = ?
      `).get(supersededScope.runId),
      {
        status: "skipped",
        resultJson:
          '{"outcome":"superseded_schedule_generation"}',
      }
    );
  });

  test("installs every declared target method and path exactly once in its intended router", (t) => {
    const database = createDatabase(t);
    const runtime = createTargetRuntime(runtimeOptions(database));
    const sortEndpoint = ({ method, path, routerKey }) =>
      `${method} ${path} ${routerKey}`;
    const actual = installedTargetEndpoints(runtime.transport.routers)
      .map(sortEndpoint)
      .sort();
    const expected = TARGET_ENDPOINTS.map(sortEndpoint).sort();
    assert.equal(new Set(actual).size, actual.length);
    assert.deepEqual(actual, expected);
  });

  test("composes zero, zero, and one shared live adapter for disabled, probe, and verified required modes", (t) => {
    const database = createDatabase(t);
    const compositionCounts = [];
    const statisticBindings = [];
    const gameStateBindings = [];
    const networkUses = [];
    const scheduledJobNames = [];
    const descriptors = [
      Object.freeze({
        mode: "disabled",
        enabled: false,
        verified: false,
      }),
      Object.freeze({
        mode: "probe",
        enabled: false,
        verified: false,
      }),
      verifiedSportsDataIoLiveNhl(),
    ];

    for (const descriptor of descriptors) {
      let compositions = 0;
      const fetchImplementation = () => {
        networkUses.push(descriptor.mode);
      };
      const sharedAdapter = {};
      Object.defineProperties(sharedAdapter, {
        fetchLiveSnapshot: {
          configurable: false,
          enumerable: true,
          get() {
            statisticBindings.push(descriptor.mode);
            return async () => {
              throw new Error("unused statistics provider");
            };
          },
        },
        fetchGameStates: {
          configurable: false,
          enumerable: true,
          get() {
            gameStateBindings.push(descriptor.mode);
            return async () => {
              throw new Error("unused game-state provider");
            };
          },
        },
      });
      Object.freeze(sharedAdapter);

      const runtime = createTargetRuntime(
        runtimeOptions(database, {
          sportsDataIoLiveNhl: descriptor,
          sportsDataIoFetchImplementation: fetchImplementation,
          createSportsDataIoLiveNhlAdapterFunction(options) {
            compositions += 1;
            assert.deepEqual(Object.keys(options).sort(), [
              "apiKey",
              "fetchImpl",
              "nowMs",
              "origin",
            ]);
            assert.equal(options.apiKey, SPORTSDATAIO_LIVE_API_KEY);
            assert.equal(options.fetchImpl, fetchImplementation);
            assert.equal(options.origin, "https://api.sportsdata.io");
            assert.equal(options.nowMs(), NOW_MS);
            return sharedAdapter;
          },
        })
      );
      scheduledJobNames.push(
        runtime.services.league.scheduledJobs.map(
          ({ name }) => name
        )
      );
      compositionCounts.push(compositions);
    }

    assert.deepEqual(compositionCounts, [0, 0, 1]);
    assert.deepEqual(
      scheduledJobNames.map((names) =>
        names.includes("matchup_occurrences")
      ),
      [false, false, true]
    );
    assert.deepEqual(
      scheduledJobNames.map((names) =>
        names.filter(
          (name) => name !== "matchup_occurrences"
        )
      ),
      [scheduledJobNames[0], scheduledJobNames[0], scheduledJobNames[0]]
    );
    assert.deepEqual(statisticBindings, ["required"]);
    assert.deepEqual(gameStateBindings, ["required"]);
    assert.deepEqual(networkUses, []);
    const requiredDescriptor = descriptors[2];
    const apiKeyDescriptor = Object.getOwnPropertyDescriptor(
      requiredDescriptor,
      "apiKey"
    );
    assert.equal(apiKeyDescriptor.enumerable, false);
    assert.equal(apiKeyDescriptor.writable, false);
    assert.equal(apiKeyDescriptor.configurable, false);
    assert.equal(
      JSON.stringify(requiredDescriptor).includes(
        SPORTSDATAIO_LIVE_API_KEY
      ),
      false
    );
  });

  test("rejects malformed enabled live descriptors before adapter or network use", (t) => {
    const database = createDatabase(t);
    const valid = verifiedSportsDataIoLiveNhl();
    const rawMarker = "raw-live-provider-payload-marker";
    const invalidDescriptors = [
      verifiedSportsDataIoLiveNhl({ mode: "probe" }),
      verifiedSportsDataIoLiveNhl({ verified: false }),
      verifiedSportsDataIoLiveNhl({
        verification: { ...valid.verification },
      }),
      verifiedSportsDataIoLiveNhl({
        verification: Object.freeze({
          ...valid.verification,
          rawPayload: rawMarker,
        }),
      }),
      Object.freeze({
        ...valid,
        apiKey: SPORTSDATAIO_LIVE_API_KEY,
      }),
    ];
    let adapterCreations = 0;
    let networkUses = 0;

    for (const descriptor of invalidDescriptors) {
      let caught;
      try {
        createTargetRuntime(
          runtimeOptions(database, {
            sportsDataIoLiveNhl: descriptor,
            sportsDataIoFetchImplementation() {
              networkUses += 1;
            },
            createSportsDataIoLiveNhlAdapterFunction() {
              adapterCreations += 1;
              throw new Error(
                `${SPORTSDATAIO_LIVE_API_KEY}:${rawMarker}`
              );
            },
          })
        );
      } catch (error) {
        caught = error;
      }
      assert.equal(caught instanceof TypeError, true);
      const serialized = JSON.stringify({
        message: caught?.message,
        name: caught?.name,
      });
      assert.equal(serialized.includes(SPORTSDATAIO_LIVE_API_KEY), false);
      assert.equal(serialized.includes(rawMarker), false);
    }
    assert.equal(adapterCreations, 0);
    assert.equal(networkUses, 0);
  });

  test("seals an empty exact live-statistics scope through the catalog identity namespace", async (t) => {
    const database = createDatabase(t);
    const providerTotals = seedLiveStatisticsCatalog(database);
    const providerCalls = [];
    const runtime = createTargetRuntime(
      runtimeOptions(database, {
        sportsDataIoLiveNhl: verifiedSportsDataIoLiveNhl(),
        async sportsDataIoFetchImplementation(url) {
          providerCalls.push(url);
          return {
            ok: true,
            async json() {
              if (url.includes("/PlayerSeasonStats/")) {
                return providerTotals;
              }
              if (
                url.endsWith("/Players") ||
                url.endsWith("/FreeAgents") ||
                url.includes("/GamesByDate/") ||
                url.includes("/PlayerGameStatsByDate/")
              ) {
                return [];
              }
              throw new Error(`Unexpected live fixture URL: ${url}`);
            },
          };
        },
      })
    );
    const requirements = runtime.repositories.statistics
      .readPlayerGameCoverageRequirements({
        nhlSeasonKey: "20262027",
        playerIdentityProvider:
          SPORTSDATAIO_PLAYER_IDENTITY_PROVIDER_NAME,
      });
    assert.deepEqual(requirements.requiredPlayers, []);
    assert.equal(
      requirements.playerIdentityProvider,
      SPORTSDATAIO_PLAYER_IDENTITY_PROVIDER_NAME
    );

    const result = await runtime.services.league.statistics.refresh();

    assert.equal(
      result.playerCount,
      MINIMUM_CURRENT_SEASON_PLAYER_COUNT
    );
    assert.deepEqual(
      {
        requiredPlayerCount:
          result.playerGameRequiredPlayerCount,
        coverageEntryCount:
          result.playerGameCoverageEntryCount,
        expectedPlayerGameCount:
          result.playerGameExpectedPlayerGameCount,
        observationCount:
          result.playerGameObservationCount,
      },
      {
        requiredPlayerCount: 0,
        coverageEntryCount: 0,
        expectedPlayerGameCount: 0,
        observationCount: 0,
      }
    );
    assert.deepEqual(
      database.prepare(
        "SELECT source.provider AS source_provider, " +
          "sets.provider AS evidence_provider, " +
          "sets.required_player_count, sets.coverage_entry_count, " +
          "sets.expected_player_game_count, sets.observation_count " +
          "FROM stat_refresh_player_game_sets AS sets " +
          "JOIN stat_sources AS source ON source.id = sets.stat_source_id"
      ).get(),
      {
        source_provider: SPORTSDATAIO_LIVE_PROVIDER_NAME,
        evidence_provider: SPORTSDATAIO_LIVE_PROVIDER_NAME,
        required_player_count: 0,
        coverage_entry_count: 0,
        expected_player_game_count: 0,
        observation_count: 0,
      }
    );
    assert.equal(
      database.prepare(
        "SELECT COUNT(*) AS count FROM player_stat_totals AS totals " +
          "JOIN player_external_ids AS external " +
          "ON external.player_id = totals.player_id " +
          "WHERE external.provider = ?"
      ).get(SPORTSDATAIO_PLAYER_IDENTITY_PROVIDER_NAME).count,
      MINIMUM_CURRENT_SEASON_PLAYER_COUNT
    );
    assert.equal(
      database.prepare(
        "SELECT COUNT(*) AS count FROM player_external_ids " +
          "WHERE provider = ?"
      ).get(SPORTSDATAIO_LIVE_PROVIDER_NAME).count,
      0
    );
    assert.equal(
      providerCalls.filter((url) => url.endsWith("/Players"))
        .length,
      1
    );
    assert.equal(
      providerCalls.filter((url) => url.endsWith("/FreeAgents"))
        .length,
      1
    );
    assert.equal(
      providerCalls.filter((url) => url.includes("/GamesByDate/"))
        .length,
      8
    );
    assert.equal(
      providerCalls.filter((url) =>
        url.includes("/PlayerGameStatsByDate/")
      ).length,
      8
    );
  });

  test("routes exact live and awaiting player-game coverage and preserves prior authority when membership disappears", async (t) => {
    const database = createDatabase(t);
    const providerTotals = seedLiveStatisticsCatalog(database);
    const livePlayerId = uuid(20_000);
    const awaitingPlayerId = uuid(20_001);
    seedPlayerGameCoverageScope(database, {
      base: 40_000,
      playerId: livePlayerId,
      weekStatus: "live",
    });
    seedPlayerGameCoverageScope(database, {
      base: 41_000,
      playerId: awaitingPlayerId,
      weekStatus: "awaiting_data",
    });
    let omitAwaitingMembership = false;
    const providerCalls = [];
    const runtime = createTargetRuntime(
      runtimeOptions(database, {
        sportsDataIoLiveNhl: verifiedSportsDataIoLiveNhl(),
        async sportsDataIoFetchImplementation(url) {
          providerCalls.push(url);
          let body;
          if (url.includes("/PlayerSeasonStats/")) {
            body = providerTotals;
          } else if (url.endsWith("/Players")) {
            body = [{ PlayerID: 100_000, TeamID: 10 }];
          } else if (url.endsWith("/FreeAgents")) {
            body = omitAwaitingMembership
              ? []
              : [{ PlayerID: 100_001, TeamID: null }];
          } else if (url.includes("/GamesByDate/")) {
            body = url.endsWith("/2026-07-22")
              ? [{
                  GameID: 9001,
                  Season: 2027,
                  SeasonType: 1,
                  Status: "InProgress",
                  DateTimeUTC: "2026-07-22T10:00:00",
                  HomeTeamID: 10,
                  AwayTeamID: 20,
                }]
              : [];
          } else if (url.includes("/PlayerGameStatsByDate/")) {
            body = url.endsWith("/2026-07-22")
              ? [{
                  PlayerID: 100_000,
                  TeamID: 10,
                  GameID: 9001,
                  Season: 2027,
                  SeasonType: 1,
                  Games: 0,
                  Goals: 1,
                  Assists: 2,
                  Updated: "2026-07-22T07:00:00.000",
                }]
              : [];
          } else {
            throw new Error(`Unexpected live fixture URL: ${url}`);
          }
          return {
            ok: true,
            async json() {
              return body;
            },
          };
        },
      })
    );
    const requirements = runtime.repositories.statistics
      .readPlayerGameCoverageRequirements({
        nhlSeasonKey: "20262027",
        playerIdentityProvider:
          SPORTSDATAIO_PLAYER_IDENTITY_PROVIDER_NAME,
      });
    assert.deepEqual(requirements.requiredPlayers, [
      {
        playerId: livePlayerId,
        providerPlayerId: "100000",
      },
      {
        playerId: awaitingPlayerId,
        providerPlayerId: "100001",
      },
    ]);

    const successful =
      await runtime.services.league.statistics.refresh();

    assert.deepEqual(
      {
        requiredPlayerCount:
          successful.playerGameRequiredPlayerCount,
        coverageEntryCount:
          successful.playerGameCoverageEntryCount,
        expectedPlayerGameCount:
          successful.playerGameExpectedPlayerGameCount,
        observationCount:
          successful.playerGameObservationCount,
      },
      {
        requiredPlayerCount: 2,
        coverageEntryCount: 2,
        expectedPlayerGameCount: 1,
        observationCount: 1,
      }
    );
    assert.deepEqual(
      database.prepare(
        "SELECT player_id, provider_player_id, provider_team_id, " +
          "disposition, nhl_game_id, nhl_game_scheduled_starts_at_ms " +
          "FROM stat_refresh_player_game_coverage_entries " +
          "WHERE refresh_id = ? ORDER BY player_id"
      ).all(successful.refreshId),
      [
        {
          player_id: livePlayerId,
          provider_player_id: "100000",
          provider_team_id: "10",
          disposition: "expected_game",
          nhl_game_id: "9001",
          nhl_game_scheduled_starts_at_ms:
            Date.parse("2026-07-22T10:00:00.000Z"),
        },
        {
          player_id: awaitingPlayerId,
          provider_player_id: "100001",
          provider_team_id: null,
          disposition: "no_team",
          nhl_game_id: null,
          nhl_game_scheduled_starts_at_ms: null,
        },
      ]
    );
    assert.deepEqual(
      database.prepare(
        "SELECT player_id, nhl_game_id, goals, assists " +
          "FROM player_game_stat_observations WHERE refresh_id = ?"
      ).all(successful.refreshId),
      [{
        player_id: livePlayerId,
        nhl_game_id: "9001",
        goals: 1,
        assists: 2,
      }]
    );
    assert.equal(providerCalls.length, 19);

    omitAwaitingMembership = true;
    await assert.rejects(
      runtime.services.league.statistics.refresh(),
      (error) =>
        error.code === "LIVE_STATISTICS_PROVIDER_FAILED" &&
        error.cause?.code ===
          "SPORTSDATAIO_LIVE_RESPONSE_INCOMPLETE"
    );

    const latest = runtime.repositories.statistics.readLatestSeason({
      provider: SPORTSDATAIO_LIVE_PROVIDER_NAME,
      nhlSeasonKey: "20262027",
    });
    assert.equal(latest.refresh.id, successful.refreshId);
    assert.equal(
      latest.totals.length,
      MINIMUM_CURRENT_SEASON_PLAYER_COUNT
    );
    assert.equal(
      database.prepare(
        "SELECT COUNT(*) AS count FROM stat_refreshes " +
          "WHERE status = 'succeeded'"
      ).get().count,
      1
    );
    assert.deepEqual(
      database.prepare(
        "SELECT status, error_code FROM stat_refreshes " +
          "WHERE status = 'failed'"
      ).get(),
      {
        status: "failed",
        error_code: "LIVE_STATISTICS_PROVIDER_FAILED",
      }
    );
    assert.equal(
      database.prepare(
        "SELECT COUNT(*) AS count " +
          "FROM stat_refresh_player_game_sets"
      ).get().count,
      1
    );
    assert.equal(providerCalls.length, 38);
  });

  test("fails closed for an unmigrated database before constructing repositories", (t) => {
    const database = createDatabase(t, { migrated: false });
    const before = database.serialize();
    assert.throws(
      () => createTargetRuntime(runtimeOptions(database)),
      { code: "MIGRATION_DATABASE_BEHIND" }
    );
    assert.equal(before.equals(database.serialize()), true);
  });

  test("requires configured independent runtime secrets even for local composition", (t) => {
    const database = createDatabase(t);
    const before = database.serialize();
    assert.throws(
      () =>
        createTargetRuntime(
          runtimeOptions(database, {
            securityFoundations: foundations({ configured: false }),
          })
        ),
      /configured rate-limit key/
    );
    assert.equal(before.equals(database.serialize()), true);
  });

  test("opens and idempotently closes an explicit local or test database", (t) => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "hundo-m3-19-owned-runtime-")
    );
    const databasePath = path.join(temporaryRoot, "target.sqlite3");
    t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
    const seedConnection = openDatabase({
      databasePath,
      environment: "test",
    });
    migrateDatabase({
      database: seedConnection.database,
      migrationsDirectory: MIGRATIONS_DIRECTORY,
      applicationBuildId: "m3-19-test-build",
      now: () => NOW_MS,
    });
    seedConnection.database.close();

    const runtime = openTargetRuntime({
      ...runtimeOptions(undefined),
      databasePath,
      environment: "test",
    });
    assert.equal(runtime.databasePath, databasePath);
    assert.equal(runtime.database.open, true);
    runtime.close();
    runtime.close();
    assert.equal(runtime.database.open, false);
  });

  test("closes an owned database when startup fails and rejects shared environments", (t) => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "hundo-m3-19-failed-runtime-")
    );
    const databasePath = path.join(temporaryRoot, "unmigrated.sqlite3");
    t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
    let openedDatabase;
    assert.throws(
      () =>
        openTargetRuntime({
          ...runtimeOptions(undefined),
          databasePath,
          environment: "test",
          openDatabaseFunction(options) {
            const connection = openDatabase(options);
            openedDatabase = connection.database;
            return connection;
          },
        }),
      { code: "MIGRATION_DATABASE_BEHIND" }
    );
    assert.equal(openedDatabase.open, false);

    let openAttempted = false;
    assert.throws(
      () =>
        openTargetRuntime({
          ...runtimeOptions(undefined),
          databasePath,
          environment: "staging",
          openDatabaseFunction() {
            openAttempted = true;
          },
        }),
      /only in local or test environments/
    );
    assert.equal(openAttempted, false);
  });
});

describe("M3-19 composed target HTTP boundary", () => {
  test("starts the verified six-team reset-original league through T-036 without publishing inaugural readiness", async (t) => {
    const database = createDatabase(t);
    const runtime = createTargetRuntime(runtimeOptions(database));
    const scenario = seedComposedLeagueStartScenario(runtime, {
      teamCount: 6,
    });
    seedComposedResetOriginalEvidence(runtime, scenario);
    const baseUrl = await startRuntimeApp(t, runtime);

    const response = await fetch(
      new URL(
        `/api/v1/leagues/${scenario.leagueId}/start`,
        baseUrl
      ),
      {
        method: "POST",
        headers: browserHeaders({
          Cookie:
            `${runtime.transport.sessionCookie.name}=` +
            scenario.session.rawSessionToken,
          "X-CSRF-Token": scenario.session.rawCsrfToken,
          "If-Match":
            `"${scenario.expectedLeagueVersion}"`,
          "Idempotency-Key":
            "target-runtime-reset-original-http-start",
        }),
        body: "{}",
      }
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("cache-control"),
      "no-store"
    );
    assert.equal(body.data.code, "LEAGUE_STARTED");
    assert.equal(body.data.league.id, scenario.leagueId);
    assert.equal(body.data.league.status, "active");
    assert.equal(
      body.data.league.currentSeason.status,
      "active"
    );
    assert.equal(body.data.activatedTeamCount, 6);
    assert.equal(
      JSON.stringify(body).includes("replayed"),
      false
    );
    assert.deepEqual(
      database
        .prepare(
          `SELECT
             (SELECT COUNT(*)
              FROM free_agent_draft_readiness_operations) AS operations,
             (SELECT COUNT(*)
              FROM job_runs
              WHERE job_type = 'fad_readiness') AS jobs`
        )
        .get(),
      { operations: 0, jobs: 0 }
    );
  });

  test("routes T-145 preflight, authentication, and input validation through the composed boundary without writes", async (t) => {
    const database = createDatabase(t);
    const runtime = createTargetRuntime(runtimeOptions(database));
    const baseUrl = await startRuntimeApp(t, runtime);
    const endpoint = new URL(
      `/api/v1/leagues/${uuid(8101)}/seasons/${uuid(8102)}/standings/finalizations`,
      baseUrl
    );

    const preflight = await fetch(endpoint, {
      method: "OPTIONS",
      headers: {
        Origin: PUBLIC_FRONTEND_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers":
          "content-type,idempotency-key,if-match,x-csrf-token",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(
      preflight.headers.get("access-control-allow-origin"),
      PUBLIC_FRONTEND_ORIGIN
    );

    const beforeAnonymous = database.serialize();
    const anonymous = await fetch(endpoint, {
      method: "POST",
      headers: browserHeaders({
        "If-Match": '"1"',
        "Idempotency-Key": "t145-runtime-anonymous",
      }),
      body: JSON.stringify({
        resultSetHash: "a".repeat(64),
        confirmation: "FINALIZE REGULAR SEASON STANDINGS",
      }),
    });
    assert.equal(anonymous.status, 401);
    assert.equal(
      (await anonymous.json()).error.code,
      "SESSION_REQUIRED"
    );
    assert.equal(
      beforeAnonymous.equals(database.serialize()),
      true
    );

    const userId = uuid(8103);
    runtime.repositories.context.repositories.users.insert({
      id: userId,
      email_normalized: "t145-runtime@example.test",
      email_display: "t145-runtime@example.test",
      display_name: "T145 Runtime",
      display_name_normalized: "t145 runtime",
      status: "active",
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });
    const session =
      runtime.services.sessionService.issueForUser({
        userId,
      });
    const beforeInvalid = database.serialize();
    const invalid = await fetch(endpoint, {
      method: "POST",
      headers: browserHeaders({
        Cookie:
          `${runtime.transport.sessionCookie.name}=` +
          session.rawSessionToken,
        "Idempotency-Key": "t145-runtime-invalid",
        "X-CSRF-Token": session.rawCsrfToken,
      }),
      body: JSON.stringify({
        resultSetHash: "a".repeat(64),
        confirmation: "FINALIZE REGULAR SEASON STANDINGS",
      }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(
      (await invalid.json()).error.code,
      "STANDINGS_FINALIZATION_INPUT_INVALID"
    );
    assert.equal(
      beforeInvalid.equals(database.serialize()),
      true
    );
  });

  test("registers through the composed endpoint without touching compatibility JSON", async (t) => {
    const database = createDatabase(t);
    const runtime = createTargetRuntime(runtimeOptions(database));
    const baseUrl = await startRuntimeApp(t, runtime);
    const protectedPaths = TRACKED_COMPATIBILITY_FILES;
    const before = new Map(
      protectedPaths.map((file) => [
        file,
        fs.readFileSync(path.join(ROOT_DIRECTORY, file)),
      ])
    );
    const response = await fetch(new URL("/api/v1/accounts", baseUrl), {
      method: "POST",
      headers: browserHeaders(),
      body: JSON.stringify({
        email: "new.manager@example.test",
        displayName: "New Manager",
        password: "correct horse battery staple",
        passwordConfirmation: "correct horse battery staple",
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 202);
    assert.deepEqual(body.data, { accepted: true });
    assert.match(body.meta.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(
      response.headers.get("access-control-allow-origin"),
      PUBLIC_FRONTEND_ORIGIN
    );
    const user = database.prepare(
      "SELECT id, status FROM users WHERE email_normalized = ?"
    ).get("new.manager@example.test");
    assert.equal(user.status, "pending_verification");
    const credential = database.prepare(
      "SELECT password_hash FROM user_credentials WHERE user_id = ? AND status = 'active'"
    ).get(user.id);
    assert.match(credential.password_hash, /^scrypt\$/);
    assert.equal(
      database.prepare(
        "SELECT COUNT(*) AS count FROM outbox_events WHERE status = 'pending'"
      ).get().count,
      1
    );
    assert.deepEqual(
      await runtime.services.accountEmail.deliveryService.deliverDue(),
      [
        {
          eventId: database
            .prepare(
              "SELECT id FROM outbox_events WHERE aggregate_id = ?"
            )
            .get(user.id).id,
          outcome: "published",
        },
      ]
    );
    const captured = runtime.services.accountEmail.adapter.listCaptured();
    assert.equal(captured.length, 1);
    assert.equal(captured[0].to, "new.manager@example.test");
    assert.match(captured[0].verificationUrl, /#token=[A-Za-z0-9_-]{43}$/u);
    for (const [file, bytes] of before) {
      assert.equal(
        bytes.equals(fs.readFileSync(path.join(ROOT_DIRECTORY, file))),
        true,
        file
      );
    }
  });

  test("session bootstrap returns current memberships and an unambiguous league default without writes", async (t) => {
    const database = createDatabase(t);
    const runtime = createTargetRuntime(runtimeOptions(database));
    const scenario = seedTwoLeagueProfileScenario(runtime);
    const session = runtime.services.sessionService.issueForUser({ userId: uuid(1101) });
    const baseUrl = await startRuntimeApp(t, runtime);
    const headers = browserHeaders({ Cookie: `${runtime.transport.sessionCookie.name}=${session.rawSessionToken}` });
    const read = async () => {
      const before = database.serialize();
      const response = await fetch(new URL(`/api/v1/session?leagueId=${uuid(1202)}`, baseUrl), { headers });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.deepEqual(database.serialize(), before);
      return body.data;
    };
    const one = await read();
    assert.equal(one.defaultLeagueId, uuid(1201));
    assert.deepEqual(one.leagues.map(league => league.id), [uuid(1201)]);
    assert.equal(one.leagues[0].membership.permissionCategory, "manager");
    assert.equal(one.leagues[0].membership.status, "active");
    database.prepare("INSERT INTO league_memberships (id,league_id,user_id,permission_category,status,joined_at_ms,ended_at_ms,created_at_ms,updated_at_ms,version) VALUES (?,?,?,'member','active',?,NULL,?,?,1)").run(uuid(1399),uuid(1202),uuid(1101),NOW_MS,NOW_MS,NOW_MS);
    const multiple = await read();
    assert.equal(multiple.leagues.length, 2);
    assert.equal(multiple.defaultLeagueId, null);
    database.prepare("UPDATE league_memberships SET status='ended',ended_at_ms=?,updated_at_ms=?,version=version+1 WHERE user_id=?").run(NOW_MS+1,NOW_MS+1,uuid(1101));
    const none = await read();
    assert.deepEqual(none.leagues, []);
    assert.equal(none.defaultLeagueId, null);
    assert.equal(database.pragma("foreign_key_check").length, 0);
  });

  test("signs in, bootstraps read-only, enforces CSRF, and signs out through the composed session router", async (t) => {
    const database = createDatabase(t);
    const securityFoundations = foundations();
    const runtime = createTargetRuntime(
      runtimeOptions(database, { securityFoundations })
    );
    const password = "correct horse battery staple";
    const account = await createTestAccount({
      repositoryContext: runtime.repositories.context,
      userRepository: runtime.repositories.users,
      credentialRepository: runtime.repositories.credentials,
      passwordHasher: createScryptPasswordHasher({
        secureRandom: securityFoundations.secureRandom,
      }),
      clock: securityFoundations.clock,
      secureRandom: securityFoundations.secureRandom,
      emailNormalized: "session.manager@example.test",
      emailDisplay: "Session.Manager@Example.Test",
      displayName: "Session Manager",
      displayNameNormalized: "session manager",
      password,
    });
    const baseUrl = await startRuntimeApp(t, runtime);
    const sessionUrl = new URL("/api/v1/session", baseUrl);
    const signIn = await fetch(sessionUrl, {
      method: "POST",
      headers: browserHeaders(),
      body: JSON.stringify({
        email: " Session.Manager@Example.Test ",
        password,
      }),
    });
    const signInBody = await signIn.json();
    assert.equal(signIn.status, 200);
    assert.equal(signInBody.data.user.id, account.user.id);
    const setCookie = signIn.headers.get("set-cookie");
    assert.match(setCookie, /^__Host-hl_session=[A-Za-z0-9_-]{43};/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Lax/);
    const cookie = setCookie.split(";", 1)[0];

    const beforeBootstrap = database.serialize();
    const bootstrap = await fetch(sessionUrl, {
      headers: browserHeaders({ Cookie: cookie }),
    });
    const bootstrapBody = await bootstrap.json();
    assert.equal(bootstrap.status, 200);
    assert.deepEqual(bootstrapBody.data.leagues, []);
    assert.equal(bootstrapBody.data.defaultLeagueId, null);
    assert.equal(
      bootstrapBody.data.session.id,
      signInBody.data.session.id
    );
    assert.equal(
      bootstrapBody.data.csrfToken,
      signInBody.data.csrfToken
    );
    assert.equal(
      bootstrapBody.data.user.displayName,
      "Session Manager"
    );
    assert.equal(beforeBootstrap.equals(database.serialize()), true);

    const beforeBadCsrf = database.serialize();
    const badCsrf = await fetch(sessionUrl, {
      method: "DELETE",
      headers: browserHeaders({
        Cookie: cookie,
        "X-CSRF-Token": "invalid",
      }),
      body: JSON.stringify({}),
    });
    assert.equal(badCsrf.status, 403);
    assert.equal((await badCsrf.json()).error.code, "CSRF_INVALID");
    assert.equal(beforeBadCsrf.equals(database.serialize()), true);

    const signOut = await fetch(sessionUrl, {
      method: "DELETE",
      headers: browserHeaders({
        Cookie: cookie,
        "X-CSRF-Token": signInBody.data.csrfToken,
      }),
      body: JSON.stringify({}),
    });
    assert.equal(signOut.status, 200);
    assert.equal((await signOut.json()).data.code, "SESSION_SIGNED_OUT");
    assert.match(
      signOut.headers.get("set-cookie"),
      /^__Host-hl_session=; Max-Age=0;/
    );
    const rejected = await fetch(sessionUrl, {
      headers: browserHeaders({ Cookie: cookie }),
    });
    assert.equal(rejected.status, 401);
    assert.equal((await rejected.json()).error.code, "SESSION_REQUIRED");
  });

  test("previews and publishes league communications with real session, CSRF and league isolation", async (t) => {
    const database = createDatabase(t);
    const securityFoundations = foundations();
    const passwordHash = await createScryptPasswordHasher({ secureRandom: securityFoundations.secureRandom }).hash("communications fixture password");
    database.transaction(() => seedFixture(database, passwordHash, { includeIdentityMetadata: false })).immediate();
    const runtime = createTargetRuntime(runtimeOptions(database, { securityFoundations }));
    const baseUrl = await startRuntimeApp(t, runtime);
    const leagueId = fixtureId("league:leagueA");
    const makeHeaders = userId => {
      const session = runtime.services.sessionService.issueForUser({ userId });
      return browserHeaders({ Cookie: `${runtime.transport.sessionCookie.name}=${session.rawSessionToken}`, "X-CSRF-Token": session.rawCsrfToken });
    };
    const headers = makeHeaders(fixtureId("account:leagueACommissioner"));
    const url = new URL(`/api/v1/leagues/${leagueId}/communications`, baseUrl);
    const input = { kind: "announcement", title: "Practice notice", body: "Synthetic local announcement only.",
      audience: "members", pinned: true, expiresAtMs: null, notify: true };
    const initial = database.serialize();
    const anonymous = await fetch(url, { headers: browserHeaders() });
    assert.equal(anonymous.status, 401);
    const denied = await fetch(`${url}/preview`, { method: "POST", headers: { ...headers, "X-CSRF-Token": "invalid" }, body: JSON.stringify(input) });
    assert.equal(denied.status, 403);
    const wrongLeague = await fetch(new URL(`/api/v1/leagues/${fixtureId("league:leagueB")}/communications`, baseUrl), { headers });
    assert.equal(wrongLeague.status, 404);
    const previewResponse = await fetch(`${url}/preview`, { method: "POST", headers, body: JSON.stringify(input) });
    const preview = await previewResponse.json();
    assert.equal(previewResponse.status, 200, JSON.stringify(preview));
    assert.ok(preview.data.recipientCount > 0);
    assert.equal(initial.equals(database.serialize()), true, "Authorization, reads and preview must not write");
    const beforeNotifications = database.prepare("SELECT count(*) AS n FROM notifications").get().n;
    const command = { method: "POST", headers: { ...headers, "Idempotency-Key": "composed-communications-1" },
      body: JSON.stringify({ message: input, previewHash: preview.data.previewHash }) };
    const firstResponse = await fetch(url, command);
    const first = await firstResponse.json();
    assert.equal(firstResponse.status, 200, JSON.stringify(first));
    const replay = await (await fetch(url, command)).json();
    assert.equal(replay.data.id, first.data.id);
    assert.equal(replay.data.replayed, true);
    assert.equal(database.prepare("SELECT count(*) AS n FROM notifications").get().n - beforeNotifications, preview.data.recipientCount);
    const listed = await (await fetch(url, { headers })).json();
    assert.equal(listed.data.messages[0].body, input.body);
    assert.equal(Object.hasOwn(listed.data.messages[0], "recipientCount"), false);
    const platformUser = database.prepare("SELECT user_id FROM platform_roles WHERE status='active'").get();
    const adminHeaders = makeHeaders(platformUser.user_id);
    assert.equal((await fetch(`${url}/preview`, { method: "POST", headers: adminHeaders, body: JSON.stringify(input) })).status, 200);
  });

  test("previews and applies an audited commissioner roster addition through the composed routers", async (t) => {
    const database = createDatabase(t);
    const securityFoundations = foundations();
    const passwordHash = await createScryptPasswordHasher({
      secureRandom: securityFoundations.secureRandom,
    }).hash("correct horse battery staple");
    database.transaction(() => {
      seedFixture(database, passwordHash, {
        includeIdentityMetadata: false,
      });
    }).immediate();
    const runtime = createTargetRuntime(
      runtimeOptions(database, { securityFoundations })
    );
    const baseUrl = await startRuntimeApp(t, runtime);
    const leagueId = fixtureId("league:leagueA");
    const playerId = fixtureId("player:freeAgentForward");
    const session = runtime.services.sessionService.issueForUser({
      userId: fixtureId("account:leagueACommissioner"),
    });
    const headers = browserHeaders({
      Cookie:
        `${runtime.transport.sessionCookie.name}=` +
        session.rawSessionToken,
      "X-CSRF-Token": session.rawCsrfToken,
    });
    const workspaceResponse = await fetch(
      new URL(
        `/api/v1/leagues/${leagueId}/commissioner/roster-workspace`,
        baseUrl
      ),
      { headers }
    );
    const workspaceBody = await workspaceResponse.json();
    assert.equal(workspaceResponse.status, 200);
    const workspace = workspaceBody.data.workspace;
    assert.equal(workspace.league.id, leagueId);
    assert.equal(
      workspace.freeAgents.some((player) => player.playerId === playerId),
      true
    );
    const teamId = fixtureId("team:leagueA:1");
    const occupiedBenchSlots = new Set(
      workspace.roster
        .filter((player) =>
          player.teamId === teamId &&
          player.rosterCategory === "Bench"
        )
        .map((player) => player.slotNumber)
    );
    const slotNumber = Array.from(
      { length: 4 },
      (_, index) => index + 1
    ).find((slot) => !occupiedBenchSlots.has(slot));
    assert.equal(Number.isSafeInteger(slotNumber), true);
    const request = {
      seasonId: workspace.league.currentSeasonId,
      playerId,
      teamId,
      rosterCategory: "Bench",
      positionGroup: "F",
      slotNumber,
      contractType: "normal",
      originalTotalValueCents: 200,
      termYears: 1,
      reason: "Restore a missing staging roster assignment.",
    };
    const previewUrl = new URL(
      `/api/v1/leagues/${leagueId}/commissioner/roster-additions/previews`,
      baseUrl
    );
    const beforePreview = database.serialize();
    const previewResponse = await fetch(previewUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });
    const previewBody = await previewResponse.json();
    assert.equal(
      previewResponse.status,
      200,
      JSON.stringify(previewBody)
    );
    assert.equal(
      previewBody.data.code,
      "COMMISSIONER_ROSTER_ADD_CORRECTION_PREVIEWED"
    );
    assert.equal(previewBody.data.preview, true);
    assert.equal(beforePreview.equals(database.serialize()), true);

    const applyUrl = new URL(
      `/api/v1/leagues/${leagueId}/commissioner/roster-additions`,
      baseUrl
    );
    const applyHeaders = {
      ...headers,
      "Idempotency-Key": "m7-10-composed-roster-addition",
    };
    const applyResponse = await fetch(applyUrl, {
      method: "POST",
      headers: applyHeaders,
      body: JSON.stringify({ ...request, confirmWarnings: false }),
    });
    const applyBody = await applyResponse.json();
    assert.equal(applyResponse.status, 200);
    assert.equal(
      applyBody.data.code,
      "COMMISSIONER_ROSTER_ADD_CORRECTION_APPLIED"
    );
    assert.equal(applyBody.data.evidence.activityType, "commissioner_player_added");
    const replayResponse = await fetch(applyUrl, {
      method: "POST",
      headers: applyHeaders,
      body: JSON.stringify({ ...request, confirmWarnings: false }),
    });
    assert.equal(replayResponse.status, 200);
    assert.deepEqual((await replayResponse.json()).data, applyBody.data);
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM player_ownerships
        WHERE league_id = ? AND player_id = ?
      `).get(leagueId, playerId).count,
      1
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM commissioner_corrections
        WHERE league_id = ? AND feature = 'roster_add'
      `).get(leagueId).count,
      1
    );
  });

  test("serves isolated read-only league player context through the composed player router", async (t) => {
    const database = createDatabase(t);
    const securityFoundations = foundations();
    const passwordHash = await createScryptPasswordHasher({
      secureRandom: securityFoundations.secureRandom,
    }).hash("correct horse battery staple");
    database.transaction(() => {
      seedFixture(database, passwordHash, {
        includeIdentityMetadata: false,
      });
    }).immediate();
    const runtime = createTargetRuntime(
      runtimeOptions(database, { securityFoundations })
    );
    const baseUrl = await startRuntimeApp(t, runtime);
    const leagueId = fixtureId("league:leagueA");
    const hiddenLeagueId = fixtureId("league:leagueB");
    const playerId = fixtureId("player:activeForward3");
    const session = runtime.services.sessionService.issueForUser({
      userId: fixtureId("account:leagueACommissioner"),
    });
    const headers = browserHeaders({
      Cookie:
        `${runtime.transport.sessionCookie.name}=` +
        session.rawSessionToken,
    });
    const before = database.serialize();

    const collection = await fetch(
      new URL(
        `/api/v1/leagues/${leagueId}/players?query=Fixture%20Player%2003`,
        baseUrl
      ),
      { headers }
    );
    const collectionBody = await collection.json();
    assert.equal(collection.status, 200);
    assert.equal(collectionBody.data.length, 1);
    assert.equal(collectionBody.data[0].id, playerId);
    assert.equal(collectionBody.data[0].league.id, leagueId);

    const detail = await fetch(
      new URL(
        `/api/v1/leagues/${leagueId}/players/${playerId}`,
        baseUrl
      ),
      { headers }
    );
    const detailBody = await detail.json();
    assert.equal(detail.status, 200);
    assert.deepEqual(detailBody.data.league, {
      id: leagueId,
      ownership: {
        kind: "Rostered",
        category: "Active",
        team: {
          id: fixtureId("team:leagueA:3"),
          name: "Alpha Wolves",
        },
      },
      activeContract: {
        originalTotalValueCents: 750,
        originalTermYears: 3,
        aavCents: 250,
        remainingYears: 3,
      },
    });

      const cardPath = `/api/v1/leagues/${leagueId}/players/${playerId}/card`;
      const cardResponse = await fetch(new URL(cardPath, baseUrl), { headers });
      const cardBody = await cardResponse.json();
      assert.equal(cardResponse.status, 200);
      assert.equal(cardResponse.headers.get('cache-control').includes('no-store'), true);
      assert.equal(cardBody.data.leagueId, leagueId);
      assert.equal(cardBody.data.playerId, playerId);
      assert.equal(cardBody.data.contract.netAavCents, 250);
      assert.ok(Array.isArray(cardBody.data.history.signings));
      assert.equal((await fetch(new URL(cardPath, baseUrl), { headers: browserHeaders() })).status, 401);
      assert.equal((await fetch(new URL(cardPath.replace(leagueId, hiddenLeagueId), baseUrl), { headers })).status, 404);

      const globalDetail = await fetch(
      new URL(`/api/v1/players/${playerId}`, baseUrl),
      { headers }
    );
    const globalBody = await globalDetail.json();
    assert.equal(globalDetail.status, 200);
    assert.equal(
      Object.prototype.hasOwnProperty.call(globalBody.data, "league"),
      false
    );

    const crossLeague = await fetch(
      new URL(
        `/api/v1/leagues/${hiddenLeagueId}/players/${playerId}`,
        baseUrl
      ),
      { headers }
    );
    assert.equal(crossLeague.status, 404);
    assert.equal(
      (await crossLeague.json()).error.code,
      "LEAGUE_NOT_FOUND"
    );
    assert.equal(before.equals(database.serialize()), true);
  });

  test("rate-limits repeated failed sign-ins through the composed session router", async (t) => {
    const database = createDatabase(t);
    const runtime = createTargetRuntime(runtimeOptions(database));
    const baseUrl = await startRuntimeApp(t, runtime);
    const statuses = [];
    let finalBody;
    let finalRetryAfter;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const response = await fetch(new URL("/api/v1/session", baseUrl), {
        method: "POST",
        headers: browserHeaders(),
        body: JSON.stringify({
          email: "unknown-rate-limit@example.test",
          password: "incorrect password",
        }),
      });
      statuses.push(response.status);
      finalRetryAfter = response.headers.get("retry-after");
      finalBody = await response.json();
    }
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
    assert.equal(finalBody.error.code, "RATE_LIMITED");
    assert.equal(Number(finalRetryAfter) > 0, true);
    assert.equal(
      JSON.stringify(finalBody).includes("unknown-rate-limit@example.test"),
      false
    );
  });

  test("routes anonymous session denial and method-aware profile preflight through their own boundaries", async (t) => {
    const database = createDatabase(t);
    const runtime = createTargetRuntime(runtimeOptions(database));
    const baseUrl = await startRuntimeApp(t, runtime);
    const before = database.serialize();
    const session = await fetch(new URL("/api/v1/session", baseUrl), {
      headers: { Origin: PUBLIC_FRONTEND_ORIGIN },
    });
    assert.equal(session.status, 401);
    assert.equal((await session.json()).error.code, "SESSION_REQUIRED");

    const preflight = await fetch(
      new URL(
        "/api/v1/leagues/00000000-0000-4000-8000-000000000001/teams/00000000-0000-4000-8000-000000000002",
        baseUrl
      ),
      {
        method: "OPTIONS",
        headers: {
          Origin: PUBLIC_FRONTEND_ORIGIN,
          "Access-Control-Request-Method": "PATCH",
          "Access-Control-Request-Headers":
            "Content-Type, X-CSRF-Token, If-Match, Idempotency-Key",
        },
      }
    );
    assert.equal(preflight.status, 204);
    assert.equal(
      preflight.headers.get("access-control-allow-origin"),
      PUBLIC_FRONTEND_ORIGIN
    );
    assert.match(
      preflight.headers.get("access-control-allow-methods"),
      /PATCH/
    );
    assert.equal(before.equals(database.serialize()), true);
  });

  test("keeps two-league visibility scoped while a real manager updates and reads a team logo", async (t) => {
    const database = createDatabase(t);
    const runtime = createTargetRuntime(runtimeOptions(database));
    const scenario = seedTwoLeagueProfileScenario(runtime);
    const baseUrl = await startRuntimeApp(t, runtime);
    const compatibilityFiles = TRACKED_COMPATIBILITY_FILES;
    const compatibilityBefore = new Map(
      compatibilityFiles.map((file) => [
        file,
        fs.readFileSync(path.join(ROOT_DIRECTORY, file)),
      ])
    );
    const sessionHeaders = {
      ...browserHeaders(),
      Cookie:
        `${runtime.transport.sessionCookie.name}=` +
        scenario.session.rawSessionToken,
    };

    const leagueListResponse = await fetch(
      new URL("/api/v1/leagues", baseUrl),
      { headers: sessionHeaders }
    );
    const leagueListBody = await leagueListResponse.json();
    assert.equal(leagueListResponse.status, 200);
    assert.deepEqual(
      leagueListBody.data.leagues.map(({ id }) => id),
      [scenario.visibleLeagueId]
    );

    const hiddenResponse = await fetch(
      new URL(`/api/v1/leagues/${scenario.hiddenLeagueId}`, baseUrl),
      { headers: sessionHeaders }
    );
    assert.equal(hiddenResponse.status, 404);
    assert.equal((await hiddenResponse.json()).error.code, "LEAGUE_NOT_FOUND");

    const logoBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    );
    const teamUrl = new URL(
      `/api/v1/leagues/${scenario.visibleLeagueId}/teams/${scenario.teamId}`,
      baseUrl
    );
    const updateResponse = await fetch(teamUrl, {
      method: "PATCH",
      headers: {
        ...sessionHeaders,
        "If-Match": '"1"',
        "Idempotency-Key": "m3-19-composed-profile",
        "X-CSRF-Token": scenario.session.rawCsrfToken,
      },
      body: JSON.stringify({
        name: "Composed Owls",
        primaryColour: "#102030",
        secondaryColour: "#abcdef",
        logo: {
          mediaType: "image/png",
          contentBase64: logoBytes.toString("base64"),
        },
      }),
    });
    const updateBody = await updateResponse.json();
    assert.equal(updateResponse.status, 200);
    assert.equal(updateBody.data.team.name, "Composed Owls");
    assert.equal(updateBody.data.team.version, 2);
    assert.equal(
      updateBody.data.team.logoReference,
      `/api/v1/leagues/${scenario.visibleLeagueId}/teams/${scenario.teamId}/logo`
    );

    const beforeStaleUpdate = database.serialize();
    const staleUpdate = await fetch(teamUrl, {
      method: "PATCH",
      headers: {
        ...sessionHeaders,
        "If-Match": '"1"',
        "Idempotency-Key": "m3-19-stale-composed-profile",
        "X-CSRF-Token": scenario.session.rawCsrfToken,
      },
      body: JSON.stringify({ name: "Stale Owls" }),
    });
    const staleBody = await staleUpdate.json();
    assert.equal(staleUpdate.status, 412);
    assert.equal(staleBody.error.code, "PRECONDITION_FAILED");
    assert.deepEqual(staleBody.error.details, {
      currentVersion: 2,
      refetch: true,
    });
    assert.equal(beforeStaleUpdate.equals(database.serialize()), true);

    const beforeLogoRead = database.serialize();
    const logoResponse = await fetch(
      new URL(updateBody.data.team.logoReference, baseUrl),
      { headers: sessionHeaders }
    );
    assert.equal(logoResponse.status, 200);
    assert.equal(logoResponse.headers.get("content-type"), "image/png");
    assert.equal(
      Buffer.from(await logoResponse.arrayBuffer()).equals(logoBytes),
      true
    );
    assert.equal(beforeLogoRead.equals(database.serialize()), true);
    for (const [file, bytes] of compatibilityBefore) {
      assert.equal(
        bytes.equals(fs.readFileSync(path.join(ROOT_DIRECTORY, file))),
        true,
        file
      );
    }
  });

  test("runs commissioner team creation and manager invitation acceptance through the composed routers", async (t) => {
    const database = createDatabase(t);
    const runtime = createTargetRuntime(runtimeOptions(database));
    const scenario = seedCommissionerInvitationScenario(runtime);
    const baseUrl = await startRuntimeApp(t, runtime);
    const compatibilityFiles = TRACKED_COMPATIBILITY_FILES;
    const compatibilityBefore = new Map(
      compatibilityFiles.map((file) => [
        file,
        fs.readFileSync(path.join(ROOT_DIRECTORY, file)),
      ])
    );
    function authenticatedHeaders(session, idempotencyKey) {
      return browserHeaders({
        Cookie:
          `${runtime.transport.sessionCookie.name}=` +
          session.rawSessionToken,
        "X-CSRF-Token": session.rawCsrfToken,
        "Idempotency-Key": idempotencyKey,
      });
    }

    const teamCollectionUrl = new URL(
      `/api/v1/leagues/${scenario.leagueId}/teams`,
      baseUrl
    );
    const teamHeaders = authenticatedHeaders(
      scenario.commissionerSession,
      "m3-19-composed-team-create"
    );
    const beforeDenied = database.serialize();
    const denied = await fetch(teamCollectionUrl, {
      method: "POST",
      headers: { ...teamHeaders, "X-CSRF-Token": "invalid" },
      body: JSON.stringify({ name: "Composed Falcons" }),
    });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, "CSRF_INVALID");
    assert.equal(beforeDenied.equals(database.serialize()), true);

    const created = await fetch(teamCollectionUrl, {
      method: "POST",
      headers: teamHeaders,
      body: JSON.stringify({ name: "Composed Falcons" }),
    });
    const createdBody = await created.json();
    assert.equal(created.status, 201);
    assert.equal(createdBody.data.code, "TEAM_CREATED");
    assert.equal(createdBody.data.team.currentManager, null);
    const teamId = createdBody.data.team.id;
    const replayed = await fetch(teamCollectionUrl, {
      method: "POST",
      headers: teamHeaders,
      body: JSON.stringify({ name: "composed falcons" }),
    });
    assert.equal(replayed.status, 200);
    assert.deepEqual((await replayed.json()).data, createdBody.data);

    const invitationResponse = await fetch(
      new URL(`/api/v1/leagues/${scenario.leagueId}/invitations`, baseUrl),
      {
        method: "POST",
        headers: authenticatedHeaders(
          scenario.commissionerSession,
          "m3-19-composed-manager-invitation"
        ),
        body: JSON.stringify({
          userId: scenario.invitedUserId,
          workflow: "manage_team",
          teamId,
        }),
      }
    );
    const invitationBody = await invitationResponse.json();
    assert.equal(invitationResponse.status, 201);
    assert.equal(
      invitationBody.data.code,
      "LEAGUE_INVITATION_CREATED"
    );
    const invitationId = invitationBody.data.invitation.id;
    const targetUrl = new URL(
      `/api/v1/league-invitations/${invitationId}`,
      baseUrl
    );
    const invitedHeaders = authenticatedHeaders(
      scenario.invitedSession,
      "m3-19-unused-target-key"
    );
    const readInvitation = await fetch(targetUrl, {
      headers: invitedHeaders,
    });
    assert.equal(readInvitation.status, 200);
    assert.equal(
      (await readInvitation.json()).data.code,
      "LEAGUE_INVITATION_FOUND"
    );
    const accepted = await fetch(
      new URL(`${targetUrl.pathname}/accept`, baseUrl),
      {
        method: "POST",
        headers: invitedHeaders,
        body: JSON.stringify({}),
      }
    );
    const acceptedBody = await accepted.json();
    assert.equal(accepted.status, 200);
    assert.equal(acceptedBody.data.code, "LEAGUE_INVITATION_ACCEPTED");
    assert.equal(acceptedBody.data.membership.status, "active");
    assert.equal(acceptedBody.data.managerAssignment.status, "accepted");

    const managedTeam = await fetch(
      new URL(
        `/api/v1/leagues/${scenario.leagueId}/teams/${teamId}`,
        baseUrl
      ),
      { headers: invitedHeaders }
    );
    const managedTeamBody = await managedTeam.json();
    assert.equal(managedTeam.status, 200);
    assert.equal(
      managedTeamBody.data.team.currentManager.userId,
      scenario.invitedUserId
    );
    for (const [file, bytes] of compatibilityBefore) {
      assert.equal(
        bytes.equals(fs.readFileSync(path.join(ROOT_DIRECTORY, file))),
        true,
        file
      );
    }
  });
});

describe("M3-19 composed target Socket.IO authorization", () => {
  test("rejects a session revoked while its socket handshake is joining rooms", async (t) => {
    const database = createDatabase(t);
    const runtime = createTargetRuntime(runtimeOptions(database));
    const scenario = seedTwoLeagueProfileScenario(runtime);
    const socket = createTargetSocket(runtime, scenario.session);
    const join = socket.join;
    let revoked = false;
    socket.join = async function (room) {
      await join.call(this, room);
      if (!revoked) {
        revoked = true;
        runtime.services.sessionService.revoke({ sessionId: scenario.session.session.id, expectedVersion: 1, reason: "sign_out" });
      }
    };
    const error = await runSocketMiddleware(runtime.socketRooms.middleware, socket);
    assert.ok(error);
    assert.equal(socket.disconnected, true);
    assert.equal(socket.rooms.size, 0);
    assert.equal(runtime.socketRooms.getAuthority(socket), null);
  });

  test("disconnects revoked and replaced sessions without another request, preserving other users", async (t) => {
    const database = createDatabase(t);
    const runtime = createTargetRuntime(runtimeOptions(database));
    const scenario = seedTwoLeagueProfileScenario(runtime);
    const otherSession = runtime.services.sessionService.issueForUser({ userId: uuid(1102) });
    const sockets = new Map();
    runtime.app.set("io", { sockets: { sockets } });
    async function connect(session) {
      const socket = createTargetSocket(runtime, session);
      assert.equal(await runSocketMiddleware(runtime.socketRooms.middleware, socket), undefined);
      sockets.set(session.session.id, socket);
      return socket;
    }
    const otherSocket = await connect(otherSession);
    let current = scenario.session;
    let socket = await connect(current);
    const replacement = runtime.services.sessionService.issueForUser({ userId: scenario.managerUserId });
    const afterReplacement = database.serialize();
    await new Promise(setImmediate);
    assert.equal(socket.disconnected, true);
    assert.equal(runtime.socketRooms.getAuthority(socket), null);
    assert.equal(afterReplacement.equals(database.serialize()), true);
    assert.equal(otherSocket.disconnected, false);
    current = replacement;
    for (const reason of ["sign_out", "password_change", "password_reset", "account_deactivation", "platform_safety_disable", "platform_security_action"]) {
      socket = await connect(current);
      runtime.services.sessionService.revoke({ sessionId: current.session.id, expectedVersion: 1, reason });
      const afterRevoke = database.serialize();
      await new Promise(setImmediate);
      assert.equal(socket.disconnected, true, reason);
      assert.equal(runtime.socketRooms.getAuthority(socket), null);
      assert.equal(otherSocket.disconnected, false);
      assert.equal(afterRevoke.equals(database.serialize()), true);
      current = runtime.services.sessionService.issueForUser({ userId: scenario.managerUserId });
    }
    socket = await connect(current);
    runtime.repositories.sessions.expireActive({ sessionId: current.session.id, expectedVersion: 1, changedAtMs: NOW_MS, reason: "idle_expired", transactionHook: null });
    await new Promise(setImmediate);
    assert.equal(socket.disconnected, true);
    assert.equal(otherSocket.disconnected, false);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  });

  test("keeps connected sessions valid when revocation or replacement rolls back", async (t) => {
    const database = createDatabase(t);
    const runtime = createTargetRuntime(runtimeOptions(database));
    const scenario = seedTwoLeagueProfileScenario(runtime);
    const socket = createTargetSocket(runtime, scenario.session);
    assert.equal(await runSocketMiddleware(runtime.socketRooms.middleware, socket), undefined);
    runtime.app.set("io", { sockets: { sockets: new Map([["current", socket]]) } });
    const before = database.serialize();
    for (const change of [
      () => runtime.services.sessionService.revoke({ sessionId: scenario.session.session.id, expectedVersion: 1, reason: "password_change" }),
      () => runtime.services.sessionService.issueForUser({ userId: scenario.managerUserId }),
    ]) {
      assert.throws(() => runtime.repositories.context.transaction(() => {
        change();
        throw new Error("later account persistence failed");
      }));
      await new Promise(setImmediate);
      assert.equal(socket.disconnected, false);
      assert.equal(runtime.socketRooms.getAuthority(socket).userId, scenario.managerUserId);
      assert.equal(before.equals(database.serialize()), true);
    }
    assert.throws(() => runtime.services.sessionService.revoke({
      sessionId: scenario.session.session.id, expectedVersion: 1, reason: "sign_out",
      transactionHook() { throw new Error("audit failed"); },
    }));
    await new Promise(setImmediate);
    assert.equal(socket.disconnected, false);
    assert.equal(before.equals(database.serialize()), true);
  });

  test("joins only the current user's visible league and managed-team rooms without writes", async (t) => {
    const database = createDatabase(t);
    const runtime = createTargetRuntime(runtimeOptions(database));
    const scenario = seedTwoLeagueProfileScenario(runtime);
    const socket = createTargetSocket(runtime, scenario.session);
    const before = database.serialize();

    const error = await runSocketMiddleware(
      runtime.socketRooms.middleware,
      socket
    );
    assert.equal(error, undefined);
    assert.deepEqual([...socket.rooms].sort(), [
      `league:${scenario.visibleLeagueId}`,
      "target-socket",
      `team:${scenario.teamId}`,
      `user:${scenario.managerUserId}`,
    ]);
    assert.equal(socket.rooms.has(`league:${scenario.hiddenLeagueId}`), false);
    assert.equal(socket.rooms.has(`team:${scenario.hiddenTeamId}`), false);
    assert.deepEqual(runtime.socketRooms.getAuthority(socket), {
      userId: scenario.managerUserId,
      rooms: [
        `user:${scenario.managerUserId}`,
        `league:${scenario.visibleLeagueId}`,
        `team:${scenario.teamId}`,
      ],
    });
    assert.equal(before.equals(database.serialize()), true);
  });

  test("fails a composed handshake closed for a non-allowlisted origin without writes", async (t) => {
    const database = createDatabase(t);
    const runtime = createTargetRuntime(runtimeOptions(database));
    const scenario = seedTwoLeagueProfileScenario(runtime);
    const socket = createTargetSocket(runtime, scenario.session);
    socket.handshake.headers.origin = "https://evil.example";
    const before = database.serialize();

    const error = await runSocketMiddleware(
      runtime.socketRooms.middleware,
      socket
    );
    assert.deepEqual(error.data, { code: "SOCKET_ORIGIN_NOT_ALLOWED" });
    assert.deepEqual([...socket.rooms], ["target-socket"]);
    assert.equal(runtime.socketRooms.getAuthority(socket), null);
    assert.equal(before.equals(database.serialize()), true);
  });
});

describe("M3-19 local target HTTP and Socket.IO server lifecycle", () => {
  test("attaches authenticated socket middleware once, listens, and closes idempotently without jobs", async (t) => {
    const database = createDatabase(t);
    const securityFoundations = foundations();
    const runtime = createTargetRuntime(
      runtimeOptions(database, { securityFoundations })
    );
    const instances = [];
    class FakeSocketServer {
      constructor(server, options) {
        this.server = server;
        this.options = options;
        this.middlewares = [];
        this.handlers = [];
        this.closeCalls = 0;
        instances.push(this);
      }
      use(middleware) {
        this.middlewares.push(middleware);
      }
      on(event, handler) {
        this.handlers.push({ event, handler });
      }
      close(callback) {
        this.closeCalls += 1;
        callback();
      }
    }
    const targetServer = createTargetHttpServer({
      runtime,
      securityConfig: securityFoundations.config,
      SocketServerClass: FakeSocketServer,
    });
    assert.equal(instances.length, 1);
    assert.deepEqual(instances[0].middlewares, [runtime.socketRooms.middleware]);
    assert.deepEqual(
      instances[0].handlers.map(({ event }) => event),
      ["connection"]
    );
    assert.equal(runtime.app.get("io"), instances[0]);
    const allowed = await new Promise((resolve) => {
      instances[0].options.cors.origin(
        PUBLIC_FRONTEND_ORIGIN,
        (error, accepted) => resolve({ error, accepted })
      );
    });
    assert.equal(allowed.error, null);
    assert.equal(allowed.accepted, true);
    const blocked = await new Promise((resolve) => {
      instances[0].options.cors.origin(
        "https://evil.example",
        (error, accepted) => resolve({ error, accepted })
      );
    });
    assert.match(blocked.error.message, /Socket CORS blocked/);
    assert.equal(blocked.accepted, undefined);

    const address = await targetServer.listen({
      port: 0,
      host: "127.0.0.1",
    });
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/session`,
      { headers: { Origin: PUBLIC_FRONTEND_ORIGIN } }
    );
    assert.equal(response.status, 401);
    const firstClose = targetServer.close();
    const secondClose = targetServer.close();
    assert.equal(firstClose, secondClose);
    await firstClose;
    assert.equal(instances[0].closeCalls, 1);
    assert.equal(targetServer.server.listening, false);
  });

  test("closes an owned SQLite runtime when listening is rejected before startup", async (t) => {
    const runtime = createOwnedTargetRuntime(
      t,
      "hundo-m3-19-listen-failure-"
    );
    let socketCloseCalls = 0;
    class FakeSocketServer {
      use() {}
      on() {}
      close(callback) {
        socketCloseCalls += 1;
        callback();
      }
    }
    const targetServer = createTargetHttpServer({
      runtime,
      securityConfig: runtime.securityConfig,
      SocketServerClass: FakeSocketServer,
    });
    await assert.rejects(
      targetServer.listen({ port: -1, host: "127.0.0.1" }),
      /valid port/
    );
    assert.equal(socketCloseCalls, 1);
    assert.equal(targetServer.server.listening, false);
    assert.equal(runtime.database.open, false);
  });

  test("continues shutdown through HTTP and SQLite when Socket.IO close fails", async (t) => {
    const runtime = createOwnedTargetRuntime(
      t,
      "hundo-m3-19-close-failure-"
    );
    class FailingSocketServer {
      use() {}
      on() {}
      close(callback) {
        callback(new Error("injected Socket.IO close failure"));
      }
    }
    const targetServer = createTargetHttpServer({
      runtime,
      securityConfig: runtime.securityConfig,
      SocketServerClass: FailingSocketServer,
    });
    await targetServer.listen({ port: 0, host: "127.0.0.1" });
    await assert.rejects(
      targetServer.close(),
      (error) =>
        error instanceof AggregateError &&
        error.errors[0].message === "injected Socket.IO close failure"
    );
    assert.equal(targetServer.server.listening, false);
    assert.equal(runtime.database.open, false);
  });
});

test('private league help preserves populated state and enforces requester, commissioner and retry boundaries over HTTP',async t=>{
 const database=createDatabase(t,{migrated:false}),migrations=discoverMigrations({migrationsDirectory:MIGRATIONS_DIRECTORY});
 const old=migrations.filter(m=>m.id<=80);applyMigrations({database,migrations:old,applicationBuildId:'help-test',now:()=>NOW_MS});
 const oldDir=path.join(path.dirname(database.name),'schema80');fs.mkdirSync(oldDir);for(const m of old)fs.copyFileSync(path.join(MIGRATIONS_DIRECTORY,m.fileName),path.join(oldDir,m.fileName));
 const oldRuntime=createTargetRuntime(runtimeOptions(database,{migrationsDirectory:oldDir})),scenario=seedComposedLeagueStartScenario(oldRuntime);
 const tables=database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations','application_metadata') ORDER BY name").all().map(r=>r.name);
 const rows=()=>Object.fromEntries(tables.map(name=>[name,database.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all()]));
 const original=rows(),objects=database.prepare('SELECT name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name').all();
 applyMigrations({database,migrations:migrations.filter(m=>m.id<=81),applicationBuildId:'help-test',now:()=>NOW_MS});assert.deepEqual(rows(),original);
 for(const object of objects)assert.equal(database.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(object.name).sql,object.sql,object.name);
 applyMigrations({database,migrations,applicationBuildId:'help-test-current',now:()=>NOW_MS});
 const runtime=createTargetRuntime(runtimeOptions(database));
 const managers=database.prepare("SELECT user_id,team_id FROM team_manager_assignments WHERE league_id=? AND user_id<>? AND status='accepted' ORDER BY team_id").all(scenario.leagueId,scenario.commissionerUserId);
 const session=userId=>runtime.services.sessionService.issueForUser({userId}),commissioner=session(scenario.commissionerUserId),manager=session(managers[0].user_id),other=session(managers[1].user_id);
 const origin=await startRuntimeApp(t,runtime),url=origin+'/api/v1/leagues/'+scenario.leagueId+'/help';
 const headersFor=s=>browserHeaders({Cookie:runtime.transport.sessionCookie.name+'='+s.rawSessionToken,'X-CSRF-Token':s.rawCsrfToken});
 const mh=headersFor(manager),ch=headersFor(commissioner),oh=headersFor(other);
 const get=(suffix='',headers=mh)=>fetch(url+suffix,{headers}),post=(suffix,body,key,headers=mh)=>fetch(url+suffix,{method:'POST',headers:{...headers,'Idempotency-Key':key},body:JSON.stringify(body)});
 assert.equal((await get('',browserHeaders())).status,401);
 const before=database.serialize();
 for(const kind of ['general','auction','roster','trade']){const response=await get('/targets?kind='+kind+'&teamId='+managers[0].team_id);assert.equal(response.status,200,JSON.stringify(await response.clone().json()));}
 assert.equal((await get('/targets?kind=auction&teamId='+managers[1].team_id)).status,403);
 const list=await get();assert.equal(list.status,200,JSON.stringify(await list.clone().json()));assert.deepEqual((await list.json()).data.requests,[]);assert.deepEqual(database.serialize(),before);
 const input={kind:'general',teamId:managers[0].team_id,targetId:null,subject:'Please check my setup',message:'Private issue for the commissioner to review.'};
 assert.equal((await post('',input,'help-create-badcsrf',{...mh,'X-CSRF-Token':'bad'})).status,403);
 assert.equal((await post('',{...input,teamId:managers[1].team_id},'help-create-other')).status,403);
 assert.equal((await post('',{...input,kind:'auction',targetId:uuid(981100)},'help-create-badtarget')).status,409);
 database.exec("CREATE TRIGGER help_fixture_failure BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'Synthetic notice failure'); END");
 const rollback=database.serialize();assert.equal((await post('',input,'help-create-once')).status,500);assert.deepEqual(database.serialize(),rollback);database.exec('DROP TRIGGER help_fixture_failure');
 const protectedBefore=rows(),created=await post('',input,'help-create-once');assert.equal(created.status,200,JSON.stringify(await created.clone().json()));const id=(await created.json()).data.id;
 const protectedAfter=rows();for(const name of tables)if(name!=='notifications')assert.deepEqual(protectedAfter[name],protectedBefore[name],name);
 const notice=database.prepare("SELECT user_id,message_data_json FROM notifications WHERE event_type='league_help_updated'").all();assert.equal(notice.length,1);assert.equal(notice[0].user_id,scenario.commissionerUserId);assert.doesNotMatch(JSON.stringify(notice),/Private issue|Please check/);
 const written=database.serialize();assert.equal((await(await post('',input,'help-create-once')).json()).data.replayed,true);assert.deepEqual(database.serialize(),written);
 assert.equal((await post('',{...input,message:'Different contents'},'help-create-once')).status,409);
 assert.equal((await get('/'+id,oh)).status,404);assert.deepEqual((await(await get('',oh)).json()).data.requests,[]);
 const detail=(await(await get('/'+id,ch)).json()).data;assert.equal(detail.canManage,true);assert.equal(detail.request.message,input.message);
 assert.equal((await post('/'+id+'/events',{action:'resolve',message:'Fix completed',expectedVersion:1},'help-wrong-resolve')).status,403);
 const reply={action:'reply',message:'I am checking the issue',expectedVersion:1};
 assert.equal((await post('/'+id+'/events',reply,'help-reply-one',ch)).status,200);
 assert.equal((await post('/'+id+'/events',reply,'help-reply-stale',ch)).status,409);
 const afterReply=database.serialize();assert.equal((await(await post('/'+id+'/events',reply,'help-reply-one',ch)).json()).data.replayed,true);assert.deepEqual(database.serialize(),afterReply);
 assert.equal((await post('/'+id+'/events',{action:'resolve',message:'Setup reviewed and corrected',expectedVersion:2},'help-resolve-once',ch)).status,200);
 assert.equal((await post('/'+id+'/events',{action:'reply',message:'An old reply',expectedVersion:3},'help-closed-reply')).status,409);
 assert.equal((await post('/'+id+'/events',{action:'reopen',message:'The issue is still happening',expectedVersion:3},'help-reopen-once')).status,200);
 assert.equal((await post('/'+id+'/events',{action:'withdraw',message:'I no longer need this request',expectedVersion:4},'help-withdraw-once')).status,200);
 assert.equal((await(await get('/'+id)).json()).data.events.length,4);
 assert.equal((await(await get()).json()).data.requests.length,0);assert.equal((await(await get('?status=closed')).json()).data.requests.length,1);
 assert.throws(()=>database.prepare('DELETE FROM league_help_requests WHERE id=?').run(id),/retained/);
 assert.throws(()=>database.exec("UPDATE league_help_events SET message='rewritten'"),/immutable/);
 assert.throws(()=>database.prepare("UPDATE league_help_requests SET message='rewritten' WHERE id=?").run(id),/retain/);
 database.prepare("INSERT INTO platform_roles(id,user_id,role,status,granted_by_user_id,granted_at_ms,ended_at_ms,version) VALUES(?,?,'platform_administrator','active',?,?,NULL,1)").run(uuid(981101),managers[1].user_id,scenario.commissionerUserId,NOW_MS);
 assert.equal((await get('/'+id,oh)).status,200);database.prepare("UPDATE platform_roles SET status='ended',ended_at_ms=?,version=version+1 WHERE id=?").run(NOW_MS,uuid(981101));assert.equal((await get('/'+id,oh)).status,404);
 assert.deepEqual(database.pragma('foreign_key_check'),[]);assert.equal(database.pragma('integrity_check',{simple:true}),'ok');
});

test('standings rebuild confirmation replays its saved result without recomputing after snapshot changes',async t=>{
 const database=createDatabase(t),runtime=createTargetRuntime(runtimeOptions(database)),scenario=seedComposedLeagueStartScenario(runtime);
 const commissioner=runtime.services.sessionService.issueForUser({userId:scenario.commissionerUserId});
 const managerId=database.prepare("SELECT user_id FROM team_manager_assignments WHERE league_id=? AND user_id<>? AND status='accepted' LIMIT 1").get(scenario.leagueId,scenario.commissionerUserId).user_id;
 const manager=runtime.services.sessionService.issueForUser({userId:managerId}),origin=await startRuntimeApp(t,runtime);
 const url=origin+'/api/v1/leagues/'+scenario.leagueId+'/seasons/'+scenario.seasonId+'/standings/rebuilds';
 const headersFor=s=>browserHeaders({Cookie:runtime.transport.sessionCookie.name+'='+s.rawSessionToken,'X-CSRF-Token':s.rawCsrfToken}),headers=headersFor(commissioner);
 const post=(body,h=headers)=>fetch(url,{method:'POST',headers:h,body:JSON.stringify(body)});
 const before=database.serialize();assert.equal((await post({confirmed:false},headersFor(manager))).status,403);
 const response=await post({confirmed:false});assert.equal(response.status,200,JSON.stringify(await response.clone().json()));const preview=(await response.json()).data.preview;assert.deepEqual(database.serialize(),before);
 const body={confirmed:true,expectedCurrentSnapshotId:preview.currentSnapshotId,reason:'Rebuild derived standings from saved results'},writeHeaders={...headers,'If-Match':'"'+preview.expectedVersion+'"','Idempotency-Key':uuid(981201)};
 const written=await post(body,writeHeaders);assert.equal(written.status,200,JSON.stringify(await written.clone().json()));assert.equal((await written.json()).data.result.replayed,false);
 const after=database.serialize(),retry=await post(body,writeHeaders);assert.equal(retry.status,200,JSON.stringify(await retry.clone().json()));assert.equal((await retry.json()).data.result.replayed,true);assert.deepEqual(database.serialize(),after);
 assert.equal((await post({...body,reason:'Different reason'},writeHeaders)).status,412);assert.deepEqual(database.serialize(),after);
 assert.equal((await post(body,{...writeHeaders,'Idempotency-Key':uuid(981202)})).status,409);assert.deepEqual(database.serialize(),after);
 assert.deepEqual(database.pragma('foreign_key_check'),[]);
});

test('season preview presents contract expiry and continuation from real rows and keeps preparation unscheduled',async t=>{
 const database=createDatabase(t),runtime=createTargetRuntime(runtimeOptions(database)),scenario=seedComposedLeagueStartScenario(runtime),targetId=uuid(981301);
 database.prepare("INSERT INTO seasons(id,league_id,label,nhl_season_key,status,created_at_ms,updated_at_ms,version) VALUES(?,?,'2027','20272028','planned',?,?,1)").run(targetId,scenario.leagueId,NOW_MS,NOW_MS);
 for(let i=0;i<2;i++){
  const playerId=uuid(981310+i),contractId=uuid(981320+i),term=i+1;
  database.prepare("INSERT INTO players(id,first_name,last_name,full_name,birth_date,status,created_at_ms,updated_at_ms,version) VALUES(?,'Preview',?, ?,NULL,'active',?,?,1)").run(playerId,String(i),'Preview '+i,NOW_MS,NOW_MS);
  database.prepare("INSERT INTO contracts(id,league_id,player_id,current_team_id,contract_type,original_total_value_cents,original_term_years,aav_cents,start_season_id,status,acquisition_source_type,created_at_ms,updated_at_ms,version) VALUES(?,?,?,?,'normal',?,?,100,?,'active','fixture',?,?,1)").run(contractId,scenario.leagueId,playerId,scenario.teamIds[0],100*term,term,scenario.seasonId,NOW_MS,NOW_MS);
  database.prepare("INSERT INTO contract_years(id,league_id,contract_id,season_id,year_number,aav_cents,status,rollover_at_ms,created_at_ms) VALUES(?,?,?,?,1,100,'current',NULL,?)").run(uuid(981330+i),scenario.leagueId,contractId,scenario.seasonId,NOW_MS);
  if(i===1)database.prepare("INSERT INTO contract_years(id,league_id,contract_id,season_id,year_number,aav_cents,status,rollover_at_ms,created_at_ms) VALUES(?,?,?,?,2,100,'future',NULL,?)").run(uuid(981340),scenario.leagueId,contractId,targetId,NOW_MS);
  database.prepare("INSERT INTO player_ownerships(id,league_id,season_id,player_id,team_id,ownership_kind,roster_category,position_group,slot_number,acquired_transaction_type,created_at_ms,updated_at_ms,version) VALUES(?,?,?,?,?,'Rostered','Active','F',?,'fixture',?,?,1)").run(uuid(981350+i),scenario.leagueId,scenario.seasonId,playerId,scenario.teamIds[0],i+1,NOW_MS,NOW_MS);
 }
 const commissioner=runtime.services.sessionService.issueForUser({userId:scenario.commissionerUserId}),origin=await startRuntimeApp(t,runtime);
 const headers=browserHeaders({Cookie:runtime.transport.sessionCookie.name+'='+commissioner.rawSessionToken}),before=database.serialize();
 const response=await fetch(origin+'/api/v1/leagues/'+scenario.leagueId+'/management/season-preview',{headers});assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
 const data=(await response.json()).data;assert.equal(data.target.id,targetId);assert.equal(data.target.startsAtMs,null);assert.equal(data.projectionAvailable,true,JSON.stringify(data));
 assert.deepEqual(data.contracts.map(c=>[c.playerName,c.currentYears,c.nextYears,c.outcome]),[['Preview 0',1,0,'expire'],['Preview 1',2,1,'continue']]);
 assert.equal(data.summary.contractsExpiring,1);assert.equal(data.summary.contractsContinuing,1);assert.equal(data.summary.playersReleased,1);assert.equal(data.summary.playersCarried,1);assert.equal(data.summary.tradesCancelled,0);
 assert.ok(data.issues.includes('NEXT_CALENDAR_UNSET'));assert.ok(data.issues.includes('NEXT_DRAFT_NOT_SCHEDULED'));assert.deepEqual(database.serialize(),before);assert.deepEqual(database.pragma('foreign_key_check'),[]);
});

test('administrator catalogue preview and confirmation preserve league records and enforce identity, authority, rollback and durable retries',async t=>{
 const database=createDatabase(t);let calls=0,failFeed=false,afterFetch=()=>{};
 let row={playerId:8479999,firstName:{default:'Synthetic'},lastName:{default:'Skater'},birthDate:'1998-02-03',isActive:true,position:'C',currentTeamAbbrev:'VAN'};
 const runtime=createTargetRuntime(runtimeOptions(database,{nhlFetchImplementation:async url=>{calls++;assert.equal(url,'https://api-web.nhle.com/v1/player/8479999/landing');afterFetch();if(failFeed)throw Error('fixture provider secret');return {ok:true,text:async()=>JSON.stringify(row)};}}));
 const scenario=seedComposedLeagueStartScenario(runtime),adminId=scenario.commissionerUserId,roleId=uuid(981401);
 database.prepare("INSERT INTO platform_roles(id,user_id,role,status,granted_by_user_id,granted_at_ms,ended_at_ms,version) VALUES(?,?,'platform_administrator','active',NULL,?,NULL,1)").run(roleId,adminId,NOW_MS);
 const managerId=database.prepare("SELECT user_id FROM team_manager_assignments WHERE league_id=? AND user_id<>? LIMIT 1").get(scenario.leagueId,adminId).user_id;
 const admin=runtime.services.sessionService.issueForUser({userId:adminId}),manager=runtime.services.sessionService.issueForUser({userId:managerId}),origin=await startRuntimeApp(t,runtime);
 const headers=s=>browserHeaders({Cookie:runtime.transport.sessionCookie.name+'='+s.rawSessionToken,'X-CSRF-Token':s.rawCsrfToken,'Content-Type':'application/json'});
 const ah=headers(admin),mh=headers(manager),base=origin+'/api/v1/operations/catalogue';
 const post=(suffix,input,h=ah)=>fetch(base+suffix,{method:'POST',headers:h,body:JSON.stringify(input)});
 assert.equal((await post('/preview',{nhlId:'8479999'},mh)).status,403);assert.equal(calls,0);
 assert.equal((await post('/preview',{nhlId:'8479999'},{...ah,'X-CSRF-Token':'bad'})).status,403);
 assert.equal((await post('/preview',{nhlId:'http://internal'})).status,400);assert.equal(calls,0);
 database.prepare("INSERT INTO players(id,first_name,last_name,full_name,birth_date,status,created_at_ms,updated_at_ms,version) VALUES(?,'Synthetic','Skater','Synthetic Skater','1998-02-03','active',?,?,1)").run(uuid(981404),NOW_MS,NOW_MS);
 const duplicateBefore=database.serialize();assert.equal((await post('/preview',{nhlId:'8479999'})).status,409);assert.deepEqual(database.serialize(),duplicateBefore);
 row={...row,firstName:{default:'Unique'},lastName:{default:'Forward'}};
 const before=database.serialize(),previewResponse=await post('/preview',{nhlId:'8479999'});assert.equal(previewResponse.status,200,JSON.stringify(await previewResponse.clone().json()));
 assert.match(previewResponse.headers.get('cache-control'),/no-store/);const preview=(await previewResponse.json()).data;assert.equal(preview.action,'import');assert.deepEqual(database.serialize(),before);
 const body={nhlId:'8479999',previewHash:preview.previewHash,operationId:uuid(981402),reason:'Import missing skater'};
 const tables=database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name);
 const dump=()=>Object.fromEntries(tables.map(name=>[name,database.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all()]));
 const protectedBefore=dump();
 database.exec("CREATE TRIGGER fixture_catalogue_audit_failure BEFORE INSERT ON operational_events WHEN NEW.event_type='administrator_catalogue_change' BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;");
 const rollbackBefore=database.serialize();assert.equal((await post('/apply',body)).status,503);assert.deepEqual(database.serialize(),rollbackBefore);database.exec('DROP TRIGGER fixture_catalogue_audit_failure');
 row={...row,currentTeamAbbrev:'SEA'};assert.equal((await post('/apply',body)).status,409);row={...row,currentTeamAbbrev:'VAN'};
 const response=await post('/apply',body);assert.equal(response.status,200,JSON.stringify(await response.clone().json()));const result=(await response.json()).data;assert.equal(result.createdPlayerCount,1);
 const protectedAfter=dump();for(const table of tables.filter(n=>!['players','player_external_ids','player_source_state','operational_events'].includes(n)))assert.deepEqual(protectedAfter[table],protectedBefore[table],table);
 const after=database.serialize(),callsBefore=calls;failFeed=true;const replay=(await(await post('/apply',body)).json()).data;assert.equal(replay.replayed,true);assert.equal(replay.playerId,result.playerId);assert.equal(calls,callsBefore);assert.deepEqual(database.serialize(),after);
 assert.equal((await post('/apply',{...body,reason:'Different reason'})).status,409);failFeed=false;
 assert.throws(()=>database.prepare('DELETE FROM operational_events WHERE id=?').run(body.operationId),/retained/);
 const search=await fetch(base+'?search=Unique',{headers:ah});assert.equal(search.status,200);const searchData=(await search.json()).data;assert.equal(searchData.players[0].nhlId,'8479999');assert.equal(searchData.history[0].reason,body.reason);assert.deepEqual(database.serialize(),after);
 row={...row,currentTeamAbbrev:'SEA'};const refresh=(await(await post('/preview',{nhlId:'8479999'})).json()).data;
 const refreshResponse=await post('/apply',{...body,previewHash:refresh.previewHash,operationId:uuid(981403)});assert.equal(refreshResponse.status,200);assert.equal((await refreshResponse.json()).data.playerId,result.playerId);assert.equal(database.prepare('SELECT count(*) n FROM players WHERE id=?').get(result.playerId).n,1);
 afterFetch=()=>database.prepare("UPDATE platform_roles SET status='ended',ended_at_ms=?,version=version+1 WHERE id=? AND status='active'").run(NOW_MS,roleId);
 const playerBeforeRevoke=database.prepare('SELECT * FROM players WHERE id=?').get(result.playerId);
 assert.equal((await post('/apply',{...body,previewHash:refresh.previewHash,operationId:uuid(981405)})).status,403);assert.deepEqual(database.prepare('SELECT * FROM players WHERE id=?').get(result.playerId),playerBeforeRevoke);
 assert.equal((await post('/preview',{nhlId:'8479999'})).status,403);assert.equal((await fetch(base,{headers:ah})).status,403);assert.equal((await post('/apply',body)).status,403);
 assert.deepEqual(database.pragma('foreign_key_check'),[]);
});

test('eligible correction reversal restores roster and contract values with retained audit, current authority and atomic retry',async t=>{
 const database=createDatabase(t);let time=NOW_MS;
 const runtime=createTargetRuntime(runtimeOptions(database,{securityFoundations:createSecurityFoundations({env:securityEnv(),now:()=>time,loggerSink(){}})}));
 const scenario=seedComposedLeagueStartScenario(runtime),teamId=scenario.teamIds[0],playerId=uuid(981501),contractId=uuid(981502),ownershipId=uuid(981503);
 database.prepare("UPDATE teams SET status='active',updated_at_ms=?,version=version+1 WHERE league_id=?").run(time,scenario.leagueId);
 database.prepare("INSERT INTO players(id,first_name,last_name,full_name,birth_date,status,created_at_ms,updated_at_ms,version) VALUES(?,'Casey','Forward','Casey Forward',NULL,'active',?,?,1)").run(playerId,time,time);
 database.prepare("INSERT INTO contracts(id,league_id,player_id,current_team_id,contract_type,original_total_value_cents,original_term_years,aav_cents,start_season_id,status,acquisition_source_type,created_at_ms,updated_at_ms,version) VALUES(?,?,?,?,'normal',100,1,100,?,'active','fixture',?,?,1)").run(contractId,scenario.leagueId,playerId,teamId,scenario.seasonId,time,time);
 database.prepare("INSERT INTO contract_years(id,league_id,contract_id,season_id,year_number,aav_cents,status,rollover_at_ms,created_at_ms) VALUES(?,?,?,?,1,100,'current',NULL,?)").run(uuid(981504),scenario.leagueId,contractId,scenario.seasonId,time);
 database.prepare("INSERT INTO player_ownerships(id,league_id,season_id,player_id,team_id,ownership_kind,roster_category,position_group,slot_number,acquired_transaction_type,created_at_ms,updated_at_ms,version) VALUES(?,?,?,?,?,'Rostered','Active','F',1,'fixture',?,?,1)").run(ownershipId,scenario.leagueId,scenario.seasonId,playerId,teamId,time,time);
 const commissioner=runtime.services.sessionService.issueForUser({userId:scenario.commissionerUserId});
 const managerId=database.prepare("SELECT user_id FROM team_manager_assignments WHERE league_id=? AND user_id<>? LIMIT 1").get(scenario.leagueId,scenario.commissionerUserId).user_id;
 const manager=runtime.services.sessionService.issueForUser({userId:managerId}),origin=await startRuntimeApp(t,runtime);
 const headers=s=>browserHeaders({Cookie:runtime.transport.sessionCookie.name+'='+s.rawSessionToken,'X-CSRF-Token':s.rawCsrfToken,'Content-Type':'application/json'}),ch=headers(commissioner),mh=headers(manager);
 const base=origin+'/api/v1/leagues/'+scenario.leagueId,post=(suffix,input,key,h=ch)=>fetch(base+suffix,{method:'POST',headers:{...h,'Idempotency-Key':key},body:JSON.stringify(input)});
 const management='/management/reversals';
 time+=100;
 const correction={seasonId:scenario.seasonId,ownershipId,playerId,expectedVersion:1,correctedTeamId:teamId,correctedOwnershipKind:'Rostered',correctedRosterCategory:'Bench',correctedPositionGroup:'F',correctedSlotNumber:1,reason:'Mistaken bench move',confirmWarnings:true};
 const moved=await post('/commissioner/roster-corrections',correction,'original-roster-change');assert.equal(moved.status,200,JSON.stringify(await moved.clone().json()));const original=(await moved.json()).data.evidence.correctionId;
 const originalEvidence=database.prepare('SELECT * FROM commissioner_corrections WHERE id=?').get(original);
 time+=100;
 const proposal={correctionId:original,reason:'Restore original roster'};
 assert.equal((await post(management+'/preview',proposal,'preview-mgr',mh)).status,403);
 assert.equal((await post(management+'/preview',proposal,'preview-csrf',{...ch,'X-CSRF-Token':'bad'})).status,403);
 const before=database.serialize();const r=await post(management+'/preview',proposal,'preview-roster');assert.equal(r.status,200,JSON.stringify(await r.clone().json()));const preview=(await r.json()).data;
 assert.equal(preview.current.rosterCategory,'Bench');assert.equal(preview.restore.rosterCategory,'Active');assert.deepEqual(database.serialize(),before);
 const confirmed={...proposal,previewHash:preview.previewHash,confirmed:true};
 database.exec("CREATE TRIGGER fixture_reverse_notice_failure BEFORE INSERT ON notifications WHEN NEW.event_type='league_correction_reversed' BEGIN SELECT RAISE(ABORT,'fixture notification rollback'); END;");
 const rollback=database.serialize();assert.equal((await post(management+'/apply',confirmed,'reverse-roster-once')).status,409);assert.deepEqual(database.serialize(),rollback);database.exec('DROP TRIGGER fixture_reverse_notice_failure');
 const scopedTables=database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name);
 const protectedTables=scopedTables.filter(n=>!['player_ownerships','ownership_events','commissioner_corrections','league_activity','league_management_actions','notifications','outbox_events','outbox_event_audiences','idempotency_requests','leagues'].includes(n));
 const protectedRecords=Object.fromEntries(protectedTables.map(n=>[n,database.prepare('SELECT * FROM "'+n+'" ORDER BY rowid').all()]));
 const done=await post(management+'/apply',confirmed,'reverse-roster-once');assert.equal(done.status,200,JSON.stringify(await done.clone().json()));const reversedRoster=(await done.json()).data.correctionId;
 assert.equal(database.prepare('SELECT roster_category FROM player_ownerships WHERE id=?').get(ownershipId).roster_category,'Active');
 for(const name of protectedTables)assert.deepEqual(database.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all(),protectedRecords[name],name);
 assert.deepEqual(database.prepare('SELECT * FROM commissioner_corrections WHERE id=?').get(original),originalEvidence);
 const after=database.serialize();assert.equal((await(await post(management+'/apply',confirmed,'reverse-roster-once')).json()).data.replayed,true);assert.deepEqual(database.serialize(),after);
 assert.equal((await post(management+'/apply',{...confirmed,reason:'Different reversal'},'reverse-roster-once')).status,409);
 assert.equal((await post(management+'/preview',proposal,'already-reversed')).status,409);
 time+=100;
 const changed=await post('/commissioner/contract-corrections',{seasonId:scenario.seasonId,contractId,playerId,expectedVersion:1,correctedOriginalTotalValueCents:200,correctedOriginalTermYears:1,reason:'Incorrect salary',confirmWarnings:true},'original-contract-change');
 assert.equal(changed.status,200,JSON.stringify(await changed.clone().json()));const contractCorrection=(await changed.json()).data.evidence.correctionId;
 time+=100;
 const contractProposal={correctionId:contractCorrection,reason:'Restore original salary'},cp=await post(management+'/preview',contractProposal,'preview-contract');assert.equal(cp.status,200,JSON.stringify(await cp.clone().json()));const contractPreview=(await cp.json()).data;
 assert.equal(contractPreview.current.aavCents,200);assert.equal(contractPreview.restore.aavCents,100);
 database.prepare('UPDATE teams SET version=version+1,updated_at_ms=? WHERE id=?').run(time,teamId);
 assert.equal((await post(management+'/apply',{...contractProposal,previewHash:contractPreview.previewHash,confirmed:true},'stale-contract-reverse')).status,409);
 const fresh=(await(await post(management+'/preview',contractProposal,'fresh-contract')).json()).data;
 const reversed=await post(management+'/apply',{...contractProposal,previewHash:fresh.previewHash,confirmed:true},'reverse-contract-once');assert.equal(reversed.status,200,JSON.stringify(await reversed.clone().json()));
 assert.equal(database.prepare('SELECT aav_cents FROM contracts WHERE id=?').get(contractId).aav_cents,100);
 assert.equal(database.prepare("SELECT count(*) n FROM league_management_actions WHERE league_id=? AND action_type='reverse_correction'").get(scenario.leagueId).n,2);
 assert.equal(database.prepare('SELECT count(*) n FROM commissioner_corrections WHERE league_id=?').get(scenario.leagueId).n,4);
 const list=await fetch(base+management,{headers:ch});assert.equal(list.status,200);assert.match(list.headers.get('cache-control'),/no-store/);assert.equal((await list.json()).data.corrections.filter(c=>c.reversed).length,2);
 assert.equal((await post(management+'/preview',{correctionId:reversedRoster,reason:'Attempt after later contract changes'},'later-change-denied')).status,409);
 const roleId=uuid(981505);database.prepare("INSERT INTO platform_roles(id,user_id,role,status,granted_by_user_id,granted_at_ms,ended_at_ms,version) VALUES(?,?,'platform_administrator','active',NULL,?,NULL,1)").run(roleId,managerId,time);
 assert.equal((await fetch(base+management,{headers:mh})).status,200);database.prepare("UPDATE platform_roles SET status='ended',ended_at_ms=?,version=version+1 WHERE id=?").run(time,roleId);
 assert.equal((await fetch(base+management,{headers:mh})).status,403);assert.equal((await post(management+'/apply',confirmed,'revoked-admin',mh)).status,403);
 time+=100;
 const transfer=await post('/commissioner/roster-corrections',{...correction,expectedVersion:3,correctedTeamId:scenario.teamIds[1],correctedRosterCategory:'Active',reason:'Mistaken team transfer'},'original-team-transfer');assert.equal(transfer.status,200,JSON.stringify(await transfer.clone().json()));
 const transferData=(await transfer.json()).data,transferProposal={correctionId:transferData.evidence.correctionId,reason:'Restore original team'};
 time+=100;const tp=await post(management+'/preview',transferProposal,'preview-transfer');assert.equal(tp.status,200,JSON.stringify(await tp.clone().json()));const transferPreview=(await tp.json()).data;
 assert.equal(transferPreview.current.teamId,scenario.teamIds[1]);assert.equal(transferPreview.restore.teamId,teamId);
 const transferUndo=await post(management+'/apply',{...transferProposal,previewHash:transferPreview.previewHash,confirmed:true},'reverse-team-transfer');assert.equal(transferUndo.status,200,JSON.stringify(await transferUndo.clone().json()));
 const restoredOwnership=database.prepare('SELECT * FROM player_ownerships WHERE league_id=? AND player_id=?').get(scenario.leagueId,playerId);
 assert.equal(restoredOwnership.team_id,teamId);assert.notEqual(restoredOwnership.id,transferData.authoritative.id);assert.notEqual(restoredOwnership.id,ownershipId);
 assert.equal(database.prepare('SELECT current_team_id FROM contracts WHERE id=?').get(contractId).current_team_id,teamId);
 assert.deepEqual(database.pragma('foreign_key_check'),[]);assert.equal(database.pragma('integrity_check',{simple:true}),'ok');
});

test('guided preseason reset rehearses exact restoration and preserves other leagues and account records',async t=>{
 const core=require('../../src/operations/guidedLeagueReset');
 const database=createDatabase(t),runtime=createTargetRuntime(runtimeOptions(database)),scenario=seedComposedLeagueStartScenario(runtime);
 const authenticated=runtime.services.sessionService.resolveWithoutActivity(scenario.session.rawSessionToken);
 const started=runtime.services.league.start.start({leagueId:scenario.leagueId,input:{},expectedLeagueVersion:scenario.expectedLeagueVersion,idempotencyKey:'reset-core-original-start',authenticated});
 runtime.services.league.matchupSchedule.generate({leagueId:scenario.leagueId,seasonId:scenario.seasonId,expectedSeasonVersion:started.league.currentSeason.version,input:{
  nhlRegularSeasonStartsAtMs:Date.parse('2026-10-06T07:00:00Z'),nhlRegularSeasonEndsAtMs:Date.parse('2027-04-12T07:00:00Z'),
  fantasyPlayoffsStartAtMs:Date.parse('2027-03-15T07:00:00Z'),fantasyPlayoffsEndAtMs:Date.parse('2027-04-12T07:00:00Z'),firstWeekStartsAtMs:Date.parse('2026-10-12T07:00:00Z'),confirmed:true},idempotencyKey:'reset-core-original-schedule',authenticated});
 await runtime.services.league.freeAgentDraftReadinessJob.run();
 assert.equal(database.prepare('SELECT count(*) n FROM candidate_cards WHERE league_id=?').get(scenario.leagueId).n,4);
 assert.throws(()=>core.rehearse(database,scenario.leagueId,scenario.commissionerUserId,NOW_MS),/Pause the league/);
 const input={action:'pause',reason:'Review a preseason reset'},pause=runtime.services.league.leaguePause.preview({leagueId:scenario.leagueId,authenticated,input});
 runtime.services.league.leaguePause.apply({leagueId:scenario.leagueId,authenticated,input:{...input,confirmed:true,previewHash:pause.previewHash},idempotencyKey:'reset-core-pause'});
 assert.throws(()=>core.rehearse(database,scenario.leagueId,scenario.commissionerUserId,NOW_MS),/deliveries must finish/);
 database.prepare("UPDATE outbox_events SET status='published',published_at_ms=?,updated_at_ms=?,version=version+1 WHERE league_id=? AND status='pending'").run(NOW_MS,NOW_MS,scenario.leagueId);
 const other=uuid(981701),otherSeason=uuid(981702),otherTeam=uuid(981703);
 const insert=(table,row)=>{const columns=Object.keys(row);database.prepare('INSERT INTO '+table+' ('+columns.join(',')+') VALUES('+columns.map(()=>'?').join(',')+')').run(...columns.map(k=>row[k]));};
 const originalLeague=database.prepare('SELECT * FROM leagues WHERE id=?').get(scenario.leagueId);
 insert('leagues',{...originalLeague,id:other,name:'Untouched League',name_normalized:'untouched league',status:'setup',commissioner_membership_id:null,current_season_id:null});
 const originalSeason=database.prepare('SELECT * FROM seasons WHERE id=?').get(scenario.seasonId);insert('seasons',{...originalSeason,id:otherSeason,league_id:other});
 insert('teams',{...database.prepare('SELECT * FROM teams WHERE id=?').get(scenario.teamIds[0]),id:otherTeam,league_id:other});
 const beforeBytes=database.serialize(),snapshot=core.capture(database,scenario.leagueId),beforeHash=core.scopeHash(database,scenario.leagueId);
 const review=core.rehearse(database,scenario.leagueId,scenario.commissionerUserId,NOW_MS);assert.equal(review.recoveryVerified,true);assert.deepEqual(database.serialize(),beforeBytes);
 assert.equal(review.manifest.clear.find(g=>g.label==='Candidate Cards').count,4);
 const afterHash=database.transaction(()=>core.reset(database,scenario.leagueId,scenario.commissionerUserId,NOW_MS)).immediate();assert.equal(afterHash,review.afterHash);
 assert.equal(database.prepare('SELECT status FROM leagues WHERE id=?').get(scenario.leagueId).status,'setup');
 assert.equal(database.prepare('SELECT count(*) n FROM free_agent_drafts WHERE league_id=?').get(scenario.leagueId).n,0);
 assert.equal(database.prepare('SELECT regular_season_starts_at_ms FROM seasons WHERE id=?').get(scenario.seasonId).regular_season_starts_at_ms,null);
 assert.equal(database.prepare('SELECT trade_deadline_at_ms FROM league_settings WHERE league_id=?').get(scenario.leagueId).trade_deadline_at_ms,null);
 assert.equal(database.prepare('SELECT count(*) n FROM team_manager_assignments WHERE league_id=?').get(scenario.leagueId).n,4);
 const resetBytes=database.serialize();assert.equal(core.rehearseRestore(database,snapshot,afterHash).recoveryVerified,true);assert.deepEqual(database.serialize(),resetBytes);
 database.transaction(()=>core.restore(database,snapshot)).immediate();assert.equal(core.scopeHash(database,scenario.leagueId),beforeHash);
 assert.deepEqual(database.prepare('SELECT * FROM leagues WHERE id=?').get(scenario.leagueId),originalLeague);
 const afterSecond=database.transaction(()=>core.reset(database,scenario.leagueId,scenario.commissionerUserId,NOW_MS)).immediate();
 database.prepare('UPDATE teams SET name=?,name_normalized=?,version=version+1 WHERE id=?').run('Later Manager Work','later manager work',scenario.teamIds[0]);
 assert.throws(()=>core.rehearseRestore(database,snapshot,afterSecond),/changed after reset/);
 assert.deepEqual(database.pragma('foreign_key_check'),[]);assert.equal(database.pragma('integrity_check',{simple:true}),'ok');
});


test('guided reset HTTP keeps encrypted recovery, atomic rollback, scoped authority and durable retries',async t=>{
 const core=require('../../src/operations/guidedLeagueReset');
 const database=createDatabase(t),runtime=createTargetRuntime(runtimeOptions(database)),s=seedComposedLeagueStartScenario(runtime),authenticated=runtime.services.sessionService.resolveWithoutActivity(s.session.rawSessionToken);
 const started=runtime.services.league.start.start({leagueId:s.leagueId,input:{},expectedLeagueVersion:s.expectedLeagueVersion,idempotencyKey:'reset-http-start',authenticated});
 const dates={nhlRegularSeasonStartsAtMs:Date.parse('2026-10-06T07:00:00Z'),nhlRegularSeasonEndsAtMs:Date.parse('2027-04-12T07:00:00Z'),fantasyPlayoffsStartAtMs:Date.parse('2027-03-15T07:00:00Z'),fantasyPlayoffsEndAtMs:Date.parse('2027-04-12T07:00:00Z'),firstWeekStartsAtMs:Date.parse('2026-10-12T07:00:00Z'),confirmed:true};
 runtime.services.league.matchupSchedule.generate({leagueId:s.leagueId,seasonId:s.seasonId,expectedSeasonVersion:started.league.currentSeason.version,input:dates,idempotencyKey:'reset-http-calendar',authenticated});
 await runtime.services.league.freeAgentDraftReadinessJob.run();
 const pauseInput={action:'pause',reason:'Restart preseason with new settings'},pause=runtime.services.league.leaguePause.preview({leagueId:s.leagueId,authenticated,input:pauseInput});
 runtime.services.league.leaguePause.apply({leagueId:s.leagueId,authenticated,input:{...pauseInput,confirmed:true,previewHash:pause.previewHash},idempotencyKey:'reset-http-pause'});
 database.prepare("UPDATE outbox_events SET status='published',published_at_ms=?,updated_at_ms=?,version=version+1 WHERE league_id=? AND status='pending'").run(NOW_MS,NOW_MS,s.leagueId);
 const commissioner=runtime.services.sessionService.issueForUser({userId:s.commissionerUserId}),managerId=database.prepare('SELECT user_id FROM team_manager_assignments WHERE league_id=? AND user_id<>? LIMIT 1').get(s.leagueId,s.commissionerUserId).user_id,manager=runtime.services.sessionService.issueForUser({userId:managerId});
 const origin=await startRuntimeApp(t,runtime),base=origin+'/api/v1/leagues/'+s.leagueId+'/management/reset';
 const headers=session=>browserHeaders({Cookie:runtime.transport.sessionCookie.name+'='+session.rawSessionToken,'X-CSRF-Token':session.rawCsrfToken,'Content-Type':'application/json'}),ch=headers(commissioner),mh=headers(manager);
 const post=(suffix,body,key='reset-http-preview',h=ch)=>fetch(base+suffix,{method:'POST',headers:{...h,'Idempotency-Key':key},body:JSON.stringify(body)});
 const proposed={action:'reset',archiveId:null,reason:'Restart preseason with new settings'};
 assert.equal((await fetch(base,{headers:mh})).status,403);assert.equal((await post('/preview',proposed,'reset-denied',mh)).status,403);assert.equal((await post('/preview',proposed,'reset-csrf',{...ch,'X-CSRF-Token':'bad'})).status,403);
 const before=database.serialize(),original=core.capture(database,s.leagueId);
 const state=await fetch(base,{headers:ch});assert.equal(state.status,200);assert.equal((await state.json()).data.blockedReason,null);
 const review=await post('/preview',proposed);assert.equal(review.status,200,JSON.stringify(await review.clone().json()));const preview=(await review.json()).data;assert.equal(preview.recoveryVerified,true);assert.deepEqual(database.serialize(),before);assert.doesNotMatch(JSON.stringify(preview),/ciphertext|snapshot|actor_user_id|bidder/);
 const body={...proposed,confirmation:preview.confirmation,previewHash:preview.previewHash};
 assert.equal((await post('/apply',{...body,confirmation:'wrong'},'reset-wrong')).status,409);assert.deepEqual(database.serialize(),before);
 database.exec("CREATE TRIGGER fixture_reset_notice_failure BEFORE INSERT ON notifications WHEN NEW.event_type='league_preseason_reset' BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;");
 const rollback=database.serialize();const failed=await post('/apply',body,'reset-http-apply');assert.equal(failed.status,500,JSON.stringify(await failed.clone().json()));assert.deepEqual(database.serialize(),rollback);database.exec('DROP TRIGGER fixture_reset_notice_failure');
 const result=await post('/apply',body,'reset-http-apply');assert.equal(result.status,200,JSON.stringify(await result.clone().json()));const receipt=(await result.json()).data;
 assert.equal(database.prepare('SELECT status FROM leagues WHERE id=?').get(s.leagueId).status,'setup');
 const archive=database.prepare('SELECT * FROM league_reset_archives WHERE id=?').get(receipt.archiveId);assert.ok(archive.ciphertext.length>100);assert.doesNotMatch(archive.ciphertext,/candidate_cards|cards_open|commissioner/);
 const after=database.serialize();assert.equal((await(await post('/apply',body,'reset-http-apply')).json()).data.replayed,true);assert.deepEqual(database.serialize(),after);
 assert.equal((await post('/apply',{...body,reason:'Different purpose'},'reset-http-apply')).status,409);
 const read=await fetch(base,{headers:ch});assert.doesNotMatch(JSON.stringify(await read.json()),/ciphertext|authentication_tag|before_hash/);assert.deepEqual(database.serialize(),after);
 const restore={action:'restore',archiveId:receipt.archiveId,reason:'Restore the previous preseason for review'};
 assert.equal((await post('/preview',{...restore,archiveId:uuid(981802)})).status,404);
 const restoredPreview=await post('/preview',restore);assert.equal(restoredPreview.status,200,JSON.stringify(await restoredPreview.clone().json()));const recovery=(await restoredPreview.json()).data;assert.deepEqual(database.serialize(),after);
 const restoreBody={...restore,confirmation:recovery.confirmation,previewHash:recovery.previewHash};
 const restored=await post('/apply',restoreBody,'reset-http-restore');assert.equal(restored.status,200,JSON.stringify(await restored.clone().json()));
 const actual=core.capture(database,s.leagueId);assert.ok(actual.tables.leagues[0].version>original.tables.leagues[0].version);actual.tables.leagues[0].version=original.tables.leagues[0].version;assert.deepEqual(actual,original);
 const restoredBytes=database.serialize();assert.equal((await(await post('/apply',restoreBody,'reset-http-restore')).json()).data.replayed,true);assert.deepEqual(database.serialize(),restoredBytes);assert.equal((await post('/preview',restore)).status,409);
 const history=await fetch(origin+'/api/v1/leagues/'+s.leagueId+'/management/history?kind=preseason_reset',{headers:ch});assert.equal(history.status,200);assert.equal((await history.json()).data.changes.length,2);
 assert.throws(()=>database.exec('DELETE FROM league_reset_archives'),/immutable|retained/);assert.throws(()=>database.exec("UPDATE league_reset_actions SET reason='rewrite'"),/immutable|retained/);
 // Repeat a reset, then complete the real setup/start/calendar/readiness workflow.
 database.prepare("UPDATE outbox_events SET status='published',published_at_ms=?,updated_at_ms=?,version=version+1 WHERE league_id=? AND status='pending'").run(NOW_MS,NOW_MS,s.leagueId);
 const second=(await(await post('/preview',proposed)).json()).data,secondResult=await post('/apply',{...proposed,previewHash:second.previewHash,confirmation:second.confirmation},'reset-http-second');assert.equal(secondResult.status,200,JSON.stringify(await secondResult.clone().json()));
 const secondArchive=(await secondResult.json()).data.archiveId;
 const setupVersion=database.prepare('SELECT version FROM leagues WHERE id=?').get(s.leagueId).version;
 const deadlineSaved=await fetch(origin+'/api/v1/leagues/'+s.leagueId+'/setup/trade-deadline',{method:'PUT',headers:{...ch,'If-Match':'"'+setupVersion+'"','Idempotency-Key':'reset-new-trade-deadline'},body:JSON.stringify({tradeDeadlineAtMs:Date.parse('2027-03-01T00:00:00Z')})});
 assert.equal(deadlineSaved.status,200,JSON.stringify(await deadlineSaved.clone().json()));
 const current=database.prepare('SELECT version FROM leagues WHERE id=?').get(s.leagueId);
 const restarted=runtime.services.league.start.start({leagueId:s.leagueId,input:{},expectedLeagueVersion:current.version,idempotencyKey:'reset-http-new-start',authenticated});
 runtime.services.league.matchupSchedule.generate({leagueId:s.leagueId,seasonId:s.seasonId,expectedSeasonVersion:restarted.league.currentSeason.version,input:dates,idempotencyKey:'reset-http-new-calendar',authenticated});
 await runtime.services.league.freeAgentDraftReadinessJob.run();
 assert.equal(database.prepare('SELECT count(*) n FROM candidate_cards WHERE league_id=?').get(s.leagueId).n,4);assert.equal(database.prepare('SELECT count(*) n FROM free_agent_drafts WHERE league_id=?').get(s.leagueId).n,1);
 assert.equal((await post('/preview',{...restore,archiveId:secondArchive})).status,409);
 assert.deepEqual(database.pragma('foreign_key_check'),[]);assert.equal(database.pragma('integrity_check',{simple:true}),'ok');
});


test('new league FAD timing saves a zero cutoff and processes fifteen minute rounds through actual workers',async t=>{
 const database=createDatabase(t);let time=NOW_MS;
 const runtime=createTargetRuntime(runtimeOptions(database,{securityFoundations:createSecurityFoundations({env:securityEnv(),now:()=>time,loggerSink(){}})}));
 const s=seedComposedLeagueStartScenario(runtime),authenticated=runtime.services.sessionService.resolveWithoutActivity(s.session.rawSessionToken);
 const started=runtime.services.league.start.start({leagueId:s.leagueId,input:{},expectedLeagueVersion:s.expectedLeagueVersion,idempotencyKey:'creation-gap-start',authenticated});
 const candidateDeadlineAtMs=NOW_MS+4*86400000,rolloverTimesAtMs=Array.from({length:7},(_,i)=>candidateDeadlineAtMs+(i+1)*900000);
 const input={nhlRegularSeasonStartsAtMs:Date.parse('2026-10-06T07:00:00Z'),nhlRegularSeasonEndsAtMs:Date.parse('2027-04-12T07:00:00Z'),fantasyPlayoffsStartAtMs:Date.parse('2027-03-15T07:00:00Z'),fantasyPlayoffsEndAtMs:Date.parse('2027-04-12T07:00:00Z'),firstWeekStartsAtMs:Date.parse('2026-10-12T07:00:00Z'),draftTiming:{candidateDeadlineAtMs,rolloverTimesAtMs,auctionCreationCutoffMinutes:0},confirmed:true};
 runtime.services.league.matchupSchedule.generate({leagueId:s.leagueId,seasonId:s.seasonId,expectedSeasonVersion:started.league.currentSeason.version,input,idempotencyKey:'creation-gap-calendar',authenticated});
 const ready=await runtime.services.league.freeAgentDraftReadinessJob.run();
 assert.equal(ready.succeeded,1,JSON.stringify(ready));
 const draft=database.prepare('SELECT * FROM free_agent_drafts WHERE league_id=?').get(s.leagueId),scope={leagueId:s.leagueId,fadId:draft.id,authenticated};
 assert.equal(database.prepare('SELECT gap_ms FROM fad_auction_cutoff_settings WHERE id=?').get(draft.id).gap_ms,0);
 assert.deepEqual(database.prepare('SELECT creation_cutoff_at_ms cutoff,rolls_over_at_ms close FROM free_agent_draft_rollovers WHERE fad_id=? ORDER BY sequence').all(draft.id),rolloverTimesAtMs.map(at=>({cutoff:at,close:at})));
 time=candidateDeadlineAtMs-1;await runtime.services.league.freeAgentDraftDeadlineReminderJob.run();time++;
 assert.equal((await runtime.services.league.freeAgentDraftDeadlineJob.run()).held,1);
 const service=runtime.services.league.fadDeadlineControl,preview=service.preview({...scope,input:{reason:'Managers agreed to skip empty cards'}});
 service.proceed({...scope,input:{reason:preview.reason,previewHash:preview.previewHash,confirmed:true},idempotencyKey:'creation-gap-proceed'});
 const locked=await runtime.services.league.freeAgentDraftDeadlineJob.run();assert.equal(locked.succeeded,1,JSON.stringify(locked));
 const allocated=await runtime.services.league.freeAgentDraftAllocationLifecycleJob.run();assert.equal(allocated.enteredRapid,1,JSON.stringify(allocated));
 const timing=runtime.services.league.fadTiming,change={deadlineAtMs:candidateDeadlineAtMs,rolloverTimesAtMs:rolloverTimesAtMs.map((at,i)=>i===0?at+60000:at),reason:'Adjust short first round'};
 const reviewed=timing.preview({...scope,input:change});timing.apply({...scope,input:{...change,confirmed:true,previewHash:reviewed.previewHash},idempotencyKey:'creation-gap-timing'});
 time=rolloverTimesAtMs[0];assert.equal((await runtime.services.league.freeAgentDraftRolloverJob.run()).due,0);time+=60000;
 const rolled=await runtime.services.league.freeAgentDraftRolloverJob.run();assert.equal(rolled.succeeded,1,JSON.stringify(rolled));
 assert.deepEqual(database.pragma('foreign_key_check'),[]);assert.equal(database.pragma('integrity_check',{simple:true}),'ok');
});


test('calendar recovery moves an unattempted overdue Week 1 lock and its actual worker runs only at the new clock',async t=>{
 const database=createDatabase(t),scope=seedComposedMatchupOccurrenceScope(database,981900);let time=NOW_MS;
 const originalGuard=database.prepare("SELECT sql FROM sqlite_schema WHERE name='free_agent_drafts_forward_update'").get().sql;database.exec('DROP TRIGGER free_agent_drafts_forward_update');completeComposedMatchupOccurrenceFad(database,scope);database.exec(originalGuard);
 const runtime=createTargetRuntime(runtimeOptions(database,{securityFoundations:createSecurityFoundations({env:securityEnv(),now:()=>time,loggerSink(){}})}));
 scheduleComposedBaselineOccurrence(runtime,scope);assert.equal((await runtime.services.league.matchupOccurrenceJob.run()).succeeded,1);
 const jobType='matchup:lock',runId=uuid(981930),bindingId=uuid(981931);
 runtime.repositories.matchupJobs.schedule({runId,bindingId,leagueId:scope.leagueId,seasonId:scope.seasonId,jobType,occurrenceKey:buildMatchupOccurrenceKey({jobType,leagueId:scope.leagueId,seasonId:scope.seasonId,weekId:scope.weekId,scheduleOperationId:scope.scheduleOperationId,scheduleVersion:1,scheduledForMs:scope.locksAtMs}),weekId:scope.weekId,scheduleOperationId:scope.scheduleOperationId,scheduleVersion:1,owningMatchupId:null,scheduledForMs:scope.locksAtMs,nowMs:5});
 const service=require('../../src/application/services/leagues/createLeagueCalendarService').createLeagueCalendarService({repository:runtime.repositories.leagueCalendar,leagueAuthorization:{requireCommissioner:()=>({actorUserId:scope.userId,authority:'commissioner'})},clock:{nowMs:()=>time}});
 const current=service.read({leagueId:scope.leagueId}),input={calendar:{regularSeasonStartsAtMs:scope.startsAtMs,regularSeasonEndsAtMs:scope.endsAtMs+30*86400000,fantasyPlayoffsStartAtMs:scope.endsAtMs+86400000,fantasyPlayoffsEndAtMs:scope.endsAtMs+29*86400000},weeks:current.weeks.map(w=>({...w,locksAtMs:scope.locksAtMs+7200000})),reason:'Recover missed unattempted Week 1 roster lock'};
 time=scope.locksAtMs-1;const early=service.preview({leagueId:scope.leagueId,input});assert.equal(early.recoversUnprocessedLock,false);
 time=scope.locksAtMs+1;assert.throws(()=>service.apply({leagueId:scope.leagueId,input:{...input,confirmed:true,previewHash:early.previewHash},idempotencyKey:'calendar-recovery-stale'}),{code:'LEAGUE_CALENDAR_PREVIEW_CHANGED'});
 const before=database.serialize(),preview=service.preview({leagueId:scope.leagueId,input});assert.equal(preview.recoversUnprocessedLock,true);assert.equal(preview.pendingJobs,1);assert.deepEqual(database.serialize(),before);
 service.apply({leagueId:scope.leagueId,input:{...input,confirmed:true,previewHash:preview.previewHash},idempotencyKey:'calendar-lock-recovery'});
 assert.equal((await runtime.services.league.matchupOccurrenceJob.run()).due,0);time=scope.locksAtMs+7200000;
 const ran=await runtime.services.league.matchupOccurrenceJob.run();assert.equal(ran.succeeded,1,JSON.stringify({ran,job:database.prepare('SELECT * FROM job_runs WHERE id=?').get(runId)}));assert.equal((await runtime.services.league.matchupOccurrenceJob.run()).due,0);
 assert.equal(database.prepare('SELECT status FROM job_runs WHERE id=?').get(runId).status,'succeeded');assert.deepEqual(database.pragma('foreign_key_check'),[]);
});

test('Week 1 website preview stays read-only and confirms only the reviewed pre-card schedule through HTTP',async t=>{
 const database=createDatabase(t),runtime=createTargetRuntime(runtimeOptions(database)),scenario=seedComposedLeagueStartScenario(runtime);
 const authenticated=runtime.services.sessionService.resolveWithoutActivity(scenario.session.rawSessionToken);
 const started=runtime.services.league.start.start({leagueId:scenario.leagueId,input:{},expectedLeagueVersion:scenario.expectedLeagueVersion,idempotencyKey:'week-shift-start',authenticated});
 const defaults=require('../../src/domain/matchups/matchupSchedulePolicy').defaultSeasonCalendar('20262027','America/Vancouver');
 runtime.services.league.matchupSchedule.generate({leagueId:scenario.leagueId,seasonId:scenario.seasonId,expectedSeasonVersion:started.league.currentSeason.version,
  input:{nhlRegularSeasonStartsAtMs:defaults.nhlRegularSeasonStartsAtMs,nhlRegularSeasonEndsAtMs:defaults.nhlRegularSeasonEndsAtMs,
   fantasyPlayoffsStartAtMs:defaults.fantasyPlayoffsStartAtMs,fantasyPlayoffsEndAtMs:defaults.fantasyPlayoffsEndAtMs,
   firstWeekStartsAtMs:defaults.firstWeekStartsAtMs,draftTiming:{candidateDeadlineAtMs:defaults.firstWeekStartsAtMs-7*86400000,
    rolloverTimesAtMs:Array.from({length:7},(_,i)=>defaults.firstWeekStartsAtMs-(6-i)*86400000)},confirmed:true},idempotencyKey:'week-shift-schedule',authenticated});
 const week=database.prepare('SELECT * FROM matchup_weeks WHERE league_id=? ORDER BY sequence').all(scenario.leagueId)[0];
 const origin=await startRuntimeApp(t,runtime),url=origin+'/api/v1/leagues/'+scenario.leagueId+'/seasons/'+scenario.seasonId+'/matchup-weeks/'+week.id;
 const headers=browserHeaders({Cookie:runtime.transport.sessionCookie.name+'='+scenario.session.rawSessionToken,'X-CSRF-Token':scenario.session.rawCsrfToken});
 const body={action:'preview_shift_week_one',firstWeekStartsAtMs:Date.parse('2026-09-30T07:00:00Z')};
 const patch=(value,extra={})=>fetch(url,{method:'PATCH',headers:{...headers,...extra},body:JSON.stringify(value)});
 const before=database.serialize();
 assert.equal((await patch(body,{'X-CSRF-Token':'bad'})).status,403);
 const managerId=database.prepare("SELECT user_id FROM team_manager_assignments WHERE league_id=? AND user_id<>? AND status='accepted' LIMIT 1").get(scenario.leagueId,scenario.commissionerUserId).user_id;
 const manager=runtime.services.sessionService.issueForUser({userId:managerId});
 assert.equal((await patch(body,{Cookie:runtime.transport.sessionCookie.name+'='+manager.rawSessionToken,'X-CSRF-Token':manager.rawCsrfToken})).status,403);
 const beforeReview=database.serialize(),review=await patch(body);assert.equal(review.status,200,JSON.stringify(await review.clone().json()));
 const preview=(await review.json()).data;assert.equal(preview.code,'MATCHUP_WEEK_ONE_SHIFT_PREVIEWED');assert.equal(preview.expectedWeekVersion,week.version);
 assert.equal(preview.weeks[0].startsAtMs,body.firstWeekStartsAtMs);assert.equal(preview.weeks.length,preview.shiftedWeekCount);
 assert.deepEqual(database.serialize(),beforeReview);
 const command={action:'shift_week_one',firstWeekStartsAtMs:body.firstWeekStartsAtMs,confirmation:'CHANGE WEEK 1 START',previewHash:preview.previewHash};
 const applyHeaders={'If-Match':'"'+week.version+'"','Idempotency-Key':'week-shift-confirm'};
 database.prepare('UPDATE matchup_weeks SET version=version+1 WHERE league_id=? AND sequence=2').run(scenario.leagueId);
 assert.equal((await patch(command,applyHeaders)).status,412);
 const fresh=await patch(body);assert.equal(fresh.status,200,JSON.stringify(await fresh.clone().json()));command.previewHash=(await fresh.json()).data.previewHash;
 const applied=await patch(command,applyHeaders);assert.equal(applied.status,200,JSON.stringify(await applied.clone().json()));
 const result=(await applied.json()).data;assert.equal(result.firstWeekStartsAtMs,body.firstWeekStartsAtMs);assert.equal(result.weekVersion,week.version+1);
 const saved=database.serialize(),replayed=await patch(command,applyHeaders);assert.equal(replayed.status,200);assert.deepEqual((await replayed.json()).data,result);assert.deepEqual(database.serialize(),saved);
 assert.equal(database.prepare('SELECT COUNT(*) n FROM free_agent_drafts').get().n,0);
 const shiftedReadiness=await runtime.services.league.freeAgentDraftReadinessJob.run();
 assert.equal(shiftedReadiness.succeeded,1,JSON.stringify(shiftedReadiness));
 const draft=database.prepare('SELECT * FROM free_agent_drafts WHERE league_id=?').get(scenario.leagueId);
 assert.equal(draft.first_matchup_starts_at_ms,body.firstWeekStartsAtMs);
 const protectedPreview=await patch({...body,firstWeekStartsAtMs:week.starts_at_ms});
 assert.equal(protectedPreview.status,409);assert.equal((await protectedPreview.json()).error.code,'FAD_WEEK_ONE_FROZEN');
 const afterOpening=database.serialize();assert.equal((await patch(command,applyHeaders)).status,200);assert.deepEqual(database.serialize(),afterOpening);
 assert.deepEqual(database.pragma('foreign_key_check'),[]);assert.equal(database.pragma('integrity_check',{simple:true}),'ok');
 assert.ok(before.length>0);
});
