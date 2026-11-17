"use strict";

const MINUTE = 60_000;
const RULES = Object.freeze({ cap: 100, minBid: 1, lotSeconds: 120, forwards: 3, defense: 2, extras: 2 });
const ROSTER_SIZE = RULES.forwards + RULES.defense + RULES.extras;
const FORWARDS = new Set(["F", "C", "L", "R", "LW", "RW"]);
const iso = (value) => new Date(value).toISOString();
const auctionEnd = (room) => room.practiceEndsAt ?? room.firstGameAt;

function reject(status, code, message) {
  throw Object.assign(new Error(message), { status, code });
}

function requireActor(actor) {
  if (typeof actor?.id !== "string" || !actor.id || typeof actor.name !== "string" || !actor.name) {
    reject(401, "DAILY_SIGN_IN_REQUIRED", "Sign in to participate in Hundo Daily.");
  }
}

function phase(room, now) {
  if (room.closed) return "closed";
  if (room.void) return "void";
  if (room.finished) return "finished";
  if (now >= auctionEnd(room)) return "locked";
  if (now >= auctionEnd(room) - 30 * MINUTE) return "auction";
  return "waiting";
}

function summary(room, actor, now) {
  const currentPhase = phase(room, now);
  return {
    id: room.id, name: room.name, capacity: room.capacity, memberCount: room.members.length,
    joined: room.members.some((member) => member.id === actor?.id),
    commissionerId: room.commissionerId, commissionerName: room.members.find(member => member.id === room.commissionerId)?.name ?? null,
    date: room.date, firstGameAt: iso(room.firstGameAt),
    mode: room.mode ?? "scheduled", auctionStartsAt: iso(auctionEnd(room) - 30 * MINUTE),
    auctionEndsAt: iso(auctionEnd(room)), phase: currentPhase, winners: room.winners,
    canClose: currentPhase !== "closed" && (actor?.isAdmin === true ||
      (actor?.id === room.commissionerId && (currentPhase === "finished" || currentPhase === "void"))),
  };
}

function winningBid(lot) {
  // Array order is commit order, including requests made in the same millisecond.
  return lot.bids.reduce((winner, bid) => bid.amount > winner.amount ? bid : winner);
}

function analyzeRoom(room, players, now) {
  const byId = new Map(players.map((player) => [player.id, player]));
  const teams = new Map(room.members.map((member) => [member.id,
    { roster: [], commitments: [], spent: 0, reserved: 0, pointsHundredths: 0 }]));
  for (const lot of room.lots) {
    const player = byId.get(lot.playerId);
    if (now >= lot.endsAt) {
      const winner = winningBid(lot);
      const team = teams.get(winner.userId);
      const pointsHundredths = room.scores[lot.playerId] ?? 0;
      team.roster.push({ ...player, price: winner.amount, points: pointsHundredths / 100 });
      team.spent += winner.amount;
      team.pointsHundredths += pointsHundredths;
    } else if (!room.void) {
      for (const bid of lot.bids) {
        const team = teams.get(bid.userId);
        team.commitments.push(player);
        team.reserved += bid.amount;
      }
    }
  }
  return teams;
}

const CAP_MESSAGE = "Keep every active bid covered and at least $1 for each unfilled slot.";
const ROSTER_MESSAGE = "Your signed players and active bids must fit three forward, two defense, and two extra slots.";
function bidLimit(team, position) {
  const committed = [...team.roster, ...team.commitments];
  const total = committed.length + 1;
  const forwards = committed.filter((player) => FORWARDS.has(player.position)).length + Number(FORWARDS.has(position));
  const defense = total - forwards;
  const extras = total - Math.min(forwards, RULES.forwards) - Math.min(defense, RULES.defense);
  if (total > ROSTER_SIZE || extras > RULES.extras) return { maxAmount: 0, reason: ROSTER_MESSAGE };
  const minimumToFinish = (ROSTER_SIZE - total) * RULES.minBid;
  const maxAmount = RULES.cap - team.spent - team.reserved - minimumToFinish;
  return maxAmount < RULES.minBid ? { maxAmount: 0, reason: CAP_MESSAGE } : { maxAmount, reason: null };
}

