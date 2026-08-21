const assert = require("node:assert/strict");
const express = require("express");
const { describe, test } = require("node:test");

const {
  createMatchupIntegrationService,
} = require("../../src/application/services/matchups/createMatchupIntegrationService");
const {
  createMatchupScheduleService,
} = require("../../src/application/services/matchups/createMatchupScheduleService");
const {
  MATCHUP_SCHEDULE_COMMAND_OPERATION,
  MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_OPERATION,
  hashMatchupScheduleCommandRequest,
  hashMatchupScheduleShiftWeekOneRequest,
} = require("../../src/domain/matchups/matchupScheduleCommandPolicy");
const {
  createMatchupRouter,
  optionalIfMatch,
} = require("../../src/transport/http/createMatchupRouter");

const LEAGUE_ID = "00000000-0000-4000-8000-000000000001";
const SEASON_ID = "00000000-0000-4000-8000-000000000002";
const WEEK_ID = "00000000-0000-4000-8000-000000000003";
const MATCHUP_ID = "00000000-0000-4000-8000-000000000004";
const RESULT_ID = "00000000-0000-4000-8000-000000000005";
const HOME_ID = "00000000-0000-4000-8000-000000000006";
const AWAY_ID = "00000000-0000-4000-8000-000000000007";
const OPERATION_ID = "00000000-0000-4000-8000-000000000008";
const COMMAND_ACTOR_ID =
  "00000000-0000-4000-8000-000000000009";
const COMMAND_MEMBERSHIP_ID =
  "00000000-0000-4000-8000-000000000010";
const COMMAND_IDEMPOTENCY_ID =
  "00000000-0000-4000-8000-000000000011";
const COMMAND_RESULT_ID =
  "00000000-0000-4000-8000-000000000012";
const NOW_MS = 10_000;
const NHL_REGULAR_SEASON_STARTS_AT_MS =
  Date.parse("2026-10-06T07:00:00.000Z");
const NHL_REGULAR_SEASON_ENDS_AT_MS =
  Date.parse("2027-04-12T07:00:00.000Z");
const FANTASY_PLAYOFFS_START_AT_MS =
  Date.parse("2027-03-15T07:00:00.000Z");
const FANTASY_PLAYOFFS_END_AT_MS =
  NHL_REGULAR_SEASON_ENDS_AT_MS;
const FIRST_WEEK_STARTS_AT_MS =
  Date.parse("2026-10-12T07:00:00.000Z");
const LAST_WEEK_ENDS_AT_MS =
  FANTASY_PLAYOFFS_START_AT_MS;
const AUDIT_CONTEXT = Object.freeze({
  clientMetadataJson:
    '{"networkSourceCategory":"unknown","origin":"https://app.example.test"}',
  networkKeyVersion: 1,
  networkMetadataDigest: "a".repeat(64),
  requestCorrelationId:
    "matchup-result-correction-request",
});

function matchupScheduleInput(
  confirmed = false,
  overrides = {}
) {
  return {
    nhlRegularSeasonStartsAtMs:
      NHL_REGULAR_SEASON_STARTS_AT_MS,
    nhlRegularSeasonEndsAtMs:
      NHL_REGULAR_SEASON_ENDS_AT_MS,
    fantasyPlayoffsStartAtMs:
      FANTASY_PLAYOFFS_START_AT_MS,
    fantasyPlayoffsEndAtMs:
      FANTASY_PLAYOFFS_END_AT_MS,
    firstWeekStartsAtMs: FIRST_WEEK_STARTS_AT_MS,
    confirmed,
    ...overrides,
  };
}

function matchupScheduleResult() {
  return {
    operationId: OPERATION_ID,
    seasonId: SEASON_ID,
    seasonVersion: 4,
    nhlRegularSeasonStartsAtMs:
      NHL_REGULAR_SEASON_STARTS_AT_MS,
    nhlRegularSeasonEndsAtMs:
      NHL_REGULAR_SEASON_ENDS_AT_MS,
    fantasyPlayoffsStartAtMs:
      FANTASY_PLAYOFFS_START_AT_MS,
    fantasyPlayoffsEndAtMs:
      FANTASY_PLAYOFFS_END_AT_MS,
    calendarPersisted: true,
    firstWeekId: WEEK_ID,
    firstWeekStartsAtMs:
      FIRST_WEEK_STARTS_AT_MS,
    participantCount: 2,
    weekCount: 1,
    matchupCount: 1,
    byeCount: 0,
    lastWeekEndsAtMs: LAST_WEEK_ENDS_AT_MS,
  };
}

