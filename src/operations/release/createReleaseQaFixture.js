const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  openDatabase,
  openReadonlyDatabase,
} = require("../../infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../infrastructure/database/migrate");
const {
  createScryptPasswordHasher,
} = require("../../infrastructure/security/createScryptPasswordHasher");
const {
  createTradeProposalService,
} = require("../../application/services/trades/createTradeProposalService");
const {
  createRespondToTradeProposalService,
} = require("../../application/services/trades/respondToTradeProposalService");
const {
  createPreviewTradeAcceptanceService,
} = require("../../application/services/trades/previewTradeAcceptanceService");
const {
  createAcceptTradeProposalService,
} = require("../../application/services/trades/acceptTradeProposalService");
const {
  createLeagueAuthorizationService,
} = require("../../application/services/authorization/requireLeagueAuthority");
const {
  createTeamAuthorizationService,
} = require("../../application/services/authorization/requireTeamManagerAuthority");
const {
  createSqliteLeagueAccessRepository,
} = require("../../infrastructure/persistence/sqlite/SqliteLeagueAccessRepository");
const {
  createSqliteTeamAuthorityRepository,
} = require("../../infrastructure/persistence/sqlite/SqliteTeamAuthorityRepository");
const {
  createSqliteTradeProposalRepository,
} = require("../../infrastructure/persistence/sqlite/SqliteTradeProposalRepository");
const {
  createSqliteCandidateCardRepository,
} = require("../../infrastructure/persistence/sqlite/SqliteCandidateCardRepository");
const {
  createSqliteCandidateCardSummerSynchronizer,
} = require("../../infrastructure/persistence/sqlite/SqliteCandidateCardSummerSynchronizer");
const {
  createSqliteLeagueOutboxWriter,
} = require("../../infrastructure/persistence/sqlite/SqliteLeagueOutboxWriter");
const {
  createSqliteNotificationWriter,
} = require("../../infrastructure/persistence/sqlite/SqliteNotificationWriter");
const {
  createSqliteUserRepository,
} = require("../../infrastructure/persistence/sqlite/SqliteUserRepository");
const {
  createPlayerGameCoverageSetEvidence,
} = require("../../domain/statistics/playerGameCoveragePolicy");
const {
  createPlayerGameObservationSetEvidence,
} = require("../../domain/statistics/playerGameStatisticsPolicy");
const {
  assertReleaseQaPassword,
} = require("./releaseQaPasswordPolicy");
const {
  BETA_PLAYER_TEAM_NUMBERS,
  FIXTURE_BUILD_ID,
  FIXTURE_CREATED_AT,
  FIXTURE_DATABASE_ID,
  FIXTURE_ENVIRONMENT_ID,
  FIXTURE_NOW_MS,
  INVALID_CAP_BUYOUT_PENALTY_CENTS,
  LEAGUE_ALIASES,
  PLAYER_BLUEPRINTS,
  TEAM_NAMES_BY_LEAGUE,
  fixtureEmail,
  fixtureId,
} = require("./releaseQaFixtureContract");
const {
  verifyReleaseQaFixture,
} = require("./verifyReleaseQaFixture");

class ReleaseQaFixtureError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "ReleaseQaFixtureError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new ReleaseQaFixtureError(
    code,
    message,
    cause === undefined ? {} : { cause }
  );
}

const RELEASE_QA_NOOP_LATE_LOCK_RESULT = Object.freeze({
  status: "not_applicable",
});

function createReleaseQaNoopLateLockCoordinator() {
  const coordinatedLeagueIds = new Set();

  async function coordinateCommittedRoster(batch) {
    const teams = batch?.teams;
    const leagueAlias = LEAGUE_ALIASES.find(
      (alias) => fixtureId(`league:${alias}`) === teams?.[0]?.leagueId
    );
    const expectedTeamIds = leagueAlias
      ? [
          fixtureId(`team:${leagueAlias}:1`),
          fixtureId(`team:${leagueAlias}:2`),
        ].sort()
      : [];
    const seenOwnershipIds = new Set();
    const witnessStateCounts = { deleted: 0, present: 0 };
    if (
      !Object.isFrozen(batch) ||
      Object.keys(batch || {}).sort().join(",") !== "mutationKind,teams" ||
      batch.mutationKind !== "trade_acceptance" ||
      !leagueAlias ||
      !Array.isArray(teams) ||
      !Object.isFrozen(teams) ||
      teams.length !== 2 ||
      coordinatedLeagueIds.has(teams[0].leagueId)
    ) {
      throw new TypeError(
        "release-QA late-lock coordination requires one exact trade receipt"
      );
    }
    for (let index = 0; index < teams.length; index += 1) {
      const team = teams[index];
      if (
        !Object.isFrozen(team) ||
        Object.keys(team).sort().join(",") !==
          "leagueId,ownershipWitnesses,seasonId,teamId" ||
        team.leagueId !== teams[0].leagueId ||
        team.seasonId !== fixtureId(`season:${leagueAlias}:current`) ||
        team.teamId !== expectedTeamIds[index] ||
        !Array.isArray(team.ownershipWitnesses) ||
        !Object.isFrozen(team.ownershipWitnesses) ||
        team.ownershipWitnesses.length !== 2
      ) {
        throw new TypeError(
          "release-QA late-lock coordination received an invalid team receipt"
        );
      }
      let previousOwnershipId = null;
      for (const witness of team.ownershipWitnesses) {
        if (
          !Object.isFrozen(witness) ||
          Object.keys(witness).sort().join(",") !==
            "ownershipId,ownershipVersion,state" ||
          typeof witness.ownershipId !== "string" ||
          witness.ownershipVersion !== 1 ||
          !["deleted", "present"].includes(witness.state) ||
          (previousOwnershipId !== null &&
            witness.ownershipId <= previousOwnershipId) ||
          seenOwnershipIds.has(witness.ownershipId)
        ) {
          throw new TypeError(
            "release-QA late-lock coordination received an invalid tenure witness"
          );
        }
        previousOwnershipId = witness.ownershipId;
        seenOwnershipIds.add(witness.ownershipId);
        witnessStateCounts[witness.state] += 1;
      }
    }
    if (
      witnessStateCounts.deleted !== 2 ||
      witnessStateCounts.present !== 2
    ) {
      throw new TypeError(
        "release-QA late-lock coordination requires both closed and acquired tenures"
      );
    }
    coordinatedLeagueIds.add(teams[0].leagueId);
    return RELEASE_QA_NOOP_LATE_LOCK_RESULT;
  }

  function assertComplete() {
    const expectedLeagueIds = LEAGUE_ALIASES
      .map((alias) => fixtureId(`league:${alias}`))
      .sort();
    const actualLeagueIds = [...coordinatedLeagueIds].sort();
    if (JSON.stringify(actualLeagueIds) !== JSON.stringify(expectedLeagueIds)) {
      fail(
        "RELEASE_QA_LATE_LOCK_COVERAGE_REQUIRED",
        "The release-QA fixture did not coordinate both accepted trades."
      );
    }
  }

  return Object.freeze({ assertComplete, coordinateCommittedRoster });
}

