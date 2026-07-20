const {
  REPOSITORY_ERROR_CODES,
  repositoryError,
} = require("./SqliteRepositoryError");

const REPOSITORY_SCOPES = Object.freeze({
  global: "global",
  requiredLeague: "required_league",
  optionalLeague: "optional_league",
});

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]*$/;

function repositoryDefinition(
  tableName,
  scope,
  {
    keyColumn = "id",
    versioned = false,
  } = {}
) {
  return Object.freeze({
    tableName,
    scope,
    keyColumn,
    versioned,
  });
}

const DEFINITIONS = [
  repositoryDefinition(
    "account_action_tokens",
    REPOSITORY_SCOPES.global,
    { versioned: true }
  ),
  repositoryDefinition(
    "account_events",
    REPOSITORY_SCOPES.global
  ),
  repositoryDefinition(
    "administrator_requests",
    REPOSITORY_SCOPES.requiredLeague,
    { versioned: true }
  ),
  repositoryDefinition(
    "application_metadata",
    REPOSITORY_SCOPES.global,
    { keyColumn: "metadata_key" }
  ),
  repositoryDefinition(
    "auction_bids",
    REPOSITORY_SCOPES.requiredLeague,
    { versioned: true }
  ),
  repositoryDefinition(
    "auction_events",
    REPOSITORY_SCOPES.requiredLeague
  ),
  repositoryDefinition(
    "auction_resolutions",
    REPOSITORY_SCOPES.requiredLeague
  ),
  repositoryDefinition(
    "auctions",
    REPOSITORY_SCOPES.requiredLeague,
    { versioned: true }
  ),
  repositoryDefinition(
    "authentication_rate_limits",
    REPOSITORY_SCOPES.global,
    { versioned: true }
  ),
  repositoryDefinition(
    "backup_catalog",
    REPOSITORY_SCOPES.optionalLeague
  ),
  repositoryDefinition(
    "buyout_obligations",
    REPOSITORY_SCOPES.requiredLeague,
    { versioned: true }
  ),
  repositoryDefinition(
    "buyout_years",
    REPOSITORY_SCOPES.requiredLeague
  ),
  repositoryDefinition(
    "commissioner_corrections",
    REPOSITORY_SCOPES.requiredLeague
  ),
  repositoryDefinition(
    "contract_events",
    REPOSITORY_SCOPES.requiredLeague
  ),
  repositoryDefinition(
    "contract_years",
    REPOSITORY_SCOPES.requiredLeague
  ),
  repositoryDefinition(
    "contracts",
    REPOSITORY_SCOPES.requiredLeague,
    { versioned: true }
  ),
  repositoryDefinition(
    "draft_eligibility_snapshots",
    REPOSITORY_SCOPES.requiredLeague
  ),
  repositoryDefinition(
    "draft_eligible_players",
    REPOSITORY_SCOPES.requiredLeague
  ),
  repositoryDefinition(
    "draft_events",
    REPOSITORY_SCOPES.requiredLeague
  ),
  repositoryDefinition(
    "draft_lottery_results",
    REPOSITORY_SCOPES.requiredLeague
  ),
  repositoryDefinition(
    "draft_lottery_runs",
    REPOSITORY_SCOPES.requiredLeague
  ),
  repositoryDefinition(
    "draft_pick_ownership_events",
    REPOSITORY_SCOPES.requiredLeague
  ),
  repositoryDefinition(
    "draft_picks",
    REPOSITORY_SCOPES.requiredLeague,
    { versioned: true }
  ),
  repositoryDefinition(
    "draft_queue_items",
    REPOSITORY_SCOPES.requiredLeague,
    { versioned: true }
  ),
  repositoryDefinition(
    "draft_selections",
    REPOSITORY_SCOPES.requiredLeague
  ),
  repositoryDefinition(
    "entry_drafts",
    REPOSITORY_SCOPES.requiredLeague,
    { versioned: true }
  ),
  repositoryDefinition(
    "future_considerations",
    REPOSITORY_SCOPES.requiredLeague,
    { versioned: true }
  ),
  repositoryDefinition(
    "idempotency_requests",
    REPOSITORY_SCOPES.optionalLeague
  ),
  repositoryDefinition(
    "job_runs",
    REPOSITORY_SCOPES.optionalLeague,
    { versioned: true }
  ),
  repositoryDefinition(
    "league_activity",
    REPOSITORY_SCOPES.requiredLeague
  ),
  repositoryDefinition(
    "league_freezes",
    REPOSITORY_SCOPES.requiredLeague,
    { versioned: true }
  ),
  repositoryDefinition(
    "league_invitations",
    REPOSITORY_SCOPES.requiredLeague,
    { versioned: true }
  ),
  repositoryDefinition(
    "league_memberships",
    REPOSITORY_SCOPES.requiredLeague,
    { versioned: true }
  ),
  repositoryDefinition(
    "league_player_positions",
    REPOSITORY_SCOPES.requiredLeague,
    { versioned: true }
  ),
  repositoryDefinition(
    "league_settings",
    REPOSITORY_SCOPES.requiredLeague,
    {
      keyColumn: "league_id",
      versioned: true,
    }
  ),
  repositoryDefinition(
    "leagues",
    REPOSITORY_SCOPES.global,
    { versioned: true }
  ),
  repositoryDefinition(
    "matchup_byes",
    REPOSITORY_SCOPES.requiredLeague
  ),
  repositoryDefinition(
    "matchup_operations",
    REPOSITORY_SCOPES.requiredLeague
  ),
  repositoryDefinition(
    "matchup_result_versions",
    REPOSITORY_SCOPES.requiredLeague
  ),
  repositoryDefinition(
    "matchup_results",
    REPOSITORY_SCOPES.requiredLeague,
    { versioned: true }
  ),
  repositoryDefinition(
    "matchup_roster_locks",
    REPOSITORY_SCOPES.requiredLeague,
    { versioned: true }
  ),
  repositoryDefinition(
    "matchup_roster_players",
    REPOSITORY_SCOPES.requiredLeague
  ),
  repositoryDefinition(
    "matchup_weeks",
    REPOSITORY_SCOPES.requiredLeague,
    { versioned: true }
  ),
  repositoryDefinition(
    "matchups",
    REPOSITORY_SCOPES.requiredLeague,
    { versioned: true }
  ),
  repositoryDefinition(
    "migration_reports",
    REPOSITORY_SCOPES.optionalLeague
  ),
  repositoryDefinition(
    "notifications",
    REPOSITORY_SCOPES.optionalLeague,
    { versioned: true }
  ),
  repositoryDefinition(
    "operational_events",
    REPOSITORY_SCOPES.optionalLeague
  ),
  repositoryDefinition(
    "outbox_events",
    REPOSITORY_SCOPES.optionalLeague,
    { versioned: true }
  ),
  repositoryDefinition(
    "ownership_events",
    REPOSITORY_SCOPES.requiredLeague
  ),
  repositoryDefinition(
    "platform_roles",
    REPOSITORY_SCOPES.global,
    { versioned: true }
  ),
  repositoryDefinition(
    "player_external_ids",
    REPOSITORY_SCOPES.global
  ),
  repositoryDefinition(
    "player_names",
    REPOSITORY_SCOPES.global
  ),
  repositoryDefinition(
    "player_ownerships",
    REPOSITORY_SCOPES.requiredLeague,
    { versioned: true }
  ),
  repositoryDefinition(
    "player_source_state",
    REPOSITORY_SCOPES.global
  ),
  repositoryDefinition(
    "player_stat_totals",
    REPOSITORY_SCOPES.global
  ),
  repositoryDefinition(
    "players",
    REPOSITORY_SCOPES.global,
    { versioned: true }
  ),
  repositoryDefinition(
    "retention_obligations",
    REPOSITORY_SCOPES.requiredLeague,
    { versioned: true }
  ),
  repositoryDefinition(
    "retention_years",
    REPOSITORY_SCOPES.requiredLeague
  ),
  repositoryDefinition(
    "seasons",
    REPOSITORY_SCOPES.requiredLeague,
    { versioned: true }
  ),
  repositoryDefinition(
    "security_audit_events",
    REPOSITORY_SCOPES.optionalLeague
  ),
  repositoryDefinition(
    "sessions",
    REPOSITORY_SCOPES.global,
    { versioned: true }
  ),
  repositoryDefinition(
    "standings_operations",
    REPOSITORY_SCOPES.requiredLeague
  ),
  repositoryDefinition(
    "standings_rows",
    REPOSITORY_SCOPES.requiredLeague
  ),
  repositoryDefinition(
    "standings_snapshots",
    REPOSITORY_SCOPES.requiredLeague
  ),
  repositoryDefinition(
    "stat_refreshes",
    REPOSITORY_SCOPES.global,
    { versioned: true }
  ),
  repositoryDefinition(
    "stat_snapshot_players",
    REPOSITORY_SCOPES.optionalLeague
  ),
  repositoryDefinition(
    "stat_snapshots",
    REPOSITORY_SCOPES.optionalLeague
  ),
  repositoryDefinition(
    "stat_sources",
    REPOSITORY_SCOPES.global,
    { versioned: true }
  ),
  repositoryDefinition(
    "team_events",
    REPOSITORY_SCOPES.requiredLeague
  ),
  repositoryDefinition(
    "team_manager_assignments",
    REPOSITORY_SCOPES.requiredLeague,
    { versioned: true }
  ),
  repositoryDefinition(
    "teams",
    REPOSITORY_SCOPES.requiredLeague,
    { versioned: true }
  ),
  repositoryDefinition(
    "trade_assets",
    REPOSITORY_SCOPES.requiredLeague
  ),
  repositoryDefinition(
    "trade_events",
    REPOSITORY_SCOPES.requiredLeague
  ),
  repositoryDefinition(
    "trades",
    REPOSITORY_SCOPES.requiredLeague,
    { versioned: true }
  ),
  repositoryDefinition(
    "user_credentials",
    REPOSITORY_SCOPES.global,
    { versioned: true }
  ),
  repositoryDefinition(
    "users",
    REPOSITORY_SCOPES.global,
    { versioned: true }
  ),
];

