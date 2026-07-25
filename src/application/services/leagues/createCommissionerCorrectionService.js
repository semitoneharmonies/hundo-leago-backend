const { createHash } = require("node:crypto");

const {
  COMMISSIONER_CORRECTION_CODES,
  CommissionerCorrectionPolicyError,
} = require("../../../domain/leagues/commissionerCorrectionPolicy");

const IDEMPOTENCY_LIFETIME_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;

function assertMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`commissioner corrections require ${description}`);
  }
}

function invalidInput() {
  throw new CommissionerCorrectionPolicyError(
    COMMISSIONER_CORRECTION_CODES.inputInvalid
  );
}

function exactObject(input, keys) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    invalidInput();
  }
  const actual = Object.keys(input).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalidInput();
  }
  return input;
}

function safeNow(clock) {
  const nowMs = clock.nowMs();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError("commissioner corrections require a safe clock");
  }
  return nowMs;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function createIdempotency({
  apply,
  key,
  operation,
  leagueId,
  actorUserId,
  input,
  occurredAtMs,
  secureRandom,
}) {
  if (!apply) return null;
  if (
    typeof key !== "string" ||
    key.trim() !== key ||
    !IDEMPOTENCY_KEY_PATTERN.test(key)
  ) {
    invalidInput();
  }
  return Object.freeze({
    id: secureRandom.id(),
    key,
    operation,
    requestHash: createHash("sha256")
      .update(canonicalJson({
        operation,
        leagueId,
        actorUserId,
        input,
      }))
      .digest("hex"),
    expiresAtMs: occurredAtMs + IDEMPOTENCY_LIFETIME_MS,
  });
}

function capImpact(teamEvaluations) {
  return Object.freeze(
    teamEvaluations.map((evaluation) =>
      Object.freeze({
        teamId: evaluation.teamId,
        cap: evaluation.cap,
        warnings: evaluation.warnings,
      })
    )
  );
}

function project(result, type) {
  const applied = !result.preview;
  const response = {
    code: applied
      ? `COMMISSIONER_${type.toUpperCase()}_CORRECTION_APPLIED`
      : `COMMISSIONER_${type.toUpperCase()}_CORRECTION_PREVIEWED`,
    preview: result.preview,
    before: result.before,
    requested: result.requested,
    authoritative: result.authoritative,
    warnings: result.warnings,
    capImpact: capImpact(result.teamEvaluations),
  };
  if (applied) {
    response.evidence = Object.freeze({
      correctionId: result.correction.id,
      activityId: result.activity.id,
      activityType: result.activity.event_type,
      occurredAtMs: result.activity.occurred_at_ms,
    });
  }
  return Object.freeze(response);
}

const ROSTER_FIELDS = Object.freeze([
  "seasonId",
  "ownershipId",
  "playerId",
  "expectedVersion",
  "correctedTeamId",
  "correctedOwnershipKind",
  "correctedRosterCategory",
  "correctedPositionGroup",
  "correctedSlotNumber",
  "reason",
]);

const CONTRACT_FIELDS = Object.freeze([
  "seasonId",
  "contractId",
  "playerId",
  "expectedVersion",
  "correctedOriginalTotalValueCents",
  "correctedOriginalTermYears",
  "reason",
]);

const ROSTER_ADD_FIELDS = Object.freeze([
  "seasonId",
  "playerId",
  "teamId",
  "rosterCategory",
  "positionGroup",
  "slotNumber",
  "contractType",
  "originalTotalValueCents",
  "termYears",
  "reason",
]);

const ROSTER_REMOVE_FIELDS = Object.freeze([
  "seasonId",
  "ownershipId",
  "playerId",
  "expectedVersion",
  "contractId",
  "expectedContractVersion",
  "reason",
]);

function assertBoundedContractTerm(termYears) {
  if (
    !Number.isSafeInteger(termYears) ||
    termYears < 1 ||
    termYears > 3
  ) {
    throw new CommissionerCorrectionPolicyError(
      COMMISSIONER_CORRECTION_CODES.contractInvalid
    );
  }
}

