const crypto = require("node:crypto");
const fs = require("node:fs");

const {
  canonicalize,
} = require("./sourceInventory");
const {
  REPOSITORY_CATALOG,
} = require("../persistence/sqlite/repositoryCatalog");

const RESET_MANIFEST_ID = "2026-season-1-reset-v1";
const RESET_MANIFEST_VERSION = 1;
const APPLICABLE_SOURCE_BUNDLE_MANIFEST_VERSION = 1;
const REQUIRED_OPERATING_MODE = "OFFSEASON_RESET";
const APPROVAL_AUTHORITY = "Grae";
const APPROVAL_REFERENCE =
  "docs/01-project/OPERATING_MODE.md";
const APPROVAL_DATE = "2026-07-14";

const SEASON_1_SELECTION_RULE =
  "source_records_explicitly_classified_as_season_1_by_the_import_transform";
const OMITTED_COUNT_TREATMENT =
  "source_count_equals_reported_omitted_count";
const OMITTED_TARGET_TREATMENT = "do_not_insert";

const RESET_MANIFEST_ERROR_CODES = Object.freeze({
  argumentInvalid: "RESET_MANIFEST_ARGUMENT_INVALID",
  parseFailed: "RESET_MANIFEST_PARSE_FAILED",
  shapeInvalid: "RESET_MANIFEST_SHAPE_INVALID",
  checksumMismatch: "RESET_MANIFEST_CHECKSUM_MISMATCH",
  policyMismatch: "RESET_MANIFEST_POLICY_MISMATCH",
  operatingModeMismatch:
    "RESET_MANIFEST_OPERATING_MODE_MISMATCH",
  sourceVersionMismatch:
    "RESET_MANIFEST_SOURCE_VERSION_MISMATCH",
  noncanonical: "RESET_MANIFEST_NONCANONICAL",
});

class ResetManifestError extends Error {
  constructor(code, message, { cause } = {}) {
    super(
      message,
      cause === undefined ? undefined : { cause }
    );
    this.name = "ResetManifestError";
    this.code = code;
  }
}

function resetManifestError(code, message, options) {
  return new ResetManifestError(code, message, options);
}

function deepFreeze(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.isFrozen(value)
  ) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function omissionFamily(familyId, targetTables, reason) {
  return {
    familyId,
    targetTables,
    selectionRule: SEASON_1_SELECTION_RULE,
    countTreatment: OMITTED_COUNT_TREATMENT,
    targetTreatment: OMITTED_TARGET_TREATMENT,
    reason,
  };
}

const RESET_OMISSION_POLICY = deepFreeze([
  omissionFamily(
    "season_1_season_containers",
    ["seasons"],
    "Season 1 competition containers are omitted to establish the clean Season 2 competition boundary."
  ),
  omissionFamily(
    "season_1_teams",
    ["teams", "team_manager_assignments", "team_events"],
    "Existing Season 1 team records are within the approved clean Season 2 reset scope."
  ),
  omissionFamily(
    "season_1_rosters",
    ["player_ownerships", "ownership_events"],
    "Existing Season 1 roster and ownership records are within the approved clean Season 2 reset scope."
  ),
  omissionFamily(
    "season_1_contracts",
    ["contracts", "contract_years", "contract_events"],
    "Existing Season 1 contract records are within the approved clean Season 2 reset scope."
  ),
  omissionFamily(
    "season_1_retention",
    ["retention_obligations", "retention_years"],
    "Existing Season 1 retained-salary records are within the approved clean Season 2 reset scope."
  ),
  omissionFamily(
    "season_1_buyouts",
    ["buyout_obligations", "buyout_years"],
    "Existing Season 1 buyout records are within the approved clean Season 2 reset scope."
  ),
  omissionFamily(
    "season_1_trades",
    [
      "trades",
      "trade_assets",
      "trade_events",
      "future_considerations",
    ],
    "Existing Season 1 trade records are within the approved clean Season 2 reset scope."
  ),
  omissionFamily(
    "season_1_auctions",
    [
      "auctions",
      "auction_bids",
      "auction_events",
      "auction_resolutions",
    ],
    "Existing Season 1 auction history is within the approved clean Season 2 reset scope."
  ),
  omissionFamily(
    "season_1_matchups",
    [
      "matchup_weeks",
      "matchups",
      "matchup_byes",
      "matchup_roster_locks",
      "matchup_roster_players",
      "matchup_results",
      "matchup_result_versions",
      "matchup_operations",
      "stat_snapshots",
      "stat_snapshot_players",
    ],
    "Existing Season 1 matchup and competition-stat snapshot records are within the approved clean Season 2 reset scope."
  ),
  omissionFamily(
    "season_1_standings",
    [
      "standings_snapshots",
      "standings_rows",
      "standings_operations",
    ],
    "Existing Season 1 standings records are within the approved clean Season 2 reset scope."
  ),
  omissionFamily(
    "season_1_competition_activity",
    ["league_activity"],
    "Season 1 competition activity tied to reset teams is omitted with the approved Season 1 records."
  ),
  omissionFamily(
    "season_1_competition_operations",
    [
      "idempotency_requests",
      "job_runs",
      "outbox_events",
      "notifications",
      "operational_events",
    ],
    "Season 1-only operational records tied to omitted competition activity are omitted while Season 2 records remain protected."
  ),
]);

