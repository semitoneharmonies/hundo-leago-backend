#!/usr/bin/env node

const {
  openReadonlyDatabase,
} = require("../src/infrastructure/database/connection");

class AuthorityPreviewArgumentError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthorityPreviewArgumentError";
    this.code = "AUTHORITY_PREVIEW_ARGUMENT_INVALID";
  }
}

function parseArguments(argv) {
  if (
    !Array.isArray(argv) ||
    argv.length !== 2 ||
    argv[0] !== "--database" ||
    typeof argv[1] !== "string" ||
    argv[1].trim() === ""
  ) {
    throw new AuthorityPreviewArgumentError(
      "Usage: preview-m7-26-authority-reconciliation --database <existing-sqlite-path>"
    );
  }
  return Object.freeze({ databasePath: argv[1].trim() });
}

function freezeRows(rows) {
  return Object.freeze(
    rows.map((row) => Object.freeze({ ...row }))
  );
}

function previewAuthorityReconciliation(
  database,
  { enforceQueryOnly = true } = {}
) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError(
      "authority reconciliation preview requires an opened SQLite database"
    );
  }
  if (typeof enforceQueryOnly !== "boolean") {
    throw new TypeError(
      "authority reconciliation preview requires an exact query-only option"
    );
  }
  if (enforceQueryOnly) database.pragma("query_only = ON");

  const missingAdministratorMemberships = freezeRows(
    database.prepare(`
      SELECT
        leagues.id AS leagueId,
        leagues.name AS leagueName,
        platform_roles.user_id AS userId
      FROM platform_roles
      CROSS JOIN leagues
      WHERE platform_roles.role = 'platform_administrator'
        AND platform_roles.status = 'active'
        AND platform_roles.ended_at_ms IS NULL
        AND leagues.status <> 'deleted'
        AND NOT EXISTS (
          SELECT 1
          FROM league_memberships
          WHERE league_memberships.league_id = leagues.id
            AND league_memberships.user_id = platform_roles.user_id
            AND league_memberships.status = 'active'
        )
      ORDER BY leagues.id, platform_roles.user_id
    `).all()
  );

  const nonCanonicalAdministratorMemberships = freezeRows(
    database.prepare(`
      SELECT
        league_memberships.league_id AS leagueId,
        league_memberships.id AS membershipId,
        league_memberships.user_id AS userId,
        league_memberships.permission_category AS permissionCategory,
        league_memberships.status AS membershipStatus,
        league_memberships.joined_at_ms AS joinedAtMs,
        league_memberships.ended_at_ms AS endedAtMs
      FROM league_memberships
      JOIN platform_roles
        ON platform_roles.user_id = league_memberships.user_id
       AND platform_roles.role = 'platform_administrator'
       AND platform_roles.status = 'active'
       AND platform_roles.ended_at_ms IS NULL
      JOIN leagues ON leagues.id = league_memberships.league_id
      WHERE leagues.status <> 'deleted'
        AND league_memberships.status = 'active'
        AND (
          league_memberships.permission_category <> 'member'
          OR league_memberships.joined_at_ms IS NULL
          OR league_memberships.ended_at_ms IS NOT NULL
        )
      ORDER BY league_memberships.league_id, league_memberships.id
    `).all()
  );

  const protectedAdministratorTeamAssignments = freezeRows(
    database.prepare(`
      SELECT
        team_manager_assignments.league_id AS leagueId,
        team_manager_assignments.team_id AS teamId,
        team_manager_assignments.id AS assignmentId,
        team_manager_assignments.user_id AS userId,
        team_manager_assignments.status AS assignmentStatus
      FROM team_manager_assignments
      JOIN platform_roles
        ON platform_roles.user_id = team_manager_assignments.user_id
       AND platform_roles.role = 'platform_administrator'
       AND platform_roles.status = 'active'
       AND platform_roles.ended_at_ms IS NULL
      WHERE team_manager_assignments.status IN ('pending', 'accepted')
        AND team_manager_assignments.ended_at_ms IS NULL
      ORDER BY team_manager_assignments.league_id,
        team_manager_assignments.team_id,
        team_manager_assignments.id
    `).all()
  );

  const invalidCommissionerCardinality = freezeRows(
    database.prepare(`
      SELECT
        leagues.id AS leagueId,
        leagues.name AS leagueName,
        leagues.status AS leagueStatus,
        COUNT(league_memberships.id) AS activeCommissionerCount
      FROM leagues
      LEFT JOIN league_memberships
        ON league_memberships.league_id = leagues.id
       AND league_memberships.permission_category = 'commissioner'
       AND league_memberships.status = 'active'
      WHERE leagues.status <> 'deleted'
      GROUP BY leagues.id
      HAVING COUNT(league_memberships.id) <> 1
      ORDER BY leagues.id
    `).all()
  );

  const invalidCommissionerPointers = freezeRows(
    database.prepare(`
      SELECT
        leagues.id AS leagueId,
        leagues.name AS leagueName,
        leagues.commissioner_membership_id AS commissionerMembershipId,
        COUNT(league_memberships.id) AS matchingActiveCommissionerCount
      FROM leagues
      LEFT JOIN league_memberships
        ON league_memberships.league_id = leagues.id
       AND league_memberships.id = leagues.commissioner_membership_id
       AND league_memberships.permission_category = 'commissioner'
       AND league_memberships.status = 'active'
      WHERE leagues.status <> 'deleted'
      GROUP BY leagues.id
      HAVING leagues.commissioner_membership_id IS NULL
        OR COUNT(league_memberships.id) <> 1
      ORDER BY leagues.id
    `).all()
  );

  const duplicatePendingCommissionerTransfers = freezeRows(
    database.prepare(`
      SELECT
        league_id AS leagueId,
        COUNT(*) AS pendingTransferCount
      FROM league_invitations
      WHERE workflow IS NULL
        AND status = 'pending'
      GROUP BY league_id
      HAVING COUNT(*) > 1
      ORDER BY league_id
    `).all()
  );

  const findings = Object.freeze({
    missingAdministratorMemberships,
    nonCanonicalAdministratorMemberships,
    protectedAdministratorTeamAssignments,
    invalidCommissionerCardinality,
    invalidCommissionerPointers,
    duplicatePendingCommissionerTransfers,
  });
  const mutationRequired =
    missingAdministratorMemberships.length > 0 ||
    nonCanonicalAdministratorMemberships.length > 0 ||
    invalidCommissionerCardinality.length > 0 ||
    invalidCommissionerPointers.length > 0 ||
    duplicatePendingCommissionerTransfers.length > 0;

  return Object.freeze({
    code: "AUTHORITY_RECONCILIATION_PREVIEW_COMPLETE",
    readOnly: true,
    mutationRequired,
    findings,
  });
}

function runPreviewCommand({
  argv = process.argv.slice(2),
  output = console,
} = {}) {
  const { databasePath } = parseArguments(argv);
  const database = openReadonlyDatabase({ databasePath });
  try {
    const result = previewAuthorityReconciliation(database);
    output.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    database.close();
  }
}

function main() {
  try {
    runPreviewCommand();
  } catch (error) {
    console.error(
      JSON.stringify({
        error: {
          code: error?.code || "AUTHORITY_PREVIEW_FAILED",
          message:
            error?.message ||
            "The authority reconciliation preview failed safely.",
        },
      })
    );
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  AuthorityPreviewArgumentError,
  parseArguments,
  previewAuthorityReconciliation,
  runPreviewCommand,
};