function assertBoundedContractValue(totalValueCents, termYears) {
  assertBoundedContractTerm(termYears);
  if (
    !Number.isSafeInteger(totalValueCents) ||
    totalValueCents < termYears * 100 ||
    (termYears > 1 && totalValueCents % 100 !== 0)
  ) {
    throw new CommissionerCorrectionPolicyError(
      COMMISSIONER_CORRECTION_CODES.contractInvalid
    );
  }
}

function authoritativeContractCorrection({
  body,
  workspace,
  secureRandom,
}) {
  const rosterEntry = workspace?.roster?.find(
    (entry) =>
      entry.playerId === body.playerId &&
      entry.contract?.id === body.contractId
  );
  if (
    !rosterEntry ||
    rosterEntry.seasonId !== body.seasonId ||
    workspace.league?.currentSeasonId !== body.seasonId
  ) {
    throw new CommissionerCorrectionPolicyError(
      COMMISSIONER_CORRECTION_CODES.scopeMismatch
    );
  }

  const current = rosterEntry.contract;
  if (current.status !== "active") {
    throw new CommissionerCorrectionPolicyError(
      COMMISSIONER_CORRECTION_CODES.contractInvalid
    );
  }
  if (
    current.type === "fantasy_elc" &&
    (
      body.correctedOriginalTotalValueCents !== 300 ||
      body.correctedOriginalTermYears !== 3
    )
  ) {
    throw new CommissionerCorrectionPolicyError(
      COMMISSIONER_CORRECTION_CODES.contractInvalid
    );
  }

  const currentYears = [...current.years].sort(
    (left, right) => left.yearNumber - right.yearNumber
  );
  const currentYear = currentYears.find((year) => year.status === "current");
  if (
    !currentYear ||
    currentYears.filter((year) => year.status === "current").length !== 1 ||
    body.correctedOriginalTermYears < currentYear.yearNumber
  ) {
    throw new CommissionerCorrectionPolicyError(
      COMMISSIONER_CORRECTION_CODES.scheduleInvalid
    );
  }

  const seasons = workspace.seasons || [];
  const currentSeasonIndex = seasons.findIndex(
    (season) => season.id === body.seasonId
  );
  if (currentSeasonIndex < 0) {
    throw new CommissionerCorrectionPolicyError(
      COMMISSIONER_CORRECTION_CODES.scheduleInvalid
    );
  }

  const correctedYears = Array.from(
    { length: body.correctedOriginalTermYears },
    (_, index) => {
      const yearNumber = index + 1;
      const existing = currentYears.find(
        (year) => year.yearNumber === yearNumber
      );
      if (existing) {
        const revivesOmittedFutureYear =
          existing.status === "eliminated" &&
          yearNumber > currentYear.yearNumber;
        return {
          id: existing.id,
          seasonId: existing.seasonId,
          yearNumber,
          status: revivesOmittedFutureYear ? "future" : existing.status,
          rolloverAtMs: revivesOmittedFutureYear
            ? null
            : existing.rolloverAtMs,
        };
      }
      const seasonOffset = yearNumber - currentYear.yearNumber;
      const season = seasons[currentSeasonIndex + seasonOffset];
      if (seasonOffset <= 0 || !season) {
        throw new CommissionerCorrectionPolicyError(
          COMMISSIONER_CORRECTION_CODES.scheduleInvalid
        );
      }
      return {
        id: secureRandom.id(),
        seasonId: season.id,
        yearNumber,
        status: "future",
        rolloverAtMs: null,
      };
    }
  );

  return Object.freeze({
    correctedTeamId: current.teamId,
    correctedContractType: current.type,
    correctedStartSeasonId: current.startSeasonId,
    correctedStatus: current.status,
    correctedAuctionBuyoutLockExpiresAtMs:
      current.auctionBuyoutLockExpiresAtMs,
    correctedYears: Object.freeze(
      correctedYears.map((year) => Object.freeze(year))
    ),
  });
}

