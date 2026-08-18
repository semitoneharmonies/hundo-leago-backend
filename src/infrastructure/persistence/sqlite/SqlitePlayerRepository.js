const {
  CANONICAL_UUID_PATTERN,
  assertStablePlayerId,
  createGlobalPlayerRecord,
  createPlayerExternalIdRecord,
  validateExternalIdentifierLookup,
} = require("../../../domain/players/playerIdentityPolicy");
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");
const {
  createSqliteRecordRepository,
  isPlainObject,
} = require("./createSqliteRecordRepository");
const {
  getRepositoryDefinition,
} = require("./repositoryCatalog");

const PLAYER_COLUMNS = Object.freeze([
  "id",
  "first_name",
  "last_name",
  "full_name",
  "birth_date",
  "status",
  "created_at_ms",
  "updated_at_ms",
  "version",
]);
const PLAYER_STATUSES = new Set(["active", "historical", "all"]);
const PLAYER_PAGE_SORTS = new Set(["name", "fantasyPoints"]);
const SPORTSDATAIO_PROVIDER = "sportsdataio-discovery-lab";
const RELEASE_QA_FIXTURE_PROVIDER = "release_qa_fixture";
const PLAYER_READ_COLUMNS = Object.freeze([
  "players.id",
  "players.first_name",
  "players.last_name",
  "players.full_name",
  "players.birth_date",
  "players.status",
  "players.created_at_ms",
  "players.updated_at_ms",
  "players.version",
  "lower(players.full_name) AS sort_name",
  "source.provider AS source_provider",
  "source.source_position",
  "source.normalized_position",
  "source.nhl_team_abbreviation",
  "source.active AS source_active",
  "source.source_version",
  "source.effective_at_ms AS source_effective_at_ms",
  "statistics.nhl_season_key AS statistics_nhl_season_key",
  "statistics_source.provider AS statistics_provider",
  "statistics.games_played AS statistics_games_played",
  "statistics.goals AS statistics_goals",
  "statistics.assists AS statistics_assists",
  "statistics.nhl_points AS statistics_nhl_points",
  "statistics.fantasy_points_hundredths AS statistics_fantasy_points_hundredths",
  "statistics.source_updated_at_ms AS statistics_source_updated_at_ms",
]);

function assertExactObject(value, expectedKeys, message) {
  if (
    !isPlainObject(value) ||
    Object.keys(value).length !== expectedKeys.length ||
    Object.keys(value).some((key) => !expectedKeys.includes(key))
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      message
    );
  }
}

function freezeRow(row) {
  return row ? Object.freeze({ ...row }) : null;
}

function freezeRows(rows) {
  return Object.freeze(rows.map((row) => freezeRow(row)));
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, "\\$&");
}