function protectedFamily(
  familyId,
  targetTables,
  reason,
  externalEvidence = []
) {
  return {
    familyId,
    targetTables,
    treatment: "preserve_or_stop",
    externalEvidence,
    reason,
  };
}

const RESET_PROTECTED_POLICY = deepFreeze([
  protectedFamily(
    "player_identity",
    [
      "players",
      "player_external_ids",
      "player_names",
      "player_source_state",
    ],
    "Player records and stable player identifiers are protected project data."
  ),
  protectedFamily(
    "league_identity_and_configuration",
    ["leagues", "league_settings"],
    "League identity and configuration are not approved Season 1 competition omissions."
  ),
  protectedFamily(
    "player_position_corrections",
    ["league_player_positions"],
    "Approved player-position corrections must remain attached to stable player identities."
  ),
  protectedFamily(
    "draft_assets_and_rights",
    [
      "draft_eligibility_snapshots",
      "draft_eligible_players",
      "draft_events",
      "draft_lottery_results",
      "draft_lottery_runs",
      "draft_pick_ownership_events",
      "draft_picks",
      "draft_queue_items",
      "draft_selections",
      "entry_drafts",
    ],
    "Draft assets and rights are not listed in the approved Season 1 reset scope."
  ),
  protectedFamily(
    "global_statistics",
    ["stat_sources", "stat_refreshes", "player_stat_totals"],
    "Global player-stat sources, refresh evidence, and totals remain reusable across seasons."
  ),
  protectedFamily(
    "season_2_accounts_and_security",
    [
      "account_action_tokens",
      "account_events",
      "authentication_rate_limits",
      "platform_roles",
      "security_audit_events",
      "sessions",
      "user_credentials",
      "users",
    ],
    "New Season 2 accounts, credentials, sessions, roles, tokens, limits, and security evidence are protected."
  ),
  protectedFamily(
    "season_2_league_access_and_controls",
    [
      "administrator_requests",
      "commissioner_corrections",
      "league_freezes",
      "league_invitations",
      "league_memberships",
    ],
    "Season 2 access and commissioner-control records are outside the approved Season 1 reset scope."
  ),
  protectedFamily(
    "recovery_and_migration_evidence",
    [
      "application_metadata",
      "backup_catalog",
      "migration_reports",
    ],
    "Migration and recovery evidence must be preserved for audit and rollback.",
    [
      "source_bundles",
      "backups",
      "snapshots",
      "documentation",
      "migration_records",
      "recovery_information",
    ]
  ),
  protectedFamily(
    "unlisted_data",
    [],
    "Every source record and target table not explicitly allowed by an omission family is preserved or stops the import."
  ),
]);

const RESET_NEVER_IMPORT_POLICY = deepFreeze([
  {
    familyId: "hard_coded_frontend_credentials",
    sourceMaterial: [
      "hard_coded_frontend_names",
      "hard_coded_frontend_roles",
      "plaintext_frontend_passwords",
    ],
    treatment: "never_import",
    reason:
      "Hard-coded frontend identity and plaintext credential material is not an account source and must never be migrated.",
  },
]);

function manifestPayload() {
  return {
    manifestId: RESET_MANIFEST_ID,
    manifestVersion: RESET_MANIFEST_VERSION,
    applicableSourceBundleManifestVersion:
      APPLICABLE_SOURCE_BUNDLE_MANIFEST_VERSION,
    requiredOperatingMode: REQUIRED_OPERATING_MODE,
    approval: {
      authority: APPROVAL_AUTHORITY,
      reference: APPROVAL_REFERENCE,
      date: APPROVAL_DATE,
    },
    omissionFamilies: clone(RESET_OMISSION_POLICY),
    protectedFamilies: clone(RESET_PROTECTED_POLICY),
    neverImportFamilies: clone(RESET_NEVER_IMPORT_POLICY),
  };
}