function roomView(room, slate, actor, now) {
  const detail = { ...summary(room, actor, now), rules: RULES };
  const closed = { maxAmount: 0, reason: "Bidding is closed." };
  detail.bidLimits = { F: closed, D: closed };
  if (room.closed) return { ...detail, winners: [], members: [], availablePlayers: [], auctions: [] };
  const teams = analyzeRoom(room, slate.players, room.voidAt ?? now);
  if (["waiting", "auction"].includes(detail.phase)) {
    const mine = teams.get(actor?.id);
    const join = { maxAmount: 0, reason: "Join this room before bidding." };
    detail.bidLimits = mine ? { F: bidLimit(mine, "F"), D: bidLimit(mine, "D") } : { F: join, D: join };
  }
  const byId = new Map(slate.players.map((player) => [player.id, player]));
  const nominated = new Set(room.lots.map((lot) => lot.playerId));
  return {
    ...detail,
    members: room.members.map(({ id, name }) => {
      const { roster, spent, reserved, pointsHundredths } = teams.get(id);
      const mine = id === actor?.id;
      return { id, name, roster, spent, reserved: mine ? reserved : null, remainingCap: RULES.cap - spent,
        availableCap: mine ? RULES.cap - spent - reserved : null, points: pointsHundredths / 100 };
    }),
    availablePlayers: ["waiting", "auction"].includes(detail.phase) ? slate.players.filter((player) => !nominated.has(player.id)) : [],
    auctions: room.lots.filter((lot) => !room.void && now < lot.endsAt).map((lot) => ({
      ...byId.get(lot.playerId), bidCount: lot.bids.length, endsAt: iso(lot.endsAt),
      ownBid: lot.bids.find((bid) => bid.userId === actor?.id)?.amount ?? null,
    })),
  };
}

function placeBid(room, slate, actor, playerId, amount, now) {
  if (!room.members.some((member) => member.id === actor.id)) reject(403, "DAILY_MEMBERSHIP_REQUIRED", "Join this room before bidding.");
  if (!Number.isSafeInteger(amount) || amount < RULES.minBid || amount > RULES.cap) {
    reject(400, "DAILY_BID_AMOUNT", "Enter a whole-dollar bid from $1 to $100.");
  }
  const lot = room.lots.find((entry) => entry.playerId === playerId);
  const previous = lot?.bids.find((bid) => bid.userId === actor.id);
  if (previous && previous.amount === amount) return;
  if (phase(room, now) !== "auction") reject(409, "DAILY_AUCTION_INACTIVE", "Bidding is closed.");
  const player = slate.players.find((entry) => entry.id === playerId);
  if (!player) reject(400, "DAILY_INELIGIBLE_PLAYER", "Choose a player from this room’s slate.");
  if (lot && now >= lot.endsAt) reject(409, "DAILY_PLAYER_SIGNED", "This player has already signed.");
  if (previous) reject(409, "DAILY_BID_BINDING", "Your bid on this player is already binding.");

  const team = analyzeRoom(room, slate.players, now).get(actor.id);
  const limit = bidLimit(team, player.position);
  if (amount > limit.maxAmount) {
    if (limit.reason === ROSTER_MESSAGE) reject(409, "DAILY_ROSTER_LIMIT", ROSTER_MESSAGE);
    reject(409, "DAILY_CAP_LIMIT", CAP_MESSAGE);
  }
  const offer = { userId: actor.id, amount };
  if (lot) lot.bids.push(offer);
  else room.lots.push({ playerId, endsAt: Math.min(now + RULES.lotSeconds * 1000, auctionEnd(room)), bids: [offer] });
}

function scoreRoom(room, pointsByPlayerId, final, voided, now) {
  if (phase(room, now) !== "locked") return;
  if (final && voided) {
    room.void = true;
    room.voidAt = now;
    room.scores = {};
    return;
  }
  if (!pointsByPlayerId || typeof pointsByPlayerId !== "object" || Array.isArray(pointsByPlayerId)) {
    throw new TypeError("Daily scoring requires a player points map.");
  }
  for (const lot of room.lots) {
    const points = pointsByPlayerId[lot.playerId];
    if (Number.isSafeInteger(points)) room.scores[lot.playerId] = points;
    else if (final || points !== undefined) throw new TypeError("Daily scoring lacks a valid signed player total.");
  }
  if (final) {
    const totals = new Map(room.members.map(({ id }) => [id, 0]));
    for (const lot of room.lots) {
      const { userId } = winningBid(lot);
      totals.set(userId, totals.get(userId) + room.scores[lot.playerId]);
    }
    let highest = -Infinity;
    for (const points of totals.values()) highest = Math.max(highest, points);
    room.winners = room.members.filter(({ id }) => totals.get(id) === highest)
      .map(({ id, name }) => ({ id, name, points: highest / 100 }));
    room.finished = true;
  }
}

module.exports = { MINUTE, auctionEnd, reject, requireActor, phase, summary, roomView, placeBid, scoreRoom };
