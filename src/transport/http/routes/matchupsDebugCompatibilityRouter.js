const express = require("express");

function isCommissioner(body) {
  const role = String(
    body?.meta?.actorRole || ""
  ).toLowerCase();
  return role === "commissioner";
}

function createMatchupsDebugCompatibilityRouter({
  leagueStore,
  captureMatchupBaselineJob,
  applyRosterLocksJob,
  publisher = { publish() {} },
  nowMs = Date.now,
  logger = console,
} = {}) {
  if (!leagueStore) {
    throw new TypeError(
      "createMatchupsDebugCompatibilityRouter requires leagueStore"
    );
  }
  if (!captureMatchupBaselineJob) {
    throw new TypeError(
      "createMatchupsDebugCompatibilityRouter requires captureMatchupBaselineJob"
    );
  }
  if (!applyRosterLocksJob) {
    throw new TypeError(
      "createMatchupsDebugCompatibilityRouter requires applyRosterLocksJob"
    );
  }

  const router = express.Router();

  router.get(
    "/api/matchups/debug/stateSummary",
    (request, response) => {
      const state = leagueStore.loadLeague();
      const matchups = state.matchups || {};
      return response.json({
        ok: true,
        currentWeekIndex:
          matchups.currentWeekIndex ?? null,
        currentWeekId:
          matchups.currentWeekId ?? null,
        resultsKeys: Object.keys(
          matchups.resultsByWeek || {}
        ),
        lastRolloverWeekId:
          matchups.lastRolloverWeekId ?? null,
      });
    }
  );

  router.post(
    "/api/matchups/debug/resetLocks",
    async (request, response) => {
      try {
        const body = request.body || {};
        if (!isCommissioner(body)) {
          return response.status(403).json({
            ok: false,
            error: "Commissioner only.",
          });
        }

        const previous = leagueStore.loadLeague();
        const matchups = previous.matchups || {};
        const next = {
          ...previous,
          matchups: {
            ...matchups,
            locksByTeam: {},
          },
        };

        await leagueStore.saveLeague(next, {
          savedBy:
            "commissioner:debugResetLocks",
        });
        publisher.publish("league:updated", {
          reason: "matchups:debugResetLocks",
        });

        return response.json({ ok: true });
      } catch (error) {
        logger.error(
          "[DEBUG] resetLocks failed:",
          error
        );
        return response.status(500).json({
          ok: false,
          error: "Failed to reset locks.",
        });
      }
    }
  );

  router.post(
    "/api/matchups/debug/resetBaselineForWeek",
    async (request, response) => {
      try {
        const body = request.body || {};
        if (!isCommissioner(body)) {
          return response.status(403).json({
            ok: false,
            error: "Commissioner only.",
          });
        }

        const previous = leagueStore.loadLeague();
        const matchups = previous.matchups || {};
        const weeks = Array.isArray(
          matchups.scheduleWeeks
        )
          ? matchups.scheduleWeeks
          : [];
        const index = Number(
          matchups.currentWeekIndex || 0
        );
        const week = weeks[index] || null;
        const weekId = week?.weekId || null;

        if (!weekId) {
          return response.status(400).json({
            ok: false,
            error: "No current weekId.",
          });
        }

        const baselineByWeekId = {
          ...(matchups.baselineByWeekId || {}),
        };
        const existed = Boolean(
          baselineByWeekId[weekId]
        );
        delete baselineByWeekId[weekId];

        const next = {
          ...previous,
          matchups: {
            ...matchups,
            baselineByWeekId,
          },
        };

        await leagueStore.saveLeague(next, {
          savedBy:
            "commissioner:debugResetBaselineForWeek",
        });
        publisher.publish("league:updated", {
          reason:
            "matchups:debugResetBaselineForWeek",
          weekId,
        });

        return response.json({
          ok: true,
          weekId,
          existed,
        });
      } catch (error) {
        logger.error(
          "[DEBUG] resetBaselineForWeek failed:",
          error
        );
        return response.status(500).json({
          ok: false,
          error: "Failed to reset baseline.",
        });
      }
    }
  );

  router.post(
    "/api/matchups/debug/captureBaselineNow",
    async (request, response) => {
      try {
        const body = request.body || {};
        if (!isCommissioner(body)) {
          return response.status(403).json({
            ok: false,
            error: "Commissioner only.",
          });
        }

        await captureMatchupBaselineJob.run();

        const state = leagueStore.loadLeague();
        const matchups = state.matchups || {};
        const weeks = Array.isArray(
          matchups.scheduleWeeks
        )
          ? matchups.scheduleWeeks
          : [];
        const index = Number(
          matchups.currentWeekIndex || 0
        );
        const week = weeks[index] || null;
        const weekId = week?.weekId || null;
        const entry = weekId
          ? (matchups.baselineByWeekId || {})[
              weekId
            ]
          : null;

        return response.json({
          ok: true,
          currentWeekIndex: index,
          weekId,
          captured: Boolean(entry),
          capturedAtMs:
            entry?.capturedAtMs ?? null,
          statsLastUpdatedAt:
            entry?.statsLastUpdatedAt ?? null,
          playerCount: entry?.byPlayerId
            ? Object.keys(entry.byPlayerId).length
            : 0,
        });
      } catch (error) {
        logger.error(
          "[DEBUG] captureBaselineNow failed:",
          error
        );
        return response.status(500).json({
          ok: false,
          error: "Failed to capture baseline.",
        });
      }
    }
  );

  router.post(
    "/api/matchups/debug/runLockNow",
    async (request, response) => {
      try {
        const body = request.body || {};
        if (!isCommissioner(body)) {
          return response.status(403).json({
            ok: false,
            error: "Commissioner only.",
          });
        }

        await applyRosterLocksJob.run();

        const state = leagueStore.loadLeague();
        const matchups = state.matchups || {};
        const weeks = Array.isArray(
          matchups.scheduleWeeks
        )
          ? matchups.scheduleWeeks
          : [];
        const index = Number(
          matchups.currentWeekIndex || 0
        );
        const week = weeks[index] || null;
        const weekId = week?.weekId || null;
        const locksByTeam =
          matchups.locksByTeam || {};
        const lockedTeams =
          Object.keys(locksByTeam);

        return response.json({
          ok: true,
          currentWeekIndex: index,
          weekId,
          serverNowMs: nowMs(),
          lockAtMs: week?.lockAtMs ?? null,
          lockedTeams,
          lockedCount: lockedTeams.length,
        });
      } catch (error) {
        logger.error(
          "[DEBUG] runLockNow failed:",
          error
        );
        return response.status(500).json({
          ok: false,
          error: "Failed to run lock.",
        });
      }
    }
  );

  router.post(
    "/api/matchups/debug/setTeamRosterEmpty",
    async (request, response) => {
      try {
        const body = request.body || {};
        if (!isCommissioner(body)) {
          return response.status(403).json({
            ok: false,
            error: "Commissioner only.",
          });
        }

        const teamName = String(
          body.teamName || ""
        ).trim();
        if (!teamName) {
          return response.status(400).json({
            ok: false,
            error: "teamName is required.",
          });
        }

        const empty = Boolean(body.empty);
        const previous = leagueStore.loadLeague();
        const teams = Array.isArray(previous.teams)
          ? previous.teams
          : [];
        const index = teams.findIndex(
          (team) => team?.name === teamName
        );

        if (index === -1) {
          return response.status(404).json({
            ok: false,
            error: "Team not found.",
          });
        }

        const nextTeams = [...teams];
        const team = { ...nextTeams[index] };

        if (empty) {
          team.roster = [];
        } else {
          const roster = Array.isArray(team.roster)
            ? team.roster
            : [];
          if (roster.length === 0) {
            team.roster = [
              {
                name: "__TEST_PLAYER__",
                salary: 1,
                position: "F",
              },
            ];
          }
        }

        nextTeams[index] = team;
        const next = {
          ...previous,
          teams: nextTeams,
        };

        await leagueStore.saveLeague(next, {
          savedBy:
            "commissioner:debugSetTeamRosterEmpty",
        });
        publisher.publish("league:updated", {
          reason:
            "matchups:debugSetTeamRosterEmpty",
          teamName,
          empty,
        });

        return response.json({
          ok: true,
          teamName,
          empty,
          rosterCount:
            (nextTeams[index].roster || []).length,
        });
      } catch (error) {
        logger.error(
          "[DEBUG] setTeamRosterEmpty failed:",
          error
        );
        return response.status(500).json({
          ok: false,
          error: "Failed to update team roster.",
        });
      }
    }
  );

  return router;
}

module.exports = {
  createMatchupsDebugCompatibilityRouter,
  isCommissioner,
};