function matchupShiftInput(overrides = {}) {
  return {
    action: "shift_week_one",
    confirmation: "CHANGE WEEK 1 START",
    firstWeekStartsAtMs:
      FIRST_WEEK_STARTS_AT_MS +
      7 * 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

function matchupShiftResult() {
  return {
    operationId: OPERATION_ID,
    seasonId: SEASON_ID,
    seasonVersion: 4,
    weekId: WEEK_ID,
    weekVersion: 5,
    previousFirstWeekStartsAtMs:
      FIRST_WEEK_STARTS_AT_MS,
    firstWeekStartsAtMs:
      matchupShiftInput()
        .firstWeekStartsAtMs,
    lastWeekEndsAtMs:
      LAST_WEEK_ENDS_AT_MS,
    shiftedWeekCount: 21,
    replacedJobOccurrenceCount: 126,
  };
}

function rawWeek() {
  return {
    id: WEEK_ID,
    league_id: LEAGUE_ID,
    season_id: SEASON_ID,
    week_key: "2026-W01",
    sequence: 1,
    starts_at_ms: 1_000,
    baseline_at_ms: 2_000,
    locks_at_ms: 3_000,
    ends_at_ms: 20_000,
    rolls_over_at_ms: 21_000,
    status: "scheduled",
    version: 4,
  };
}

function rawMatchup() {
  return {
    id: MATCHUP_ID,
    league_id: LEAGUE_ID,
    season_id: SEASON_ID,
    matchup_week_id: WEEK_ID,
    home_team_id: HOME_ID,
    away_team_id: AWAY_ID,
    home_team_name: "Home",
    away_team_name: "Away",
    status: "scheduled",
    version: 2,
    week_key: "2026-W01",
    sequence: 1,
    starts_at_ms: 1_000,
    locks_at_ms: 3_000,
    ends_at_ms: 20_000,
    week_status: "scheduled",
    week_version: 4,
  };
}

function integrationFixture({
  matchupRow = rawMatchup(),
  matchupResult = null,
  finalScore = null,
  liveScore = null,
  commissionerAuthority = {
    actorUserId: "commissioner",
    authority: "commissioner",
  },
  scheduleServiceOverride = null,
} = {}) {
  const calls = [];
  const authority = {
    requireActiveMembership(authenticated, leagueId) {
      calls.push({ method: "member", authenticated, leagueId });
      return { actorUserId: "member" };
    },
    requireCommissioner(authenticated, leagueId) {
      calls.push({ method: "commissioner", authenticated, leagueId });
      return commissionerAuthority;
    },
  };
  const schedule = {
    season: { id: SEASON_ID, nhl_season_key: "20262027", version: 3 },
    health: {
      latest: { status: "succeeded", started_at_ms: 8_000, completed_at_ms: 9_000 },
      latestSuccessful: { status: "succeeded", completed_at_ms: 9_000 },
    },
    weeks: [rawWeek()],
    matchups: [matchupRow],
    byes: [],
  };
  const readRepository = {
    readSchedule(input) {
      calls.push({ method: "readSchedule", input });
      return schedule;
    },
    readWeek(input) {
      calls.push({ method: "readWeek", input });
      return { week: rawWeek(), matchups: [matchupRow], byes: [] };
    },
    readMatchup(input) {
      calls.push({ method: "readMatchup", input });
      return { matchup: matchupRow, result: matchupResult };
    },
    readResultScope(input) {
      calls.push({ method: "readResultScope", input });
      return {
        result_id: RESULT_ID,
        result_version: 3,
        week_id: WEEK_ID,
        matchup_id: MATCHUP_ID,
        week_sequence: 1,
        week_starts_at_ms: 1_000,
        week_ends_at_ms: 20_000,
        home_team_id: HOME_ID,
        away_team_id: AWAY_ID,
        home_team_name: "Home",
        away_team_name: "Away",
        result_version_id: OPERATION_ID,
        version_number: 3,
        home_score_hundredths: 450,
        away_score_hundredths: 375,
        outcome: "home_win",
      };
    },
  };
  const scheduleService = scheduleServiceOverride || {
    preview(input) {
      calls.push({ method: "schedulePreview", input });
      return {
        calendarWillBePersisted: true,
        context: {
          season_id: SEASON_ID,
          season_version: 3,
        },
        plan: {
          teamIds: [HOME_ID, AWAY_ID],
          nhlRegularSeasonStartsAtMs:
            NHL_REGULAR_SEASON_STARTS_AT_MS,
          nhlRegularSeasonEndsAtMs:
            NHL_REGULAR_SEASON_ENDS_AT_MS,
          fantasyPlayoffsStartAtMs:
            FANTASY_PLAYOFFS_START_AT_MS,
          fantasyPlayoffsEndAtMs:
            FANTASY_PLAYOFFS_END_AT_MS,
          firstWeekStartsAtMs:
            FIRST_WEEK_STARTS_AT_MS,
          weeks: [
            {
              pairs: [{
                homeTeamId: HOME_ID,
                awayTeamId: AWAY_ID,
              }],
              byeTeamId: null,
              endsAtMs: LAST_WEEK_ENDS_AT_MS,
            },
          ],
        },
      };
    },
    generate(input) {
      calls.push({ method: "scheduleGenerate", input });
      return matchupScheduleResult();
    },
    shiftWeekOne(input) {
      calls.push({
        method: "scheduleShiftWeekOne",
        input,
      });
      return matchupShiftResult();
    },
  };
  const weekService = {
    advance(input) {
      calls.push({ method: "weekAdvance", input });
      return { week: { status: "baseline_ready" } };
    },
  };
  const scoringService = {
    readAtRefresh(input) {
      calls.push({ method: "finalScore", input });
      if (finalScore) return finalScore;
      throw new Error("scheduled matchups do not score");
    },
    readLive(input) {
      calls.push({ method: "score", input });
      if (liveScore) return liveScore;
      throw new Error("scheduled matchups do not score");
    },
  };
  const resultCorrectionService = {
    correct(input) {
      calls.push({ method: "correct", input });
      return {
        code: "MATCHUP_RESULT_CORRECTED",
        result: {
          resultId: RESULT_ID,
          resultVersionId: OPERATION_ID,
          resultVersionNumber: 4,
          resultVersion: 4,
          leagueId: LEAGUE_ID,
          seasonId: SEASON_ID,
          weekId: WEEK_ID,
          matchupId: MATCHUP_ID,
          correctedAtMs: NOW_MS,
          standingsReplacement: null,
        },
      };
    },
  };
  const standingsService = {
    read(input) {
      calls.push({ method: "standings", input });
      return {
        leagueId: LEAGUE_ID,
        seasonId: SEASON_ID,
        finalizedResultCount: 0,
        sourceResultVersion: 0,
        rows: [],
      };
    },
    previewCorrection(input) {
      calls.push({ method: "standingsCorrectionPreview", input });
      return {
        currentRows: [
          {
            teamId: AWAY_ID,
            teamDisplayName: "Away",
            rank: 1,
            standingsPoints: 2,
          },
        ],
        projectedRows: [
          {
            teamId: HOME_ID,
            teamDisplayName: "Home",
            rank: 1,
            standingsPoints: 2,
          },
        ],
        changedTeamIds: [HOME_ID, AWAY_ID],
      };
    },
  };
  const recoveryService = {
    previewStandings(input) {
      calls.push({ method: "standingsPreview", input });
      return {
        currentSnapshotId: null,
        expectedVersion: 1,
        nextSnapshotVersion: 1,
        projection: { rows: [] },
      };
    },
    rebuildStandings(input) {
      calls.push({ method: "standingsRebuild", input });
      return { rebuilt: true };
    },
  };
  const service = createMatchupIntegrationService({
    leagueAuthorization: authority,
    readRepository,
    scheduleService,
    weekService,
    scoringService,
    resultCorrectionService,
    standingsService,
    recoveryService,
    clock: { nowMs: () => NOW_MS },
    createId: () => OPERATION_ID,
  });
  return { calls, service };
}

function actualConfirmedScheduleFixture(
  mode = "replay"
) {
  const calls = [];
  const requestHash =
    hashMatchupScheduleCommandRequest({
      leagueId: LEAGUE_ID,
      seasonId: SEASON_ID,
      expectedSeasonVersion: 3,
      input: matchupScheduleInput(true),
    });
  const scheduleService =
    createMatchupScheduleService({
      repositoryContext: {
        transaction(action) {
          calls.push("transaction");
          return action();
        },
      },
      leagueAuthorization: {
        requireCommissioner() {
          calls.push("authorize");
          if (mode === "denied") {
            const error = new Error(
              "private authority detail"
            );
            error.code =
              "LEAGUE_COMMISSIONER_REQUIRED";
            throw error;
          }
          return {
            actorUserId: COMMAND_ACTOR_ID,
            membershipId:
              COMMAND_MEMBERSHIP_ID,
            authority: "commissioner",
            leagueId: LEAGUE_ID,
          };
        },
      },
      repository: {
        findIdempotency() {
          calls.push("findIdempotency");
          if (
            mode !== "replay" &&
            mode !== "incomplete"
          ) {
            return null;
          }
          return {
            id: COMMAND_IDEMPOTENCY_ID,
            leagueId: LEAGUE_ID,
            actorUserId: COMMAND_ACTOR_ID,
            operation:
              MATCHUP_SCHEDULE_COMMAND_OPERATION,
            clientKey:
              "opaque-http-schedule-key",
            requestHash,
            status:
              mode === "replay"
                ? "completed"
                : "started",
            resultType:
              mode === "replay"
                ? "matchup_schedule_command"
                : null,
            resultId:
              mode === "replay"
                ? COMMAND_RESULT_ID
                : null,
            createdAtMs: NOW_MS,
            completedAtMs:
              mode === "replay" ? NOW_MS : null,
            expiresAtMs: NOW_MS + 1,
          };
        },
        findCommandResult() {
          calls.push("findCommandResult");
          return {
            id: COMMAND_RESULT_ID,
            leagueId: LEAGUE_ID,
            seasonId: SEASON_ID,
            action: "generate",
            idempotencyRequestId:
              COMMAND_IDEMPOTENCY_ID,
            idempotencyOperation:
              MATCHUP_SCHEDULE_COMMAND_OPERATION,
            requestSha256: requestHash,
            matchupOperationId: OPERATION_ID,
            actorUserId: COMMAND_ACTOR_ID,
            actorMembershipId:
              COMMAND_MEMBERSHIP_ID,
            actorAuthority: "commissioner",
            oldScheduleOperationId: null,
            oldScheduleVersion: null,
            newScheduleOperationId:
              OPERATION_ID,
            newScheduleVersion: 1,
            seasonVersionBefore: 3,
            seasonVersionAfter: 4,
            weekOneMatchupWeekId: WEEK_ID,
            weekVersionBefore: null,
            weekVersionAfter: 1,
            previousFirstWeekStartsAtMs:
              null,
            firstWeekStartsAtMs:
              FIRST_WEEK_STARTS_AT_MS,
            lastWeekEndsAtMs:
              LAST_WEEK_ENDS_AT_MS,
            nhlRegularSeasonStartsAtMs:
              NHL_REGULAR_SEASON_STARTS_AT_MS,
            nhlRegularSeasonEndsAtMs:
              NHL_REGULAR_SEASON_ENDS_AT_MS,
            fantasyPlayoffsStartAtMs:
              FANTASY_PLAYOFFS_START_AT_MS,
            fantasyPlayoffsEndAtMs:
              FANTASY_PLAYOFFS_END_AT_MS,
            calendarPersisted: 1,
            participantCount: 2,
            weekCount: 1,
            matchupCount: 1,
            byeCount: 0,
            shiftedWeekCount: null,
            replacedJobOccurrenceCount: null,
            responseHttpStatus: 201,
            responseCode:
              "MATCHUP_SCHEDULE_GENERATED",
            resultSchemaVersion: 1,
            createdAtMs: NOW_MS,
            version: 1,
          };
        },
        readContext() {
          calls.push("readContext");
          if (mode === "missing") return null;
          return {
            league_id: LEAGUE_ID,
            timezone: "America/Vancouver",
            commissioner_membership_id:
              COMMAND_MEMBERSHIP_ID,
            season_id: SEASON_ID,
            season_status: "planned",
            season_version:
              mode === "stale" ? 4 : 3,
            nhl_season_key: "20262027",
            regular_season_starts_at_ms:
              NHL_REGULAR_SEASON_STARTS_AT_MS,
            regular_season_ends_at_ms:
              NHL_REGULAR_SEASON_ENDS_AT_MS,
            fantasy_playoffs_start_at_ms:
              FANTASY_PLAYOFFS_START_AT_MS,
            fantasy_playoffs_end_at_ms:
              FANTASY_PLAYOFFS_END_AT_MS,
            scoring_rule_version: 1,
            commissioner_user_id:
              COMMAND_ACTOR_ID,
            teams: [
              {
                id: HOME_ID,
                name: "Home",
                primary_colour: null,
                secondary_colour: null,
                logo_reference: null,
                version: 1,
              },
              {
                id: AWAY_ID,
                name: "Away",
                primary_colour: null,
                secondary_colour: null,
                logo_reference: null,
                version: 1,
              },
            ],
            existingWeekCount: 0,
            existingGenerationCount: 0,
          };
        },
        applyConfirmedSchedulePlan() {
          throw new Error(
            "The HTTP error fixture must not persist."
          );
        },
        readShiftContext() {
          throw new Error(
            "The confirmed-schedule fixture must not read shift context."
          );
        },
        applyWeekOneShiftPlan() {
          throw new Error(
            "The confirmed-schedule fixture must not shift Week 1."
          );
        },
      },
      clock: {
        nowMs() {
          calls.push("clock");
          return NOW_MS;
        },
      },
      secureRandom: {
        id() {
          throw new Error(
            "The HTTP error fixture must not allocate identifiers."
          );
        },
      },
    });
  return {
    calls,
    service: integrationFixture({
      scheduleServiceOverride: scheduleService,
    }).service,
  };
}

function actualShiftFixture(
  mode = "replay"
) {
  const calls = [];
  const input = matchupShiftInput();
  const requestHash =
    hashMatchupScheduleShiftWeekOneRequest({
      leagueId: LEAGUE_ID,
      seasonId: SEASON_ID,
      weekId: WEEK_ID,
      expectedWeekVersion: 4,
      input,
    });
  const scheduleService =
    createMatchupScheduleService({
      repositoryContext: {
        transaction(action) {
          calls.push("transaction");
          return action();
        },
      },
      leagueAuthorization: {
        requireCommissioner() {
          calls.push("authorize");
          if (mode === "denied") {
            const error = new Error(
              "private shift authority detail"
            );
            error.code =
              "LEAGUE_COMMISSIONER_REQUIRED";
            throw error;
          }
          return {
            actorUserId: COMMAND_ACTOR_ID,
            membershipId:
              COMMAND_MEMBERSHIP_ID,
            authority: "commissioner",
            leagueId: LEAGUE_ID,
          };
        },
      },
      repository: {
        findIdempotency() {
          calls.push("findIdempotency");
          if (
            mode !== "replay" &&
            mode !== "incomplete"
          ) {
            return null;
          }
          return {
            id: COMMAND_IDEMPOTENCY_ID,
            leagueId: LEAGUE_ID,
            actorUserId: COMMAND_ACTOR_ID,
            operation:
              MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_OPERATION,
            clientKey:
              "opaque-http-shift-key",
            requestHash,
            status:
              mode === "replay"
                ? "completed"
                : "started",
            resultType:
              mode === "replay"
                ? "matchup_schedule_command"
                : null,
            resultId:
              mode === "replay"
                ? COMMAND_RESULT_ID
                : null,
            createdAtMs: NOW_MS,
            completedAtMs:
              mode === "replay"
                ? NOW_MS
                : null,
            expiresAtMs: NOW_MS + 1,
          };
        },
        findCommandResult() {
          calls.push("findCommandResult");
          return {
            id: COMMAND_RESULT_ID,
            leagueId: LEAGUE_ID,
            seasonId: SEASON_ID,
            action: "shift_week_one",
            idempotencyRequestId:
              COMMAND_IDEMPOTENCY_ID,
            idempotencyOperation:
              MATCHUP_SCHEDULE_SHIFT_WEEK_ONE_OPERATION,
            requestSha256: requestHash,
            matchupOperationId:
              OPERATION_ID,
            actorUserId: COMMAND_ACTOR_ID,
            actorMembershipId:
              COMMAND_MEMBERSHIP_ID,
            actorAuthority: "commissioner",
            oldScheduleOperationId:
              RESULT_ID,
            oldScheduleVersion: 1,
            newScheduleOperationId:
              OPERATION_ID,
            newScheduleVersion: 2,
            seasonVersionBefore: 3,
            seasonVersionAfter: 4,
            weekOneMatchupWeekId:
              WEEK_ID,
            weekVersionBefore: 4,
            weekVersionAfter: 5,
            previousFirstWeekStartsAtMs:
              FIRST_WEEK_STARTS_AT_MS,
            firstWeekStartsAtMs:
              input.firstWeekStartsAtMs,
            lastWeekEndsAtMs:
              LAST_WEEK_ENDS_AT_MS,
            nhlRegularSeasonStartsAtMs:
              null,
            nhlRegularSeasonEndsAtMs: null,
            fantasyPlayoffsStartAtMs: null,
            fantasyPlayoffsEndAtMs: null,
            calendarPersisted: null,
            participantCount: null,
            weekCount: null,
            matchupCount: null,
            byeCount: null,
            shiftedWeekCount: 21,
            replacedJobOccurrenceCount:
              126,
            responseHttpStatus: 200,
            responseCode: null,
            resultSchemaVersion: 1,
            createdAtMs: NOW_MS,
            version: 1,
          };
        },
        readContext() {
          throw new Error(
            "The shift fixture must not read generation context."
          );
        },
        applyConfirmedSchedulePlan() {
          throw new Error(
            "The shift fixture must not generate a schedule."
          );
        },
        readShiftContext() {
          calls.push("readShiftContext");
          if (mode === "frozen") {
            return {
              leagueId: LEAGUE_ID,
              seasonId: SEASON_ID,
              fadCount: 1,
            };
          }
          return null;
        },
        applyWeekOneShiftPlan() {
          throw new Error(
            "The shift HTTP error fixture must not persist."
          );
        },
      },
      clock: {
        nowMs() {
          calls.push("clock");
          return NOW_MS;
        },
      },
      secureRandom: {
        id() {
          throw new Error(
            "The shift HTTP fixture must not allocate identifiers."
          );
        },
      },
    });
  return {
    calls,
    input,
    service: integrationFixture({
      scheduleServiceOverride: scheduleService,
    }).service,
  };
}

describe("M6-12 matchup HTTP integration service", () => {
  test("projects schedule, current week, week detail, matchup detail, health, and standings safely", () => {
    const { calls, service } = integrationFixture();
    const input = { leagueId: LEAGUE_ID, seasonId: SEASON_ID, authenticated: { valid: true } };
    const list = service.listWeeks(input);
    const current = service.readCurrentWeek(input);
    const week = service.readWeek({ ...input, weekId: WEEK_ID });
    const matchup = service.readMatchup({ ...input, weekId: WEEK_ID, matchupId: MATCHUP_ID });
    const standings = service.readStandings(input);

    assert.equal(list.code, "MATCHUP_WEEKS_FOUND");
    assert.equal(list.weeks[0].matchups[0].homeTeam.name, "Home");
    assert.deepEqual(list.health.statistics, {
      status: "fresh",
      completedAtMs: 9_000,
      ageMs: 1_000,
    });
    assert.equal(current.week.id, WEEK_ID);
    assert.equal(week.week.version, 4);
    assert.equal(matchup.matchup.liveScore, null);
    assert.deepEqual(matchup.matchup.health.scoring, { status: "not_live" });
    assert.equal(standings.code, "MATCHUP_STANDINGS_FOUND");
    assert.equal(calls.filter(({ method }) => method === "member").length, 5);
    assert.equal(calls.some(({ method }) => method === "score"), false);
    assert.equal(JSON.stringify(list).includes("nhl_season_key"), false);
  });

  test("uses current names for scheduled matchups while preserving finalized names", () => {
    const renamed = {
      ...rawMatchup(),
      current_home_team_name: "Renamed Home",
      current_away_team_name: "Renamed Away",
    };
    const active = integrationFixture({ matchupRow: renamed });
    const input = {
      leagueId: LEAGUE_ID,
      seasonId: SEASON_ID,
      authenticated: { valid: true },
    };
    assert.equal(
      active.service.listWeeks(input).weeks[0].matchups[0].homeTeam.name,
      "Renamed Home"
    );
    assert.equal(
      active.service.readMatchup({
        ...input,
        weekId: WEEK_ID,
        matchupId: MATCHUP_ID,
      }).matchup.awayTeam.name,
      "Renamed Away"
    );

    const finalized = integrationFixture({
      matchupRow: { ...renamed, status: "final" },
    });
    assert.equal(
      finalized.service.listWeeks(input).weeks[0].matchups[0].homeTeam.name,
      "Home"
    );
  });

  test("uses commissioner authority and explicit previews before all four writes", () => {
    const { calls, service } = integrationFixture();
    const base = { leagueId: LEAGUE_ID, seasonId: SEASON_ID, authenticated: { valid: true } };
    assert.deepEqual(
      service.generateSchedule({
        ...base,
        input: matchupScheduleInput(false),
      }),
      {
        code: "MATCHUP_SCHEDULE_PREVIEWED",
        preview: {
          seasonId: SEASON_ID,
          expectedSeasonVersion: 3,
          nhlRegularSeasonStartsAtMs:
            NHL_REGULAR_SEASON_STARTS_AT_MS,
          nhlRegularSeasonEndsAtMs:
            NHL_REGULAR_SEASON_ENDS_AT_MS,
          fantasyPlayoffsStartAtMs:
            FANTASY_PLAYOFFS_START_AT_MS,
          fantasyPlayoffsEndAtMs:
            FANTASY_PLAYOFFS_END_AT_MS,
          calendarWillBePersisted: true,
          firstWeekStartsAtMs:
            FIRST_WEEK_STARTS_AT_MS,
          participantCount: 2,
          weekCount: 1,
          matchupCount: 1,
          byeCount: 0,
          lastWeekEndsAtMs:
            LAST_WEEK_ENDS_AT_MS,
        },
      }
    );
    assert.equal(
      service.transitionWeek({ ...base, weekId: WEEK_ID, input: { confirmed: false } }).code,
      "MATCHUP_WEEK_TRANSITION_PREVIEWED"
    );
    assert.deepEqual(
      service.correctResult({
        ...base,
        resultId: RESULT_ID,
        input: { confirmed: false },
      }),
      {
        code:
          "MATCHUP_RESULT_CORRECTION_PREVIEWED",
        preview: {
          resultId: RESULT_ID,
          expectedVersion: 3,
          weekId: WEEK_ID,
          matchupId: MATCHUP_ID,
          currentVersion: {
            id: OPERATION_ID,
            versionNumber: 3,
            homeScoreHundredths: 450,
            awayScoreHundredths: 375,
            outcome: "home_win",
          },
        },
      }
    );
    assert.equal(
      service.rebuildStandings({ ...base, input: { confirmed: false } }).code,
      "MATCHUP_STANDINGS_REBUILD_PREVIEWED"
    );
    assert.equal(calls.filter(({ method }) => method === "commissioner").length, 4);
    for (const method of ["scheduleGenerate", "weekAdvance", "correct", "standingsRebuild"]) {
      assert.equal(calls.some((call) => call.method === method), false, method);
    }
  });

  test("previews a recognizable corrected result and its standings impact without writing", () => {
    const { calls, service } = integrationFixture();
    const result = service.correctResult({
      leagueId: LEAGUE_ID,
      seasonId: SEASON_ID,
      resultId: RESULT_ID,
      authenticated: { valid: true },
      input: {
        confirmed: false,
        homeScoreHundredths: 500,
        awayScoreHundredths: 400,
      },
    });

    assert.equal(
      result.code,
      "MATCHUP_RESULT_CORRECTION_PREVIEWED"
    );
    assert.deepEqual(result.preview.week, {
      id: WEEK_ID,
      sequence: 1,
      startsAtMs: 1_000,
      endsAtMs: 20_000,
    });
    assert.deepEqual(result.preview.matchup, {
      id: MATCHUP_ID,
      homeTeam: { id: HOME_ID, name: "Home" },
      awayTeam: { id: AWAY_ID, name: "Away" },
    });
    assert.deepEqual(result.preview.proposedVersion, {
      homeScoreHundredths: 500,
      awayScoreHundredths: 400,
      outcome: "home_win",
    });
    assert.deepEqual(
      result.preview.standingsImpact.changedTeamIds,
      [HOME_ID, AWAY_ID]
    );
    assert.deepEqual(
      calls.find(
        ({ method }) =>
          method === "standingsCorrectionPreview"
      ).input,
      {
        leagueId: LEAGUE_ID,
        seasonId: SEASON_ID,
        resultId: RESULT_ID,
        homeScoreHundredths: 500,
        awayScoreHundredths: 400,
      }
    );
    assert.equal(
      calls.some(({ method }) => method === "correct"),
      false
    );
  });

  test("propagates inherited platform-administrator authority to matchup commands", () => {
    const { calls, service } = integrationFixture({
      commissionerAuthority: {
        actorUserId: "platform-admin",
        authority: "platform_administrator",
      },
    });
    const base = {
      leagueId: LEAGUE_ID,
      seasonId: SEASON_ID,
      authenticated: { valid: true },
    };

    service.generateSchedule({
      ...base,
      input: matchupScheduleInput(false),
    });
    service.rebuildStandings({
      ...base,
      input: { confirmed: false },
    });
    service.correctResult({
      ...base,
      resultId: RESULT_ID,
      expectedVersion: 3,
      idempotencyKey: OPERATION_ID,
      auditContext: AUDIT_CONTEXT,
      input: {
        confirmed: true,
        homeScoreHundredths: 500,
        awayScoreHundredths: 400,
        reason: "Official provider correction",
      },
    });

    for (const method of [
      "schedulePreview",
      "standingsPreview",
    ]) {
      const call = calls.find((candidate) => candidate.method === method);
      assert.equal(call.input.actorUserId, "platform-admin");
      assert.equal(call.input.authorizedAsPlatformAdministrator, true);
    }
    const correction = calls.find(
      (candidate) =>
        candidate.method === "correct"
    ).input;
    assert.deepEqual(
      correction.authenticated,
      base.authenticated
    );
    assert.equal(
      correction.expectedResultVersion,
      3
    );
    assert.equal(
      correction.auditContext,
      AUDIT_CONTEXT
    );
    assert.equal(
      Object.hasOwn(correction, "actorUserId"),
      false
    );
  });

  test("projects a finalized player breakdown from the result's exact statistics refresh", () => {
    const matchupRow = {
      ...rawMatchup(),
      status: "final",
      week_status: "final",
    };
    const matchupResult = {
      id: RESULT_ID,
      status: "official",
      version: 1,
      finalized_at_ms: 9_500,
      result_version_id: OPERATION_ID,
      version_number: 1,
      home_team_id: HOME_ID,
      away_team_id: AWAY_ID,
      home_score_hundredths: 325,
      away_score_hundredths: 0,
      outcome: "home_win",
      source_type: "calculated",
      reason: null,
      result_version_created_at_ms: 9_500,
      result_source_refresh_id: OPERATION_ID,
    };
    const player = {
      playerId: OPERATION_ID,
      fullName: "Fixture Player",
      positionGroup: "F",
      slotNumber: 1,
      gamesPlayedDelta: 2,
      goalDelta: 1,
      assistDelta: 2,
      pointDelta: 3,
      scoreHundredths: 325,
      dataStatus: "available",
    };
    const finalScore = {
      matchupId: MATCHUP_ID,
      status: "final",
      source: {
        refreshId: OPERATION_ID,
        completedAtMs: 9_000,
        ageMs: 1_000,
        freshnessStatus: "fresh",
      },
      home: {
        teamId: HOME_ID,
        legal: true,
        scoreHundredths: 325,
        players: [player],
      },
      away: {
        teamId: AWAY_ID,
        legal: false,
        scoreHundredths: 0,
        players: [],
      },
    };
    const { calls, service } = integrationFixture({
      matchupRow,
      matchupResult,
      finalScore,
    });
    const result = service.readMatchup({
      leagueId: LEAGUE_ID,
      seasonId: SEASON_ID,
      weekId: WEEK_ID,
      matchupId: MATCHUP_ID,
      authenticated: { valid: true },
    });
    assert.equal(result.matchup.scoring.mode, "final");
    assert.equal(result.matchup.scoring.home.players[0].fullName, "Fixture Player");
    assert.equal(result.matchup.scoring.home.players[0].pointDelta, 3);
    assert.equal(
      calls.find(({ method }) => method === "finalScore").input.refreshId,
      OPERATION_ID
    );
    assert.equal(result.matchup.result.currentVersion.homeScoreHundredths, 325);
  });

  test("routes confirmed schedules through the canonical command while preserving other confirmed versioned writes", () => {
    const { calls, service } = integrationFixture();
    const base = { leagueId: LEAGUE_ID, seasonId: SEASON_ID, authenticated: { valid: true } };
    assert.deepEqual(
      service.generateSchedule({
        ...base,
        expectedVersion: 3,
        idempotencyKey:
          "opaque-matchup-schedule-key",
        input: matchupScheduleInput(true),
      }),
      {
        code: "MATCHUP_SCHEDULE_GENERATED",
        result: matchupScheduleResult(),
      }
    );
    assert.equal(
      service.transitionWeek({
        ...base,
        weekId: WEEK_ID,
        expectedVersion: 4,
        idempotencyKey: OPERATION_ID,
        input: { confirmed: true },
      }).code,
      "MATCHUP_WEEK_TRANSITIONED"
    );
    assert.equal(
      service.correctResult({
        ...base,
        resultId: RESULT_ID,
        expectedVersion: 3,
        idempotencyKey: OPERATION_ID,
        auditContext: AUDIT_CONTEXT,
        input: {
          confirmed: true,
          homeScoreHundredths: 500,
          awayScoreHundredths: 400,
          reason: "Official provider correction",
        },
      }).code,
      "MATCHUP_RESULT_CORRECTED"
    );
    assert.equal(
      service.rebuildStandings({
        ...base,
        expectedVersion: 1,
        idempotencyKey: OPERATION_ID,
        input: {
          confirmed: true,
          expectedCurrentSnapshotId: null,
          reason: "Apply corrected official result",
        },
      }).code,
      "MATCHUP_STANDINGS_REBUILT"
    );
    assert.deepEqual(
      calls.find(({ method }) => method === "correct")
        .input.authenticated,
      base.authenticated
    );
    assert.equal(calls.find(({ method }) => method === "weekAdvance").input.operationId, OPERATION_ID);
    assert.deepEqual(
      calls.find(
        ({ method }) =>
          method === "scheduleGenerate"
      ).input,
      {
        leagueId: LEAGUE_ID,
        seasonId: SEASON_ID,
        input: matchupScheduleInput(true),
        expectedSeasonVersion: 3,
        idempotencyKey:
          "opaque-matchup-schedule-key",
        authenticated: base.authenticated,
      }
    );
  });

  test("forwards only the exact shift action to the canonical Week 1 command and returns its raw result", () => {
    const { calls, service } =
      integrationFixture();
    const authenticated = {
      valid: true,
      sessionId: "shift-session",
    };
    const input = matchupShiftInput();

    assert.deepEqual(
      service.transitionWeek({
        leagueId: LEAGUE_ID,
        seasonId: SEASON_ID,
        weekId: WEEK_ID,
        input,
        expectedVersion: 4,
        idempotencyKey:
          "opaque-http-shift-key",
        authenticated,
      }),
      matchupShiftResult()
    );
    const shiftCall = calls.find(
      ({ method }) =>
        method ===
        "scheduleShiftWeekOne"
    );
    assert.deepEqual(shiftCall.input, {
      leagueId: LEAGUE_ID,
      seasonId: SEASON_ID,
      weekId: WEEK_ID,
      input,
      expectedWeekVersion: 4,
      idempotencyKey:
        "opaque-http-shift-key",
      authenticated,
    });
    assert.equal(
      shiftCall.input.input,
      input
    );
    assert.equal(
      shiftCall.input.authenticated,
      authenticated
    );
    assert.equal(
      calls.some(
        ({ method }) =>
          method === "commissioner" ||
          method === "readWeek" ||
          method === "weekAdvance"
      ),
      false
    );

    assert.throws(
      () =>
        service.transitionWeek({
          leagueId: LEAGUE_ID,
          seasonId: SEASON_ID,
          weekId: WEEK_ID,
          input: {
            action: "shift-week-one",
            confirmed: true,
          },
          expectedVersion: 4,
          authenticated,
        }),
      {
        code:
          "MATCHUP_INTEGRATION_INPUT_INVALID",
      }
    );
    assert.equal(
      calls.filter(
        ({ method }) =>
          method ===
          "scheduleShiftWeekOne"
      ).length,
      1
    );
  });

  test("requires the schedule dependency to expose Week 1 shifting", () => {
    assert.throws(
      () =>
        integrationFixture({
          scheduleServiceOverride: {
            preview() {},
            generate() {},
          },
        }),
      {
        name: "TypeError",
        message:
          "matchup integration requires a schedule service",
      }
    );
  });

  test("rejects incomplete, overposted, and unversioned write input before mutation", () => {
    const { calls, service } = integrationFixture();
    const base = { leagueId: LEAGUE_ID, seasonId: SEASON_ID, authenticated: { valid: true } };
    assert.throws(
      () => service.generateSchedule({
        ...base,
        input: { confirmed: false },
      }),
      { code: "MATCHUP_INTEGRATION_INPUT_INVALID" }
    );
    assert.throws(
      () => service.generateSchedule({
        ...base,
        input: matchupScheduleInput(false, {
          unsupported: true,
        }),
      }),
      { code: "MATCHUP_INTEGRATION_INPUT_INVALID" }
    );
    assert.throws(
      () => service.generateSchedule({
        ...base,
        idempotencyKey:
          "opaque-matchup-schedule-key",
        input: matchupScheduleInput(true),
      }),
      {
        code: "MATCHUP_INTEGRATION_INPUT_INVALID",
      }
    );
    assert.throws(
      () => service.transitionWeek({ ...base, weekId: WEEK_ID, input: { confirmed: true } }),
      { code: "MATCHUP_INTEGRATION_INPUT_INVALID" }
    );
    assert.throws(
      () => service.rebuildStandings({ ...base, input: { confirmed: false, reason: "extra" } }),
      { code: "MATCHUP_INTEGRATION_INPUT_INVALID" }
    );
    assert.equal(calls.some(({ method }) => method === "scheduleGenerate"), false);
    assert.equal(calls.some(({ method }) => method === "weekAdvance"), false);
    assert.equal(calls.some(({ method }) => method === "standingsRebuild"), false);
  });
});

function requestSecurity(calls) {
  const session = { valid: true, user: { id: "user" }, session: { id: "session" } };
  return {
    assignRequestId(request, response, next) { request.testRequestId = "m6-12-request"; next(); },
    securityHeaders(request, response, next) { response.set("Cache-Control", "no-store"); next(); },
    credentialedCors(request, response, next) { next(); },
    requireAllowedOrigin(request, response, next) { next(); },
    requireJson(request, response, next) { next(); },
    requireCompatibleFetchMetadata(request, response, next) { next(); },
    authenticateBootstrap(request, response, next) {
      calls.push("authenticateBootstrap");
      if (request.get("x-test-session") !== "valid") {
        return response.status(401).json({ error: { code: "AUTH_REQUIRED" } });
      }
      return next();
    },
    authenticateUnsafe(request, response, next) {
      calls.push("authenticateUnsafe");
      if (request.get("x-test-session") !== "valid") {
        return response.status(401).json({ error: { code: "AUTH_REQUIRED" } });
      }
      if (request.get("x-test-csrf") !== "valid") {
        return response.status(403).json({ error: { code: "CSRF_REQUIRED" } });
      }
      return next();
    },
    getRequestId(request) { return request.testRequestId; },
    getSessionBootstrap() { return session; },
    getAuthenticatedSession() { return session; },
  };
}

function serviceStub(calls, overrides = {}) {
  return Object.fromEntries(
    [
      "correctResult",
      "generateSchedule",
      "listWeeks",
      "readCurrentWeek",
      "readMatchup",
      "readStandings",
      "readWeek",
      "rebuildStandings",
      "transitionWeek",
    ].map((method) => [
      method,
      overrides[method] || ((input) => {
        calls.push({ method, input });
        return { code: `${method.toUpperCase()}_OK` };
      }),
    ])
  );
}

async function startApi(
  t,
  service,
  securityCalls = [],
  auditCalls = []
) {
  const app = express();
  app.use(createMatchupRouter({
    requestSecurity: requestSecurity(securityCalls),
    matchupService: service,
    auditPrivacyDigest: {
      digest(value) {
        auditCalls.push(value);
        return {
          keyVersion: 7,
          digest: "b".repeat(64),
        };
      },
    },
    networkSourceResolver: () => "127.0.0.1",
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

function authHeaders(extra = {}) {
  return { "x-test-session": "valid", ...extra };
}

function writeHeaders(extra = {}) {
  return {
    "content-type": "application/json",
    "x-test-session": "valid",
    "x-test-csrf": "valid",
    ...extra,
  };
}

describe("M6-12 isolated matchup HTTP contract", () => {
  test("routes all nine approved contracts with authenticated scope and request envelopes", async (t) => {
    const calls = [];
    const securityCalls = [];
    const auditCalls = [];
    const baseUrl = await startApi(
      t,
      serviceStub(calls),
      securityCalls,
      auditCalls
    );
    const base = `${baseUrl}/api/v1/leagues/${LEAGUE_ID}/seasons/${SEASON_ID}`;
    const responses = await Promise.all([
      fetch(`${base}/matchup-weeks`, { headers: authHeaders() }),
      fetch(`${base}/matchup-weeks/current`, { headers: authHeaders() }),
      fetch(`${base}/matchup-weeks/${WEEK_ID}`, { headers: authHeaders() }),
      fetch(`${base}/matchup-weeks/${WEEK_ID}/matchups/${MATCHUP_ID}`, { headers: authHeaders() }),
      fetch(`${base}/standings`, { headers: authHeaders() }),
      fetch(`${base}/matchup-schedules`, {
        method: "POST",
        headers: writeHeaders(),
        body: JSON.stringify(
          matchupScheduleInput(false)
        ),
      }),
      fetch(`${base}/matchup-weeks/${WEEK_ID}`, {
        method: "PATCH", headers: writeHeaders(), body: JSON.stringify({ confirmed: false }),
      }),
      fetch(`${base}/matchup-results/${RESULT_ID}/corrections`, {
        method: "POST", headers: writeHeaders(), body: JSON.stringify({ confirmed: false }),
      }),
      fetch(`${base}/standings/rebuilds`, {
        method: "POST", headers: writeHeaders(), body: JSON.stringify({ confirmed: false }),
      }),
    ]);
    assert.deepEqual(responses.map(({ status }) => status), Array(9).fill(200));
    assert.equal(
      responses.every(
        (response) =>
          response.headers.get("cache-control") ===
          "no-store"
      ),
      true
    );
    assert.deepEqual(auditCalls, []);
    assert.equal(calls.length, 9);
    assert.deepEqual(
      calls.map(({ method }) => method).sort(),
      [
        "correctResult", "generateSchedule", "listWeeks", "readCurrentWeek", "readMatchup",
        "readStandings", "readWeek", "rebuildStandings", "transitionWeek",
      ].sort()
    );
    assert.deepEqual(securityCalls.sort(), [
      ...Array(5).fill("authenticateBootstrap"),
      ...Array(4).fill("authenticateUnsafe"),
    ].sort());
    const detail = calls.find(({ method }) => method === "readMatchup").input;
    assert.equal(detail.weekId, WEEK_ID);
    assert.equal(detail.matchupId, MATCHUP_ID);
    const correction = calls.find(({ method }) => method === "correctResult").input;
    assert.equal(correction.resultId, RESULT_ID);
    assert.deepEqual(correction.input, { confirmed: false });
    const scheduleRequest = calls.find(
      ({ method }) => method === "generateSchedule"
    ).input;
    assert.deepEqual(
      scheduleRequest.input,
      matchupScheduleInput(false)
    );
    assert.equal(
      scheduleRequest.expectedVersion,
      null
    );
    assert.equal(
      scheduleRequest.idempotencyKey,
      undefined
    );
  });

  test("blocks unauthenticated reads and writes without CSRF before service access", async (t) => {
    const calls = [];
    const baseUrl = await startApi(t, serviceStub(calls));
    const base = `${baseUrl}/api/v1/leagues/${LEAGUE_ID}/seasons/${SEASON_ID}`;
    const unauthenticated = await fetch(`${base}/matchup-weeks`);
    const noCsrf = await fetch(`${base}/standings/rebuilds`, {
      method: "POST",
      headers: writeHeaders({ "x-test-csrf": "missing" }),
      body: JSON.stringify({ confirmed: false }),
    });
    assert.equal(unauthenticated.status, 401);
    assert.equal(noCsrf.status, 403);
    assert.equal(calls.length, 0);
  });

  test("passes version and idempotency preconditions and rejects malformed If-Match", async (t) => {
    const calls = [];
    const auditCalls = [];
    const baseUrl = await startApi(
      t,
      serviceStub(calls),
      [],
      auditCalls
    );
    const url = `${baseUrl}/api/v1/leagues/${LEAGUE_ID}/seasons/${SEASON_ID}/matchup-weeks/${WEEK_ID}`;
    const correctionUrl =
      `${baseUrl}/api/v1/leagues/${LEAGUE_ID}/seasons/${SEASON_ID}` +
      `/matchup-results/${RESULT_ID}/corrections`;
    const valid = await fetch(url, {
      method: "PATCH",
      headers: writeHeaders({ "if-match": '"4"', "idempotency-key": OPERATION_ID }),
      body: JSON.stringify({ confirmed: true }),
    });
    const invalid = await fetch(url, {
      method: "PATCH",
      headers: writeHeaders({ "if-match": "4" }),
      body: JSON.stringify({ confirmed: true }),
    });
    const correction = await fetch(correctionUrl, {
      method: "POST",
      headers: writeHeaders({
        "if-match": '"3"',
        "idempotency-key": "opaque-correction-key",
        origin: "https://app.example.test",
      }),
      body: JSON.stringify({
        confirmed: true,
        homeScoreHundredths: 500,
        awayScoreHundredths: 400,
      }),
    });
    assert.equal(valid.status, 200);
    assert.equal(invalid.status, 400);
    assert.equal(correction.status, 200);
    assert.equal(calls.length, 2);
    const transition = calls.find(
      ({ method }) => method === "transitionWeek"
    );
    assert.equal(
      transition.input.expectedVersion,
      4
    );
    assert.equal(
      transition.input.idempotencyKey,
      OPERATION_ID
    );
    const correctionCall = calls.find(
      ({ method }) => method === "correctResult"
    );
    assert.equal(
      correctionCall.input.expectedVersion,
      3
    );
    assert.equal(
      correctionCall.input.idempotencyKey,
      "opaque-correction-key"
    );
    assert.deepEqual(
      correctionCall.input.auditContext,
      {
        clientMetadataJson:
          '{"networkSourceCategory":"unknown","origin":"https://app.example.test"}',
        networkKeyVersion: 7,
        networkMetadataDigest: "b".repeat(64),
        requestCorrelationId: "m6-12-request",
      }
    );
    assert.deepEqual(
      auditCalls,
      ["network\u0000127.0.0.1"]
    );
  });

  test("returns and replays the raw ten-field Week 1 shift result with status 200", async (t) => {
    const fixture =
      actualShiftFixture("replay");
    const baseUrl = await startApi(
      t,
      fixture.service
    );
    const url =
      `${baseUrl}/api/v1/leagues/${LEAGUE_ID}` +
      `/seasons/${SEASON_ID}` +
      `/matchup-weeks/${WEEK_ID}`;
    const options = {
      method: "PATCH",
      headers: writeHeaders({
        "if-match": '"4"',
        "idempotency-key":
          "opaque-http-shift-key",
      }),
      body: JSON.stringify(fixture.input),
    };
    const first = await fetch(url, options);
    const firstBody = await first.json();
    const second = await fetch(url, options);
    const secondBody = await second.json();

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(
      firstBody.data,
      matchupShiftResult()
    );
    assert.deepEqual(
      secondBody.data,
      firstBody.data
    );
    assert.deepEqual(
      Object.keys(firstBody.data).sort(),
      [
        "firstWeekStartsAtMs",
        "lastWeekEndsAtMs",
        "operationId",
        "previousFirstWeekStartsAtMs",
        "replacedJobOccurrenceCount",
        "seasonId",
        "seasonVersion",
        "shiftedWeekCount",
        "weekId",
        "weekVersion",
      ]
    );
    assert.equal(
      Object.hasOwn(firstBody.data, "code"),
      false
    );
    assert.equal(
      Object.hasOwn(firstBody.data, "result"),
      false
    );
    assert.deepEqual(fixture.calls, [
      "transaction",
      "authorize",
      "findIdempotency",
      "findCommandResult",
      "transaction",
      "authorize",
      "findIdempotency",
      "findCommandResult",
    ]);
  });

  test("rejects missing or malformed Week 1 shift headers and bodies before command work", async (t) => {
    const fixture =
      actualShiftFixture("replay");
    const baseUrl = await startApi(
      t,
      fixture.service
    );
    const url =
      `${baseUrl}/api/v1/leagues/${LEAGUE_ID}` +
      `/seasons/${SEASON_ID}` +
      `/matchup-weeks/${WEEK_ID}`;
    const requests = [
      {
        headers: writeHeaders({
          "idempotency-key":
            "opaque-http-shift-key",
        }),
        body: fixture.input,
      },
      {
        headers: writeHeaders({
          "if-match": "4",
          "idempotency-key":
            "opaque-http-shift-key",
        }),
        body: fixture.input,
      },
      {
        headers: writeHeaders({
          "if-match": '"4"',
        }),
        body: fixture.input,
      },
      {
        headers: writeHeaders({
          "if-match": '"4"',
          "idempotency-key": " ",
        }),
        body: fixture.input,
      },
      {
        headers: writeHeaders({
          "if-match": '"4"',
          "idempotency-key":
            "opaque-http-shift-key",
        }),
        body: {
          action: "shift_week_one",
          firstWeekStartsAtMs:
            fixture.input
              .firstWeekStartsAtMs,
        },
      },
      {
        headers: writeHeaders({
          "if-match": '"4"',
          "idempotency-key":
            "opaque-http-shift-key",
        }),
        body: {
          ...fixture.input,
          extra: true,
        },
      },
    ];
    for (const request of requests) {
      const response = await fetch(url, {
        method: "PATCH",
        headers: request.headers,
        body: JSON.stringify(request.body),
      });
      const responseBody =
        await response.json();
      assert.equal(response.status, 400);
      assert.equal(
        responseBody.error.code,
        "MATCHUP_INPUT_INVALID"
      );
    }
    assert.deepEqual(fixture.calls, []);
  });

  test("maps Week 1 shift validation, authority, missing, frozen, conflict, and stale failures safely", async (t) => {
    const cases = [
      [
        "MATCHUP_SCHEDULE_COMMAND_INPUT_INVALID",
        400,
        "MATCHUP_INPUT_INVALID",
      ],
      [
        "LEAGUE_COMMISSIONER_REQUIRED",
        403,
        "MATCHUP_AUTHORITY_DENIED",
      ],
      [
        "MATCHUP_SCHEDULE_WEEK_MISSING",
        404,
        "MATCHUP_NOT_FOUND",
      ],
      [
        "FAD_WEEK_ONE_FROZEN",
        409,
        "FAD_WEEK_ONE_FROZEN",
      ],
      [
        "MATCHUP_SCHEDULE_WEEK_INVALID",
        409,
        "MATCHUP_CONFLICT",
      ],
      [
        "MATCHUP_SCHEDULE_PRECONDITION_FAILED",
        412,
        "MATCHUP_PRECONDITION_FAILED",
      ],
    ];
    for (const [
      privateCode,
      status,
      publicCode,
    ] of cases) {
      const error = new Error(
        "private Week 1 shift detail"
      );
      error.code = privateCode;
      const baseUrl = await startApi(
        t,
        serviceStub([], {
          transitionWeek() {
            throw error;
          },
        })
      );
      const response = await fetch(
        `${baseUrl}/api/v1/leagues/${LEAGUE_ID}` +
          `/seasons/${SEASON_ID}` +
          `/matchup-weeks/${WEEK_ID}`,
        {
          method: "PATCH",
          headers: writeHeaders({
            "if-match": '"4"',
            "idempotency-key":
              "opaque-http-shift-key",
          }),
          body: JSON.stringify(
            matchupShiftInput()
          ),
        }
      );
      const body = await response.json();
      assert.equal(
        response.status,
        status,
        privateCode
      );
      assert.equal(
        body.error.code,
        publicCode,
        privateCode
      );
      assert.equal(
        JSON.stringify(body).includes(
          "private Week 1 shift detail"
        ),
        false
      );
      if (
        privateCode ===
        "FAD_WEEK_ONE_FROZEN"
      ) {
        assert.equal(
          body.error.message,
          "Week 1 is frozen after Candidate Card opening."
        );
      }
    }

    const frozen =
      actualShiftFixture("frozen");
    const baseUrl = await startApi(
      t,
      frozen.service
    );
    const response = await fetch(
      `${baseUrl}/api/v1/leagues/${LEAGUE_ID}` +
        `/seasons/${SEASON_ID}` +
        `/matchup-weeks/${WEEK_ID}`,
      {
        method: "PATCH",
        headers: writeHeaders({
          "if-match": '"4"',
          "idempotency-key":
            "opaque-http-shift-key",
        }),
        body: JSON.stringify(frozen.input),
      }
    );
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(
      body.error.code,
      "FAD_WEEK_ONE_FROZEN"
    );
    assert.deepEqual(frozen.calls, [
      "transaction",
      "authorize",
      "findIdempotency",
      "clock",
      "readShiftContext",
    ]);
  });

  test("returns 201 for a confirmed schedule and preserves its opaque idempotency key", async (t) => {
    const calls = [];
    const baseUrl = await startApi(
      t,
      serviceStub(calls, {
        generateSchedule(input) {
          calls.push({
            method: "generateSchedule",
            input,
          });
          return {
            code: "MATCHUP_SCHEDULE_GENERATED",
            result: matchupScheduleResult(),
          };
        },
      })
    );
    const response = await fetch(
      `${baseUrl}/api/v1/leagues/${LEAGUE_ID}/seasons/${SEASON_ID}/matchup-schedules`,
      {
        method: "POST",
        headers: writeHeaders({
          "if-match": '"3"',
          "idempotency-key":
            "opaque-matchup-schedule-key",
        }),
        body: JSON.stringify(
          matchupScheduleInput(true)
        ),
      }
    );
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.equal(
      body.data.code,
      "MATCHUP_SCHEDULE_GENERATED"
    );
    assert.deepEqual(
      body.data.result,
      matchupScheduleResult()
    );
    assert.equal(
      calls[0].input.expectedVersion,
      3
    );
    assert.equal(
      calls[0].input.idempotencyKey,
      "opaque-matchup-schedule-key"
    );
  });

  test("requires valid confirmed-schedule If-Match and Idempotency-Key headers before command work", async (t) => {
    const fixture =
      actualConfirmedScheduleFixture("replay");
    const baseUrl = await startApi(
      t,
      fixture.service
    );
    const url =
      `${baseUrl}/api/v1/leagues/${LEAGUE_ID}` +
      `/seasons/${SEASON_ID}/matchup-schedules`;
    const requests = [
      writeHeaders({
        "idempotency-key":
          "opaque-http-schedule-key",
      }),
      writeHeaders({
        "if-match": "3",
        "idempotency-key":
          "opaque-http-schedule-key",
      }),
      writeHeaders({
        "if-match": '"3"',
      }),
      writeHeaders({
        "if-match": '"3"',
        "idempotency-key": "x".repeat(129),
      }),
    ];
    const responses = [];
    for (const headers of requests) {
      responses.push(
        await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(
            matchupScheduleInput(true)
          ),
        })
      );
    }
    assert.deepEqual(
      responses.map(({ status }) => status),
      [400, 400, 400, 400]
    );
    assert.deepEqual(fixture.calls, []);
  });

  test("replays the immutable confirmed-schedule response over HTTP without clock or identifier work", async (t) => {
    const fixture =
      actualConfirmedScheduleFixture("replay");
    const baseUrl = await startApi(
      t,
      fixture.service
    );
    const url =
      `${baseUrl}/api/v1/leagues/${LEAGUE_ID}` +
      `/seasons/${SEASON_ID}/matchup-schedules`;
    const options = {
      method: "POST",
      headers: writeHeaders({
        "if-match": '"3"',
        "idempotency-key":
          "opaque-http-schedule-key",
      }),
      body: JSON.stringify(
        matchupScheduleInput(true)
      ),
    };
    const first = await fetch(url, options);
    const firstBody = await first.json();
    const second = await fetch(url, options);
    const secondBody = await second.json();

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.deepEqual(
      firstBody.data,
      secondBody.data
    );
    assert.deepEqual(firstBody.data, {
      code: "MATCHUP_SCHEDULE_GENERATED",
      result: matchupScheduleResult(),
    });
    assert.deepEqual(fixture.calls, [
      "transaction",
      "authorize",
      "findIdempotency",
      "findCommandResult",
      "transaction",
      "authorize",
      "findIdempotency",
      "findCommandResult",
    ]);
  });

  test("maps actual confirmed-schedule authority, context, idempotency, and precondition failures", async (t) => {
    const cases = [
      [
        "denied",
        403,
        "MATCHUP_AUTHORITY_DENIED",
      ],
      ["missing", 404, "MATCHUP_NOT_FOUND"],
      [
        "incomplete",
        409,
        "IDEMPOTENCY_REQUEST_UNAVAILABLE",
      ],
      [
        "stale",
        412,
        "MATCHUP_PRECONDITION_FAILED",
      ],
    ];
    for (const [mode, status, publicCode] of cases) {
      const fixture =
        actualConfirmedScheduleFixture(mode);
      const baseUrl = await startApi(
        t,
        fixture.service
      );
      const response = await fetch(
        `${baseUrl}/api/v1/leagues/${LEAGUE_ID}` +
          `/seasons/${SEASON_ID}/matchup-schedules`,
        {
          method: "POST",
          headers: writeHeaders({
            "if-match": '"3"',
            "idempotency-key":
              "opaque-http-schedule-key",
          }),
          body: JSON.stringify(
            matchupScheduleInput(true)
          ),
        }
      );
      const body = await response.json();
      assert.equal(response.status, status, mode);
      assert.equal(
        body.error.code,
        publicCode,
        mode
      );
      assert.equal(
        JSON.stringify(body).includes("private"),
        false,
        mode
      );
    }
  });

  test("maps validation, authority, missing, stale, conflict, and internal failures safely", async (t) => {
    const cases = [
      ["MATCHUP_INTEGRATION_INPUT_INVALID", 400, "MATCHUP_INPUT_INVALID"],
      [
        "MATCHUP_SCHEDULE_CALENDAR_INVALID",
        400,
        "MATCHUP_INPUT_INVALID",
      ],
      [
        "MATCHUP_RESULT_CORRECTION_INPUT_INVALID",
        400,
        "MATCHUP_INPUT_INVALID",
        "body_invalid",
      ],
      ["LEAGUE_COMMISSIONER_REQUIRED", 403, "MATCHUP_AUTHORITY_DENIED"],
      ["MATCHUP_INTEGRATION_MATCHUP_MISSING", 404, "MATCHUP_NOT_FOUND"],
      ["MATCHUP_RESULT_CORRECTION_NOT_FOUND", 404, "MATCHUP_NOT_FOUND"],
      ["MATCHUP_INTEGRATION_VERSION_CONFLICT", 412, "MATCHUP_PRECONDITION_FAILED"],
      [
        "MATCHUP_SCHEDULE_PRECONDITION_FAILED",
        412,
        "MATCHUP_PRECONDITION_FAILED",
      ],
      ["MATCHUP_RESULT_CORRECTION_PRECONDITION_FAILED", 412, "MATCHUP_PRECONDITION_FAILED"],
      ["REPOSITORY_VERSION_CONFLICT", 412, "MATCHUP_PRECONDITION_FAILED"],
      ["IDEMPOTENCY_KEY_REUSED", 409, "IDEMPOTENCY_KEY_REUSED"],
      [
        "IDEMPOTENCY_REQUEST_UNAVAILABLE",
        409,
        "IDEMPOTENCY_REQUEST_UNAVAILABLE",
      ],
      [
        "MATCHUP_RESULT_CORRECTION_STATE_INVALID",
        409,
        "MATCHUP_CONFLICT",
        "season_state_invalid",
      ],
      [
        "MATCHUP_SCHEDULE_CALENDAR_CONFLICT",
        409,
        "MATCHUP_CONFLICT",
      ],
      ["MATCHUP_WEEK_STATE_INVALID", 409, "MATCHUP_CONFLICT"],
      ["REPOSITORY_OPERATION_FAILED", 500, "MATCHUP_FAILED"],
    ];
    for (const [
      errorCode,
      status,
      publicCode,
      reasonCode,
    ] of cases) {
      const error = new Error("private database detail");
      error.code = errorCode;
      if (reasonCode) error.reasonCode = reasonCode;
      const baseUrl = await startApi(t, serviceStub([], {
        listWeeks() { throw error; },
      }));
      const response = await fetch(
        `${baseUrl}/api/v1/leagues/${LEAGUE_ID}/seasons/${SEASON_ID}/matchup-weeks`,
        { headers: authHeaders() }
      );
      const body = await response.json();
      assert.equal(response.status, status, errorCode);
      assert.equal(body.error.code, publicCode, errorCode);
      assert.equal(JSON.stringify(body).includes("private database detail"), false);
    }
  });

  test("maps a finalized standings rebuild to a safe conflict on the rebuild route", async (t) => {
    const error = new Error("private canonical standings detail");
    error.code = "MATCHUP_RECOVERY_STATE_INVALID";
    const baseUrl = await startApi(t, serviceStub([], {
      rebuildStandings() { throw error; },
    }));
    const response = await fetch(
      `${baseUrl}/api/v1/leagues/${LEAGUE_ID}/seasons/${SEASON_ID}/standings/rebuilds`,
      {
        method: "POST",
        headers: writeHeaders(),
        body: JSON.stringify({ confirmed: false }),
      }
    );
    const body = await response.json();

    assert.equal(response.status, 409);
    assert.equal(body.error.code, "MATCHUP_CONFLICT");
    assert.equal(
      JSON.stringify(body).includes("private canonical standings detail"),
      false
    );
  });

  test("validates the isolated If-Match parser", () => {
    assert.deepEqual(optionalIfMatch({ get: () => undefined }), { valid: true, version: null });
    assert.deepEqual(optionalIfMatch({ get: () => '"12"' }), { valid: true, version: 12 });
    assert.deepEqual(optionalIfMatch({ get: () => "12" }), { valid: false, version: null });
  });
});
