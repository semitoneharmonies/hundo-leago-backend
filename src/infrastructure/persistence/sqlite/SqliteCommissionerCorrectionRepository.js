const {
  CommissionerCorrectionPolicyError,
  assertCommissionerAuthority,
  assertCorrectionChanged,
  assertCurrentRecord,
  assertNoDependentTransactions,
  assertWarningsConfirmed,
  validateContractCorrection,
  validateRosterCorrection,
} = require("../../../domain/leagues/commissionerCorrectionPolicy");
const {
  evaluateStructuralRosterLegality,
} = require("../../../domain/rosters/rosterMovementPolicy");
const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");
const {
  createSqliteCapReadRepository,
} = require("./SqliteCapReadRepository");
const {
  createSqliteRecordRepository,
} = require("./createSqliteRecordRepository");
const {
  getRepositoryDefinition,
} = require("./repositoryCatalog");

class PreviewRollback extends Error {
  constructor(result) {
    super("Rollback read-only correction preview.");
    this.result = result;
  }
}

function freezeRow(row) {
  return row ? Object.freeze({ ...row }) : null;
}

function freezeRows(rows) {
  return Object.freeze(rows.map(freezeRow));
}

function freezeWarnings(warnings) {
  return Object.freeze(
    warnings.map((warning) => Object.freeze({ ...warning }))
  );
}

function rosterValues(row) {
  return Object.freeze({
    teamId: row.team_id,
    ownershipKind: row.ownership_kind,
    rosterCategory: row.roster_category,
    positionGroup: row.position_group,
    slotNumber: row.slot_number,
  });
}

function requestedRosterValues(correction) {
  return Object.freeze({
    teamId: correction.correctedTeamId,
    ownershipKind: correction.correctedOwnershipKind,
    rosterCategory: correction.correctedRosterCategory,
    positionGroup: correction.correctedPositionGroup,
    slotNumber: correction.correctedSlotNumber,
  });
}

function rosterSnapshot(row) {
  return Object.freeze({
    id: row.id,
    leagueId: row.league_id,
    seasonId: row.season_id,
    playerId: row.player_id,
    ...rosterValues(row),
    version: row.version,
  });
}

function contractValues(row, years) {
  return Object.freeze({
    teamId: row.current_team_id,
    contractType: row.contract_type,
    originalTotalValueCents: row.original_total_value_cents,
    originalTermYears: row.original_term_years,
    aavCents: row.aav_cents,
    startSeasonId: row.start_season_id,
    status: row.status,
    auctionBuyoutLockExpiresAtMs:
      row.auction_buyout_lock_expires_at_ms,
    years: Object.freeze(
      years.map((year) =>
        Object.freeze({
          id: year.id,
          seasonId: year.season_id,
          yearNumber: year.year_number,
          aavCents: year.aav_cents,
          status: year.status,
          rolloverAtMs: year.rollover_at_ms,
        })
      )
    ),
  });
}

function requestedContractValues(correction) {
  return Object.freeze({
    teamId: correction.correctedTeamId,
    contractType: correction.correctedContractType,
    originalTotalValueCents:
      correction.correctedOriginalTotalValueCents,
    originalTermYears: correction.correctedOriginalTermYears,
    aavCents: correction.correctedAavCents,
    startSeasonId: correction.correctedStartSeasonId,
    status: correction.correctedStatus,
    auctionBuyoutLockExpiresAtMs:
      correction.correctedAuctionBuyoutLockExpiresAtMs,
    years: Object.freeze(
      correction.correctedYears.map((year) =>
        Object.freeze({
          id: year.id,
          seasonId: year.seasonId,
          yearNumber: year.yearNumber,
          aavCents: correction.correctedAavCents,
          status: year.status,
          rolloverAtMs: year.rolloverAtMs,
        })
      )
    ),
  });
}

function contractSnapshot(row, years) {
  return Object.freeze({
    id: row.id,
    leagueId: row.league_id,
    playerId: row.player_id,
    ...contractValues(row, years),
    version: row.version,
  });
}

function correctionSnapshot({
  actorMembershipId,
  actorAuthority,
  requested,
  authoritative,
  warnings,
  confirmed,
}) {
  return JSON.stringify({
    actionType: "correction",
    actor: {
      authority: actorAuthority,
      membershipId: actorMembershipId,
    },
    requested,
    authoritative,
    warnings,
    confirmations: { warningsAccepted: confirmed },
    outcome: "applied",
  });
}

