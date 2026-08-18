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
  { teamCount = 4 } = {}
) {
  const repositories = runtime.repositories.context.repositories;
  const commissionerUserId = uuid(91_001);
  const commissionerMembershipId = uuid(91_002);
  const leagueId = uuid(91_003);
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
      primary_colour: "#102030",
      secondary_colour: "#f0a020",
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
  test("declares 118 unique method/path contracts across the exact router set", () => {
    assert.equal(TARGET_ENDPOINTS.length, 118);
    assert.equal(
      new Set(TARGET_ENDPOINTS.map(({ method, path }) => `${method} ${path}`))
        .size,
      118
    );
    assert.deepEqual(TARGET_ROUTER_KEYS, [
      "accountProfile",
      "accountRegistration",
      "accountSession",
      "activityNotification",
      "auction",
      "candidateCard",
      "commissionerAssignment",
      "commissionerCorrection",
      "entryDraft",
      "freeAgentDraft",
      "leagueInvitation",
      "leagueLifecycle",
      "leagueMembership",
      "leagueRead",
      "matchup",
      "platformAdministration",
      "player",
      "publicRoster",
      "rosterAction",
      "standingsFinalization",
      "team",
      "teamManagerAssignment",
      "teamProfile",
      "trade",
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

  test("fails closed for all 20 dedicated FAD routes and preflights while preserving shared auction routes", async (t) => {
    const fadEndpoints = TARGET_ENDPOINTS.filter(({ routerKey }) =>
      ["candidateCard", "freeAgentDraft"].includes(routerKey)
    );
    const auctionEndpoints = TARGET_ENDPOINTS.filter(
      ({ routerKey }) => routerKey === "auction"
    );
    assert.equal(fadEndpoints.length, 20);
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
  test("constructs every repository, service, router, and socket boundary without writes or listening", (t) => {
    const database = createDatabase(t);
    const before = database.serialize();
    const options = runtimeOptions(database);
    const runtime = createTargetRuntime(options);
    assert.equal(runtime.migrationState.status, "exact");
    assert.equal(runtime.migrationState.userVersion, 52);
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
    assert.equal(TARGET_ENDPOINTS.length, 118);
  });

  test("runs FAD readiness through the composed target runtime and opens every Candidate Card atomically", async (t) => {
    const database = createDatabase(t);
    const runtime = createTargetRuntime(runtimeOptions(database));
    const scenario = seedComposedLeagueStartScenario(runtime);
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

    const summary = await runtime.services.league
      .freeAgentDraftReadinessJob.run();
    assert.equal(summary.status, "succeeded");
    assert.equal(summary.due, 1);
    assert.equal(summary.acquired, 1);
    assert.equal(summary.succeeded, 1);
    assert.equal(summary.blocked, 0);
    assert.equal(summary.failed, 0);
    assert.equal(summary.skipped, 0);

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

  test("runs the composed reminder and zero-candidate deadline publication at their exact clocks", async (t) => {
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
        query: {},
      });
    assert.equal(publishedResults.data.length, 1);
    assert.equal(
      publishedResults.data[0].status,
      "automatic_award"
    );
    assert.equal(
      publishedResults.data[0].winner.teamId,
      scenario.teamIds[0]
    );
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