function calculateResetManifestChecksum(manifest) {
  if (!manifest || typeof manifest !== "object") {
    throw resetManifestError(
      RESET_MANIFEST_ERROR_CODES.argumentInvalid,
      "A reset manifest object is required."
    );
  }
  const payload = { ...manifest };
  delete payload.checksum;
  return crypto
    .createHash("sha256")
    .update(canonicalize(payload))
    .digest("hex");
}

function createResetManifest() {
  const payload = manifestPayload();
  return deepFreeze({
    ...payload,
    checksum: calculateResetManifestChecksum(payload),
  });
}

function serializeResetManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function isPlainObject(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expectedKeys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isBoundedText(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1000
  );
}

function isStringArray(value, { allowEmpty = false } = {}) {
  return (
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.every(isBoundedText) &&
    new Set(value).size === value.length
  );
}

function assertManifestShape(manifest) {
  const rootKeys = [
    "manifestId",
    "manifestVersion",
    "applicableSourceBundleManifestVersion",
    "requiredOperatingMode",
    "approval",
    "omissionFamilies",
    "protectedFamilies",
    "neverImportFamilies",
    "checksum",
  ];
  if (
    !hasExactKeys(manifest, rootKeys) ||
    !isBoundedText(manifest.manifestId) ||
    !Number.isSafeInteger(manifest.manifestVersion) ||
    !Number.isSafeInteger(
      manifest.applicableSourceBundleManifestVersion
    ) ||
    !isBoundedText(manifest.requiredOperatingMode) ||
    !/^[a-f0-9]{64}$/.test(manifest.checksum || "") ||
    !hasExactKeys(manifest.approval, [
      "authority",
      "reference",
      "date",
    ]) ||
    !Object.values(manifest.approval).every(isBoundedText) ||
    !Array.isArray(manifest.omissionFamilies) ||
    !Array.isArray(manifest.protectedFamilies) ||
    !Array.isArray(manifest.neverImportFamilies)
  ) {
    throw resetManifestError(
      RESET_MANIFEST_ERROR_CODES.shapeInvalid,
      "The reset manifest has an invalid shape."
    );
  }

  const omissionKeys = [
    "familyId",
    "targetTables",
    "selectionRule",
    "countTreatment",
    "targetTreatment",
    "reason",
  ];
  const protectedKeys = [
    "familyId",
    "targetTables",
    "treatment",
    "externalEvidence",
    "reason",
  ];
  const neverImportKeys = [
    "familyId",
    "sourceMaterial",
    "treatment",
    "reason",
  ];

  const omissionsValid = manifest.omissionFamilies.every(
    (family) => {
      return (
        hasExactKeys(family, omissionKeys) &&
        isBoundedText(family.familyId) &&
        isStringArray(family.targetTables) &&
        isBoundedText(family.selectionRule) &&
        isBoundedText(family.countTreatment) &&
        isBoundedText(family.targetTreatment) &&
        isBoundedText(family.reason)
      );
    }
  );
  const protectedValid = manifest.protectedFamilies.every(
    (family) => {
      return (
        hasExactKeys(family, protectedKeys) &&
        isBoundedText(family.familyId) &&
        isStringArray(family.targetTables, {
          allowEmpty: true,
        }) &&
        isBoundedText(family.treatment) &&
        isStringArray(family.externalEvidence, {
          allowEmpty: true,
        }) &&
        isBoundedText(family.reason)
      );
    }
  );
  const neverImportValid = manifest.neverImportFamilies.every(
    (family) => {
      return (
        hasExactKeys(family, neverImportKeys) &&
        isBoundedText(family.familyId) &&
        isStringArray(family.sourceMaterial) &&
        isBoundedText(family.treatment) &&
        isBoundedText(family.reason)
      );
    }
  );

  const familyIds = [
    ...manifest.omissionFamilies,
    ...manifest.protectedFamilies,
    ...manifest.neverImportFamilies,
  ].map((family) => family.familyId);

  if (
    !omissionsValid ||
    !protectedValid ||
    !neverImportValid ||
    new Set(familyIds).size !== familyIds.length
  ) {
    throw resetManifestError(
      RESET_MANIFEST_ERROR_CODES.shapeInvalid,
      "The reset manifest contains an invalid family."
    );
  }
}

