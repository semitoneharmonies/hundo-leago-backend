const {
  createSqliteCapReadRepository,
} = require("./SqliteCapReadRepository");
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function stableId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A canonical stable identifier is required."
    );
  }
  return value;
}

function freezeRow(row) {
  return row ? Object.freeze({ ...row }) : null;
}

function freezeRows(rows) {
  return Object.freeze(rows.map(freezeRow));
}

function createSqliteTeamWorkspaceRepository({ database } = {}) {
  const capRepository = createSqliteCapReadRepository({ database });
  let scopeStatement;
  let playersStatement;
  let draftPicksStatement;
  let retentionsStatement;
  let buyoutsStatement;
  let futureConsiderationsStatement;
  let activeOwnershipsStatement;
  let orderSetStatement;
  let insertOrderSetStatement;
  let updateOrderSetStatement;
  let deleteOrderEntriesStatement;
  let insertOrderEntryStatement;

  try {
    scopeStatement = database.prepare(`
      SELECT
        league.id AS league_id,
        league.name AS league_name,
        season.id AS season_id,
        season.label AS season_label,
        season.nhl_season_key,
        team.id AS team_id,
        team.name AS team_name,
        team.primary_colour,
        team.secondary_colour,
        team.version AS team_version,
        CASE WHEN logo.id IS NULL THEN 0 ELSE 1 END AS has_logo
      FROM leagues AS league
      INNER JOIN seasons AS season
        ON season.league_id = league.id
       AND season.id = league.current_season_id
      INNER JOIN teams AS team
        ON team.league_id = league.id
       AND team.id = @teamId
       AND team.status <> 'erased'
      LEFT JOIN team_logo_objects AS logo
        ON logo.league_id = team.league_id
       AND logo.team_id = team.id
       AND logo.id = team.logo_reference
      WHERE league.id = @leagueId
        AND league.status <> 'deleted'
      LIMIT 2
    `);
    playersStatement = database.prepare(`
      WITH latest_stats AS (
        SELECT
          totals.*,
          ROW_NUMBER() OVER (
            PARTITION BY totals.player_id
            ORDER BY totals.source_updated_at_ms DESC,
              totals.created_at_ms DESC,
              totals.id DESC
          ) AS recency
        FROM player_stat_totals AS totals
        WHERE totals.nhl_season_key = @nhlSeasonKey
      )
      SELECT
        ownership.id AS ownership_id,
        ownership.version AS ownership_version,
        ownership.player_id,
        ownership.ownership_kind,
        ownership.position_group,
        ownership.roster_category,
        ownership.slot_number,
        player.full_name,
        player.birth_date,
        contract.id AS contract_id,
        contract.contract_type,
        contract.original_total_value_cents,
        contract.original_term_years,
        contract.aav_cents,
        contract.version AS contract_version,
        COALESCE((
          SELECT COUNT(*)
          FROM contract_years AS contract_year
          WHERE contract_year.league_id = ownership.league_id
            AND contract_year.contract_id = contract.id
            AND contract_year.status IN ('current', 'future')
        ), 0) AS remaining_contract_years,
        stats.games_played,
        stats.goals,
        stats.assists,
        stats.nhl_points,
        stats.fantasy_points_hundredths,
        display_entry.display_order
      FROM player_ownerships AS ownership
      INNER JOIN players AS player ON player.id = ownership.player_id
      LEFT JOIN contracts AS contract
        ON contract.league_id = ownership.league_id
       AND contract.player_id = ownership.player_id
       AND contract.current_team_id = ownership.team_id
       AND contract.status = 'active'
      LEFT JOIN latest_stats AS stats
        ON stats.player_id = ownership.player_id
       AND stats.recency = 1
      LEFT JOIN roster_display_order_sets AS display_set
        ON display_set.league_id = ownership.league_id
       AND display_set.season_id = ownership.season_id
       AND display_set.team_id = ownership.team_id
      LEFT JOIN roster_display_order_entries AS display_entry
        ON display_entry.league_id = ownership.league_id
       AND display_entry.order_set_id = display_set.id
       AND display_entry.ownership_id = ownership.id
      WHERE ownership.league_id = @leagueId
        AND ownership.season_id = @seasonId
        AND ownership.team_id = @teamId
      ORDER BY
        CASE ownership.roster_category
          WHEN 'Active' THEN 0
          WHEN 'Bench' THEN 1
          WHEN 'Injured Reserve' THEN 2
          ELSE 3
        END,
        ownership.position_group ASC,
        COALESCE(display_entry.display_order, ownership.slot_number, 999) ASC,
        player.full_name ASC,
        ownership.player_id ASC
    `);
    draftPicksStatement = database.prepare(`
      SELECT
        pick.id,
        pick.version,
        pick.round_number,
        pick.position_number,
        pick.status,
        season.id AS target_season_id,
        season.label AS target_season_label,
        original_team.id AS original_team_id,
        original_team.name AS original_team_name
      FROM draft_picks AS pick
      INNER JOIN seasons AS season
        ON season.league_id = pick.league_id
       AND season.id = pick.target_season_id
      INNER JOIN teams AS original_team
        ON original_team.league_id = pick.league_id
       AND original_team.id = pick.original_team_id
      WHERE pick.league_id = @leagueId
        AND pick.current_owner_team_id = @teamId
        AND pick.status = 'unused'
      ORDER BY season.nhl_season_key ASC,
        pick.round_number ASC,
        pick.position_number ASC,
        pick.id ASC
    `);
    retentionsStatement = database.prepare(`
      SELECT
        obligation.id,
        obligation.version,
        obligation.contract_id,
        obligation.player_id,
        player.full_name AS player_name,
        year.retained_aav_cents,
        COALESCE((
          SELECT COUNT(*)
          FROM retention_years AS remaining
          WHERE remaining.league_id = obligation.league_id
            AND remaining.retention_obligation_id = obligation.id
            AND remaining.status IN ('current', 'future')
        ), 0) AS remaining_years
      FROM retention_obligations AS obligation
      INNER JOIN retention_years AS year
        ON year.league_id = obligation.league_id
       AND year.retention_obligation_id = obligation.id
       AND year.season_id = @seasonId
       AND year.status = 'current'
      INNER JOIN players AS player ON player.id = obligation.player_id
      WHERE obligation.league_id = @leagueId
        AND obligation.responsible_team_id = @teamId
        AND obligation.status = 'active'
      ORDER BY player.full_name ASC, obligation.id ASC
    `);
    buyoutsStatement = database.prepare(`
      SELECT
        obligation.id,
        obligation.version,
        obligation.contract_id,
        obligation.player_id,
        player.full_name AS player_name,
        year.penalty_cents,
        COALESCE((
          SELECT COUNT(*)
          FROM buyout_years AS remaining
          WHERE remaining.league_id = obligation.league_id
            AND remaining.buyout_obligation_id = obligation.id
            AND remaining.status IN ('current', 'future')
        ), 0) AS remaining_years
      FROM buyout_obligations AS obligation
      INNER JOIN buyout_years AS year
        ON year.league_id = obligation.league_id
       AND year.buyout_obligation_id = obligation.id
       AND year.season_id = @seasonId
       AND year.status = 'current'
      INNER JOIN players AS player ON player.id = obligation.player_id
      WHERE obligation.league_id = @leagueId
        AND obligation.responsible_team_id = @teamId
        AND obligation.status = 'active'
      ORDER BY player.full_name ASC, obligation.id ASC
    `);
    futureConsiderationsStatement = database.prepare(`
      SELECT id, version, description, owing_team_id
      FROM future_considerations
      WHERE league_id = @leagueId
        AND receiving_team_id = @teamId
        AND status = 'outstanding'
      ORDER BY created_at_ms ASC, id ASC
    `);
    activeOwnershipsStatement = database.prepare(`
      SELECT id, version, position_group
      FROM player_ownerships
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND team_id = @teamId
        AND roster_category = 'Active'
      ORDER BY position_group ASC, slot_number ASC, id ASC
    `);
    orderSetStatement = database.prepare(`
      SELECT id, version
      FROM roster_display_order_sets
      WHERE league_id = @leagueId
        AND season_id = @seasonId
        AND team_id = @teamId
      LIMIT 2
    `);
    insertOrderSetStatement = database.prepare(`
      INSERT INTO roster_display_order_sets (
        id, league_id, season_id, team_id, updated_by_user_id,
        created_at_ms, updated_at_ms, version
      ) VALUES (
        @id, @leagueId, @seasonId, @teamId, @actorUserId,
        @occurredAtMs, @occurredAtMs, 1
      )
    `);
    updateOrderSetStatement = database.prepare(`
      UPDATE roster_display_order_sets
      SET updated_by_user_id = @actorUserId,
        updated_at_ms = @occurredAtMs,
        version = version + 1
      WHERE id = @id
        AND league_id = @leagueId
        AND season_id = @seasonId
        AND team_id = @teamId
        AND version = @expectedVersion
    `);
    deleteOrderEntriesStatement = database.prepare(`
      DELETE FROM roster_display_order_entries
      WHERE league_id = @leagueId
        AND order_set_id = @orderSetId
    `);
    insertOrderEntryStatement = database.prepare(`
      INSERT INTO roster_display_order_entries (
        id, league_id, order_set_id, ownership_id,
        position_group, display_order, created_at_ms
      ) VALUES (
        @id, @leagueId, @orderSetId, @ownershipId,
        @positionGroup, @displayOrder, @occurredAtMs
      )
    `);
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareTeamWorkspaceRepository",
      tableName: "player_ownerships",
    });
  }

  const saveOrderTransaction = database.transaction((command) => {
    const currentRows = orderSetStatement.all(command);
    if (currentRows.length > 1) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "A roster display-order set is not unique."
      );
    }
    const current = currentRows[0] || null;
    if ((current?.version || 0) !== command.expectedVersion) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.versionConflict,
        "The roster display order changed before this request completed."
      );
    }

    const ownershipRows = activeOwnershipsStatement.all(command);
    const expected = new Map(
      ownershipRows.map((row) => [
        row.id,
        { positionGroup: row.position_group, version: row.version },
      ])
    );
    const submitted = [
      ...command.forwardOwnerships.map((item, index) => ({
        ...item,
        positionGroup: "F",
        displayOrder: index + 1,
      })),
      ...command.defenceOwnerships.map((item, index) => ({
        ...item,
        positionGroup: "D",
        displayOrder: index + 1,
      })),
    ];
    if (
      submitted.length !== expected.size ||
      new Set(submitted.map(({ id }) => id)).size !== submitted.length ||
      submitted.some((item) => {
        const authoritative = expected.get(item.id);
        return (
          !authoritative ||
          authoritative.positionGroup !== item.positionGroup ||
          authoritative.version !== item.version
        );
      })
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.versionConflict,
        "The active roster changed before this request completed."
      );
    }

    let orderSetId;
    let version;
    if (!current) {
      orderSetId = command.createId();
      insertOrderSetStatement.run({ ...command, id: orderSetId });
      version = 1;
    } else {
      orderSetId = current.id;
      const result = updateOrderSetStatement.run({
        ...command,
        id: orderSetId,
      });
      if (result.changes !== 1) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.versionConflict,
          "The roster display order changed before this request completed."
        );
      }
      version = current.version + 1;
      deleteOrderEntriesStatement.run({
        leagueId: command.leagueId,
        orderSetId,
      });
    }
    for (const item of submitted) {
      insertOrderEntryStatement.run({
        id: command.createId(),
        leagueId: command.leagueId,
        orderSetId,
        ownershipId: item.id,
        positionGroup: item.positionGroup,
        displayOrder: item.displayOrder,
        occurredAtMs: command.occurredAtMs,
      });
    }
    return Object.freeze({ orderSetId, version });
  });

  return Object.freeze({
    read({ leagueId, teamId } = {}) {
      const lookup = {
        leagueId: stableId(leagueId),
        teamId: stableId(teamId),
      };
      try {
        const scopeRows = scopeStatement.all(lookup);
        if (scopeRows.length > 1) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.schemaIncompatible,
            "A team workspace scope is not unique."
          );
        }
        if (!scopeRows[0]) return null;
        const scope = scopeRows[0];
        const scoped = {
          ...lookup,
          seasonId: scope.season_id,
          nhlSeasonKey: scope.nhl_season_key,
        };
        const orderRows = orderSetStatement.all(scoped);
        if (orderRows.length > 1) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.schemaIncompatible,
            "A roster display-order set is not unique."
          );
        }
        return Object.freeze({
          scope: freezeRow(scope),
          cap: capRepository.calculate({
            leagueId: scoped.leagueId,
            seasonId: scoped.seasonId,
            teamId: scoped.teamId,
          }),
          players: freezeRows(playersStatement.all(scoped)),
          draftPicks: freezeRows(draftPicksStatement.all(scoped)),
          retentions: freezeRows(retentionsStatement.all(scoped)),
          buyouts: freezeRows(buyoutsStatement.all(scoped)),
          futureConsiderations: freezeRows(
            futureConsiderationsStatement.all(scoped)
          ),
          orderVersion: orderRows[0]?.version || 0,
        });
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "readTeamWorkspace",
          tableName: "player_ownerships",
        });
      }
    },
    saveOrder(command) {
      try {
        return saveOrderTransaction.immediate({
          ...command,
          leagueId: stableId(command.leagueId),
          seasonId: stableId(command.seasonId),
          teamId: stableId(command.teamId),
          actorUserId: stableId(command.actorUserId),
        });
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "saveRosterDisplayOrder",
          tableName: "roster_display_order_sets",
        });
      }
    },
  });
}

module.exports = { createSqliteTeamWorkspaceRepository };