function createSqlitePlayerRepository({ database } = {}) {
  const players = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("players"),
  });
  const externalIds = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("player_external_ids"),
  });

  let findByExternalIdentifierStatement;
  let createPlayerWithExternalId;
  let findDetailByIdStatement;
  let findPageCursorStatement;
  let listExternalIdsStatement;
  let listPageStatement;
  let listPageByFantasyPointsStatement;
  try {
    findByExternalIdentifierStatement = database.prepare(
      `SELECT ${PLAYER_COLUMNS.map((column) => `players.${column}`).join(", ")} ` +
        "FROM player_external_ids " +
        "JOIN players ON players.id = player_external_ids.player_id " +
        "WHERE player_external_ids.provider = @provider " +
        "AND player_external_ids.external_value = @externalValue LIMIT 2"
    );
    createPlayerWithExternalId = database.transaction(
      ({ player, externalId }) => {
        const createdPlayer = players.insert(player);
        const createdExternalId = externalIds.insert(externalId);
        return Object.freeze({
          player: freezeRow(createdPlayer),
          externalId: freezeRow(createdExternalId),
        });
      }
    );
    const currentSourceJoin =
      "LEFT JOIN player_source_state AS source ON source.id = (" +
      "SELECT candidate.id FROM player_source_state AS candidate " +
      "WHERE candidate.player_id = players.id " +
      "AND candidate.ended_at_ms IS NULL " +
      `ORDER BY (candidate.provider = '${SPORTSDATAIO_PROVIDER}') DESC, ` +
      "candidate.effective_at_ms DESC, candidate.provider ASC, candidate.id ASC " +
      "LIMIT 1)";
    const currentStatisticsJoin =
      "LEFT JOIN player_stat_totals AS statistics ON statistics.id = (" +
      "SELECT totals.id FROM player_stat_totals AS totals " +
      "JOIN stat_refreshes AS refresh ON refresh.id = totals.refresh_id " +
      "JOIN stat_sources AS statistics_source ON statistics_source.id = totals.stat_source_id " +
      "WHERE totals.player_id = players.id " +
      `AND statistics_source.provider IN ('${SPORTSDATAIO_PROVIDER}', '${RELEASE_QA_FIXTURE_PROVIDER}') ` +
      "AND refresh.status = 'succeeded' " +
      `ORDER BY (statistics_source.provider = '${SPORTSDATAIO_PROVIDER}') DESC, ` +
      `((statistics_source.provider = '${RELEASE_QA_FIXTURE_PROVIDER}')) DESC, ` +
      "refresh.completed_at_ms DESC, totals.created_at_ms DESC, totals.id DESC " +
      "LIMIT 1) " +
      "LEFT JOIN stat_sources AS statistics_source ON statistics_source.id = statistics.stat_source_id";
    findDetailByIdStatement = database.prepare(
      `SELECT ${PLAYER_READ_COLUMNS.join(", ")} FROM players ` +
        `${currentSourceJoin} ${currentStatisticsJoin} ` +
        "WHERE players.id = @playerId LIMIT 1"
    );
    findPageCursorStatement = database.prepare(
      "SELECT players.id, players.full_name, " +
        "lower(players.full_name) AS sort_name, players.status, " +
        "COALESCE(statistics.fantasy_points_hundredths, -1) " +
        "AS sort_fantasy_points_hundredths " +
        `FROM players ${currentStatisticsJoin} ` +
        "WHERE players.id = ? LIMIT 1"
    );
    listExternalIdsStatement = database.prepare(
      "SELECT provider, external_value, created_at_ms " +
        "FROM player_external_ids WHERE player_id = ? " +
        "ORDER BY provider ASC, external_value ASC"
    );
    listPageStatement = database.prepare(
      `SELECT ${PLAYER_READ_COLUMNS.join(", ")} FROM players ` +
        `${currentSourceJoin} ${currentStatisticsJoin} ` +
        "WHERE (@status = 'all' OR players.status = @status) " +
        "AND (@pattern = '' OR lower(players.full_name) LIKE @pattern ESCAPE '\\') " +
        "AND (@ownershipTeamId IS NULL OR EXISTS (" +
        "SELECT 1 FROM leagues AS ownership_league " +
        "JOIN player_ownerships AS team_ownership " +
        "ON team_ownership.league_id = ownership_league.id " +
        "AND team_ownership.season_id = ownership_league.current_season_id " +
        "WHERE ownership_league.id = @leagueId " +
        "AND team_ownership.player_id = players.id " +
        "AND team_ownership.team_id = @ownershipTeamId" +
        ")) " +
        "AND (@auctionEligible = 0 OR (" +
        "players.status = 'active' " +
        "AND (" +
        "EXISTS (" +
        "SELECT 1 FROM league_player_positions AS correction " +
        "WHERE correction.league_id = @leagueId " +
        "AND correction.player_id = players.id " +
        "AND correction.ended_at_ms IS NULL " +
        "AND correction.position_group IN ('F', 'D')" +
        ") OR (" +
        "NOT EXISTS (" +
        "SELECT 1 FROM league_player_positions AS correction " +
        "WHERE correction.league_id = @leagueId " +
        "AND correction.player_id = players.id " +
        "AND correction.ended_at_ms IS NULL" +
        ") AND 1 = (" +
        "SELECT COUNT(DISTINCT state.normalized_position) " +
        "FROM player_source_state AS state " +
        "WHERE state.player_id = players.id " +
        "AND state.ended_at_ms IS NULL " +
        "AND state.active = 1 " +
        "AND state.normalized_position IN ('F', 'D')" +
        ")" +
        ")) " +
        "AND NOT EXISTS (" +
        "SELECT 1 FROM player_ownerships AS ownership " +
        "WHERE ownership.league_id = @leagueId " +
        "AND ownership.player_id = players.id" +
        ") " +
        "AND NOT EXISTS (" +
        "SELECT 1 FROM ownership_events AS event " +
        "WHERE event.league_id = @leagueId " +
        "AND event.player_id = players.id " +
        "AND event.event_type IN (" +
        "'fantasy_elc_declined', 'unsigned_prospect_rights_released'" +
        ")" +
        ") " +
        "AND NOT EXISTS (" +
        "SELECT 1 FROM auctions AS auction " +
        "WHERE auction.league_id = @leagueId " +
        "AND auction.player_id = players.id " +
        "AND auction.status IN ('open', 'resolving')" +
        ")" +
        ")) " +
        "AND (" +
        "@cursorName IS NULL OR lower(players.full_name) > @cursorName OR " +
        "(lower(players.full_name) = @cursorName AND players.id > @cursorId)" +
        ") " +
        "ORDER BY lower(players.full_name) ASC, players.id ASC " +
        "LIMIT @limit"
    );
    listPageByFantasyPointsStatement = database.prepare(
      `SELECT ${PLAYER_READ_COLUMNS.join(", ")} FROM players ` +
        `${currentSourceJoin} ${currentStatisticsJoin} ` +
        "WHERE (@status = 'all' OR players.status = @status) " +
        "AND (@pattern = '' OR lower(players.full_name) LIKE @pattern ESCAPE '\\') " +
        "AND (@ownershipTeamId IS NULL OR EXISTS (" +
        "SELECT 1 FROM leagues AS ownership_league " +
        "JOIN player_ownerships AS team_ownership " +
        "ON team_ownership.league_id = ownership_league.id " +
        "AND team_ownership.season_id = ownership_league.current_season_id " +
        "WHERE ownership_league.id = @leagueId " +
        "AND team_ownership.player_id = players.id " +
        "AND team_ownership.team_id = @ownershipTeamId" +
        ")) " +
        "AND (@auctionEligible = 0 OR (" +
        "players.status = 'active' " +
        "AND (" +
        "EXISTS (" +
        "SELECT 1 FROM league_player_positions AS correction " +
        "WHERE correction.league_id = @leagueId " +
        "AND correction.player_id = players.id " +
        "AND correction.ended_at_ms IS NULL " +
        "AND correction.position_group IN ('F', 'D')" +
        ") OR (" +
        "NOT EXISTS (" +
        "SELECT 1 FROM league_player_positions AS correction " +
        "WHERE correction.league_id = @leagueId " +
        "AND correction.player_id = players.id " +
        "AND correction.ended_at_ms IS NULL" +
        ") AND 1 = (" +
        "SELECT COUNT(DISTINCT state.normalized_position) " +
        "FROM player_source_state AS state " +
        "WHERE state.player_id = players.id " +
        "AND state.ended_at_ms IS NULL " +
        "AND state.active = 1 " +
        "AND state.normalized_position IN ('F', 'D')" +
        ")" +
        ")) " +
        "AND NOT EXISTS (" +
        "SELECT 1 FROM player_ownerships AS ownership " +
        "WHERE ownership.league_id = @leagueId " +
        "AND ownership.player_id = players.id" +
        ") " +
        "AND NOT EXISTS (" +
        "SELECT 1 FROM ownership_events AS event " +
        "WHERE event.league_id = @leagueId " +
        "AND event.player_id = players.id " +
        "AND event.event_type IN (" +
        "'fantasy_elc_declined', 'unsigned_prospect_rights_released'" +
        ")" +
        ") " +
        "AND NOT EXISTS (" +
        "SELECT 1 FROM auctions AS auction " +
        "WHERE auction.league_id = @leagueId " +
        "AND auction.player_id = players.id " +
        "AND auction.status IN ('open', 'resolving')" +
        ")" +
        ")) " +
        "AND (" +
        "@cursorFantasyPoints IS NULL OR " +
        "COALESCE(statistics.fantasy_points_hundredths, -1) < @cursorFantasyPoints OR (" +
        "COALESCE(statistics.fantasy_points_hundredths, -1) = @cursorFantasyPoints AND (" +
        "lower(players.full_name) > @cursorName OR " +
        "(lower(players.full_name) = @cursorName AND players.id > @cursorId)" +
        "))) " +
        "ORDER BY COALESCE(statistics.fantasy_points_hundredths, -1) DESC, " +
        "lower(players.full_name) ASC, players.id ASC " +
        "LIMIT @limit"
    );
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "preparePlayerRepository",
      tableName: "players",
    });
  }

  function insertPlayer(input) {
    const player = createGlobalPlayerRecord(input);
    return freezeRow(players.insert(player));
  }

  function insertExternalId(input) {
    const externalId = createPlayerExternalIdRecord(input);
    return freezeRow(externalIds.insert(externalId));
  }

  return Object.freeze({
    create(options) {
      assertExactObject(
        options,
        ["player", "externalId"],
        "An exact global-player creation is required."
      );
      const player = createGlobalPlayerRecord(options.player);
      const externalId = createPlayerExternalIdRecord(
        options.externalId
      );
      if (externalId.player_id !== player.id) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.argumentInvalid,
          "The external identifier must belong to the created player."
        );
      }
      try {
        return createPlayerWithExternalId.immediate({
          player,
          externalId,
        });
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "createPlayer",
          tableName: "players",
        });
      }
    },
    findById(playerId) {
      return freezeRow(
        players.findByKey({
          key: assertStablePlayerId(playerId),
        })
      );
    },
    findDetailById(playerId) {
      const canonicalPlayerId = assertStablePlayerId(playerId);
      try {
        return freezeRow(
          findDetailByIdStatement.get({ playerId: canonicalPlayerId })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findPlayerDetailById",
          tableName: "players",
        });
      }
    },
    findPageCursor(playerId) {
      const canonicalPlayerId = assertStablePlayerId(playerId);
      try {
        return freezeRow(findPageCursorStatement.get(canonicalPlayerId));
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findPlayerPageCursor",
          tableName: "players",
        });
      }
    },
    findByExternalIdentifier(input) {
      const lookup = validateExternalIdentifierLookup(input);
      try {
        const rows = findByExternalIdentifierStatement.all(lookup);
        if (rows.length > 1) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.schemaIncompatible,
            "A provider identifier resolves to multiple players."
          );
        }
        return freezeRow(rows[0]);
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "findByExternalIdentifier",
          tableName: "player_external_ids",
        });
      }
    },
    insertExternalId,
    insertPlayer,
    listExternalIds(playerId) {
      const canonicalPlayerId = assertStablePlayerId(playerId);
      try {
        return freezeRows(listExternalIdsStatement.all(canonicalPlayerId));
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "listPlayerExternalIds",
          tableName: "player_external_ids",
        });
      }
    },
    listPage(options) {
      assertExactObject(
        options,
        [
          "query",
          "status",
          "limit",
          "cursorName",
          "cursorId",
          "cursorFantasyPoints",
          "leagueId",
          "ownershipTeamId",
          "auctionEligible",
          "sort",
        ],
        "Exact player-page options are required."
      );
      if (
        typeof options.query !== "string" ||
        !PLAYER_STATUSES.has(options.status) ||
        !Number.isSafeInteger(options.limit) ||
        options.limit < 1 ||
        options.limit > 101 ||
        !PLAYER_PAGE_SORTS.has(options.sort) ||
        !(
          (options.cursorName === null && options.cursorId === null) ||
          (
            typeof options.cursorName === "string" &&
            options.cursorName.length > 0 &&
            typeof options.cursorId === "string"
          )
        ) ||
        !(
          options.cursorFantasyPoints === null ||
          Number.isSafeInteger(options.cursorFantasyPoints)
        ) ||
        !(
          (options.sort === "name" &&
            options.cursorFantasyPoints === null) ||
          (options.sort === "fantasyPoints" &&
            ((options.cursorId === null &&
              options.cursorFantasyPoints === null) ||
              (options.cursorId !== null &&
                Number.isSafeInteger(options.cursorFantasyPoints))))
        ) ||
        typeof options.auctionEligible !== "boolean" ||
        !(
          (
            options.auctionEligible === false &&
            options.leagueId === null &&
            options.ownershipTeamId === null
          ) ||
          (
            options.auctionEligible === false &&
            typeof options.leagueId === "string" &&
            CANONICAL_UUID_PATTERN.test(options.leagueId) &&
            typeof options.ownershipTeamId === "string" &&
            CANONICAL_UUID_PATTERN.test(options.ownershipTeamId)
          ) ||
          (
            options.auctionEligible === true &&
            typeof options.leagueId === "string" &&
            CANONICAL_UUID_PATTERN.test(options.leagueId) &&
            options.ownershipTeamId === null
          )
        )
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.argumentInvalid,
          "The player-page options are invalid."
        );
      }
      const cursorId =
        options.cursorId === null
          ? null
          : assertStablePlayerId(options.cursorId);
      const pattern =
        options.query === ""
          ? ""
          : `%${escapeLike(options.query.toLowerCase())}%`;
      try {
        return freezeRows(
          (options.sort === "fantasyPoints"
            ? listPageByFantasyPointsStatement
            : listPageStatement).all({
            status: options.status,
            pattern,
            cursorName: options.cursorName,
            cursorId,
            cursorFantasyPoints: options.cursorFantasyPoints,
            limit: options.limit,
            leagueId: options.leagueId,
            ownershipTeamId: options.ownershipTeamId,
            auctionEligible: options.auctionEligible ? 1 : 0,
          })
        );
      } catch (error) {
        throw mapRepositoryError(error, {
          operation: "listPlayerPage",
          tableName: "players",
        });
      }
    },
  });
}

module.exports = {
  PLAYER_COLUMNS,
  PLAYER_READ_COLUMNS,
  createSqlitePlayerRepository,
};
