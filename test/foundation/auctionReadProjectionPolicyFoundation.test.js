"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  AUCTION_READ_PROJECTION_CODES,
  AUCTION_READ_PROJECTION_REASON_CODES,
  AuctionReadProjectionPolicyError,
  validateAuctionReadProjection,
  validateAuctionStartTeamsProjection,
} = require(
  "../../src/domain/auctions/auctionReadProjectionPolicy"
);
const {
  createFreeAgentDraftAuctionDrawCommitment,
  createFreeAgentDraftAuctionDrawReveal,
  createFreeAgentDraftAuctionNoSelectionReveal,
} = require(
  "../../src/domain/freeAgentDraft/freeAgentDraftAuctionDrawPolicy"
);

function id(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

const IDS = Object.freeze({
  auction: id(1),
  league: id(2),
  season: id(3),
  player: id(4),
  teamOne: id(5),
  teamTwo: id(6),
  bidOne: id(7),
  bidTwo: id(8),
  fad: id(9),
  rollover: id(10),
  contract: id(11),
  ownership: id(12),
  activity: id(13),
  recovery: id(14),
});

const NONCE_BYTES = new Uint8Array(32).fill(0x0b);
const HOUR_MS = 3_600_000;
const FAD_ROLLOVER_AT_MS = 7_200_000;
const FAD_CREATION_CUTOFF_AT_MS =
  FAD_ROLLOVER_AT_MS - HOUR_MS;
const COMMITMENT =
  createFreeAgentDraftAuctionDrawCommitment({
    auctionId: IDS.auction,
    nonceBytes: NONCE_BYTES,
  }).commitmentHex;

function team(teamId, name = "North Stars") {
  return {
    teamId,
    name,
    primaryColour: "#112233",
    secondaryColour: "#ddeeff",
    tertiaryColour: null,
    patternTemplate: "solid",
    logoReference: null,
  };
}

function player() {
  return {
    playerId: IDS.player,
    fullName: "Safe Player",
    positionGroup: "F",
  };
}

function allowed() {
  return { allowed: true, reasonCode: null };
}

function blocked(reasonCode = "PHASE_CLOSED") {
  return { allowed: false, reasonCode };
}

function viewerBid({
  bidId = IDS.bidOne,
  status = "active",
  fad = false,
} = {}) {
  const value = {
    bidId,
    version: 1,
    status,
    totalValueCents: 600,
    termYears: 2,
    aavCents: 300,
    editCount: 0,
    editLimit: 2,
    cooldownEndsAtMs: 1_100,
  };
  if (fad) {
    value.bindingIllegalityConfirmedAtMs = 1_000;
  }
  return value;
}

function viewerTeam({
  teamId = IDS.teamOne,
  bid = viewerBid(),
  sourceKind = "ordinary_weekly",
  participantStatus,
} = {}) {
  const restricted = sourceKind === "fad_restricted";
  const status = participantStatus === undefined
    ? (restricted ? "active" : null)
    : participantStatus;
  return {
    teamId,
    team: team(teamId),
    eligible: restricted ? status === "active" : true,
    participantStatus: status,
    bid,
    join: bid === null ? allowed() : blocked(),
    edit: bid === null ? blocked() : allowed(),
  };
}

function administrativeBid({
  bidId = IDS.bidOne,
  teamId = IDS.teamOne,
  status = "active",
  sourceKind = "ordinary_weekly",
  participantStatus,
} = {}) {
  const restricted = sourceKind === "fad_restricted";
  return {
    bidId,
    teamId,
    team: team(teamId),
    version: 1,
    status,
    participantStatus: participantStatus === undefined
      ? (restricted ? "active" : null)
      : participantStatus,
    capabilities: {
      adminEditBid: allowed(),
      adminRemoveBid: allowed(),
    },
  };
}

function capabilities() {
  return {
    view: allowed(),
    adminCancel: blocked("NOT_AUTHORIZED"),
    adminResolve: blocked("NOT_AUTHORIZED"),
  };
}

function ordinaryActive() {
  return {
    auctionId: IDS.auction,
    leagueId: IDS.league,
    seasonId: IDS.season,
    version: 1,
    player: player(),
    status: "active",
    openedAtMs: 1_000,
    resolvesAtMs: 2_000,
    resolvedAtMs: null,
    updatedAtMs: 1_000,
    bidCount: 1,
    participatingTeamCount: 1,
    sourceKind: "ordinary_weekly",
    fadOrigin: null,
    fadId: null,
    fadRolloverId: null,
    targetRolloverAtMs: null,
    creationCutoffAtMs: null,
    eligibleTeams: [],
    minimumContract: null,
    drawCommitment: null,
    viewerTeams: [viewerTeam()],
    administrativeBids: [administrativeBid()],
    result: null,
    capabilities: capabilities(),
  };
}

function fadActive(sourceKind = "fad_open_rapid") {
  const restricted = sourceKind === "fad_restricted";
  const projection = ordinaryActive();
  projection.sourceKind = sourceKind;
  projection.fadOrigin = restricted
    ? "candidate_tie_restricted"
    : "manager_nomination";
  projection.fadId = IDS.fad;
  projection.fadRolloverId = IDS.rollover;
  projection.resolvesAtMs = FAD_ROLLOVER_AT_MS;
  projection.targetRolloverAtMs = FAD_ROLLOVER_AT_MS;
  projection.creationCutoffAtMs =
    FAD_CREATION_CUTOFF_AT_MS;
  projection.eligibleTeams = restricted
    ? [team(IDS.teamOne)]
    : [];
  projection.minimumContract = restricted
    ? {
        totalValueCents: 600,
        termYears: 2,
        aavCents: 300,
      }
    : null;
  projection.drawCommitment = COMMITMENT;
  projection.viewerTeams = [viewerTeam({
    sourceKind,
    bid: viewerBid({ fad: true }),
  })];
  projection.administrativeBids = [administrativeBid({
    sourceKind,
  })];
  return projection;
}

function noSelectionReveal() {
  const canonical =
    createFreeAgentDraftAuctionNoSelectionReveal({
      auctionId: IDS.auction,
      commitmentHex: COMMITMENT,
      nonceBytes: NONCE_BYTES,
    });
  return {
    ...canonical,
    orderedBidIds: [...canonical.orderedBidIds],
    selectedTeamId: null,
  };
}

function selectionReveal() {
  const canonical = createFreeAgentDraftAuctionDrawReveal({
    auctionId: IDS.auction,
    commitmentHex: COMMITMENT,
    nonceBytes: NONCE_BYTES,
    rolloverAtMs: FAD_ROLLOVER_AT_MS,
    tiedBidIds: [IDS.bidOne, IDS.bidTwo],
  });
  return {
    ...canonical,
    orderedBidIds: [...canonical.orderedBidIds],
    selectedTeamId: canonical.selectedBidId === IDS.bidOne
      ? IDS.teamOne
      : IDS.teamTwo,
  };
}

function terminalResult({
  status = "resolved",
  fad = false,
  reveal = noSelectionReveal(),
  resolvedAtMs = 2_000,
} = {}) {
  const resolved = status === "resolved";
  const winningTeamId = reveal?.selectionUsed
    ? reveal.selectedTeamId
    : IDS.teamOne;
  return {
    outcomeCode: status,
    winningTeam: resolved ? team(winningTeamId) : null,
    submittedTotalValueCents: resolved ? 600 : null,
    submittedTermYears: resolved ? 2 : null,
    submittedAavCents: resolved ? 300 : null,
    finalContractValueCents: resolved ? 600 : null,
    finalAavCents: resolved ? 300 : null,
    contractId: resolved ? IDS.contract : null,
    ownershipId: resolved ? IDS.ownership : null,
    activityId: IDS.activity,
    recoveryId: status === "correction_required"
      ? IDS.recovery
      : null,
    drawEvidence: fad
      ? { commitmentHex: COMMITMENT, reveal }
      : null,
    resolvedAtMs,
  };
}

function ordinaryResolved() {
  const projection = ordinaryActive();
  projection.status = "resolved";
  projection.resolvedAtMs = 2_000;
  projection.updatedAtMs = 2_000;
  projection.viewerTeams[0].bid.status = "won";
  projection.administrativeBids[0].status = "won";
  projection.result = terminalResult();
  return projection;
}

function fadResolved({ tie = false } = {}) {
  const projection = fadActive();
  const reveal = tie ? selectionReveal() : noSelectionReveal();
  projection.status = "resolved";
  projection.resolvedAtMs = FAD_ROLLOVER_AT_MS;
  projection.updatedAtMs = FAD_ROLLOVER_AT_MS;
  projection.viewerTeams[0].bid.status =
    reveal.selectedTeamId === IDS.teamTwo ? "lost" : "won";
  projection.administrativeBids[0].status =
    reveal.selectedTeamId === IDS.teamTwo ? "lost" : "won";
  if (tie) {
    projection.bidCount = 2;
    projection.participatingTeamCount = 2;
    projection.administrativeBids.push(administrativeBid({
      bidId: IDS.bidTwo,
      teamId: IDS.teamTwo,
      status: reveal.selectedTeamId === IDS.teamTwo
        ? "won"
        : "lost",
      sourceKind: "fad_open_rapid",
    }));
  }
  projection.result = terminalResult({
    fad: true,
    reveal,
    resolvedAtMs: FAD_ROLLOVER_AT_MS,
  });
  return projection;
}

function fadCorrectionAwaitingReveal() {
  const projection = fadActive("fad_restricted");
  projection.status = "correction_required";
  projection.resolvedAtMs = FAD_ROLLOVER_AT_MS;
  projection.updatedAtMs = FAD_ROLLOVER_AT_MS;
  projection.result = terminalResult({
    status: "correction_required",
    fad: true,
    reveal: null,
    resolvedAtMs: FAD_ROLLOVER_AT_MS,
  });
  return projection;
}

function clone(value) {
  return structuredClone(value);
}

function expectInvalid(value, reasonCode) {
  assert.throws(
    () => validateAuctionReadProjection(value),
    (error) => {
      assert.ok(error instanceof AuctionReadProjectionPolicyError);
      assert.equal(
        error.code,
        AUCTION_READ_PROJECTION_CODES.projectionInvalid
      );
      if (reasonCode) {
        assert.equal(error.reasonCode, reasonCode);
      }
      return true;
    }
  );
}

function expectStartTeamsInvalid(value, reasonCode) {
  assert.throws(
    () => validateAuctionStartTeamsProjection(value),
    (error) => {
      assert.ok(error instanceof AuctionReadProjectionPolicyError);
      assert.equal(
        error.code,
        AUCTION_READ_PROJECTION_CODES.projectionInvalid
      );
      if (reasonCode) {
        assert.equal(error.reasonCode, reasonCode);
      }
      return true;
    }
  );
}

test("auction read projection accepts exact ordinary and FAD active DTOs and deeply freezes them", () => {
  const inactiveBidProjection = ordinaryActive();
  inactiveBidProjection.bidCount = 0;
  inactiveBidProjection.participatingTeamCount = 0;
  inactiveBidProjection.viewerTeams[0].bid.status = "withdrawn";
  inactiveBidProjection.viewerTeams[0].edit = blocked();
  inactiveBidProjection.administrativeBids[0].status = "withdrawn";
  const aavFirstProjection = ordinaryActive();
  aavFirstProjection.viewerTeams[0].bid = {
    ...aavFirstProjection.viewerTeams[0].bid,
    totalValueCents: 250,
    termYears: 2,
    aavCents: 125,
  };
  for (const projection of [
    ordinaryActive(),
    inactiveBidProjection,
    aavFirstProjection,
    fadActive(),
    fadActive("fad_restricted"),
  ]) {
    const validated = validateAuctionReadProjection(projection);
    assert.equal(validated, projection);
    assert.ok(Object.isFrozen(validated));
    assert.ok(Object.isFrozen(validated.player));
    assert.ok(Object.isFrozen(validated.viewerTeams));
    assert.ok(Object.isFrozen(validated.viewerTeams[0]));
    assert.ok(Object.isFrozen(validated.viewerTeams[0].bid));
    assert.ok(Object.isFrozen(validated.capabilities.view));
  }
});

test("auction read projection accepts exact ordinary and FAD terminal result variants", () => {
  const ordinary = ordinaryResolved();
  ordinary.result.recoveryId = IDS.recovery;
  const values = [
    ordinary,
    fadResolved(),
    fadResolved({ tie: true }),
    fadCorrectionAwaitingReveal(),
  ];
  for (const projection of values) {
    const validated = validateAuctionReadProjection(projection);
    assert.equal(validated, projection);
    assert.ok(Object.isFrozen(validated.result));
    if (validated.result.drawEvidence) {
      assert.ok(Object.isFrozen(validated.result.drawEvidence));
    }
  }
});

test("auction read projection rejects extra, accessor, symbol, identifier, version, timestamp, status, and count defects", () => {
  const cases = [
    ["extra auction field", (value) => {
      value.secret = "leak";
    }, AUCTION_READ_PROJECTION_REASON_CODES.auctionFieldsInvalid],
    ["symbol auction field", (value) => {
      value[Symbol("hidden")] = "leak";
    }, AUCTION_READ_PROJECTION_REASON_CODES.auctionFieldsInvalid],
    ["accessor auction field", (value) => {
      Object.defineProperty(value, "auctionId", {
        enumerable: true,
        get() {
          return IDS.auction;
        },
      });
    }, AUCTION_READ_PROJECTION_REASON_CODES.auctionFieldsInvalid],
    ["non-enumerable auction field", (value) => {
      Object.defineProperty(value, "hidden", {
        value: "leak",
      });
    }, AUCTION_READ_PROJECTION_REASON_CODES.auctionFieldsInvalid],
    ["bad identifier", (value) => {
      value.auctionId = "A1";
    }, AUCTION_READ_PROJECTION_REASON_CODES.auctionInvalid],
    ["zero version", (value) => {
      value.version = 0;
    }, AUCTION_READ_PROJECTION_REASON_CODES.auctionInvalid],
    ["unknown status", (value) => {
      value.status = "open";
    }, AUCTION_READ_PROJECTION_REASON_CODES.auctionInvalid],
    ["reversed timestamps", (value) => {
      value.resolvesAtMs = value.openedAtMs;
    }, AUCTION_READ_PROJECTION_REASON_CODES.auctionInvalid],
    ["unsafe timestamp", (value) => {
      value.updatedAtMs = Number.MAX_SAFE_INTEGER;
    }, AUCTION_READ_PROJECTION_REASON_CODES.auctionInvalid],
    ["negative count", (value) => {
      value.bidCount = -1;
    }, AUCTION_READ_PROJECTION_REASON_CODES.auctionInvalid],
    ["too many participating teams", (value) => {
      value.participatingTeamCount = 2;
    }, AUCTION_READ_PROJECTION_REASON_CODES.auctionInvalid],
  ];
  for (const [name, mutate, reason] of cases) {
    const value = ordinaryActive();
    mutate(value);
    assert.doesNotThrow(() => {
      expectInvalid(value, reason);
    }, name);
  }
});

test("auction read projection rejects unsafe shared player, team, and capability shapes", () => {
  const cases = [
    ["player position", (value) => {
      value.player.positionGroup = "G";
    }, AUCTION_READ_PROJECTION_REASON_CODES.playerInvalid],
    ["player extra", (value) => {
      value.player.currentTeam = "Secret";
    }, AUCTION_READ_PROJECTION_REASON_CODES.playerInvalid],
    ["team mismatch", (value) => {
      value.viewerTeams[0].team.teamId = IDS.teamTwo;
    }, AUCTION_READ_PROJECTION_REASON_CODES.viewerTeamsInvalid],
    ["team extra", (value) => {
      value.viewerTeams[0].team.salary = 600;
    }, AUCTION_READ_PROJECTION_REASON_CODES.teamInvalid],
    ["allowed reason", (value) => {
      value.capabilities.view.reasonCode = "PHASE_CLOSED";
    }, AUCTION_READ_PROJECTION_REASON_CODES.capabilityInvalid],
    ["unknown blocked reason", (value) => {
      value.capabilities.adminCancel.reasonCode = "NOPE";
    }, AUCTION_READ_PROJECTION_REASON_CODES.capabilityInvalid],
    ["capability extra", (value) => {
      value.viewerTeams[0].join.retryAtMs = 2_000;
    }, AUCTION_READ_PROJECTION_REASON_CODES.capabilityInvalid],
  ];
  for (const [name, mutate, reason] of cases) {
    const value = ordinaryActive();
    mutate(value);
    assert.doesNotThrow(() => {
      expectInvalid(value, reason);
    }, name);
  }
});

test("viewer rows enforce exact own-bid visibility and context-dependent confirmation fields", () => {
  const cases = [
    ["ordinary confirmation leak", ordinaryActive, (value) => {
      value.viewerTeams[0].bid.bindingIllegalityConfirmedAtMs = 1_000;
    }, "viewerBidInvalid"],
    ["missing FAD confirmation", fadActive, (value) => {
      delete value.viewerTeams[0].bid.bindingIllegalityConfirmedAtMs;
    }, "viewerBidInvalid"],
    ["null FAD confirmation", fadActive, (value) => {
      value.viewerTeams[0].bid.bindingIllegalityConfirmedAtMs = null;
    }, "viewerBidInvalid"],
    ["wrong AAV", ordinaryActive, (value) => {
      value.viewerTeams[0].bid.aavCents = 301;
    }, "viewerBidInvalid"],
    ["invalid multi-year increment", ordinaryActive, (value) => {
      value.viewerTeams[0].bid.totalValueCents = 601;
      value.viewerTeams[0].bid.aavCents = 301;
    }, "viewerBidInvalid"],
    ["edit count beyond limit", ordinaryActive, (value) => {
      value.viewerTeams[0].bid.editCount = 3;
    }, "viewerBidInvalid"],
    ["null cooldown end", ordinaryActive, (value) => {
      value.viewerTeams[0].bid.cooldownEndsAtMs = null;
    }, "viewerBidInvalid"],
    ["duplicate viewer team", ordinaryActive, (value) => {
      value.viewerTeams.push(clone(value.viewerTeams[0]));
    }],
    ["viewer array extra field", ordinaryActive, (value) => {
      value.viewerTeams.hidden = "leak";
    }],
    ["duplicate viewer bid", ordinaryActive, (value) => {
      value.viewerTeams.push(viewerTeam({
        teamId: IDS.teamTwo,
        bid: viewerBid({ bidId: IDS.bidOne }),
      }));
    }],
    ["ordinary participant", ordinaryActive, (value) => {
      value.viewerTeams[0].participantStatus = "active";
    }],
    ["ordinary ineligible", ordinaryActive, (value) => {
      value.viewerTeams[0].eligible = false;
    }],
    ["restricted eligibility mismatch", () => fadActive("fad_restricted"), (value) => {
      value.viewerTeams[0].eligible = false;
    }],
    ["restricted unknown participant", () => fadActive("fad_restricted"), (value) => {
      value.viewerTeams[0].participantStatus = "invited";
    }],
  ];
  for (const [name, build, mutate, reasonKey = "viewerTeamsInvalid"] of cases) {
    const value = build();
    mutate(value);
    assert.doesNotThrow(() => {
      expectInvalid(
        value,
        AUCTION_READ_PROJECTION_REASON_CODES[reasonKey]
      );
    }, name);
  }
});

test("administrative bid rows are identity-only and never expose competing values or histories", () => {
  const leakageFields = [
    ["totalValueCents", 600],
    ["termYears", 2],
    ["aavCents", 300],
    ["editCount", 0],
    ["editHistory", []],
    ["cooldownEndsAtMs", 2_000],
  ];
  for (const [field, leakedValue] of leakageFields) {
    const value = ordinaryActive();
    value.administrativeBids[0][field] = leakedValue;
    expectInvalid(
      value,
      AUCTION_READ_PROJECTION_REASON_CODES
        .administrativeBidsInvalid
    );
  }
  const cases = [
    ["ordinary participant", ordinaryActive, (value) => {
      value.administrativeBids[0].participantStatus = "active";
    }],
    ["restricted missing participant", () => fadActive("fad_restricted"), (value) => {
      value.administrativeBids[0].participantStatus = null;
    }],
    ["duplicate bid", ordinaryActive, (value) => {
      value.administrativeBids.push(administrativeBid({
        bidId: IDS.bidOne,
        teamId: IDS.teamTwo,
      }));
    }],
    ["duplicate team", ordinaryActive, (value) => {
      value.administrativeBids.push(administrativeBid({
        bidId: IDS.bidTwo,
        teamId: IDS.teamOne,
      }));
    }],
  ];
  for (const [name, build, mutate] of cases) {
    const value = build();
    mutate(value);
    assert.doesNotThrow(() => {
      expectInvalid(value);
    }, name);
  }

  const rejoined = ordinaryActive();
  rejoined.administrativeBids.push(administrativeBid({
    bidId: IDS.bidTwo,
    teamId: IDS.teamOne,
    status: "withdrawn",
  }));
  rejoined.administrativeBids[1].capabilities = {
    adminEditBid: blocked(),
    adminRemoveBid: blocked(),
  };
  assert.equal(
    validateAuctionReadProjection(rejoined),
    rejoined
  );
});

test("auction context matrix rejects ordinary leakage and invalid FAD origin, eligibility, floor, and commitment combinations", () => {
  const cases = [
    ["ordinary FAD id", ordinaryActive, (value) => {
      value.fadId = IDS.fad;
    }],
    ["ordinary eligible team", ordinaryActive, (value) => {
      value.eligibleTeams = [team(IDS.teamOne)];
    }],
    ["ordinary floor", ordinaryActive, (value) => {
      value.minimumContract = {
        totalValueCents: 600,
        termYears: 2,
        aavCents: 300,
      };
    }],
    ["open eligible team", fadActive, (value) => {
      value.eligibleTeams = [team(IDS.teamOne)];
    }],
    ["open restricted origin", fadActive, (value) => {
      value.fadOrigin = "candidate_tie_restricted";
    }],
    ["restricted nomination origin", () => fadActive("fad_restricted"), (value) => {
      value.fadOrigin = "manager_nomination";
    }],
    ["restricted missing floor", () => fadActive("fad_restricted"), (value) => {
      value.minimumContract = null;
    }],
    ["fallback missing floor", fadActive, (value) => {
      value.fadOrigin = "restricted_no_improvement_fallback";
    }],
    ["normal open extra floor", fadActive, (value) => {
      value.minimumContract = {
        totalValueCents: 600,
        termYears: 2,
        aavCents: 300,
      };
    }],
    ["floor wrong AAV", () => fadActive("fad_restricted"), (value) => {
      value.minimumContract.aavCents = 299;
    }],
    ["active missing commitment", fadActive, (value) => {
      value.drawCommitment = null;
    }],
    ["uppercase commitment", fadActive, (value) => {
      value.drawCommitment = "A".repeat(64);
    }],
    ["cutoff one millisecond late", fadActive, (value) => {
      value.creationCutoffAtMs =
        FAD_CREATION_CUTOFF_AT_MS + 1;
    }],
    ["cutoff one millisecond early", fadActive, (value) => {
      value.creationCutoffAtMs =
        FAD_CREATION_CUTOFF_AT_MS - 1;
    }],
    ["duplicate eligible team", () => fadActive("fad_restricted"), (value) => {
      value.eligibleTeams.push(team(IDS.teamOne));
    }],
  ];
  for (const [name, build, mutate] of cases) {
    const value = build();
    mutate(value);
    assert.doesNotThrow(() => {
      expectInvalid(value);
    }, name);
  }
});

test("active and terminal lifecycle matrix rejects result, winner, recovery, and draw evidence inconsistencies", () => {
  const cases = [
    ["active result", ordinaryActive, (value) => {
      value.result = terminalResult();
    }],
    ["active resolved timestamp", ordinaryActive, (value) => {
      value.resolvedAtMs = 2_000;
    }],
    ["terminal missing result", ordinaryResolved, (value) => {
      value.result = null;
    }],
    ["terminal timestamp mismatch", ordinaryResolved, (value) => {
      value.result.resolvedAtMs = 2_001;
    }],
    ["terminal outcome mismatch", ordinaryResolved, (value) => {
      value.result.outcomeCode = "no_winner";
    }],
    ["resolved missing ownership", ordinaryResolved, (value) => {
      value.result.ownershipId = null;
    }],
    ["resolved submitted AAV mismatch", ordinaryResolved, (value) => {
      value.result.submittedAavCents = 301;
    }],
    ["nonwinner with money", () => {
      const value = ordinaryResolved();
      value.status = "no_winner";
      value.result = terminalResult({ status: "no_winner" });
      return value;
    }, (value) => {
      value.result.finalAavCents = 300;
    }],
    ["correction missing recovery", fadCorrectionAwaitingReveal, (value) => {
      value.result.recoveryId = null;
    }],
    ["ordinary draw evidence", ordinaryResolved, (value) => {
      value.result.drawEvidence = {
        commitmentHex: COMMITMENT,
        reveal: noSelectionReveal(),
      };
    }],
    ["FAD missing evidence", fadResolved, (value) => {
      value.result.drawEvidence = null;
    }],
    ["semantic terminal null reveal", fadResolved, (value) => {
      value.result.drawEvidence.reveal = null;
    }],
    ["awaiting reveal missing top commitment", fadCorrectionAwaitingReveal, (value) => {
      value.drawCommitment = null;
    }],
    ["evidence commitment mismatch", fadResolved, (value) => {
      value.result.drawEvidence.commitmentHex = "d".repeat(64);
    }],
  ];
  for (const [name, build, mutate] of cases) {
    const value = build();
    mutate(value);
    assert.doesNotThrow(() => {
      expectInvalid(value);
    }, name);
  }
});

test("FAD draw reveal validates exact no-selection and equal-chance selection semantics", () => {
  const cases = [
    ["reveal extra field", (value) => {
      value.result.drawEvidence.reveal.seed = "secret";
    }],
    ["wrong algorithm", (value) => {
      value.result.drawEvidence.reveal.algorithmVersion = 2;
    }],
    ["nonce commitment mismatch", (value) => {
      value.result.drawEvidence.reveal.nonceHex = "d".repeat(64);
    }],
    ["no selection ordered IDs", (value) => {
      value.result.drawEvidence.reveal.orderedBidIds = [IDS.bidOne];
    }],
    ["no selection counter", (value) => {
      value.result.drawEvidence.reveal.counter = 0;
    }],
    ["selection unsorted", (value) => {
      value.result.drawEvidence.reveal.orderedBidIds = [
        IDS.bidTwo,
        IDS.bidOne,
      ];
    }, true],
    ["selection duplicate", (value) => {
      value.result.drawEvidence.reveal.orderedBidIds = [
        IDS.bidOne,
        IDS.bidOne,
      ];
    }, true],
    ["selection wrong selected bid", (value) => {
      value.result.drawEvidence.reveal.selectedBidId =
        value.result.drawEvidence.reveal.selectedBidId === IDS.bidOne
          ? IDS.bidTwo
          : IDS.bidOne;
    }, true],
    ["selection wrong selected team", (value) => {
      value.result.drawEvidence.reveal.selectedTeamId =
        value.result.drawEvidence.reveal.selectedTeamId === IDS.teamOne
          ? IDS.teamTwo
          : IDS.teamOne;
    }, true],
    ["selection bad digest", (value) => {
      value.result.drawEvidence.reveal.digestHex = "d".repeat(64);
    }, true],
    ["selection noncanonical counter", (value) => {
      value.result.drawEvidence.reveal.counter += 1;
    }, true],
    ["selection uint32 overflow", (value) => {
      value.result.drawEvidence.reveal.counter = 0x1_0000_0000;
    }, true],
  ];
  for (const [name, mutate, tie = false] of cases) {
    const value = fadResolved({ tie });
    mutate(value);
    assert.doesNotThrow(() => {
      expectInvalid(
        value,
        AUCTION_READ_PROJECTION_REASON_CODES
          .drawEvidenceInvalid
      );
    }, name);
  }

  const cancelled = fadResolved();
  cancelled.status = "cancelled";
  cancelled.result = terminalResult({
    status: "cancelled",
    fad: true,
    reveal: selectionReveal(),
    resolvedAtMs: FAD_ROLLOVER_AT_MS,
  });
  expectInvalid(
    cancelled,
    AUCTION_READ_PROJECTION_REASON_CODES.drawEvidenceInvalid
  );
});

function startTeam({
  teamId = IDS.teamOne,
  sourceKind = "ordinary_weekly",
  withRollover = true,
} = {}) {
  const fad = sourceKind === "fad_open_rapid";
  return {
    teamId,
    team: team(teamId),
    sourceKind,
    fadId: fad ? IDS.fad : null,
    fadRolloverId: fad && withRollover
      ? IDS.rollover
      : null,
    targetRolloverAtMs: fad && withRollover
      ? FAD_ROLLOVER_AT_MS
      : null,
    creationCutoffAtMs: fad && withRollover
      ? FAD_CREATION_CUTOFF_AT_MS
      : null,
    startAuction: allowed(),
  };
}

test("start-team collection actions accept ordinary and FAD rows, including a FAD awaiting its rapid rollover", () => {
  const rows = [
    startTeam(),
    startTeam({
      teamId: IDS.teamTwo,
      sourceKind: "fad_open_rapid",
    }),
  ];
  const validated = validateAuctionStartTeamsProjection(rows);
  assert.equal(validated, rows);
  assert.ok(Object.isFrozen(validated));
  assert.ok(Object.isFrozen(validated[0]));
  assert.ok(Object.isFrozen(validated[0].team));

  const awaiting = [startTeam({
    sourceKind: "fad_open_rapid",
    withRollover: false,
  })];
  validateAuctionStartTeamsProjection(awaiting);
  assert.ok(Object.isFrozen(awaiting[0].startAuction));
});

test("start-team collection actions reject leaks, duplicates, team mismatches, restricted contexts, and partial rollover identity", () => {
  const cases = [
    ["extra field", [startTeam()], (value) => {
      value[0].minimumContract = null;
    }],
    ["array extra field", [startTeam()], (value) => {
      value.hidden = "leak";
    }],
    ["duplicate team", [startTeam(), startTeam()], () => {}],
    ["team mismatch", [startTeam()], (value) => {
      value[0].team.teamId = IDS.teamTwo;
    }],
    ["restricted context", [startTeam()], (value) => {
      value[0].sourceKind = "fad_restricted";
    }],
    ["ordinary FAD identity", [startTeam()], (value) => {
      value[0].fadId = IDS.fad;
    }],
    ["FAD missing identity", [startTeam({
      sourceKind: "fad_open_rapid",
    })], (value) => {
      value[0].fadId = null;
    }],
    ["partial rollover", [startTeam({
      sourceKind: "fad_open_rapid",
    })], (value) => {
      value[0].creationCutoffAtMs = null;
    }],
    ["cutoff one millisecond late", [startTeam({
      sourceKind: "fad_open_rapid",
    })], (value) => {
      value[0].creationCutoffAtMs =
        FAD_CREATION_CUTOFF_AT_MS + 1;
    }],
    ["cutoff one millisecond early", [startTeam({
      sourceKind: "fad_open_rapid",
    })], (value) => {
      value[0].creationCutoffAtMs =
        FAD_CREATION_CUTOFF_AT_MS - 1;
    }],
    ["competing value leak", [startTeam()], (value) => {
      value[0].totalValueCents = 600;
    }],
  ];
  for (const [name, rows, mutate] of cases) {
    mutate(rows);
    assert.doesNotThrow(() => {
      expectStartTeamsInvalid(rows);
    }, name);
  }
});

test("public policy exports are frozen and stable", () => {
  assert.ok(Object.isFrozen(AUCTION_READ_PROJECTION_CODES));
  assert.ok(Object.isFrozen(
    AUCTION_READ_PROJECTION_REASON_CODES
  ));
  assert.deepEqual(
    Object.keys(require(
      "../../src/domain/auctions/auctionReadProjectionPolicy"
    )).sort(),
    [
      "AUCTION_READ_PROJECTION_CODES",
      "AUCTION_READ_PROJECTION_REASON_CODES",
      "AuctionReadProjectionPolicyError",
      "validateAuctionReadProjection",
      "validateAuctionStartTeamsProjection",
    ].sort()
  );
});