function assertPolicyCatalogCoverage() {
  const omittedTables = RESET_OMISSION_POLICY.flatMap(
    (family) => family.targetTables
  );
  const protectedTables = RESET_PROTECTED_POLICY.flatMap(
    (family) => family.targetTables
  );
  const allPolicyTables = [...omittedTables, ...protectedTables];
  const catalogTables = REPOSITORY_CATALOG.map(
    (definition) => definition.tableName
  );

  if (
    new Set(allPolicyTables).size !== allPolicyTables.length ||
    allPolicyTables.length !== catalogTables.length ||
    catalogTables.some(
      (tableName) => !allPolicyTables.includes(tableName)
    )
  ) {
    throw new Error(
      "The version-1 reset policy must classify every repository table exactly once."
    );
  }
}

function assertValidationContext(
  operatingMode,
  sourceBundleManifestVersion
) {
  if (
    typeof operatingMode !== "string" ||
    operatingMode.trim() === "" ||
    !Number.isSafeInteger(sourceBundleManifestVersion) ||
    sourceBundleManifestVersion < 0
  ) {
    throw resetManifestError(
      RESET_MANIFEST_ERROR_CODES.argumentInvalid,
      "Explicit operating-mode and source-version context is required."
    );
  }
}

function validateResetManifest(
  manifest,
  {
    operatingMode,
    sourceBundleManifestVersion,
  } = {}
) {
  assertValidationContext(
    operatingMode,
    sourceBundleManifestVersion
  );
  assertManifestShape(manifest);

  const actualChecksum =
    calculateResetManifestChecksum(manifest);
  if (actualChecksum !== manifest.checksum) {
    throw resetManifestError(
      RESET_MANIFEST_ERROR_CODES.checksumMismatch,
      "The reset manifest checksum does not match."
    );
  }

  const expectedManifest = createResetManifest();
  if (
    canonicalize(manifest) !== canonicalize(expectedManifest)
  ) {
    throw resetManifestError(
      RESET_MANIFEST_ERROR_CODES.policyMismatch,
      "The reset manifest does not match the approved policy."
    );
  }
  if (operatingMode !== manifest.requiredOperatingMode) {
    throw resetManifestError(
      RESET_MANIFEST_ERROR_CODES.operatingModeMismatch,
      "The reset manifest is not approved for this operating mode."
    );
  }
  if (
    sourceBundleManifestVersion !==
    manifest.applicableSourceBundleManifestVersion
  ) {
    throw resetManifestError(
      RESET_MANIFEST_ERROR_CODES.sourceVersionMismatch,
      "The reset manifest is not approved for this source-bundle version."
    );
  }

  return deepFreeze(clone(manifest));
}

function loadAndValidateResetManifest({
  manifestPath,
  operatingMode,
  sourceBundleManifestVersion,
  fsModule = fs,
} = {}) {
  if (
    typeof manifestPath !== "string" ||
    manifestPath.trim() === "" ||
    !fsModule ||
    typeof fsModule.readFileSync !== "function"
  ) {
    throw resetManifestError(
      RESET_MANIFEST_ERROR_CODES.argumentInvalid,
      "An explicit reset-manifest path is required."
    );
  }

  let rawText;
  let manifest;
  try {
    rawText = fsModule.readFileSync(manifestPath, "utf8");
    manifest = JSON.parse(rawText);
  } catch (error) {
    throw resetManifestError(
      RESET_MANIFEST_ERROR_CODES.parseFailed,
      "The reset manifest could not be read and parsed.",
      { cause: error }
    );
  }

  if (rawText !== serializeResetManifest(manifest)) {
    throw resetManifestError(
      RESET_MANIFEST_ERROR_CODES.noncanonical,
      "The reset manifest file is not canonical."
    );
  }

  return validateResetManifest(manifest, {
    operatingMode,
    sourceBundleManifestVersion,
  });
}

assertPolicyCatalogCoverage();

module.exports = {
  APPLICABLE_SOURCE_BUNDLE_MANIFEST_VERSION,
  REQUIRED_OPERATING_MODE,
  RESET_MANIFEST_ERROR_CODES,
  RESET_MANIFEST_ID,
  RESET_MANIFEST_VERSION,
  RESET_NEVER_IMPORT_POLICY,
  RESET_OMISSION_POLICY,
  RESET_PROTECTED_POLICY,
  ResetManifestError,
  calculateResetManifestChecksum,
  createResetManifest,
  loadAndValidateResetManifest,
  serializeResetManifest,
  validateResetManifest,
};