function createSqliteCommissionerCorrectionRepository({ database } = {}) {
  const ownerships = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("player_ownerships"),
  });
  const ownershipEvents = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("ownership_events"),
  });
  const contracts = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("contracts"),
  });
  const contractYears = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("contract_years"),
  });
  const contractEvents = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("contract_events"),
  });
  const corrections = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("commissioner_corrections"),
  });
  const activity = createSqliteRecordRepository({
    database,
    definition: getRepositoryDefinition("league_activity"),
  });
  const capRepository = createSqliteCapReadRepository({ database });

  let authorityStatement;
  let ownershipStatement;
  let contractStatement;
  let contractYearsStatement;
  let deleteContractYearsStatement;
  let rosterRowsStatement;
  let benchViolationStatement;
  let rosterDependencyStatement;
  let contractDependencyStatement;
  let rosterTransaction;
  let contractTransaction;
  try {
    authorityStatement = database.prepare(`
      SELECT membership.*
      FROM league_memberships AS membership
      INNER JOIN leagues AS league
        ON league.id = membership.league_id
        AND league.commissioner_membership_id = membership.id
      WHERE membership.league_id = @leagueId
        AND membership.id = @actorMembershipId
        AND membership.user_id = @actorUserId
        AND membership.permission_category = 'commissioner'
        AND membership.status = 'active'
        AND league.status <> 'deleted'
      LIMIT 2
    `);
    ownershipStatement = database.prepare(
      "SELECT * FROM player_ownerships " +
        "WHERE league_id = @leagueId AND id = @ownershipId LIMIT 2"
    );
    contractStatement = database.prepare(
      "SELECT * FROM contracts " +
        "WHERE league_id = @leagueId AND id = @contractId LIMIT 2"
    );
    contractYearsStatement = database.prepare(
      "SELECT * FROM contract_years " +
        "WHERE league_id = @leagueId AND contract_id = @contractId " +
        "ORDER BY year_number ASC"
    );
    deleteContractYearsStatement = database.prepare(
      "DELETE FROM contract_years " +
        "WHERE league_id = @leagueId AND contract_id = @contractId"
    );
    rosterRowsStatement = database.prepare(`
      SELECT
        ownership.league_id,
        ownership.season_id,
        ownership.team_id,
        ownership.player_id,
        ownership.roster_category,
        ownership.position_group,
        COALESCE(
          (
            SELECT correction.position_group
            FROM league_player_positions AS correction
            WHERE correction.league_id = ownership.league_id
              AND correction.player_id = ownership.player_id
              AND correction.ended_at_ms IS NULL
            LIMIT 1
          ),
          (
            SELECT source.normalized_position
            FROM player_source_state AS source
            WHERE source.player_id = ownership.player_id
              AND source.ended_at_ms IS NULL
            ORDER BY source.provider ASC
            LIMIT 1
          )
        ) AS effective_position
      FROM player_ownerships AS ownership
      WHERE ownership.league_id = @leagueId
        AND ownership.season_id = @seasonId
        AND ownership.team_id = @teamId
      ORDER BY ownership.player_id ASC
    `);
    benchViolationStatement = database.prepare(`
      SELECT ownership.player_id
      FROM player_ownerships AS ownership
      INNER JOIN contracts AS contract
        ON contract.league_id = ownership.league_id
        AND contract.player_id = ownership.player_id
        AND contract.current_team_id = ownership.team_id
        AND contract.status = 'active'
      INNER JOIN league_settings AS settings
        ON settings.league_id = ownership.league_id
      WHERE ownership.league_id = @leagueId
        AND ownership.season_id = @seasonId
        AND ownership.team_id = @teamId
        AND ownership.ownership_kind = 'Rostered'
        AND ownership.roster_category = 'Bench'
        AND contract.aav_cents > settings.maximum_bench_aav_cents
      ORDER BY ownership.player_id ASC
    `);
    rosterDependencyStatement = database.prepare(`
      SELECT COUNT(*) AS count
      FROM trade_assets AS asset
      INNER JOIN trades AS trade
        ON trade.league_id = asset.league_id
        AND trade.id = asset.trade_id
      WHERE asset.league_id = @leagueId
        AND asset.asset_type = 'prospect_right'
        AND asset.player_id = @playerId
        AND trade.status IN ('proposed', 'accepted')
    `);
    contractDependencyStatement = database.prepare(`
      SELECT COUNT(*) AS count
      FROM trade_assets AS asset
      INNER JOIN trades AS trade
        ON trade.league_id = asset.league_id
        AND trade.id = asset.trade_id
      WHERE asset.league_id = @leagueId
        AND asset.asset_type = 'contract'
        AND asset.contract_id = @contractId
        AND trade.status IN ('proposed', 'accepted')
    `);

    rosterTransaction = database.transaction((request) => {
      const result = executeRosterCorrection(request.correction, request.persist);
      if (!request.persist) throw new PreviewRollback(result);
      return result;
    });
    contractTransaction = database.transaction((request) => {
      const result = executeContractCorrection(
        request.correction,
        request.persist
      );
      if (!request.persist) throw new PreviewRollback(result);
      return result;
    });
  } catch (error) {
    throw mapRepositoryError(error, {
      operation: "prepareCommissionerCorrectionRepository",
      tableName: "commissioner_corrections",
    });
  }

  function requireUnique(rows, message) {
    if (rows.length > 1) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        message
      );
    }
    if (!rows[0]) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.recordNotFound,
        message
      );
    }
    return freezeRow(rows[0]);
  }

  function requireAuthority(correction) {
    const rows = authorityStatement.all(correction);
    if (rows.length > 1) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.schemaIncompatible,
        "A league has multiple active commissioner authorities."
      );
    }
    return assertCommissionerAuthority(
      freezeRow(rows[0]),
      correction
    );
  }

  function teamEvaluation(correction, teamId) {
    const rows = rosterRowsStatement.all({
      leagueId: correction.leagueId,
      seasonId: correction.seasonId,
      teamId,
    });
    const legality = evaluateStructuralRosterLegality({
      leagueId: correction.leagueId,
      seasonId: correction.seasonId,
      teamId,
      assignments: rows.map((row) => ({
        leagueId: row.league_id,
        seasonId: row.season_id,
        teamId: row.team_id,
        playerId: row.player_id,
        rosterCategory: row.roster_category,
        assignedPositionGroup: row.position_group,
      })),
      effectivePositions: rows.map((row) => ({
        playerId: row.player_id,
        positionGroup: row.effective_position,
      })),
    });
    const cap = capRepository.calculate({
      leagueId: correction.leagueId,
      seasonId: correction.seasonId,
      teamId,
    });
    const warnings = [
      ...legality.reasons.map((reason) => ({
        ...reason,
        teamId,
      })),
      ...benchViolationStatement.all({
        leagueId: correction.leagueId,
        seasonId: correction.seasonId,
        teamId,
      }).map((row) => ({
        code: "BENCH_AAV_LIMIT_EXCEEDED",
        teamId,
        playerId: row.player_id,
      })),
      ...cap.issues.map((issue) => ({ ...issue, teamId })),
      ...(cap.overCap ? [{ code: "TEAM_OVER_CAP", teamId }] : []),
    ];
    return Object.freeze({
      teamId,
      legality,
      cap,
      warnings: freezeWarnings(warnings),
    });
  }

  function evaluateTeams(correction, teamIds) {
    const evaluations = Object.freeze(
      [...new Set(teamIds)].sort().map((teamId) =>
        teamEvaluation(correction, teamId)
      )
    );
    return Object.freeze({
      evaluations,
      warnings: freezeWarnings(
        evaluations.flatMap((evaluation) => evaluation.warnings)
      ),
    });
  }

  function insertCorrectionEvidence({
    correction,
    feature,
    featureRecordId,
    before,
    requested,
    authoritative,
    warnings,
  }) {
    return freezeRow(
      corrections.insert({
        id: correction.correctionId,
        league_id: correction.leagueId,
        season_id: correction.seasonId,
        feature,
        feature_record_id: featureRecordId,
        actor_user_id: correction.actorUserId,
        reason: correction.reason,
        before_snapshot_json: JSON.stringify(before),
        after_snapshot_json: correctionSnapshot({
          actorMembershipId: correction.actorMembershipId,
          actorAuthority: correction.actorAuthority,
          requested,
          authoritative,
          warnings,
          confirmed: correction.confirmWarnings,
        }),
        corrected_at_ms: correction.occurredAtMs,
      })
    );
  }

  function executeRosterCorrection(correction, persist) {
    requireAuthority(correction);
    assertNoDependentTransactions(
      rosterDependencyStatement.get(correction).count
    );
    const current = requireUnique(
      ownershipStatement.all(correction),
      "The corrected roster ownership does not exist."
    );
    assertCurrentRecord(current, correction, "roster");
    const before = rosterSnapshot(current);
    const requested = requestedRosterValues(correction);
    assertCorrectionChanged(rosterValues(current), requested);
    const updated = freezeRow(
      ownerships.updateVersioned({
        key: current.id,
        leagueId: correction.leagueId,
        expectedVersion: correction.expectedVersion,
        changes: {
          team_id: correction.correctedTeamId,
          ownership_kind: correction.correctedOwnershipKind,
          roster_category: correction.correctedRosterCategory,
          position_group: correction.correctedPositionGroup,
          slot_number: correction.correctedSlotNumber,
          updated_at_ms: correction.occurredAtMs,
        },
      })
    );
    const after = rosterSnapshot(updated);
    const evaluation = evaluateTeams(correction, [
      current.team_id,
      updated.team_id,
    ]);
    if (persist) {
      assertWarningsConfirmed(
        evaluation.warnings,
        correction.confirmWarnings
      );
    }

    let correctionRow = null;
    let ownershipEvent = null;
    let activityRow = null;
    if (persist) {
      correctionRow = insertCorrectionEvidence({
        correction,
        feature: "roster",
        featureRecordId: current.id,
        before,
        requested,
        authoritative: after,
        warnings: evaluation.warnings,
      });
      ownershipEvent = freezeRow(
        ownershipEvents.insert({
          id: correction.ownershipEventId,
          league_id: correction.leagueId,
          season_id: correction.seasonId,
          player_id: correction.playerId,
          team_id: updated.team_id,
          ownership_id: current.id,
          event_type: "commissioner_roster_corrected",
          actor_user_id: correction.actorUserId,
          source_type: "commissioner_correction",
          source_id: correction.correctionId,
          before_metadata_json: JSON.stringify(before),
          after_metadata_json: JSON.stringify(after),
          reason: correction.reason,
          occurred_at_ms: correction.occurredAtMs,
        })
      );
      activityRow = freezeRow(
        activity.insert({
          id: correction.activityId,
          league_id: correction.leagueId,
          season_id: correction.seasonId,
          event_type: "commissioner_roster_corrected",
          actor_user_id: correction.actorUserId,
          actor_authority: correction.actorAuthority,
          team_id: updated.team_id,
          player_id: correction.playerId,
          related_type: "player_ownership",
          related_id: current.id,
          display_summary: "Commissioner corrected a roster assignment.",
          reason: correction.reason,
          metadata_json: JSON.stringify({
            correctionId: correction.correctionId,
            actorMembershipId: correction.actorMembershipId,
            before,
            after,
            warnings: evaluation.warnings,
          }),
          occurred_at_ms: correction.occurredAtMs,
        })
      );
    }
    return Object.freeze({
      preview: !persist,
      before,
      requested,
      authoritative: after,
      warnings: evaluation.warnings,
      teamEvaluations: evaluation.evaluations,
      correction: correctionRow,
      ownershipEvent,
      activity: activityRow,
    });
  }

  function replaceContractYears(correction, currentYears) {
    const correctedIds = new Set(
      correction.correctedYears.map((year) => year.id)
    );
    for (const current of currentYears) {
      if (
        current.year_number <= correction.correctedOriginalTermYears &&
        correction.correctedYears[current.year_number - 1].id !== current.id
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.argumentInvalid,
          "A contract correction must preserve each existing contract-year ID."
        );
      }
    }
    deleteContractYearsStatement.run(correction);
    const omittedYears = currentYears.filter(
      (year) => !correctedIds.has(year.id)
    );
    return freezeRows(
      [
        ...correction.correctedYears.map((year) => ({
          id: year.id,
          league_id: correction.leagueId,
          contract_id: correction.contractId,
          season_id: year.seasonId,
          year_number: year.yearNumber,
          aav_cents: correction.correctedAavCents,
          status: year.status,
          rollover_at_ms: year.rolloverAtMs,
          created_at_ms:
            currentYears.find((current) => current.id === year.id)
              ?.created_at_ms ?? correction.occurredAtMs,
        })),
        ...omittedYears.map((year) => ({
          ...year,
          aav_cents: correction.correctedAavCents,
          status: "eliminated",
          rollover_at_ms: correction.occurredAtMs,
        })),
      ]
        .sort((left, right) => left.year_number - right.year_number)
        .map((year) => contractYears.insert(year))
    );
  }

  function executeContractCorrection(correction, persist) {
    requireAuthority(correction);
    assertNoDependentTransactions(
      contractDependencyStatement.get(correction).count
    );
    const current = requireUnique(
      contractStatement.all(correction),
      "The corrected contract does not exist."
    );
    assertCurrentRecord(current, correction, "contract");
    const currentYears = freezeRows(
      contractYearsStatement.all(correction)
    );
    const before = contractSnapshot(current, currentYears);
    const requested = requestedContractValues(correction);
    assertCorrectionChanged(contractValues(current, currentYears), requested);
    const updated = freezeRow(
      contracts.updateVersioned({
        key: current.id,
        leagueId: correction.leagueId,
        expectedVersion: correction.expectedVersion,
        changes: {
          current_team_id: correction.correctedTeamId,
          contract_type: correction.correctedContractType,
          original_total_value_cents:
            correction.correctedOriginalTotalValueCents,
          original_term_years: correction.correctedOriginalTermYears,
          aav_cents: correction.correctedAavCents,
          start_season_id: correction.correctedStartSeasonId,
          status: correction.correctedStatus,
          auction_buyout_lock_expires_at_ms:
            correction.correctedAuctionBuyoutLockExpiresAtMs,
          updated_at_ms: correction.occurredAtMs,
        },
      })
    );
    const updatedYears = replaceContractYears(correction, currentYears);
    const after = contractSnapshot(updated, updatedYears);
    const evaluation = evaluateTeams(correction, [
      current.current_team_id,
      updated.current_team_id,
    ]);
    if (persist) {
      assertWarningsConfirmed(
        evaluation.warnings,
        correction.confirmWarnings
      );
    }

    let correctionRow = null;
    let contractEvent = null;
    let activityRow = null;
    if (persist) {
      correctionRow = insertCorrectionEvidence({
        correction,
        feature: "contract",
        featureRecordId: current.id,
        before,
        requested,
        authoritative: after,
        warnings: evaluation.warnings,
      });
      contractEvent = freezeRow(
        contractEvents.insert({
          id: correction.contractEventId,
          league_id: correction.leagueId,
          contract_id: current.id,
          player_id: correction.playerId,
          team_id: updated.current_team_id,
          actor_user_id: correction.actorUserId,
          event_type: "commissioner_contract_corrected",
          source_type: "commissioner_correction",
          source_id: correction.correctionId,
          metadata_json: JSON.stringify({ before, after }),
          reason: correction.reason,
          occurred_at_ms: correction.occurredAtMs,
        })
      );
      activityRow = freezeRow(
        activity.insert({
          id: correction.activityId,
          league_id: correction.leagueId,
          season_id: correction.seasonId,
          event_type: "commissioner_contract_corrected",
          actor_user_id: correction.actorUserId,
          actor_authority: correction.actorAuthority,
          team_id: updated.current_team_id,
          player_id: correction.playerId,
          related_type: "contract",
          related_id: current.id,
          display_summary: "Commissioner corrected a contract.",
          reason: correction.reason,
          metadata_json: JSON.stringify({
            correctionId: correction.correctionId,
            actorMembershipId: correction.actorMembershipId,
            before,
            after,
            warnings: evaluation.warnings,
          }),
          occurred_at_ms: correction.occurredAtMs,
        })
      );
    }
    return Object.freeze({
      preview: !persist,
      before,
      requested,
      authoritative: after,
      warnings: evaluation.warnings,
      teamEvaluations: evaluation.evaluations,
      correction: correctionRow,
      contractEvent,
      activity: activityRow,
    });
  }

  function run(transaction, correction, persist, operation) {
    try {
      return transaction.immediate({ correction, persist });
    } catch (error) {
      if (error instanceof PreviewRollback) return error.result;
      if (error instanceof CommissionerCorrectionPolicyError) throw error;
      throw mapRepositoryError(error, {
        operation,
        tableName: "commissioner_corrections",
      });
    }
  }

  return Object.freeze({
    previewRoster(input) {
      return run(
        rosterTransaction,
        validateRosterCorrection(input),
        false,
        "previewRosterCorrection"
      );
    },
    applyRoster(input) {
      return run(
        rosterTransaction,
        validateRosterCorrection(input),
        true,
        "applyRosterCorrection"
      );
    },
    previewContract(input) {
      return run(
        contractTransaction,
        validateContractCorrection(input),
        false,
        "previewContractCorrection"
      );
    },
    applyContract(input) {
      return run(
        contractTransaction,
        validateContractCorrection(input),
        true,
        "applyContractCorrection"
      );
    },
  });
}

module.exports = { createSqliteCommissionerCorrectionRepository };
