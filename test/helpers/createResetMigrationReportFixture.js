const {
  canonicalize,
} = require(
  "../../src/infrastructure/migration/sourceInventory"
);
const {
  RESET_OMISSION_POLICY,
  createResetManifest,
} = require(
  "../../src/infrastructure/migration/resetManifest"
);

function zeroMoneyFamily(familyId) {
  return {
    familyId,
    sourceCount: 0,
    sourceSumCents: 0,
    importedCount: 0,
    importedSumCents: 0,
    omittedCount: 0,
    omittedSumCents: 0,
    reconciled: true,
  };
}

function createResetMigrationReportFixture({
  id,
  leagueId,
  startedAtMs,
  completedAtMs,
  createdAtMs,
  bundleCharacter = "a",
  databaseSchemaVersion = 49,
} = {}) {
  const sourceBundleId =
    `source-bundle-v1-${bundleCharacter.repeat(64)}`;
  const resetManifest = createResetManifest();
  return {
    id,
    league_id: leagueId,
    source_bundle_id: sourceBundleId,
    reset_manifest_id: resetManifest.manifestId,
    database_schema_version: databaseSchemaVersion,
    status: "succeeded",
    source_hashes_json: canonicalize({
      evidenceVersion: 1,
      sourceBundle: {
        id: sourceBundleId,
        checksum: "b".repeat(64),
        manifestVersion: 1,
      },
      sourceFiles: [
        {
          sourceLabel: "league_state",
          copiedPath:
            "files/league_state/league-state.json",
          byteSize: 100,
          sha256: "c".repeat(64),
        },
      ],
      resetManifest: {
        id: resetManifest.manifestId,
        version: resetManifest.manifestVersion,
        checksum: resetManifest.checksum,
      },
      importReport: {
        reportVersion: 1,
        importerVersion: 1,
        semanticHash: "d".repeat(64),
      },
    }),
    counts_json: canonicalize({
      evidenceVersion: 1,
      sourceCollections: {
        players: 0,
        teams: 0,
        roster_entries: 0,
        buyout_entries: 0,
        league_activity: 0,
        trade_proposals: 0,
        matchup_weeks: 0,
        recovery_evidence_files: 0,
        ignored_metadata_records: 0,
        never_import_credential_records: 0,
      },
      targetTables: [
        {
          table: "players",
          plannedRowCount: 0,
          validatedRowCount: 0,
          semanticHash: "e".repeat(64),
        },
        {
          table: "player_external_ids",
          plannedRowCount: 0,
          validatedRowCount: 0,
          semanticHash: "f".repeat(64),
        },
        {
          table: "player_source_state",
          plannedRowCount: 0,
          validatedRowCount: 0,
          semanticHash: "1".repeat(64),
        },
      ],
      resetOmissions: RESET_OMISSION_POLICY.map(
        (family) => ({
          familyId: family.familyId,
          sourceCount: 0,
          countTreatment: family.countTreatment,
          targetTreatment: family.targetTreatment,
          validatedTargetRowCount: 0,
          reconciled: true,
        })
      ),
      blockingRejectCount: 0,
      warningCount: 0,
    }),
    totals_json: canonicalize({
      evidenceVersion: 1,
      money: {
        sourceCount: 0,
        sourceSumCents: 0,
        importedCount: 0,
        importedSumCents: 0,
        omittedCount: 0,
        omittedSumCents: 0,
        reconciled: true,
        families: [
          zeroMoneyFamily("season_1_contracts"),
          zeroMoneyFamily("season_1_buyouts"),
          zeroMoneyFamily("season_1_trades"),
          zeroMoneyFamily("season_1_retention"),
        ],
      },
      ownership: {
        sourceCount: 0,
        importedCount: 0,
        omittedCount: 0,
        duplicateTargetPlayerCount: 0,
        reconciled: true,
      },
    }),
    warnings_json: "[]",
    rejects_json: "[]",
    started_at_ms: startedAtMs,
    completed_at_ms: completedAtMs,
    created_at_ms: createdAtMs,
  };
}

module.exports = {
  createResetMigrationReportFixture,
};