function isInside(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative !== "" && relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertSafeFixturePath({ databasePath, environment, temporaryRoot }) {
  if (environment !== "test") {
    fail(
      "RELEASE_QA_TEST_ENVIRONMENT_REQUIRED",
      "The release-QA fixture can only run with environment=test."
    );
  }
  if (!path.isAbsolute(databasePath || "") || !path.isAbsolute(temporaryRoot || "")) {
    fail(
      "RELEASE_QA_ABSOLUTE_PATH_REQUIRED",
      "Absolute database and temporary-root paths are required."
    );
  }

  const resolvedDatabasePath = path.resolve(databasePath);
  const resolvedTemporaryRoot = path.resolve(temporaryRoot);
  const resolvedSystemTemp = fs.realpathSync(os.tmpdir());
  let physicalTemporaryRoot;
  let physicalParent;
  try {
    physicalTemporaryRoot = fs.realpathSync(resolvedTemporaryRoot);
    physicalParent = fs.realpathSync(path.dirname(resolvedDatabasePath));
  } catch (error) {
    fail(
      "RELEASE_QA_TEMPORARY_PATH_REQUIRED",
      "The temporary root and database parent must already exist.",
      error
    );
  }

  if (
    physicalTemporaryRoot !== resolvedSystemTemp &&
    !isInside(resolvedSystemTemp, physicalTemporaryRoot)
  ) {
    fail(
      "RELEASE_QA_SYSTEM_TEMP_REQUIRED",
      "The release-QA temporary root must be below the operating-system temp directory."
    );
  }
  if (!isInside(physicalTemporaryRoot, physicalParent) &&
      physicalParent !== physicalTemporaryRoot) {
    fail(
      "RELEASE_QA_PATH_OUTSIDE_TEMP_ROOT",
      "The release-QA database must be below its temporary root."
    );
  }
  if (!/release-qa[^\\/]*\.sqlite3$/i.test(path.basename(resolvedDatabasePath))) {
    fail(
      "RELEASE_QA_DATABASE_NAME_INVALID",
      "The release-QA database file name must identify release-qa and end in .sqlite3."
    );
  }
  if (fs.existsSync(resolvedDatabasePath)) {
    fail(
      "RELEASE_QA_DATABASE_ALREADY_EXISTS",
      "The release-QA fixture refuses to replace an existing database."
    );
  }
  return resolvedDatabasePath;
}

function assertProviderCatalogSourcePath({
  providerCatalogSourceDatabasePath,
  targetDatabasePath,
}) {
  if (providerCatalogSourceDatabasePath === undefined) return null;
  if (!path.isAbsolute(providerCatalogSourceDatabasePath || "")) {
    fail(
      "RELEASE_QA_PROVIDER_CATALOG_PATH_INVALID",
      "The provider-catalog source database path must be absolute."
    );
  }
  let sourcePath;
  try {
    sourcePath = fs.realpathSync(providerCatalogSourceDatabasePath);
  } catch (error) {
    fail(
      "RELEASE_QA_PROVIDER_CATALOG_PATH_INVALID",
      "The provider-catalog source database must already exist.",
      error
    );
  }
  if (
    sourcePath === path.resolve(targetDatabasePath) ||
    !fs.statSync(sourcePath).isFile()
  ) {
    fail(
      "RELEASE_QA_PROVIDER_CATALOG_PATH_INVALID",
      "The provider-catalog source must be a distinct regular file."
    );
  }
  return sourcePath;
}

function importProviderCatalogFromDatabase({
  database,
  providerCatalogSourceDatabasePath,
}) {
  if (providerCatalogSourceDatabasePath === null) {
    return Object.freeze({ importedPlayerCount: 0 });
  }
  const source = openReadonlyDatabase({
    databasePath: providerCatalogSourceDatabasePath,
  });
  try {
    source.pragma("query_only = ON");
    if (source.pragma("quick_check", { simple: true }) !== "ok") {
      fail(
        "RELEASE_QA_PROVIDER_CATALOG_INVALID",
        "The provider-catalog source database failed its integrity check."
      );
    }
    const rows = source.prepare(`
      SELECT
        player.id AS player_id,
        player.first_name,
        player.last_name,
        player.full_name,
        player.birth_date,
        player.status,
        player.created_at_ms AS player_created_at_ms,
        player.updated_at_ms AS player_updated_at_ms,
        player.version AS player_version,
        external.id AS external_id,
        external.external_value,
        external.created_at_ms AS external_created_at_ms,
        source.id AS source_state_id,
        source.source_position,
        source.normalized_position,
        source.nhl_team_abbreviation,
        source.active,
        source.source_version,
        source.source_payload_json,
        source.effective_at_ms,
        source.ended_at_ms,
        source.created_at_ms AS source_created_at_ms
      FROM players AS player
      INNER JOIN player_external_ids AS external
        ON external.player_id = player.id
       AND external.provider = 'sportsdataio-discovery-lab'
      INNER JOIN player_source_state AS source
        ON source.player_id = player.id
       AND source.provider = 'sportsdataio-discovery-lab'
       AND source.ended_at_ms IS NULL
       AND source.normalized_position IN ('F', 'D')
      ORDER BY lower(player.full_name) ASC, player.id ASC
    `).all();
    if (rows.length < PLAYER_BLUEPRINTS.length) {
      fail(
        "RELEASE_QA_PROVIDER_CATALOG_INSUFFICIENT",
        "The provider-catalog source does not contain enough current players."
      );
    }
    const insertPlayer = database.prepare(`
      INSERT INTO players (
        id, first_name, last_name, full_name, birth_date, status,
        created_at_ms, updated_at_ms, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertExternal = database.prepare(`
      INSERT INTO player_external_ids (
        id, player_id, provider, external_value, created_at_ms
      ) VALUES (?, ?, 'sportsdataio-discovery-lab', ?, ?)
    `);
    const insertSource = database.prepare(`
      INSERT INTO player_source_state (
        id, player_id, provider, source_position, normalized_position,
        nhl_team_abbreviation, active, source_version, source_payload_json,
        effective_at_ms, ended_at_ms, created_at_ms
      ) VALUES (
        ?, ?, 'sportsdataio-discovery-lab', ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);
    database.transaction(() => {
      if (database.prepare("SELECT COUNT(*) FROM players").pluck().get() !== 0) {
        fail(
          "RELEASE_QA_PROVIDER_CATALOG_TARGET_NOT_EMPTY",
          "The provider catalog can only be copied into a fresh fixture database."
        );
      }
      for (const row of rows) {
        insertPlayer.run(
          row.player_id,
          row.first_name,
          row.last_name,
          row.full_name,
          row.birth_date,
          row.status,
          row.player_created_at_ms,
          row.player_updated_at_ms,
          row.player_version
        );
        insertExternal.run(
          row.external_id,
          row.player_id,
          row.external_value,
          row.external_created_at_ms
        );
        insertSource.run(
          row.source_state_id,
          row.player_id,
          row.source_position,
          row.normalized_position,
          row.nhl_team_abbreviation,
          row.active,
          row.source_version,
          row.source_payload_json,
          row.effective_at_ms,
          row.ended_at_ms,
          row.source_created_at_ms
        );
      }
    }).immediate();
    return Object.freeze({ importedPlayerCount: rows.length });
  } catch (error) {
    if (error instanceof ReleaseQaFixtureError) throw error;
    fail(
      "RELEASE_QA_PROVIDER_CATALOG_INVALID",
      "The provider catalog could not be copied safely.",
      error
    );
  } finally {
    source.close();
  }
}

function deterministicPasswordHasher() {
  const salt = Buffer.from("m7-release-qa-salt", "utf8").subarray(0, 16);
  return createScryptPasswordHasher({
    secureRandom: Object.freeze({
      bytes(length) {
        if (length !== salt.byteLength) return Buffer.alloc(length, 7);
        return Buffer.from(salt);
      },
    }),
    maxConcurrent: 1,
    maxQueued: 0,
    validatePassword: assertReleaseQaPassword,
  });
}

const ACCOUNT_DEFINITIONS = Object.freeze([
  Object.freeze({ alias: "platformAdmin", displayName: "Admin", status: "active" }),
  Object.freeze({ alias: "leagueACommissioner", displayName: "Comm A", status: "active" }),
  Object.freeze({ alias: "leagueBCommissioner", displayName: "Comm B", status: "active" }),
  Object.freeze({ alias: "leagueAManagerOne", displayName: "Man A Leag A", status: "active" }),
  Object.freeze({ alias: "leagueAManagerTwo", displayName: "Man B Leag A", status: "active" }),
  Object.freeze({ alias: "leagueBManagerOne", displayName: "Man A Leag B", status: "active" }),
  Object.freeze({ alias: "verifiedWithoutMembership", displayName: "No League", status: "active" }),
  Object.freeze({ alias: "pendingVerification", displayName: "Pending", status: "pending_verification" }),
  Object.freeze({ alias: "deactivated", displayName: "Deactivated", status: "deactivated" }),
]);

function insertAccounts(database, passwordHash) {
  const insertUser = database.prepare(`
    INSERT INTO users (
      id, email_normalized, email_display, display_name,
      display_name_normalized, status, created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  const insertCredential = database.prepare(`
    INSERT INTO user_credentials (
      id, user_id, password_hash, algorithm, algorithm_version,
      status, created_at_ms, replaced_at_ms, version
    ) VALUES (?, ?, ?, 'scrypt', 1, 'active', ?, NULL, 1)
  `);
  const accounts = {};
  for (const definition of ACCOUNT_DEFINITIONS) {
    const id = fixtureId(`account:${definition.alias}`);
    const email = fixtureEmail(definition.alias);
    insertUser.run(
      id,
      email,
      email,
      definition.displayName,
      definition.displayName.toLowerCase(),
      definition.status,
      FIXTURE_NOW_MS,
      FIXTURE_NOW_MS
    );
    insertCredential.run(
      fixtureId(`credential:${definition.alias}`),
      id,
      passwordHash,
      FIXTURE_NOW_MS
    );
    accounts[definition.alias] = Object.freeze({ id });
  }
  database.prepare(`
    INSERT INTO platform_roles (
      id, user_id, role, status, granted_by_user_id,
      granted_at_ms, ended_at_ms, version
    ) VALUES (?, ?, 'platform_administrator', 'active', ?, ?, NULL, 1)
  `).run(
    fixtureId("platform-role:administrator"),
    accounts.platformAdmin.id,
    accounts.platformAdmin.id,
    FIXTURE_NOW_MS
  );
  return Object.freeze(accounts);
}

function insertGlobalPlayers(database) {
  const providerPlayers = database.prepare(`
    SELECT
      player.id,
      player.first_name,
      player.last_name,
      player.full_name,
      player.birth_date,
      source.normalized_position,
      source.active
    FROM players AS player
    INNER JOIN player_external_ids AS external
      ON external.player_id = player.id
     AND external.provider = 'sportsdataio-discovery-lab'
    INNER JOIN player_source_state AS source
      ON source.player_id = player.id
     AND source.provider = 'sportsdataio-discovery-lab'
     AND source.ended_at_ms IS NULL
     AND source.normalized_position IN ('F', 'D')
    WHERE player.status = 'active'
    GROUP BY player.id
    ORDER BY lower(player.full_name) ASC, player.id ASC
  `).all();
  const providerByPosition = new Map([
    ["F", providerPlayers.filter((player) => player.normalized_position === "F")],
    ["D", providerPlayers.filter((player) => player.normalized_position === "D")],
  ]);
  const available = new Map(
    [...providerByPosition].map(([position, rows]) => [
      position,
      [...rows],
    ])
  );
  const selectedByAlias = new Map();
  const selectionOrder = [
    ...PLAYER_BLUEPRINTS.filter(({ requiresUnder19 }) => requiresUnder19),
    ...PLAYER_BLUEPRINTS.filter(({ requiresUnder19 }) => !requiresUnder19),
  ];
  for (const blueprint of selectionOrder) {
    const pool = available.get(blueprint.position);
    const selectedIndex = blueprint.requiresUnder19
      ? pool.findIndex(
          (player) =>
            typeof player.birth_date === "string" &&
            player.birth_date > "2007-07-26"
        )
      : pool.findIndex((player) => player.active === 1);
    if (selectedIndex >= 0) {
      const [selected] = pool.splice(selectedIndex, 1);
      selectedByAlias.set(blueprint.alias, selected);
    }
  }

  const insertPlayer = database.prepare(`
    INSERT INTO players (
      id, first_name, last_name, full_name, birth_date,
      status, created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, 1)
  `);
  const insertExternalId = database.prepare(`
    INSERT INTO player_external_ids (
      id, player_id, provider, external_value, created_at_ms
    ) VALUES (?, ?, 'release_qa', ?, ?)
  `);
  const insertSyntheticSportsDataIoExternalId = database.prepare(`
    INSERT INTO player_external_ids (
      id, player_id, provider, external_value, created_at_ms
    ) VALUES (?, ?, 'sportsdataio-discovery-lab', ?, ?)
  `);
  const players = {};
  PLAYER_BLUEPRINTS.forEach((blueprint, index) => {
    const providerPlayer = selectedByAlias.get(blueprint.alias);
    if (providerPlayer) {
      players[blueprint.alias] = Object.freeze({
        id: providerPlayer.id,
        ...blueprint,
        providerBacked: true,
      });
      return;
    }
    const id = fixtureId(`player:${blueprint.alias}`);
    const firstName = "Fixture";
    const lastName = `Player ${String(index + 1).padStart(2, "0")}`;
    insertPlayer.run(
      id,
      firstName,
      lastName,
      `${firstName} ${lastName}`,
      blueprint.requiresUnder19
        ? `200${8 + (index % 2)}-01-01`
        : `199${index % 10}-01-01`,
      FIXTURE_NOW_MS,
      FIXTURE_NOW_MS
    );
    insertExternalId.run(
      fixtureId(`player-external:${blueprint.alias}`),
      id,
      `release-qa-${String(index + 1).padStart(3, "0")}`,
      FIXTURE_NOW_MS
    );
    insertSyntheticSportsDataIoExternalId.run(
      fixtureId(`player-sportsdataio-external:${blueprint.alias}`),
      id,
      `release-qa-synthetic-${String(index + 1).padStart(3, "0")}`,
      FIXTURE_NOW_MS
    );
    players[blueprint.alias] = Object.freeze({ id, ...blueprint });
  });
  return Object.freeze(players);
}

function insertLeagueBase(database, leagueAlias, accounts) {
  const leagueId = fixtureId(`league:${leagueAlias}`);
  const leagueName = leagueAlias === "leagueA"
    ? "Release QA Alpha League"
    : "Release QA Beta League";
  const commissionerAlias = leagueAlias === "leagueA"
    ? "leagueACommissioner"
    : "leagueBCommissioner";
  const managerAliases = leagueAlias === "leagueA"
    ? ["leagueAManagerOne", "leagueAManagerTwo"]
    : ["leagueBManagerOne"];
  const maximumTeams = TEAM_NAMES_BY_LEAGUE[leagueAlias]?.length;
  if (!Number.isSafeInteger(maximumTeams) || maximumTeams < 2) {
    fail(
      "RELEASE_QA_TEAM_NAMES_REQUIRED",
      `The release-QA fixture has no valid team count for ${leagueAlias}.`
    );
  }

  database.prepare(`
    INSERT INTO leagues (
      id, name, name_normalized, status, timezone,
      commissioner_membership_id, current_season_id,
      created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, 'active', 'America/Vancouver', NULL, NULL, ?, ?, 1)
  `).run(leagueId, leagueName, leagueName.toLowerCase(), FIXTURE_NOW_MS, FIXTURE_NOW_MS);
  database.prepare(`
    INSERT INTO league_settings (
      league_id, salary_cap_cents, trade_deadline_at_ms, maximum_teams,
      active_forward_slots, active_defence_slots, bench_slots,
      maximum_bench_aav_cents, injured_reserve_slots,
      prospect_slots_unlimited, scoring_rule_version, standings_rule_version,
      created_at_ms, updated_at_ms, version
    ) VALUES (?, 10000, ?, ?, 12, 6, 4, 400, 4, 1, 1, 1, ?, ?, 1)
  `).run(
    leagueId,
    FIXTURE_NOW_MS + 30 * 86_400_000,
    maximumTeams,
    FIXTURE_NOW_MS,
    FIXTURE_NOW_MS
  );

  const seasons = [
    "current",
    "futureOne",
    "futureTwo",
    "futureThree",
  ].map((seasonAlias, index) => {
    const id = fixtureId(`season:${leagueAlias}:${seasonAlias}`);
    database.prepare(`
      INSERT INTO seasons (
        id, league_id, label, nhl_season_key, status,
        regular_season_starts_at_ms, regular_season_ends_at_ms,
        fantasy_playoffs_start_at_ms, fantasy_playoffs_end_at_ms,
        created_at_ms, updated_at_ms, version, free_agent_draft_completed_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
      id,
      leagueId,
      index === 0 ? "2026-27" : `${2026 + index}-${String(27 + index).padStart(2, "0")}`,
      `${20262027 + index * 10001}`,
      index === 0 ? "active" : "planned",
      FIXTURE_NOW_MS + (index * 365 - 21) * 86_400_000,
      FIXTURE_NOW_MS + (180 + index * 365) * 86_400_000,
      FIXTURE_NOW_MS + (150 + index * 365) * 86_400_000,
      FIXTURE_NOW_MS + (180 + index * 365) * 86_400_000,
      FIXTURE_NOW_MS,
      FIXTURE_NOW_MS,
      index === 0 ? FIXTURE_NOW_MS - 7 * 86_400_000 : null
    );
    return Object.freeze({ alias: seasonAlias, id });
  });

  const membershipAliases = [
    "platformAdmin",
    commissionerAlias,
    ...managerAliases,
  ];
  const memberships = {};
  const insertMembership = database.prepare(`
    INSERT INTO league_memberships (
      id, league_id, user_id, permission_category, status,
      joined_at_ms, ended_at_ms, created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, ?, 'active', ?, NULL, ?, ?, 1)
  `);
  for (const accountAlias of membershipAliases) {
    const id = fixtureId(`membership:${leagueAlias}:${accountAlias}`);
    insertMembership.run(
      id,
      leagueId,
      accounts[accountAlias].id,
      accountAlias === "platformAdmin"
        ? "member"
        : accountAlias === commissionerAlias
          ? "commissioner"
          : "manager",
      FIXTURE_NOW_MS,
      FIXTURE_NOW_MS,
      FIXTURE_NOW_MS
    );
    memberships[accountAlias] = Object.freeze({ id });
  }

  const teamNames = TEAM_NAMES_BY_LEAGUE[leagueAlias];
  if (!teamNames) {
    fail(
      "RELEASE_QA_TEAM_NAMES_REQUIRED",
      `The release-QA fixture has no team names for ${leagueAlias}.`
    );
  }
  const teams = teamNames.map((name, index) => {
    const id = fixtureId(`team:${leagueAlias}:${index + 1}`);
    database.prepare(`
      INSERT INTO teams (
        id, league_id, name, name_normalized, status,
        primary_colour, secondary_colour, logo_reference,
        created_at_ms, updated_at_ms, version
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, NULL, ?, ?, 1)
    `).run(
      id,
      leagueId,
      name,
      name.toLowerCase(),
      index % 2 === 0 ? "#16324f" : "#b03a2e",
      "#f7f7f7",
      FIXTURE_NOW_MS,
      FIXTURE_NOW_MS
    );
    return Object.freeze({ id, name });
  });

  const assignmentAccounts = managerAliases;
  assignmentAccounts.forEach((accountAlias, index) => {
    database.prepare(`
      INSERT INTO team_manager_assignments (
        id, league_id, team_id, user_id, membership_id,
        assigned_by_user_id, replaces_assignment_id, status,
        assigned_at_ms, accepted_at_ms, ended_at_ms, version
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'accepted', ?, ?, NULL, 1)
    `).run(
      fixtureId(`assignment:${leagueAlias}:${accountAlias}`),
      leagueId,
      teams[index + 1].id,
      accounts[accountAlias].id,
      memberships[accountAlias].id,
      accounts[commissionerAlias].id,
      FIXTURE_NOW_MS,
      FIXTURE_NOW_MS
    );
  });

  database.prepare(`
    UPDATE leagues
    SET commissioner_membership_id = ?, current_season_id = ?,
        updated_at_ms = ?, version = version + 1
    WHERE id = ?
  `).run(
    memberships[commissionerAlias].id,
    seasons[0].id,
    FIXTURE_NOW_MS,
    leagueId
  );
  const insertDraft = database.prepare(`
    INSERT INTO entry_drafts (
      id, league_id, season_id, status, rounds, pick_clock_seconds,
      starts_at_ms, completed_at_ms, created_by_user_id,
      created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, ?, 4, 300, ?, ?, ?, ?, ?, 1)
  `);
  const insertDraftPick = database.prepare(`
    INSERT INTO draft_picks (
      id, league_id, draft_id, target_season_id, round_number,
      position_number, original_team_id, current_owner_team_id,
      status, selection_id, created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unused', NULL, ?, ?, 1)
  `);
  seasons.forEach((season, seasonIndex) => {
    const draftId =
      seasonIndex === 0
        ? fixtureId(`entry-draft:${leagueAlias}`)
        : fixtureId(`entry-draft:${leagueAlias}:${season.alias}`);
    const startsAtMs =
      FIXTURE_NOW_MS + (seasonIndex * 365 - 8) * 86_400_000;
    insertDraft.run(
      draftId,
      leagueId,
      season.id,
      seasonIndex === 0 ? "completed" : "setup",
      startsAtMs,
      seasonIndex === 0 ? startsAtMs + 86_400_000 : null,
      accounts[commissionerAlias].id,
      FIXTURE_NOW_MS,
      FIXTURE_NOW_MS
    );
    for (let round = 1; round <= 4; round += 1) {
      teams.forEach((team, teamIndex) => {
        insertDraftPick.run(
          fixtureId(
            `draft-pick:${leagueAlias}:${season.alias}:${round}:${teamIndex + 1}`
          ),
          leagueId,
          draftId,
          season.id,
          round,
          teamIndex + 1,
          team.id,
          team.id,
          FIXTURE_NOW_MS,
          FIXTURE_NOW_MS
        );
      });
    }
  });

  return Object.freeze({
    alias: leagueAlias,
    commissionerAlias,
    leagueId,
    memberships: Object.freeze(memberships),
    seasons: Object.freeze(seasons),
    teams: Object.freeze(teams),
  });
}

function insertLeaguePlayerState(database, league, players, accounts) {
  const insertPosition = database.prepare(`
    INSERT INTO league_player_positions (
      id, league_id, player_id, position_group, reason,
      corrected_by_user_id, effective_at_ms, ended_at_ms, version
    ) VALUES (?, ?, ?, ?, 'release QA fixture', ?, ?, NULL, 1)
  `);
  const insertOwnership = database.prepare(`
    INSERT INTO player_ownerships (
      id, league_id, season_id, player_id, team_id, ownership_kind,
      roster_category, position_group, slot_number,
      acquired_transaction_type, acquired_transaction_id,
      created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'release_qa_fixture', NULL, ?, ?, 1)
  `);
  const insertContract = database.prepare(`
    INSERT INTO contracts (
      id, league_id, player_id, current_team_id, contract_type,
      original_total_value_cents, original_term_years, aav_cents,
      start_season_id, status, acquisition_source_type,
      acquisition_source_id, auction_buyout_lock_expires_at_ms,
      created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'release_qa_fixture', NULL, NULL, ?, ?, 1)
  `);
  const insertContractYear = database.prepare(`
    INSERT INTO contract_years (
      id, league_id, contract_id, season_id, year_number,
      aav_cents, status, rollover_at_ms, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
  `);
  const contracts = {};
  const rosteredPlayersByTeam = new Map(
    league.teams.map((team) => [team.id, []])
  );

  PLAYER_BLUEPRINTS.forEach((blueprint, index) => {
    const player = players[blueprint.alias];
    const assignedTeamNumber =
      league.alias === "leagueB"
        ? BETA_PLAYER_TEAM_NUMBERS[blueprint.alias]
        : undefined;
    const assignedTeamIndex = blueprint.alias === "boughtOutForward"
      ? Math.min(5, league.teams.length - 1)
      : assignedTeamNumber === undefined
        ? (blueprint.teamNumber || ((index % league.teams.length) + 1)) - 1
        : assignedTeamNumber - 1;
    const assignedTeam = league.teams[assignedTeamIndex] || null;
    insertPosition.run(
      fixtureId(`position:${league.alias}:${blueprint.alias}`),
      league.leagueId,
      player.id,
      blueprint.position,
      accounts[league.commissionerAlias].id,
      FIXTURE_NOW_MS
    );
    if (blueprint.injuredReserveEligible) {
      const source = database.prepare(`
        SELECT id, source_payload_json
        FROM player_source_state
        WHERE player_id=? AND ended_at_ms IS NULL
        ORDER BY effective_at_ms DESC, id DESC
        LIMIT 1
      `).get(player.id);
      if (source) {
        let payload = {};
        try {
          payload = JSON.parse(source.source_payload_json);
        } catch {
          payload = {};
        }
        database.prepare(`
          UPDATE player_source_state
          SET source_payload_json=?
          WHERE id=?
        `).run(JSON.stringify({ ...payload, Status: "Injured Reserve" }), source.id);
      }
    }
    if (blueprint.rosterCategory && assignedTeam) {
      insertOwnership.run(
        fixtureId(`ownership:${league.alias}:${blueprint.alias}`),
        league.leagueId,
        league.seasons[0].id,
        player.id,
        assignedTeam.id,
        blueprint.ownershipKind,
        blueprint.rosterCategory,
        blueprint.position,
        blueprint.slotNumber,
        FIXTURE_NOW_MS,
        FIXTURE_NOW_MS
      );
      rosteredPlayersByTeam.get(assignedTeam.id).push(Object.freeze({
        playerId: player.id,
        positionGroup: blueprint.position,
        rosterCategory: blueprint.rosterCategory,
        slotNumber: blueprint.slotNumber,
      }));
    }
    if (
      (!blueprint.contract && blueprint.alias !== "boughtOutForward") ||
      !assignedTeam
    ) return;

    const contractId = fixtureId(`contract:${league.alias}:${blueprint.alias}`);
    const termYears = blueprint.alias === "boughtOutForward"
      ? 1
      : blueprint.contractType === "fantasy_elc" ? 3 : (index % 3) + 1;
    const aavCents = blueprint.aavCents || 200 + (index % 3) * 25;
    const status = blueprint.alias === "boughtOutForward" ? "eliminated" : "active";
    insertContract.run(
      contractId,
      league.leagueId,
      player.id,
      assignedTeam.id,
      blueprint.contractType || "normal",
      aavCents * termYears,
      termYears,
      aavCents,
      league.seasons[0].id,
      status,
      FIXTURE_NOW_MS,
      FIXTURE_NOW_MS
    );
    for (let year = 1; year <= termYears; year += 1) {
      insertContractYear.run(
        fixtureId(`contract-year:${league.alias}:${blueprint.alias}:${year}`),
        league.leagueId,
        contractId,
        league.seasons[year - 1].id,
        year,
        aavCents,
        status === "eliminated" ? "eliminated" : year === 1 ? "current" : "future",
        FIXTURE_NOW_MS
      );
    }
    contracts[blueprint.alias] = Object.freeze({
      id: contractId,
      aavCents,
      teamId: assignedTeam.id,
      termYears,
    });
  });

  const retentionId = fixtureId(`retention:${league.alias}`);
  database.prepare(`
    INSERT INTO retention_obligations (
      id, league_id, contract_id, player_id, originating_team_id,
      responsible_team_id, retained_aav_cents, creation_trade_id,
      status, created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, ?, ?, ?, 75, NULL, 'active', ?, ?, 1)
  `).run(
    retentionId,
    league.leagueId,
    contracts.activeForward1.id,
    players.activeForward1.id,
    contracts.activeForward1.teamId,
    league.teams[1].id,
    FIXTURE_NOW_MS,
    FIXTURE_NOW_MS
  );
  database.prepare(`
    INSERT INTO retention_years (
      id, league_id, retention_obligation_id, season_id,
      retained_aav_cents, status, created_at_ms
    ) VALUES (?, ?, ?, ?, 75, 'current', ?)
  `).run(
    fixtureId(`retention-year:${league.alias}`),
    league.leagueId,
    retentionId,
    league.seasons[0].id,
    FIXTURE_NOW_MS
  );

  const buyoutId = fixtureId(`buyout:${league.alias}`);
  database.prepare(`
    INSERT INTO buyout_obligations (
      id, league_id, contract_id, player_id, originating_team_id,
      responsible_team_id, annual_penalty_basis_cents,
      buyout_transaction_id, status, created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 1)
  `).run(
    buyoutId,
    league.leagueId,
    contracts.boughtOutForward.id,
    players.boughtOutForward.id,
    contracts.boughtOutForward.teamId,
    contracts.boughtOutForward.teamId,
    INVALID_CAP_BUYOUT_PENALTY_CENTS,
    `release-qa-buyout-${league.alias}`,
    FIXTURE_NOW_MS,
    FIXTURE_NOW_MS
  );
  database.prepare(`
    INSERT INTO buyout_years (
      id, league_id, buyout_obligation_id, season_id,
      penalty_cents, status, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, 'current', ?)
  `).run(
    fixtureId(`buyout-year:${league.alias}`),
    league.leagueId,
    buyoutId,
    league.seasons[0].id,
    INVALID_CAP_BUYOUT_PENALTY_CENTS,
    FIXTURE_NOW_MS
  );
  return Object.freeze({
    contracts,
    retentionId,
    buyoutId,
    rosteredPlayersByTeam: Object.freeze(Object.fromEntries(
      [...rosteredPlayersByTeam.entries()].map(([teamId, rosteredPlayers]) => [
        teamId,
        Object.freeze(rosteredPlayers),
      ])
    )),
  });
}

function insertAuctionAndTrades(
  database,
  league,
  leagueState,
  players,
  accounts,
  {
    lateLockCoordinator,
    leagueOutboxWriter,
    notificationWriter,
    candidateCardSummerSynchronizer,
  }
) {
  const managerAlias = league.alias === "leagueA"
    ? "leagueAManagerOne"
    : "leagueBManagerOne";
  const auctionId = fixtureId(`auction:${league.alias}`);
  database.prepare(`
    INSERT INTO auctions (
      id, league_id, season_id, player_id, status, opened_at_ms,
      resolves_at_ms, opened_by_user_id, created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, 1)
  `).run(
    auctionId,
    league.leagueId,
    league.seasons[0].id,
    players.freeAgentForward.id,
    FIXTURE_NOW_MS - 3_600_000,
    FIXTURE_NOW_MS + 86_400_000,
    accounts[managerAlias].id,
    FIXTURE_NOW_MS - 3_600_000,
    FIXTURE_NOW_MS - 3_600_000
  );
  database.prepare(`
    INSERT INTO auction_contexts (
      id, league_id, season_id, auction_id, source_kind,
      fad_id, fad_rollover_id, fad_allocation_id, created_at_ms
    ) VALUES (?, ?, ?, ?, 'ordinary_weekly', NULL, NULL, NULL, ?)
  `).run(
    auctionId,
    league.leagueId,
    league.seasons[0].id,
    auctionId,
    FIXTURE_NOW_MS - 3_600_000
  );
  database.prepare(`
    INSERT INTO auction_bids (
      id, league_id, season_id, auction_id, team_id,
      submitted_by_user_id, total_value_cents, term_years,
      lowest_offered_aav_cents, first_submitted_at_ms,
      last_edited_at_ms, edit_count, status, idempotency_request_id, version
    ) VALUES (?, ?, ?, ?, ?, ?, 900, 3, 300, ?, ?, 0, 'active', NULL, 1)
  `).run(
    fixtureId(`auction-bid:${league.alias}`),
    league.leagueId,
    league.seasons[0].id,
    auctionId,
    league.teams[0].id,
    accounts[managerAlias].id,
    FIXTURE_NOW_MS - 1_800_000,
    FIXTURE_NOW_MS - 1_800_000
  );

  const leagueAuthorization = createLeagueAuthorizationService({
    userRepository: createSqliteUserRepository({ database }),
    leagueAccessRepository: createSqliteLeagueAccessRepository({ database }),
  });
  const teamAuthorization = createTeamAuthorizationService({
    leagueAuthorization,
    teamAuthorityRepository: createSqliteTeamAuthorityRepository({ database }),
  });
  const tradeRepository = createSqliteTradeProposalRepository({
    database,
    leagueOutboxWriter,
    notificationWriter,
    candidateCardSummerSynchronizer,
  });
  let scenarioAlias = "uninitialized";
  let scenarioIdSequence = 0;
  let nowMs = FIXTURE_NOW_MS;
  const clock = Object.freeze({ nowMs: () => nowMs });
  const secureRandom = Object.freeze({
    id() {
      scenarioIdSequence += 1;
      return fixtureId(
        `trade-scenario:${league.alias}:${scenarioAlias}:${scenarioIdSequence}`
      );
    },
  });
  const createService = createTradeProposalService({
    leagueAuthorization,
    teamAuthorization,
    repository: tradeRepository,
    clock,
    secureRandom,
  });
  const lifecycleService = createRespondToTradeProposalService({
    leagueAuthorization,
    teamAuthorization,
    repository: tradeRepository,
    clock,
    secureRandom,
  });
  const previewService = createPreviewTradeAcceptanceService({
    leagueAuthorization,
    teamAuthorization,
    repository: tradeRepository,
    clock,
  });
  const acceptanceService = createAcceptTradeProposalService({
    leagueAuthorization,
    teamAuthorization,
    repository: tradeRepository,
    lateLockCoordinator,
    clock,
    secureRandom,
  });
  const authenticated = Object.freeze({
    valid: true,
    user: Object.freeze({ id: accounts[league.commissionerAlias].id }),
    session: Object.freeze({ userId: accounts[league.commissionerAlias].id }),
  });

  function beginScenario(alias, occurredAtMs) {
    scenarioAlias = alias;
    scenarioIdSequence = 0;
    nowMs = occurredAtMs;
  }

  function createScenario(alias, occurredAtMs, input) {
    beginScenario(alias, occurredAtMs);
    return createService.create({
      leagueId: league.leagueId,
      input,
      idempotencyKey: `release-qa:${league.alias}:${alias}:create`,
      authenticated,
    });
  }

  const completed = createScenario(
    "accepted",
    FIXTURE_NOW_MS + 10_000,
    {
      proposingTeamId: league.teams[0].id,
      receivingTeamId: league.teams[1].id,
      proposingAssets: [{
        type: "prospect_right",
        playerId: players.team1Prospect1.id,
      }],
      receivingAssets: [{
        type: "prospect_right",
        playerId: players.team2Prospect2.id,
      }],
    }
  );
  nowMs = FIXTURE_NOW_MS + 11_000;
  const acceptedResult = acceptanceService.accept({
    leagueId: league.leagueId,
    input: { tradeId: completed.proposal.id },
    idempotencyKey: `release-qa:${league.alias}:accepted:execute`,
    authenticated,
  }).then((accepted) => {
    if (
      accepted.proposal.storageStatus !== "completed" ||
      accepted.generallyIllegal ||
      accepted.lateLock.status !== "not_applicable"
    ) {
      fail(
        "RELEASE_QA_COMPLETED_TRADE_REQUIRED",
        `The ${league.alias} accepted trade did not complete legally with ` +
          "its deterministic late-lock receipt."
      );
    }
    return accepted;
  });

  const rejected = createScenario(
    "rejected",
    FIXTURE_NOW_MS + 20_000,
    {
      proposingTeamId: league.teams[2].id,
      receivingTeamId: league.teams[3].id,
      proposingAssets: [{
        type: "contract",
        contractId: leagueState.contracts.activeForward3.id,
      }],
      receivingAssets: [{
        type: "contract",
        contractId: leagueState.contracts.activeForward4.id,
      }],
    }
  );
  nowMs = FIXTURE_NOW_MS + 21_000;
  const rejectedResult = lifecycleService.respond({
    leagueId: league.leagueId,
    input: { tradeId: rejected.proposal.id, action: "reject" },
    idempotencyKey: `release-qa:${league.alias}:rejected:respond`,
    authenticated,
  });
  if (rejectedResult.proposal.storageStatus !== "declined") {
    fail(
      "RELEASE_QA_REJECTED_TRADE_REQUIRED",
      `The ${league.alias} rejected trade did not persist as declined.`
    );
  }

  const invalidCap = createScenario(
    "invalid-cap",
    FIXTURE_NOW_MS + 30_000,
    {
      proposingTeamId: league.teams[5].id,
      receivingTeamId: league.teams[2].id,
      proposingAssets: [
        {
          type: "contract",
          contractId: leagueState.contracts.activeForward6.id,
        },
        {
          type: "buyout_obligation",
          buyoutObligationId: leagueState.buyoutId,
        },
      ],
      receivingAssets: [{
        type: "contract",
        contractId: leagueState.contracts.injuredReserveForward.id,
      }],
    }
  );
  const invalidCapPreview = previewService.preview({
    leagueId: league.leagueId,
    input: { tradeId: invalidCap.proposal.id },
    authenticated,
  });
  const receivingCapIssue = invalidCapPreview.teams
    .find(({ teamId }) => teamId === league.teams[2].id)
    ?.issues.some(({ code }) => code === "SALARY_CAP_EXCEEDED");
  if (!invalidCapPreview.generallyIllegal || !receivingCapIssue) {
    fail(
      "RELEASE_QA_INVALID_CAP_PREFLIGHT_REQUIRED",
      `The ${league.alias} invalid-cap trade did not fail real cap preflight.`
    );
  }

  createScenario(
    "simultaneous-one",
    FIXTURE_NOW_MS + 40_000,
    {
      proposingTeamId: league.teams[1].id,
      receivingTeamId: league.teams[0].id,
      proposingAssets: [{
        type: "contract",
        contractId: leagueState.contracts.activeForward2.id,
      }],
      receivingAssets: [{
        type: "contract",
        contractId: leagueState.contracts.activeForward1.id,
      }],
    }
  );
  createScenario(
    "simultaneous-two",
    FIXTURE_NOW_MS + 50_000,
    {
      proposingTeamId: league.teams[1].id,
      receivingTeamId: league.teams[2].id,
      proposingAssets: [{
        type: "contract",
        contractId: leagueState.contracts.activeForward2.id,
      }],
      receivingAssets: [{
        type: "contract",
        contractId: leagueState.contracts.activeForward9.id,
      }],
    }
  );
  return acceptedResult;
}

function insertMatchupAndReleaseSignals(
  database,
  league,
  leagueState,
  players,
  accounts,
  statSourceId,
  { leagueOutboxWriter, notificationWriter }
) {
  const day = 86_400_000;
  const matchupWeekCount = 22;
  const priorWeekId = fixtureId(`matchup-week:${league.alias}:prior`);
  const currentWeekId = fixtureId(`matchup-week:${league.alias}:current`);
  const insertWeek = database.prepare(`
    INSERT INTO matchup_weeks (
      id, league_id, season_id, week_key, sequence,
      starts_at_ms, baseline_at_ms, locks_at_ms, ends_at_ms,
      rolls_over_at_ms, status, created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  insertWeek.run(
    priorWeekId, league.leagueId, league.seasons[0].id, "week-01", 1,
    FIXTURE_NOW_MS - 14 * day, FIXTURE_NOW_MS - 14 * day,
    FIXTURE_NOW_MS - 13 * day, FIXTURE_NOW_MS - 8 * day,
    FIXTURE_NOW_MS - 7 * day, "final", FIXTURE_NOW_MS - 14 * day,
    FIXTURE_NOW_MS - 7 * day
  );
  insertWeek.run(
    currentWeekId, league.leagueId, league.seasons[0].id, "week-02", 2,
    FIXTURE_NOW_MS - day, FIXTURE_NOW_MS - day,
    FIXTURE_NOW_MS - 12 * 3_600_000, FIXTURE_NOW_MS + 6 * day,
    FIXTURE_NOW_MS + 7 * day, "scheduled", FIXTURE_NOW_MS - day,
    FIXTURE_NOW_MS
  );
  for (let sequence = 3; sequence <= matchupWeekCount; sequence += 1) {
    const startsAtMs = FIXTURE_NOW_MS - day + (sequence - 2) * 7 * day;
    insertWeek.run(
      fixtureId(`matchup-week:${league.alias}:future:${sequence}`),
      league.leagueId,
      league.seasons[0].id,
      `week-${String(sequence).padStart(2, "0")}`,
      sequence,
      startsAtMs,
      startsAtMs,
      startsAtMs + 15 * 3_600_000,
      startsAtMs + 7 * day,
      startsAtMs + 7 * day,
      "scheduled",
      FIXTURE_NOW_MS,
      FIXTURE_NOW_MS
    );
  }

  const scheduleOperationId = fixtureId(
    `matchup-schedule-operation:${league.alias}`
  );
  const scheduleGeneratedAtMs = FIXTURE_NOW_MS - 14 * day;
  database.prepare(`
    INSERT INTO matchup_operations (
      id, league_id, season_id, matchup_week_id, matchup_id,
      actor_user_id, operation_type, status, reason, metadata_json,
      started_at_ms, completed_at_ms
    ) VALUES (
      ?, ?, ?, NULL, NULL, ?, 'schedule_generate', 'succeeded',
      'release_qa_fixture', ?, ?, ?
    )
  `).run(
    scheduleOperationId,
    league.leagueId,
    league.seasons[0].id,
    accounts[league.commissionerAlias].id,
    JSON.stringify({
      fixture: true,
      generatedWeekCount: matchupWeekCount,
      schemaVersion: 1,
    }),
    scheduleGeneratedAtMs,
    scheduleGeneratedAtMs
  );
  database.prepare(`
    INSERT INTO season_matchup_schedule_generations (
      league_id, season_id, schedule_version,
      schedule_operation_id, week_one_matchup_week_id,
      week_one_starts_at_ms, status, created_at_ms,
      superseded_at_ms, version
    ) VALUES (?, ?, 1, ?, ?, ?, 'current', ?, NULL, 1)
  `).run(
    league.leagueId,
    league.seasons[0].id,
    scheduleOperationId,
    priorWeekId,
    FIXTURE_NOW_MS - 14 * day,
    scheduleGeneratedAtMs
  );

  const priorMatchupId = fixtureId(`matchup:${league.alias}:prior`);
  const insertMatchup = database.prepare(`
    INSERT INTO matchups (
      id, league_id, season_id, matchup_week_id,
      home_team_id, away_team_id, home_team_name, away_team_name,
      status, created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  const roundRobinRounds = (() => {
    const rotating = league.teams.map((_, index) => index);
    const rounds = [];
    for (let roundIndex = 0; roundIndex < rotating.length - 1; roundIndex += 1) {
      const round = [];
      for (let index = 0; index < rotating.length / 2; index += 1) {
        const left = rotating[index];
        const right = rotating[rotating.length - 1 - index];
        round.push(roundIndex % 2 === 0 ? [left, right] : [right, left]);
      }
      rounds.push(round);
      rotating.splice(1, 0, rotating.pop());
    }
    return rounds;
  })();
  const pairings = roundRobinRounds[0];
  pairings.forEach(([homeIndex, awayIndex], index) => {
    const suffix = index === 0 ? "" : `:${index + 1}`;
    insertMatchup.run(
      fixtureId(`matchup:${league.alias}:prior${suffix}`),
      league.leagueId,
      league.seasons[0].id,
      priorWeekId,
      league.teams[homeIndex].id,
      league.teams[awayIndex].id,
      league.teams[homeIndex].name,
      league.teams[awayIndex].name,
      "final",
      FIXTURE_NOW_MS - 14 * day,
      FIXTURE_NOW_MS - 7 * day
    );
    insertMatchup.run(
      fixtureId(`matchup:${league.alias}:current${suffix}`),
      league.leagueId,
      league.seasons[0].id,
      currentWeekId,
      league.teams[homeIndex].id,
      league.teams[awayIndex].id,
      league.teams[homeIndex].name,
      league.teams[awayIndex].name,
      "awaiting_data",
      FIXTURE_NOW_MS - day,
      FIXTURE_NOW_MS
    );
  });
  const futureRounds = roundRobinRounds.slice(1);
  for (let sequence = 3; sequence <= matchupWeekCount; sequence += 1) {
    const weekId = fixtureId(
      `matchup-week:${league.alias}:future:${sequence}`
    );
    const startsAtMs = FIXTURE_NOW_MS - day + (sequence - 2) * 7 * day;
    const round = futureRounds[(sequence - 3) % futureRounds.length];
    round.forEach(([homeIndex, awayIndex], index) => {
      insertMatchup.run(
        fixtureId(
          `matchup:${league.alias}:future:${sequence}:${index + 1}`
        ),
        league.leagueId,
        league.seasons[0].id,
        weekId,
        league.teams[homeIndex].id,
        league.teams[awayIndex].id,
        league.teams[homeIndex].name,
        league.teams[awayIndex].name,
        "scheduled",
        FIXTURE_NOW_MS,
        startsAtMs
      );
    });
  }

  const refreshId = fixtureId(`stat-refresh:${league.alias}`);
  database.prepare(`
    INSERT INTO stat_refreshes (
      id, stat_source_id, nhl_season_key, source_version, status,
      started_at_ms, completed_at_ms, player_count, error_code,
      metadata_json, version
    ) VALUES (?, ?, '20262027', 'release-qa-v4', 'succeeded',
      ?, ?, ?, NULL, ?, 1)
  `).run(
    refreshId,
    statSourceId,
    FIXTURE_NOW_MS - 7 * day,
    FIXTURE_NOW_MS - 7 * day,
    PLAYER_BLUEPRINTS.length,
    JSON.stringify({
      fixture: true,
      leagueAlias: league.alias,
      sourceKind: "synthetic_release_qa",
    })
  );
  const insertTotal = database.prepare(`
    INSERT INTO player_stat_totals (
      id, stat_source_id, refresh_id, nhl_season_key, player_id,
      games_played, goals, assists, nhl_points, fantasy_points_hundredths,
      source_updated_at_ms, created_at_ms
    ) VALUES (?, ?, ?, '20262027', ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const totalsByPlayerId = new Map();
  PLAYER_BLUEPRINTS.forEach((blueprint, index) => {
    const gamesPlayed = 48 + index;
    const goals = 6 + (index % 11);
    const assists = 9 + ((index * 2) % 13);
    const fantasyPointsHundredths = goals * 125 + assists * 100;
    const total = Object.freeze({
      gamesPlayed,
      goals,
      assists,
      fantasyPointsHundredths,
    });
    const playerId = players[blueprint.alias].id;
    insertTotal.run(
      fixtureId(`stat-total:${league.alias}:${blueprint.alias}`),
      statSourceId,
      refreshId,
      playerId,
      total.gamesPlayed,
      total.goals,
      total.assists,
      total.goals + total.assists,
      total.fantasyPointsHundredths,
      FIXTURE_NOW_MS - 7 * day,
      FIXTURE_NOW_MS - 7 * day
    );
    totalsByPlayerId.set(playerId, total);
  });

  const playerGameSetId = fixtureId(
    `stat-player-game-set:${league.alias}`
  );
  const capturedAtMs = FIXTURE_NOW_MS - 7 * day;
  const providerIdentity = database.prepare(`
    SELECT external_value
    FROM player_external_ids
    WHERE player_id = ?
      AND provider = 'sportsdataio-discovery-lab'
  `);
  const requiredPlayers = [];
  const coverage = [];
  for (const blueprint of PLAYER_BLUEPRINTS) {
    const playerId = players[blueprint.alias].id;
    const identity = providerIdentity.get(playerId);
    if (typeof identity?.external_value !== "string") {
      fail(
        "RELEASE_QA_PROVIDER_IDENTITY_REQUIRED",
        `The ${league.alias} score fixture is missing a provider player identity.`
      );
    }
    requiredPlayers.push({
      playerId,
      providerPlayerId: identity.external_value,
    });
    coverage.push({
      coverageEntryId: fixtureId(
        `stat-player-game-coverage:${league.alias}:${blueprint.alias}`
      ),
      playerId,
      providerPlayerId: identity.external_value,
      providerTeamId: null,
      disposition: "no_team",
      nhlGameId: null,
      nhlGameScheduledStartsAtMs: null,
    });
  }
  const coverageEvidence = createPlayerGameCoverageSetEvidence({
    setId: playerGameSetId,
    statSourceId,
    refreshId,
    nhlSeasonKey: "20262027",
    provider: "release_qa_fixture",
    sourceVersion: "release-qa-v4",
    capturedAtMs,
    requiredPlayers,
    coverage,
  });
  const observationEvidence = createPlayerGameObservationSetEvidence({
    setId: playerGameSetId,
    statSourceId,
    refreshId,
    nhlSeasonKey: "20262027",
    provider: "release_qa_fixture",
    sourceVersion: "release-qa-v4",
    capturedAtMs,
    observations: [],
  });
  const insertCoverage = database.prepare(`
    INSERT INTO stat_refresh_player_game_coverage_entries (
      id, stat_source_id, refresh_id, observation_set_id,
      nhl_season_key, player_id, provider_player_id,
      provider_team_id, disposition, nhl_game_id,
      nhl_game_scheduled_starts_at_ms, created_at_ms, version
    ) VALUES (
      @coverageEntryId, @statSourceId, @refreshId, @setId,
      '20262027', @playerId, @providerPlayerId,
      NULL, 'no_team', NULL, NULL, @capturedAtMs, 1
    )
  `);
  for (const row of coverage) {
    insertCoverage.run({
      ...row,
      setId: playerGameSetId,
      statSourceId,
      refreshId,
      capturedAtMs,
    });
  }
  database.prepare(`
    INSERT INTO stat_refresh_player_game_sets (
      id, stat_source_id, refresh_id, nhl_season_key, provider,
      source_version, captured_at_ms, required_player_count,
      coverage_entry_count, expected_player_game_count,
      coverage_schema_version, coverage_sha256, observation_count,
      evidence_schema_version, evidence_sha256, created_at_ms, version
    ) VALUES (
      @setId, @statSourceId, @refreshId, '20262027',
      'release_qa_fixture', 'release-qa-v4', @capturedAtMs,
      @requiredPlayerCount, @coverageEntryCount,
      @expectedPlayerGameCount, 1, @coverageSha256,
      @observationCount, 1, @evidenceSha256, @capturedAtMs, 1
    )
  `).run({
    setId: playerGameSetId,
    statSourceId,
    refreshId,
    capturedAtMs,
    requiredPlayerCount: coverageEvidence.requiredPlayerCount,
    coverageEntryCount: coverageEvidence.coverageEntryCount,
    expectedPlayerGameCount: coverageEvidence.expectedPlayerGameCount,
    coverageSha256: coverageEvidence.coverageSha256,
    observationCount: observationEvidence.observationCount,
    evidenceSha256: observationEvidence.evidenceSha256,
  });

  const insertSnapshot = database.prepare(`
    INSERT INTO stat_snapshots (
      id, stat_source_id, source_refresh_id, league_id, season_id,
      matchup_week_id, intended_use, completeness_status,
      freshness_status, captured_at_ms, committed, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'complete', 'fresh', ?, 1, ?)
  `);
  const insertSnapshotPlayer = database.prepare(`
    INSERT INTO stat_snapshot_players (
      id, league_id, stat_snapshot_id, player_id, games_played, goals,
      assists, nhl_points, fantasy_points_hundredths, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertLock = database.prepare(`
    INSERT INTO matchup_roster_locks (
      id, league_id, season_id, matchup_week_id, team_id, lock_type, legal,
      legality_reason_code, locked_at_ms, baseline_snapshot_id,
      source_freshness_status, created_at_ms, version
    ) VALUES (?, ?, ?, ?, ?, 'normal', 1, NULL, ?, ?, 'fresh', ?, 1)
  `);
  const insertLockPlayer = database.prepare(`
    INSERT INTO matchup_roster_players (
      id, league_id, season_id, matchup_roster_lock_id, player_id,
      position_group, slot_number, baseline_games_played, baseline_goals,
      baseline_assists, baseline_fantasy_points_hundredths, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  function insertWeekLocks({ weekAlias, weekId, intendedUse, capturedAtMs, lockedAtMs }) {
    const snapshotIds = new Map();
    league.teams.forEach((team, teamIndex) => {
      const snapshotId = fixtureId(
        `stat-snapshot:${league.alias}:${weekAlias}:${teamIndex + 1}`
      );
      const lockId = fixtureId(
        `matchup-lock:${league.alias}:${weekAlias}:${teamIndex + 1}`
      );
      const activeRoster = leagueState.rosteredPlayersByTeam[team.id]
        .filter(({ rosterCategory }) => rosterCategory === "Active");
      insertSnapshot.run(
        snapshotId,
        statSourceId,
        refreshId,
        league.leagueId,
        league.seasons[0].id,
        weekId,
        intendedUse,
        capturedAtMs,
        capturedAtMs
      );
      insertLock.run(
        lockId,
        league.leagueId,
        league.seasons[0].id,
        weekId,
        team.id,
        lockedAtMs,
        snapshotId,
        lockedAtMs
      );
      activeRoster.forEach((rosteredPlayer, rosterIndex) => {
        const total = totalsByPlayerId.get(rosteredPlayer.playerId);
        const goalDelta = 1 + ((rosterIndex + teamIndex) % 2);
        const assistDelta =
          1 + ((rosterIndex + teamIndex) % 2) + (teamIndex % 3);
        const baselineGoals = total.goals - goalDelta;
        const baselineAssists = total.assists - assistDelta;
        const baselineFantasyPointsHundredths =
          baselineGoals * 125 + baselineAssists * 100;
        insertSnapshotPlayer.run(
          fixtureId(
            `stat-snapshot-player:${league.alias}:${weekAlias}:${teamIndex + 1}:${rosteredPlayer.playerId}`
          ),
          league.leagueId,
          snapshotId,
          rosteredPlayer.playerId,
          total.gamesPlayed - 1,
          baselineGoals,
          baselineAssists,
          baselineGoals + baselineAssists,
          baselineFantasyPointsHundredths,
          capturedAtMs
        );
        insertLockPlayer.run(
          fixtureId(
            `matchup-lock-player:${league.alias}:${weekAlias}:${teamIndex + 1}:${rosteredPlayer.playerId}`
          ),
          league.leagueId,
          league.seasons[0].id,
          lockId,
          rosteredPlayer.playerId,
          rosteredPlayer.positionGroup,
          rosteredPlayer.slotNumber,
          total.gamesPlayed - 1,
          baselineGoals,
          baselineAssists,
          baselineFantasyPointsHundredths,
          lockedAtMs
        );
      });
      snapshotIds.set(team.id, snapshotId);
    });
    return snapshotIds;
  }
  const priorSnapshotIds = insertWeekLocks({
    weekAlias: "prior",
    weekId: priorWeekId,
    intendedUse: "matchup_final",
    capturedAtMs: FIXTURE_NOW_MS - 7 * day,
    lockedAtMs: FIXTURE_NOW_MS - 13 * day,
  });
  insertWeekLocks({
    weekAlias: "current",
    weekId: currentWeekId,
    intendedUse: "matchup_baseline",
    capturedAtMs: FIXTURE_NOW_MS - day,
    lockedAtMs: FIXTURE_NOW_MS - 12 * 3_600_000,
  });

  const resultId = fixtureId(`matchup-result:${league.alias}`);
  const resultVersionId = fixtureId(`matchup-result-version:${league.alias}`);
  const [resultHomeIndex, resultAwayIndex] = pairings[0];
  database.prepare(`
    INSERT INTO matchup_results (
      id, league_id, season_id, matchup_id, current_version_id,
      status, finalized_at_ms, created_at_ms, updated_at_ms, version
    ) VALUES (?, ?, ?, ?, NULL, 'official', ?, ?, ?, 1)
  `).run(
    resultId, league.leagueId, league.seasons[0].id, priorMatchupId,
    FIXTURE_NOW_MS - 7 * day, FIXTURE_NOW_MS - 14 * day,
    FIXTURE_NOW_MS - 7 * day
  );
  database.prepare(`
    INSERT INTO matchup_result_versions (
      id, league_id, season_id, matchup_result_id, version_number,
      home_team_id, away_team_id, home_score_hundredths,
      away_score_hundredths, outcome, source_snapshot_id,
      source_type, actor_user_id, reason, supersedes_version_id, created_at_ms
    ) VALUES (?, ?, ?, ?, 1, ?, ?, 1250, 975, 'home_win', ?,
      'calculated', NULL, NULL, NULL, ?)
  `).run(
    resultVersionId, league.leagueId, league.seasons[0].id, resultId,
    league.teams[resultHomeIndex].id,
    league.teams[resultAwayIndex].id,
    priorSnapshotIds.get(league.teams[resultHomeIndex].id),
    FIXTURE_NOW_MS - 7 * day
  );
  database.prepare(`
    UPDATE matchup_results SET current_version_id = ?, version = version + 1
    WHERE id = ?
  `).run(resultVersionId, resultId);

  const standingsSnapshotId = fixtureId(`standings-snapshot:${league.alias}`);
  database.prepare(`
    INSERT INTO standings_snapshots (
      id, league_id, season_id, snapshot_version, source_result_version,
      status, calculated_at_ms, created_at_ms
    ) VALUES (?, ?, ?, 1, 1, 'current', ?, ?)
  `).run(
    standingsSnapshotId, league.leagueId, league.seasons[0].id,
    FIXTURE_NOW_MS - 7 * day, FIXTURE_NOW_MS - 7 * day
  );
  league.teams.forEach((team, index) => {
    const wins = index === resultHomeIndex ? 1 : 0;
    const losses = index === resultAwayIndex ? 1 : 0;
    const pointsFor = index === resultHomeIndex
      ? 1250
      : index === resultAwayIndex
        ? 975
        : 0;
    const pointsAgainst = index === resultHomeIndex
      ? 975
      : index === resultAwayIndex
        ? 1250
        : 0;
    database.prepare(`
      INSERT INTO standings_rows (
        id, league_id, season_id, standings_snapshot_id, team_id, rank,
        wins, losses, ties, standings_points,
        fantasy_points_for_hundredths, fantasy_points_against_hundredths,
        fantasy_point_differential_hundredths, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
    `).run(
      fixtureId(`standings-row:${league.alias}:${index + 1}`),
      league.leagueId,
      league.seasons[0].id,
      standingsSnapshotId,
      team.id,
      index + 1,
      wins,
      losses,
      wins * 2,
      pointsFor,
      pointsAgainst,
      pointsFor - pointsAgainst,
      FIXTURE_NOW_MS - 7 * day
    );
  });

  database.prepare(`
    INSERT INTO league_activity (
      id, league_id, season_id, event_type, actor_user_id,
      actor_authority, team_id, player_id, related_type, related_id,
      display_summary, reason, metadata_json, occurred_at_ms
    ) VALUES (?, ?, ?, 'release_qa.fixture_ready', ?, 'commissioner',
      ?, NULL, 'league', ?, 'Release QA fixture is ready.',
      NULL, ?, ?)
  `).run(
    fixtureId(`activity:${league.alias}`),
    league.leagueId,
    league.seasons[0].id,
    accounts[league.commissionerAlias].id,
    league.teams[0].id,
    league.leagueId,
    JSON.stringify({ fixture: true, leagueAlias: league.alias }),
    FIXTURE_NOW_MS
  );
  notificationWriter.insert({
    id: fixtureId(`notification:${league.alias}`),
    userId: accounts[league.commissionerAlias].id,
    leagueId: league.leagueId,
    eventType: "release_qa.fixture_ready",
    messageDataJson: JSON.stringify({
      message: "Release QA fixture ready",
    }),
    relatedFeature: "release_qa",
    relatedRecordId: league.leagueId,
    deliveryStatus: "delivered",
    createdAtMs: FIXTURE_NOW_MS,
    deliveredAtMs: FIXTURE_NOW_MS,
    deduplicationKey: null,
  });
  const capturedEmailEventId =
    fixtureId(`captured-email:${league.alias}`);
  leagueOutboxWriter.write({
    id: capturedEmailEventId,
    leagueId: league.leagueId,
    eventType: "release_qa.email_captured",
    aggregateType: "league",
    aggregateId: league.leagueId,
    payload: {
      kind: "invalidation",
      eventType: "release_qa.email_captured",
      scope: "league",
      scopeId: league.leagueId,
      version: 1,
      changedAtMs: FIXTURE_NOW_MS,
    },
    occurredAtMs: FIXTURE_NOW_MS,
  });
  const capturedEmailPublication = database.prepare(`
    UPDATE outbox_events
    SET status = 'published',
        attempt_count = 1,
        published_at_ms = @publishedAtMs,
        updated_at_ms = @publishedAtMs,
        version = version + 1
    WHERE id = @eventId
      AND league_id = @leagueId
      AND status = 'pending'
      AND version = 1
  `).run({
    eventId: capturedEmailEventId,
    leagueId: league.leagueId,
    publishedAtMs: FIXTURE_NOW_MS,
  });
  if (capturedEmailPublication.changes !== 1) {
    throw new Error(
      "The release-QA captured-email event could not be finalized."
    );
  }
}

function seedFixture(
  database,
  passwordHash,
  { includeIdentityMetadata = true } = {}
) {
  if (includeIdentityMetadata) {
    const insertMetadata = database.prepare(`
      INSERT INTO application_metadata (
        metadata_key, metadata_value, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?)
    `);
    insertMetadata.run("database_created_at", FIXTURE_CREATED_AT, FIXTURE_NOW_MS, FIXTURE_NOW_MS);
    insertMetadata.run("database_id", FIXTURE_DATABASE_ID, FIXTURE_NOW_MS, FIXTURE_NOW_MS);
    insertMetadata.run("environment_id", FIXTURE_ENVIRONMENT_ID, FIXTURE_NOW_MS, FIXTURE_NOW_MS);
  }

  const accounts = insertAccounts(database, passwordHash);
  const players = insertGlobalPlayers(database);
  const lateLockCoordinator = createReleaseQaNoopLateLockCoordinator();
  const unexpectedCandidateCardWrite = () => {
    throw new Error(
      "The release QA fixture unexpectedly attempted a Candidate Card write."
    );
  };
  const candidateCardRepository = createSqliteCandidateCardRepository({
    database,
    writeMutationSideEffects: unexpectedCandidateCardWrite,
    writeHelpGrantSideEffects: unexpectedCandidateCardWrite,
  });
  const writers = Object.freeze({
    lateLockCoordinator,
    leagueOutboxWriter:
      createSqliteLeagueOutboxWriter({ database }),
    notificationWriter:
      createSqliteNotificationWriter({ database }),
    candidateCardSummerSynchronizer:
      createSqliteCandidateCardSummerSynchronizer({
        database,
        candidateCardRepository,
      }),
  });
  const statSourceId = fixtureId("stat-source");
  database.prepare(`
    INSERT INTO stat_sources (
      id, provider, status, created_at_ms, updated_at_ms, version
    ) VALUES (?, 'release_qa_fixture', 'active', ?, ?, 1)
  `).run(statSourceId, FIXTURE_NOW_MS, FIXTURE_NOW_MS);

  const acceptancePromises = [];
  for (const leagueAlias of LEAGUE_ALIASES) {
    const league = insertLeagueBase(database, leagueAlias, accounts);
    const leagueState = insertLeaguePlayerState(database, league, players, accounts);
    acceptancePromises.push(
      insertAuctionAndTrades(
        database,
        league,
        leagueState,
        players,
        accounts,
        writers
      )
    );
    insertMatchupAndReleaseSignals(
      database,
      league,
      leagueState,
      players,
      accounts,
      statSourceId,
      writers
    );
  }
  return Object.freeze({
    acceptancePromises: Object.freeze(acceptancePromises),
    assertLateLockCoverage: lateLockCoordinator.assertComplete,
  });
}

async function createReleaseQaFixture({
  databasePath,
  environment,
  migrationsDirectory,
  password,
  providerCatalogSourceDatabasePath,
  temporaryRoot,
} = {}) {
  const resolvedDatabasePath = assertSafeFixturePath({
    databasePath,
    environment,
    temporaryRoot,
  });
  const resolvedProviderCatalogSourcePath =
    assertProviderCatalogSourcePath({
      providerCatalogSourceDatabasePath,
      targetDatabasePath: resolvedDatabasePath,
    });
  if (!path.isAbsolute(migrationsDirectory || "")) {
    fail(
      "RELEASE_QA_MIGRATIONS_REQUIRED",
      "An absolute migrations directory is required."
    );
  }
  if (typeof password !== "string" || password.length === 0) {
    fail(
      "RELEASE_QA_PASSWORD_REQUIRED",
      "An explicit fixture password is required."
    );
  }

  const passwordHash = await deterministicPasswordHasher().hash(password);
  const connection = openDatabase({
    databasePath: resolvedDatabasePath,
    environment: "test",
  });
  try {
    migrateDatabase({
      database: connection.database,
      migrationsDirectory,
      applicationBuildId: FIXTURE_BUILD_ID,
      now: () => FIXTURE_NOW_MS,
    });
    importProviderCatalogFromDatabase({
      database: connection.database,
      providerCatalogSourceDatabasePath:
        resolvedProviderCatalogSourcePath,
    });
    const seedResult = connection.database.transaction(() =>
      seedFixture(connection.database, passwordHash)
    ).immediate();
    await Promise.all(seedResult.acceptancePromises);
    seedResult.assertLateLockCoverage();
  } catch (error) {
    if (error instanceof ReleaseQaFixtureError) throw error;
    fail(
      "RELEASE_QA_FIXTURE_CREATION_FAILED",
      "The release-QA fixture could not be created.",
      error
    );
  } finally {
    if (connection.database?.open) connection.database.close();
  }

  const manifest = verifyReleaseQaFixture({
    databasePath: resolvedDatabasePath,
  });
  return Object.freeze({
    databasePath: resolvedDatabasePath,
    manifest,
  });
}

module.exports = {
  ReleaseQaFixtureError,
  assertSafeFixturePath,
  createReleaseQaFixture,
  importProviderCatalogFromDatabase,
  seedFixture,
};