function validateRepositoryCatalog(definitions) {
  if (!Array.isArray(definitions) || definitions.length === 0) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.catalogInvalid,
      "The repository catalog must contain definitions."
    );
  }

  const validScopes = new Set(Object.values(REPOSITORY_SCOPES));
  const tableNames = new Set();

  for (const definition of definitions) {
    if (
      !definition ||
      !IDENTIFIER_PATTERN.test(definition.tableName || "") ||
      !IDENTIFIER_PATTERN.test(definition.keyColumn || "") ||
      !validScopes.has(definition.scope) ||
      typeof definition.versioned !== "boolean"
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.catalogInvalid,
        "The repository catalog contains an invalid definition."
      );
    }

    if (tableNames.has(definition.tableName)) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.catalogInvalid,
        "The repository catalog contains a duplicate table.",
        { details: { tableName: definition.tableName } }
      );
    }
    tableNames.add(definition.tableName);
  }

  return true;
}

validateRepositoryCatalog(DEFINITIONS);

const REPOSITORY_CATALOG = Object.freeze([...DEFINITIONS]);
const REPOSITORY_CATALOG_BY_TABLE = Object.freeze(
  Object.fromEntries(
    REPOSITORY_CATALOG.map((definition) => [
      definition.tableName,
      definition,
    ])
  )
);

function getRepositoryDefinition(tableName) {
  if (
    typeof tableName !== "string" ||
    !REPOSITORY_CATALOG_BY_TABLE[tableName]
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "An approved repository table name is required."
    );
  }

  return REPOSITORY_CATALOG_BY_TABLE[tableName];
}

module.exports = {
  IDENTIFIER_PATTERN,
  REPOSITORY_CATALOG,
  REPOSITORY_SCOPES,
  getRepositoryDefinition,
  validateRepositoryCatalog,
};