function createCommissionerCorrectionService({
  leagueAuthorization,
  repository,
  clock,
  secureRandom,
  providerEnabled = false,
} = {}) {
  assertMethod(
    leagueAuthorization,
    "requireCommissioner",
    "league commissioner authorization"
  );
  for (const method of [
    "readWorkspace",
    "previewAdd",
    "applyAdd",
    "previewRemove",
    "applyRemove",
    "previewRoster",
    "applyRoster",
    "previewContract",
    "applyContract",
  ]) {
    assertMethod(repository, method, "an atomic commissioner-correction repository");
  }
  assertMethod(clock, "nowMs", "a clock");
  assertMethod(secureRandom, "id", "secure identifiers");
  if (typeof providerEnabled !== "boolean") {
    throw new TypeError(
      "commissioner corrections require a provider-enabled flag"
    );
  }

  function rosterCorrection({
    leagueId,
    input,
    idempotencyKey,
    authenticated,
    apply,
  }) {
    const body = exactObject(
      input,
      apply ? [...ROSTER_FIELDS, "confirmWarnings"] : ROSTER_FIELDS
    );
    const authority = leagueAuthorization.requireCommissioner(
      authenticated,
      leagueId
    );
    const occurredAtMs = safeNow(clock);
    const correction = {
      correctionId: secureRandom.id(),
      ownershipEventId: secureRandom.id(),
      activityId: secureRandom.id(),
      leagueId,
      ...body,
      actorUserId: authority.actorUserId,
      actorMembershipId: authority.membershipId,
      actorAuthority: authority.authority,
      confirmWarnings: apply ? body.confirmWarnings : false,
      occurredAtMs,
    };
    const idempotency = createIdempotency({
      apply,
      key: idempotencyKey,
      operation: "commissioner_roster_correction",
      leagueId,
      actorUserId: authority.actorUserId,
      input: body,
      occurredAtMs,
      secureRandom,
    });
    return project(
      apply
        ? repository.applyRoster(correction, idempotency)
        : repository.previewRoster(correction),
      "roster"
    );
  }

  function rosterAddition({
    leagueId,
    input,
    idempotencyKey,
    authenticated,
    apply,
  }) {
    const body = exactObject(
      input,
      apply ? [...ROSTER_ADD_FIELDS, "confirmWarnings"] : ROSTER_ADD_FIELDS
    );
    const authority = leagueAuthorization.requireCommissioner(
      authenticated,
      leagueId
    );
    const prospect = body.rosterCategory === "Prospect";
    if (!prospect) {
      assertBoundedContractTerm(body.termYears);
    }
    const occurredAtMs = safeNow(clock);
    const correction = {
      correctionId: secureRandom.id(),
      ownershipId: secureRandom.id(),
      ownershipEventId: secureRandom.id(),
      contractId: prospect ? null : secureRandom.id(),
      contractEventId: prospect ? null : secureRandom.id(),
      contractYearIds: prospect
        ? []
        : Array.from(
            { length: body.termYears },
            () => secureRandom.id()
          ),
      activityId: secureRandom.id(),
      leagueId,
      ...body,
      actorUserId: authority.actorUserId,
      actorMembershipId: authority.membershipId,
      actorAuthority: authority.authority,
      confirmWarnings: apply ? body.confirmWarnings : false,
      occurredAtMs,
    };
    const idempotency = createIdempotency({
      apply,
      key: idempotencyKey,
      operation: "commissioner_roster_add",
      leagueId,
      actorUserId: authority.actorUserId,
      input: body,
      occurredAtMs,
      secureRandom,
    });
    return project(
      apply
        ? repository.applyAdd(correction, idempotency)
        : repository.previewAdd(correction),
      "roster_add"
    );
  }

  function rosterRemoval({
    leagueId,
    input,
    idempotencyKey,
    authenticated,
    apply,
  }) {
    const body = exactObject(
      input,
      apply
        ? [...ROSTER_REMOVE_FIELDS, "confirmWarnings"]
        : ROSTER_REMOVE_FIELDS
    );
    const authority = leagueAuthorization.requireCommissioner(
      authenticated,
      leagueId
    );
    const occurredAtMs = safeNow(clock);
    const correction = {
      correctionId: secureRandom.id(),
      ownershipEventId: secureRandom.id(),
      contractEventId: secureRandom.id(),
      activityId: secureRandom.id(),
      leagueId,
      ...body,
      actorUserId: authority.actorUserId,
      actorMembershipId: authority.membershipId,
      actorAuthority: authority.authority,
      confirmWarnings: apply ? body.confirmWarnings : false,
      occurredAtMs,
    };
    const idempotency = createIdempotency({
      apply,
      key: idempotencyKey,
      operation: "commissioner_roster_remove",
      leagueId,
      actorUserId: authority.actorUserId,
      input: body,
      occurredAtMs,
      secureRandom,
    });
    return project(
      apply
        ? repository.applyRemove(correction, idempotency)
        : repository.previewRemove(correction),
      "roster_remove"
    );
  }

  function contractCorrection({
    leagueId,
    input,
    idempotencyKey,
    authenticated,
    apply,
  }) {
    const body = exactObject(
      input,
      apply ? [...CONTRACT_FIELDS, "confirmWarnings"] : CONTRACT_FIELDS
    );
    const authority = leagueAuthorization.requireCommissioner(
      authenticated,
      leagueId
    );
    assertBoundedContractValue(
      body.correctedOriginalTotalValueCents,
      body.correctedOriginalTermYears
    );
    const occurredAtMs = safeNow(clock);
    const workspace = repository.readWorkspace({
      leagueId,
      actorUserId: authority.actorUserId,
      actorMembershipId: authority.membershipId,
      actorAuthority: authority.authority,
      observedAtMs: occurredAtMs,
    });
    const authoritative = authoritativeContractCorrection({
      body,
      workspace,
      secureRandom,
    });
    const correction = {
      correctionId: secureRandom.id(),
      contractEventId: secureRandom.id(),
      activityId: secureRandom.id(),
      leagueId,
      ...body,
      ...authoritative,
      actorUserId: authority.actorUserId,
      actorMembershipId: authority.membershipId,
      actorAuthority: authority.authority,
      confirmWarnings: apply ? body.confirmWarnings : false,
      occurredAtMs,
    };
    const idempotency = createIdempotency({
      apply,
      key: idempotencyKey,
      operation: "commissioner_contract_correction",
      leagueId,
      actorUserId: authority.actorUserId,
      input: body,
      occurredAtMs,
      secureRandom,
    });
    return project(
      apply
        ? repository.applyContract(correction, idempotency)
        : repository.previewContract(correction),
      "contract"
    );
  }

  return Object.freeze({
    readWorkspace({ leagueId, authenticated } = {}) {
      const authority = leagueAuthorization.requireCommissioner(
        authenticated,
        leagueId
      );
      const workspace = repository.readWorkspace({
        leagueId,
        actorUserId: authority.actorUserId,
        actorMembershipId: authority.membershipId,
        actorAuthority: authority.authority,
        observedAtMs: safeNow(clock),
      });
      return Object.freeze({
        code: "COMMISSIONER_ROSTER_WORKSPACE_FOUND",
        workspace: Object.freeze({
          ...workspace,
          providerHealth: Object.freeze({
            ...workspace.providerHealth,
            enabled: providerEnabled,
          }),
        }),
      });
    },
    previewAdd(options) {
      return rosterAddition({ ...options, apply: false });
    },
    applyAdd(options) {
      return rosterAddition({ ...options, apply: true });
    },
    previewRemove(options) {
      return rosterRemoval({ ...options, apply: false });
    },
    applyRemove(options) {
      return rosterRemoval({ ...options, apply: true });
    },
    previewRoster(options) {
      return rosterCorrection({ ...options, apply: false });
    },
    applyRoster(options) {
      return rosterCorrection({ ...options, apply: true });
    },
    previewContract(options) {
      return contractCorrection({ ...options, apply: false });
    },
    applyContract(options) {
      return contractCorrection({ ...options, apply: true });
    },
  });
}

module.exports = {
  CONTRACT_FIELDS,
  ROSTER_ADD_FIELDS,
  ROSTER_FIELDS,
  ROSTER_REMOVE_FIELDS,
  createCommissionerCorrectionService,
};
