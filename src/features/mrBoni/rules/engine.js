/** Deterministic Mr. Boni rules. Coordinates are in feet; time is in seconds. */
const TANK_LOAD_PER_FOOT = .65 / .8;
const SNOW_LOAD_MULTIPLIERS = Object.freeze([1.4, 2.4, 3.4]);
const RINKS = [25, 25, 25].map((x, i) => Object.freeze({
  id: i + 1, x, y: 12, w: 85, h: 200, radius: 28, density: SNOW_LOAD_MULTIPLIERS[i] * TANK_LOAD_PER_FOOT,
}));
const EPSILON = 1e-7;
// Private indexes only accelerate derived statistics. The cells remain the
// authoritative state, and untracked version changes force a complete recount.
const incrementalStats = new WeakMap();
function cellKind(cell) {
  return !cell.valid ? 0 : cell.snow > EPSILON ? 1 : cell.wet ? 2 : cell.water < CONFIG.waterMinimum - EPSILON ? 3 : 4;
}
function markCellChanged(rink, cell) {
  const state = incrementalStats.get(rink);
  if (!state) return;
  if (state.version !== rink.version || !state.kinds.has(cell)) state.invalidated = true;
  state.dirty.add(cell);
}
function bumpVersion(rink) {
  const state = incrementalStats.get(rink);
  if (state && state.version !== rink.version) state.invalidated = true;
  rink.version++;
  if (state) state.version = rink.version;
}
const GATE_NORMAL = Object.freeze({ x: -Math.SQRT1_2, y: Math.SQRT1_2 });
const GATE_CORNER = Object.freeze({ x: 53, y: 184 });
const GATE_CENTER = Object.freeze({ x: 53 - 28 * Math.SQRT1_2, y: 184 + 28 * Math.SQRT1_2 });
const GATE = Object.freeze({
  center: GATE_CENTER, normal: GATE_NORMAL,
  tangent: Object.freeze({ x: Math.SQRT1_2, y: Math.SQRT1_2 }),
  cornerCenter: GATE_CORNER, angle: 3 * Math.PI / 4, halfAngle: Math.asin(12 / 28), width: 24,
  inner: Object.freeze({ x: GATE_CENTER.x - GATE_NORMAL.x * 12, y: GATE_CENTER.y - GATE_NORMAL.y * 12 }),
  outer: Object.freeze({ x: GATE_CENTER.x + GATE_NORMAL.x * 22, y: GATE_CENTER.y + GATE_NORMAL.y * 22 }),
});

function roundedContains(x, y, rink, inset = 0) {
  const left = rink.x + inset, top = rink.y + inset;
  const width = rink.w - 2 * inset, height = rink.h - 2 * inset;
  if (x < left - EPSILON || x > left + width + EPSILON || y < top - EPSILON || y > top + height + EPSILON) return false;
  const radius = Math.max(0, rink.radius - inset);
  const nearX = Math.max(left + radius, Math.min(x, left + width - radius));
  const nearY = Math.max(top + radius, Math.min(y, top + height - radius));
  return (x - nearX) ** 2 + (y - nearY) ** 2 <= radius ** 2 + EPSILON;
}

let rinkArea = 0;
for (let row = 0; row < 200; row++) {
  for (let col = 0; col < 85; col++) {
    if (roundedContains(RINKS[0].x + col + .5, RINKS[0].y + row + .5, RINKS[0])) rinkArea++;
  }
}

export const CONFIG = Object.freeze({
  worldWidth: 135, worldHeight: 285, rinkWidth: 85, rinkHeight: 200,
  rinkXs: Object.freeze([25, 25, 25]), rinkY: 12, cornerRadius: 28,
  rinks: Object.freeze(RINKS), rinkArea, gateWidth: 24, gate: GATE,
  vehicleLength: 13.25, vehicleWidth: 10, brushWidth: 10, brushRadius: 5,
  collisionRadius: 3.2, maxSpeed: 28, reverseSpeed: 16, acceleration: 34,
  deceleration: 40, brakeDeceleration: 90, stoppedSpeed: .4,
  minTurnRadius: 15.5, steeringRampRate: 2.5, steeringReturnRate: 3.5,
  headingAssistAngle: 10 * Math.PI / 180, headingAssistRate: 6,
  tankCapacity: rinkArea * .65 / .8,
  snowLoadMultipliers: SNOW_LOAD_MULTIPLIERS,
  fullTankSpeedFactor: .4,
  spillIntervalSeconds: 1.5, spillCells: 2, spillSnowPerCell: .35,
  edgeAssistReach: 2,
  snowDensities: Object.freeze(RINKS.map(rink => rink.density)),
  inspectDuration: 1.2, stationaryGraceSeconds: .5, stationaryWaterRate: .6,
  waterTarget: 1, waterMinimum: .82, waterMaximum: 1.65,
  overlapTolerance: .35, wetRepairLoad: .18,
  freshIceSeconds: 30, smearRadius: 5, smearMaxUnfinishedFraction: .35,
  poolCarryCapacity: 8, poolCarryDistance: 18,
  puddleDryGraceSeconds: 8, puddleDryRingSeconds: 3,
  speckMaxRemaining: 32, speckMaxComponent: 4, speckMaxExtent: 2, speckMinCleanBorder: 3,
  corridor: Object.freeze({ x: 10, y: 212, w: 115, h: 38 }),
  dump: Object.freeze({ x: 14, y: 250, w: 67, h: 30 }),
  dumpBay: Object.freeze({ x: 20, y: 250, w: 55, h: 28 }),
  spawn: Object.freeze({ x: GATE_CENTER.x + GATE_NORMAL.x * 18, y: GATE_CENTER.y + GATE_NORMAL.y * 18, angle: -Math.PI / 4 }),
});

export function createGame() {
  return {
    status: 'ready', elapsed: 0, clockStarted: false, level: 1, levelStartedAt: 0, levelTimes: [], levelDumps: [0, 0, 0],
    vehicle: { ...CONFIG.spawn, speed: 0, steering: 0 },
    pump: 1, tank: 0, lastChecked: 0, checkedAt: 0,
    inspection: 0, dumping: 0, dumpEvents: 0, action: null,
    overloaded: false, spillEvents: 0, exitBlocked: false, exitBlockedEvents: 0,
    waterCarry: 0, waterRemoved: 0,
    message: 'Ready for your shift.',
    rinks: RINKS.map(definition => ({
      ...definition, cols: 85, rows: 200, version: 0,
      cells: Array.from({ length: 85 * 200 }, (_, index) => {
        const x = definition.x + index % 85 + .5;
        const y = definition.y + Math.floor(index / 85) + .5;
        const valid = roundedContains(x, y, definition);
        return { x, y, valid, snow: valid ? definition.density : 0, water: 0, wet: false, freshUntil: 0,
          lastWaterAt: 0, wetSince: 0, driedAt: 0, spilledSnow: 0 };
      }),
    })),
    _contacts: new Set(), _contactStates: new Map(), _statsCache: new Map(), _stationarySeconds: 0,
    _smearPlans: null, _lastSweepPump: null, _leakSeconds: 0, _waterCarryBatches: [],
  };
}

export function getFreshness(cell, elapsed) {
  if (!cell.valid || cell.snow > EPSILON || cell.wet || cell.water <= CONFIG.waterMinimum + EPSILON) return 0;
  return Math.max(0, Math.min(1, ((cell.freshUntil || 0) - elapsed) / CONFIG.freshIceSeconds));
}

/** Center collision uses the brush's smaller, forgiving 3.2ft body radius. */
export function canDrive(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const r = CONFIG.collisionRadius;
  for (const rink of [RINKS[0]]) {
    if (roundedContains(x, y, rink, r)) return true;
  }
  // The diagonal southwest opening is the only break in the rink boards.
  if (distanceToSegmentSquared(x, y, GATE.inner.x, GATE.inner.y, GATE.outer.x, GATE.outer.y)
      <= (CONFIG.gateWidth / 2 - r) ** 2 + EPSILON) return true;
  const c = CONFIG.corridor;
  if (x >= c.x + r && x <= c.x + c.w - r && y >= c.y + r && y <= c.y + c.h - r) return true;
  const d = CONFIG.dump;
  // The snow bay is open along its entire top edge.
  return x >= d.x + r && x <= d.x + d.w - r && y >= d.y - r - EPSILON && y <= d.y + d.h - r;
}

export function setPump(game, value) {
  if (![0, .5, 1].includes(value)) return false;
  if (game.status === 'levelComplete' || game.status === 'complete') return false;
  if (value === 0 && game.pump !== 0) game._smearPlans = null;
  if (value !== game.pump) game.exitBlocked = false;
  if (value > 0) clearWaterCarry(game);
  game.pump = value;
  if (value === 0) game._stationarySeconds = 0;
  return true;
}

export function cancelAction(game) {
  if (!game.action) return false;
  game.action = null;
  game.inspection = 0;
  game.dumping = 0;
  game.message = 'Action cancelled.';
  return true;
}

export function beginInspection(game) {
  if (game.status !== 'running' || game.action || Math.abs(game.vehicle.speed) > CONFIG.stoppedSpeed) {
    if (game.status === 'running' && !game.action) game.message = 'Stop before checking the snow tank.';
    return false;
  }
  game.vehicle.speed = 0;
  game.action = 'inspect';
  game.inspection = 0;
  game.message = 'Checking the snow tank…';
  return true;
}

export function beginDump(game) {
  if (game.status !== 'running' || game.tank <= EPSILON) return false;
  const { x, y } = game.vehicle, bay = CONFIG.dumpBay;
  if (x < bay.x || x > bay.x + bay.w || y < bay.y || y > bay.y + bay.h) {
    return false;
  }
  game.tank = 0;
  game.overloaded = false;
  game._leakSeconds = 0;
  game.lastChecked = 0;
  game.checkedAt = game.elapsed;
  game.inspection = 0;
  game.dumping = 1;
  game.action = null;
  game.dumpEvents++;
  game.levelDumps[game.level - 1]++;
  game.message = 'Return to the ice. Switch the pump off when crossing finished areas.';
  return true;
}

function distanceToSegmentSquared(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / length)) : 0;
  return (x - x1 - t * dx) ** 2 + (y - y1 - t * dy) ** 2;
}

function recordWaterAddition(game, cell, wasWet) {
  cell.lastWaterAt = game.elapsed;
  if (cell.wet && !wasWet) cell.wetSince = game.elapsed;
  // New water cannot dry before its grace plus one outer-ring interval. A
  // stale earlier wake-up is safe when an existing puddle is watered again.
  if (cell.wet) game._nextDryAt = Math.min(game._nextDryAt ?? 0,
    game.elapsed + CONFIG.puddleDryGraceSeconds + CONFIG.puddleDryRingSeconds);
}

function limitFullTankSpeed(game) {
  if (game.tank >= CONFIG.tankCapacity - EPSILON) game.overloaded = true;
  if (game.overloaded) {
    game.vehicle.speed = Math.max(-CONFIG.reverseSpeed * CONFIG.fullTankSpeedFactor,
      Math.min(CONFIG.maxSpeed * CONFIG.fullTankSpeedFactor, game.vehicle.speed));
  }
}

function clearWaterCarry(game) {
  game.waterRemoved += game.waterCarry;
  game.waterCarry = 0;
  game._waterCarryBatches = [];
}

function moveWaterCarry(game, distance) {
  for (const batch of game._waterCarryBatches) batch.distance -= distance;
  const expired = game._waterCarryBatches.filter(batch => batch.distance <= EPSILON);
  const amount = expired.reduce((sum, batch) => sum + batch.amount, 0);
  game.waterRemoved += amount;
  game.waterCarry = Math.max(0, game.waterCarry - amount);
  game._waterCarryBatches = game._waterCarryBatches.filter(batch => batch.distance > EPSILON && batch.amount > EPSILON);
}

function boundaryDistance(cell, rink) {
  // Signed rounded-box distance is radial in the corners, not an enlarged
  // rectangle that could reach distant corner ice through the boards.
  const qx = Math.abs(cell.x - rink.x - rink.w / 2) - (rink.w / 2 - rink.radius);
  const qy = Math.abs(cell.y - rink.y - rink.h / 2) - (rink.h / 2 - rink.radius);
  return rink.radius - Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - Math.min(Math.max(qx, qy), 0);
}

/**
 * Reserve local donor budgets in stable cell order for this OFF run. Applying
 * one long sweep or many short sweeps, in either direction, cannot let the
 * first visited hole spend another hole's allocation. Reservations never alter
 * ice; actual transfer still requires a moving brush covering every contributor.
 */
function planSmearing(game) {
  const plans = new Map(), radius = CONFIG.smearRadius;
  for (const rink of game.rinks) {
    if (rink.id !== game.level) continue;
    const available = new Map();
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    for (const cell of rink.cells) {
      if (getFreshness(cell, game.elapsed) > 0 && cell.water > CONFIG.waterMinimum + EPSILON) {
        available.set(cell, cell.water - CONFIG.waterMinimum);
        left = Math.min(left, cell.x); right = Math.max(right, cell.x);
        top = Math.min(top, cell.y); bottom = Math.max(bottom, cell.y);
      }
    }
    if (!available.size) continue;
    for (const cell of rink.cells) {
      if (!cell.valid || cell.wet || cell.water >= CONFIG.waterMinimum - EPSILON ||
          cell.x < left - radius || cell.x > right + radius || cell.y < top - radius || cell.y > bottom + radius) continue;
      const donors = [];
      let total = 0, unfinished = 0, budget = 0;
      const minCol = Math.max(0, Math.floor(cell.x - radius - rink.x));
      const maxCol = Math.min(rink.cols - 1, Math.floor(cell.x + radius - rink.x));
      const minRow = Math.max(0, Math.floor(cell.y - radius - rink.y));
      const maxRow = Math.min(rink.rows - 1, Math.floor(cell.y + radius - rink.y));
      for (let row = minRow; row <= maxRow; row++) {
        for (let col = minCol; col <= maxCol; col++) {
          const neighbor = rink.cells[row * rink.cols + col];
          const distance = (neighbor.x - cell.x) ** 2 + (neighbor.y - cell.y) ** 2;
          if (!neighbor.valid || distance > radius * radius + EPSILON) continue;
          total++;
          if (neighbor.snow > EPSILON || neighbor.wet || neighbor.water < CONFIG.waterMinimum - EPSILON) unfinished++;
          const spare = available.get(neighbor) || 0;
          if (spare > EPSILON) {
            donors.push({ cell: neighbor, distance, index: row * rink.cols + col, spare });
            budget += spare;
          }
        }
      }
      const required = CONFIG.waterMinimum - cell.water;
      if (!total || unfinished / total > CONFIG.smearMaxUnfinishedFraction || budget + EPSILON < required) continue;
      donors.sort((a, b) => a.distance - b.distance || a.index - b.index);
      let needed = required, expires = Infinity;
      const transfers = [];
      for (const donor of donors) {
        const amount = Math.min(needed, donor.spare);
        if (amount <= EPSILON) continue;
        transfers.push({ cell: donor.cell, amount });
        available.set(donor.cell, donor.spare - amount);
        expires = Math.min(expires, donor.cell.freshUntil);
        needed -= amount;
        if (needed <= EPSILON) break;
      }
      plans.set(cell, { transfers, expires, rink });
    }
  }
  return plans;
}

// Does some center on this actual movement segment cover recipient + donors
// at the same instant? Intersect each point's permissible segment interval.
function shareBrushFootprint(points, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, lengthSquared = dx * dx + dy * dy;
  let start = 0, end = 1;
  for (const point of points) {
    const px = point.x - x1, py = point.y - y1;
    const center = (px * dx + py * dy) / lengthSquared;
    const perpendicularSquared = Math.max(0, px * px + py * py - center * center * lengthSquared);
    if (perpendicularSquared > CONFIG.brushRadius ** 2 + EPSILON) return false;
    const half = Math.sqrt(Math.max(0, CONFIG.brushRadius ** 2 - perpendicularSquared) / lengthSquared);
    start = Math.max(start, center - half);
    end = Math.min(end, center + half);
    if (start > end + EPSILON) return false;
  }
  return true;
}

function smearFreshWater(game, covered, x1, y1, x2, y2, changed) {
  if (!covered.some(({ cell }) => cell.snow <= EPSILON && !cell.wet && cell.water < CONFIG.waterMinimum - EPSILON)) return;
  if (!game._smearPlans) game._smearPlans = planSmearing(game);
  for (const { cell } of covered) {
    if (cell.snow > EPSILON || cell.wet || cell.water >= CONFIG.waterMinimum - EPSILON) continue;
    const plan = game._smearPlans.get(cell);
    if (!plan || game.elapsed >= plan.expires) continue;
    if (plan.transfers.some(({ cell: donor, amount }) =>
      getFreshness(donor, game.elapsed) <= 0 || donor.water - amount < CONFIG.waterMinimum - EPSILON)) continue;
    if (!shareBrushFootprint([cell, ...plan.transfers.map(transfer => transfer.cell)], x1, y1, x2, y2)) continue;
    let transferred = 0;
    for (const { cell: donor, amount } of plan.transfers) {
      const actual = Math.min(amount, Math.max(0, donor.water - CONFIG.waterMinimum));
      donor.water -= actual;
      markCellChanged(plan.rink, donor);
      transferred += actual;
    }
    cell.water += transferred;
    cell.freshUntil = plan.expires;
    markCellChanged(plan.rink, cell);
    changed.add(plan.rink);
    game._smearPlans.delete(cell);
  }
}

function repairWetCell(game, cell, rink, changed, retainWater) {
  if (!cell.wet || game.overloaded || game.tank + CONFIG.wetRepairLoad > CONFIG.tankCapacity + EPSILON) return;
  const excess = Math.max(0, cell.water - CONFIG.waterTarget);
  const retained = retainWater ? Math.min(excess, CONFIG.poolCarryCapacity) : 0;
  // New excess replaces the oldest carried water instead of leaving a long
  // puddle with an exhausted leading-edge supply. Displacement is removal,
  // never an extension of old water's lifetime or creation of fresh water.
  let displaced = Math.max(0, game.waterCarry + retained - CONFIG.poolCarryCapacity);
  for (const batch of game._waterCarryBatches) {
    const amount = Math.min(displaced, batch.amount);
    batch.amount -= amount; displaced -= amount;
    game.waterCarry = Math.max(0, game.waterCarry - amount);
    game.waterRemoved += amount;
    if (displaced <= EPSILON) break;
  }
  if (retained > EPSILON) {
    game._waterCarryBatches.push({ amount: retained, distance: CONFIG.poolCarryDistance });
    game.waterCarry += retained;
  }
  game.waterRemoved += excess - retained;
  cell.wet = false;
  cell.water = CONFIG.waterTarget;
  cell.driedAt = game.elapsed;
  // Repair may expose a neighboring ring sooner than its previous schedule.
  game._nextDryAt = Math.min(game._nextDryAt ?? 0, game.elapsed + CONFIG.puddleDryRingSeconds);
  cell.freshUntil = game.elapsed + CONFIG.freshIceSeconds;
  game._smearPlans = null;
  game.tank = Math.min(CONFIG.tankCapacity, game.tank + CONFIG.wetRepairLoad);
  markCellChanged(rink, cell);
  changed.add(rink);
  limitFullTankSpeed(game);
}

/**
 * The conditioner carries a bounded amount of excess puddle water. Entry/exit
 * events along the true swept circle, rather than frame-wide cell batches,
 * make both its 18ft lifetime and actual coverage independent of frame size.
 */
function carryPoolWater(game, covered, x1, y1, x2, y2, changed) {
  const dx = x2 - x1, dy = y2 - y1, length = Math.hypot(dx, dy);
  const events = [], active = new Set();
  for (const entry of covered) {
    const { cell } = entry;
    if (distanceToSegmentSquared(cell.x, cell.y, x1, y1, x2, y2) > CONFIG.brushRadius ** 2 + EPSILON) {
      repairWetCell(game, cell, entry.rink, changed, false);
      continue;
    }
    const px = cell.x - x1, py = cell.y - y1;
    const along = (px * dx + py * dy) / length;
    const perpendicular = Math.max(0, px * px + py * py - along * along);
    if (perpendicular > CONFIG.brushRadius ** 2 + EPSILON) {
      // Edge assistance can repair excess water, but it cannot acquire water
      // for the traveling conditioner beyond the real brush footprint.
      repairWetCell(game, cell, entry.rink, changed, false);
      continue;
    }
    const half = Math.sqrt(Math.max(0, CONFIG.brushRadius ** 2 - perpendicular));
    const enter = Math.max(0, along - half), exit = Math.min(length, along + half);
    if (enter > exit + EPSILON) continue;
    events.push({ distance: enter, entry, enter: true }, { distance: exit, entry, enter: false });
  }
  events.sort((a, b) => a.distance - b.distance || Number(b.enter) - Number(a.enter)
    || a.entry.cell.y - b.entry.cell.y || a.entry.cell.x - b.entry.cell.x);
  let previous = 0;
  for (let index = 0; index < events.length;) {
    const distance = events[index].distance;
    moveWaterCarry(game, Math.max(0, distance - previous));
    previous = distance;
    const group = [];
    while (index < events.length && Math.abs(events[index].distance - distance) <= EPSILON) group.push(events[index++]);
    for (const event of group) if (event.enter) {
      active.add(event.entry);
      repairWetCell(game, event.entry.cell, event.entry.rink, changed, true);
    }
    if (!game.overloaded && game.tank < CONFIG.tankCapacity - EPSILON && game.waterCarry > EPSILON) {
      const recipients = [...active].filter(({ cell }) => cell.snow <= EPSILON && !cell.wet && cell.water < CONFIG.waterMinimum - EPSILON)
        .sort((a, b) => a.cell.y - b.cell.y || a.cell.x - b.cell.x);
      for (const { cell, rink } of recipients) {
        let needed = CONFIG.waterMinimum - cell.water;
        for (const batch of game._waterCarryBatches) {
          const amount = Math.min(needed, batch.amount);
          batch.amount -= amount; needed -= amount;
          cell.water += amount; game.waterCarry = Math.max(0, game.waterCarry - amount);
          if (needed <= EPSILON) break;
        }
        // Donated water never restarts a fresh-ice timer or becomes another
        // source of traveling water on a subsequent pass.
        cell.freshUntil = 0;
        markCellChanged(rink, cell);
        changed.add(rink);
        if (game.waterCarry <= EPSILON) break;
      }
    }
    for (const event of group) if (!event.enter) active.delete(event.entry);
  }
  moveWaterCarry(game, Math.max(0, length - previous));
}

/**
 * A swept cleaning footprint. A cell receives water once per traversal,
 * never once per animation frame. A half-flow pass directs its available water
 * toward dry cells first, a deliberately forgiving game approximation.
 */
export function processSweep(game, x1, y1, x2, y2, pump = game.pump) {
  if (['paused', 'levelComplete', 'complete'].includes(game.status)) return;
  if (![x1, y1, x2, y2, pump].every(Number.isFinite) || ![0, .5, 1].includes(pump)) return;
  if (Math.hypot(x2 - x1, y2 - y1) < EPSILON) return;
  limitFullTankSpeed(game);
  if (pump !== game._lastSweepPump) {
    if (pump === 0) game._smearPlans = null;
    else clearWaterCarry(game);
    game._lastSweepPump = pump;
  }
  const radius = CONFIG.brushRadius + CONFIG.edgeAssistReach, radiusSquared = CONFIG.brushRadius ** 2;
  const touched = [], covered = [], endContacts = new Set(), endStates = new Map(), changed = new Set();
  let sampleDry = 0, sampleFinished = 0;
  for (const rink of game.rinks) {
    if (rink.id !== game.level) continue;
    const minCol = Math.max(0, Math.floor(Math.min(x1, x2) - radius - rink.x));
    const maxCol = Math.min(rink.cols - 1, Math.floor(Math.max(x1, x2) + radius - rink.x));
    const minRow = Math.max(0, Math.floor(Math.min(y1, y2) - radius - rink.y));
    const maxRow = Math.min(rink.rows - 1, Math.floor(Math.max(y1, y2) + radius - rink.y));
    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        const cell = rink.cells[row * rink.cols + col];
        if (!cell.valid) continue;
        const distance = distanceToSegmentSquared(cell.x, cell.y, x1, y1, x2, y2);
        const assisted = cell.spilledSnow <= EPSILON && boundaryDistance(cell, rink) <= CONFIG.edgeAssistReach + EPSILON;
        const reach = assisted ? radius * radius : radiusSquared;
        if (distance > reach + EPSILON) continue;
        covered.push({ cell, rink });
        // Classify the whole footprint, retaining a cell's original condition
        // until the brush leaves it. Looking only at the newly entered crescent
        // makes HALF and overlap tolerance vary with frame rate and speed.
        const wasDry = game._contactStates.has(cell) ? game._contactStates.get(cell)
          : !cell.wet && cell.water < CONFIG.waterMinimum - EPSILON;
        if (wasDry) sampleDry++;
        else sampleFinished++;
        if ((cell.x - x2) ** 2 + (cell.y - y2) ** 2 <= reach + EPSILON) {
          endContacts.add(cell);
          endStates.set(cell, wasDry);
        }
        if (!game._contacts.has(cell)) touched.push({ cell, rink });
      }
    }
  }
  game._contacts = endContacts;
  game._contactStates = endStates;
  if (!covered.length || game.overloaded || game.tank >= CONFIG.tankCapacity - EPSILON) {
    moveWaterCarry(game, Math.hypot(x2 - x1, y2 - y1));
    return;
  }

  const eligible = [];
  for (const entry of pump === 0 ? covered : touched) {
    const { cell, rink } = entry;
    if (cell.snow > EPSILON) {
      const collected = Math.min(cell.snow, Math.max(0, CONFIG.tankCapacity - game.tank));
      if (collected > 0) {
        cell.snow = Math.max(0, cell.snow - collected);
        cell.spilledSnow = Math.max(0, cell.spilledSnow - collected);
        game.tank += collected;
        markCellChanged(rink, cell);
        changed.add(rink);
      }
    }
    if (cell.snow <= EPSILON) eligible.push(entry);
  }

  if (pump === 0) {
    limitFullTankSpeed(game);
    carryPoolWater(game, eligible, x1, y1, x2, y2, changed);
    if (!game.overloaded) smearFreshWater(game, covered, x1, y1, x2, y2, changed);
  } else {
    const dry = eligible.filter(({ cell }) => !cell.wet && cell.water < CONFIG.waterMinimum - EPSILON);
    const finished = eligible.filter(({ cell }) => cell.wet || cell.water >= CONFIG.waterMinimum - EPSILON);
    const sampleTotal = sampleDry + sampleFinished;
    const dryFraction = sampleTotal ? sampleDry / sampleTotal : 0;
    const finishedFraction = sampleTotal ? sampleFinished / sampleTotal : 0;
    // Equal distribution into the dry portion of the complete footprint. Dose
    // is applied once on entry, independent of the thin newly entered slice.
    const dryDose = sampleDry ? Math.min(1, pump / dryFraction) : 0;
    for (const { cell, rink } of dry) {
      const amount = Math.min(CONFIG.waterTarget - cell.water, dryDose);
      cell.water += amount;
      if (amount > 0) {
        recordWaterAddition(game, cell, false);
        if (cell.water >= CONFIG.waterMinimum - EPSILON) cell.freshUntil = game.elapsed + CONFIG.freshIceSeconds;
        markCellChanged(rink, cell);
        changed.add(rink);
      }
    }
    // Normal slivers of overlap are absorbed by the conditioner tolerance.
    const thinOverlap = sampleDry > 0 && finishedFraction <= CONFIG.overlapTolerance;
    const excessDose = !thinOverlap && sampleFinished ? Math.max(0, pump - dryFraction * dryDose) / finishedFraction : 0;
    if (excessDose > EPSILON) {
      for (const { cell, rink } of finished) {
        const wasWet = cell.wet;
        cell.water = Math.min(4, cell.water + excessDose);
        cell.wet = cell.wet || cell.water > CONFIG.waterMaximum + EPSILON;
        recordWaterAddition(game, cell, wasWet);
        if (!cell.wet) cell.freshUntil = game.elapsed + CONFIG.freshIceSeconds;
        markCellChanged(rink, cell);
        changed.add(rink);
      }
    }
  }
  for (const rink of changed) bumpVersion(rink);
  // Collection may have filled the tank during this sweep. Apply the lower
  // speed ceiling now rather than allowing acceleration/deceleration to lag.
  limitFullTankSpeed(game);
}

export function getStats(game) {
  const rinks = game.rinks.map(rink => {
    const cached = game._statsCache.get(rink.id);
    const dumps = game.levelDumps[rink.id - 1];
    if (cached?.version === rink.version && cached.stats.dumps === dumps) return cached.stats;
    let state = incrementalStats.get(rink);
    const counts = [0, 0, 0, 0, 0];
    if (cached && state && !state.invalidated && state.version === rink.version) {
      counts[1] = cached.stats.snow; counts[2] = cached.stats.wet; counts[3] = cached.stats.dry;
      counts[4] = cached.stats.total - counts[1] - counts[2] - counts[3];
      for (const cell of state.dirty) {
        const before = state.kinds.get(cell), after = cellKind(cell);
        if (before) counts[before]--;
        if (after) counts[after]++;
        state.kinds.set(cell, after);
      }
      state.dirty.clear();
    } else {
      state = {version: rink.version, kinds: new WeakMap(), dirty: new Set(), invalidated: false};
      for (const cell of rink.cells) {
        const kind = cellKind(cell);
        state.kinds.set(cell, kind);
        if (kind) counts[kind]++;
      }
      incrementalStats.set(rink, state);
    }
    const snow = counts[1], wet = counts[2], dry = counts[3], total = snow + wet + dry + counts[4];
    const remaining = snow + dry + wet;
    const stats = {
      id: rink.id, total, snow, dry, wet, remaining, dumps,
      percent: remaining ? Math.min(99.9, Math.floor((total - remaining) / total * 1000) / 10) : 100,
      complete: remaining === 0,
    };
    game._statsCache.set(rink.id, { version: rink.version, stats });
    return stats;
  });
  const total = rinks.reduce((sum, rink) => sum + rink.total, 0);
  const remaining = rinks.reduce((sum, rink) => sum + rink.remaining, 0);
  return {
    rinks, total, remaining, wet: rinks.reduce((sum, rink) => sum + rink.wet, 0),
    percent: remaining ? Math.min(99.9, Math.floor((total - remaining) / total * 1000) / 10) : 100,
    complete: rinks.every(rink => rink.complete), active: rinks[game.level - 1], completedLevels: game.levelTimes.length,
  };
}

/** Advance only from a verified perfect level; the three records form one run. */
export function advanceLevel(game) {
  if (game.status !== 'levelComplete' || !Number.isInteger(game.level) || game.level < 1 || game.level >= game.rinks.length ||
      game.levelTimes.length !== game.level) return false;
  // Recheck the actual cell records, not a potentially stale cached completion.
  for (const rink of game.rinks.slice(0, game.level)) game._statsCache.delete(rink.id);
  const stats = getStats(game);
  if (!stats.rinks.slice(0, game.level).every(rink => rink.complete)) return false;
  game.level++;
  game.levelStartedAt = game.elapsed;
  game.vehicle = { ...CONFIG.spawn, speed: 0, steering: 0 };
  game.pump = 1;
  game.tank = 0;
  game.overloaded = false;
  game._leakSeconds = 0;
  game.exitBlocked = false;
  clearWaterCarry(game);
  game.lastChecked = 0;
  game.checkedAt = game.elapsed;
  game.inspection = 0;
  game.dumping = 0;
  game.action = null;
  game._contacts = new Set();
  game._contactStates = new Map();
  game._stationarySeconds = 0;
  game._smearPlans = null;
  game._lastSweepPump = null;
  game._nextDryAt = 0;
  game.status = 'running';
  game.message = `Level ${game.level}. ${game.level === 2 ? 'Medium' : 'Heavy'} snow. Ready to clean.`;
  return true;
}

function finishActiveLevel(game) {
  const stats = getStats(game);
  if (!stats.active?.complete || !stats.rinks.slice(0, game.level).every(rink => rink.complete)) return;
  if (game.levelTimes.length === game.level - 1) {
    game.levelTimes.push(Math.max(0, game.elapsed - game.levelStartedAt));
  }
  if (game.levelTimes.length !== game.level) return;
  game.status = game.level === game.rinks.length ? 'complete' : 'levelComplete';
  game.vehicle.speed = 0;
  game.vehicle.steering = 0;
  game.pump = 0;
  game.action = null;
  game.inspection = 0;
  game.dumping = 0;
  game._stationarySeconds = 0;
  game.message = game.status === 'complete'
    ? 'Perfect finish. All three levels are complete.'
    : `Level ${game.level} is perfect. Ready for level ${game.level + 1}.`;
}

function approach(current, target, maximumChange) {
  return current < target ? Math.min(target, current + maximumChange) : Math.max(target, current - maximumChange);
}

/** Continuous water while parked is separate from once-per-traversal cleaning. */
function applyStationaryWater(game, dt, distanceMoved) {
  if (game.pump === 0 || distanceMoved / dt > CONFIG.stoppedSpeed) {
    game._stationarySeconds = 0;
    return;
  }
  const { x, y } = game.vehicle;
  if (!game.rinks.some(rink => rink.id === game.level && roundedContains(x, y, rink))) {
    game._stationarySeconds = 0;
    return;
  }
  const radius = CONFIG.brushRadius;
  const patches = [];
  for (const rink of game.rinks) {
    if (rink.id !== game.level) continue;
    const minCol = Math.max(0, Math.floor(x - radius - rink.x));
    const maxCol = Math.min(rink.cols - 1, Math.floor(x + radius - rink.x));
    const minRow = Math.max(0, Math.floor(y - radius - rink.y));
    const maxRow = Math.min(rink.rows - 1, Math.floor(y + radius - rink.y));
    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        const cell = rink.cells[row * rink.cols + col];
        if (cell.valid && (cell.x - x) ** 2 + (cell.y - y) ** 2 <= radius * radius + EPSILON) {
          patches.push({ cell, rink });
        }
      }
    }
  }
  if (!patches.length) {
    game._stationarySeconds = 0;
    return;
  }
  const before = game._stationarySeconds;
  game._stationarySeconds += dt;
  // Integrate only the fraction after the grace boundary, so frame size does
  // not change the puddling time (including while a tank inspection runs).
  const wetSeconds = Math.max(0, game._stationarySeconds - CONFIG.stationaryGraceSeconds)
    - Math.max(0, before - CONFIG.stationaryGraceSeconds);
  if (wetSeconds <= 0) return;
  const dose = wetSeconds * CONFIG.stationaryWaterRate * game.pump;
  const changed = new Set();
  for (const { cell, rink } of patches) {
    const nextWater = Math.min(4, cell.water + dose);
    const wasWet = cell.wet, previousWater = cell.water;
    cell.water = nextWater;
    cell.wet = cell.wet || cell.water > CONFIG.waterMaximum + EPSILON;
    // A running pump keeps a capped puddle wet too; numeric saturation is not
    // permission to dry it beneath the active outlet.
    recordWaterAddition(game, cell, wasWet);
    if (nextWater !== previousWater || cell.wet !== wasWet) {
      markCellChanged(rink, cell);
      changed.add(rink);
    }
  }
  for (const rink of changed) bumpVersion(rink);
}

/** Dry exposed one-foot wet-cell rings at exact simulation-time events. */
function dryPuddles(game) {
  const rink = game.rinks[game.level - 1];
  if (!rink) return;
  if (game.elapsed + EPSILON < (game._nextDryAt ?? 0)) return;
  game._nextDryAt = Infinity;
  const wet = [];
  for (let index = 0; index < rink.cells.length; index++) {
    if (rink.cells[index].valid && rink.cells[index].wet) wet.push(index);
  }
  let changed = false;
  while (wet.length) {
    let earliest = Infinity;
    const due = [];
    for (const index of wet) {
      const cell = rink.cells[index];
      if (!cell.wet) continue;
      const col = index % rink.cols, row = Math.floor(index / rink.cols);
      let exposedAt = Infinity;
      for (const [dc, dr] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nc = col + dc, nr = row + dr;
        const neighbor = nc >= 0 && nc < rink.cols && nr >= 0 && nr < rink.rows ? rink.cells[nr * rink.cols + nc] : null;
        if (!neighbor?.valid) exposedAt = 0;
        else if (!neighbor.wet) exposedAt = Math.min(exposedAt, neighbor.driedAt || 0);
      }
      if (!Number.isFinite(exposedAt)) continue;
      const time = Math.max(cell.lastWaterAt + CONFIG.puddleDryGraceSeconds, cell.wetSince, exposedAt)
        + CONFIG.puddleDryRingSeconds;
      if (time < earliest - EPSILON) {
        earliest = time;
        due.length = 0;
      }
      if (Math.abs(time - earliest) <= EPSILON) due.push(cell);
    }
    if (!due.length || earliest > game.elapsed + EPSILON) {
      game._nextDryAt = earliest;
      break;
    }
    // Change a whole outer ring together, then expose the next ring using the
    // event time, not this frame's end. Different dt values therefore agree.
    for (const cell of due) {
      cell.wet = false;
      cell.water = CONFIG.waterTarget;
      cell.freshUntil = 0;
      cell.driedAt = earliest;
      markCellChanged(rink, cell);
    }
    changed = true;
  }
  if (changed) bumpVersion(rink);
}

/** Finish only tiny isolated end-of-rink specks, never percentage-based credit. */
function tidyTinySpecks(game) {
  if (game.status !== 'running' || !game.clockStarted || game.overloaded || game.tank >= CONFIG.tankCapacity - EPSILON) return;
  const rink = game.rinks[game.level - 1];
  if (!rink) return;
  const stats = getStats(game).active;
  if (stats.snow + stats.dry > CONFIG.speckMaxRemaining) return;
  const candidates = new Set();
  let remaining = 0;
  for (let index = 0; index < rink.cells.length; index++) {
    const cell = rink.cells[index];
    if (!cell.valid || (cell.snow <= EPSILON && cell.water >= CONFIG.waterMinimum - EPSILON)) continue;
    // Snow under a wet patch still counts toward the near-complete limit, but
    // the wet patch itself is never eligible for automatic cleanup.
    remaining++;
    if (remaining > CONFIG.speckMaxRemaining) return;
    if (!cell.wet && cell.spilledSnow <= EPSILON) candidates.add(index);
  }
  if (!candidates.size) return;
  const visited = new Set();
  let changed = false;
  for (const seed of candidates) {
    if (visited.has(seed) || game.tank >= CONFIG.tankCapacity - EPSILON) continue;
    const component = [], queue = [seed];
    visited.add(seed);
    let minCol = Infinity, maxCol = -Infinity, minRow = Infinity, maxRow = -Infinity;
    for (let q = 0; q < queue.length; q++) {
      const index = queue[q], col = index % rink.cols, row = Math.floor(index / rink.cols);
      component.push(index);
      minCol = Math.min(minCol, col); maxCol = Math.max(maxCol, col);
      minRow = Math.min(minRow, row); maxRow = Math.max(maxRow, row);
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if ((!dc && !dr) || col + dc < 0 || col + dc >= rink.cols || row + dr < 0 || row + dr >= rink.rows) continue;
          const neighbor = (row + dr) * rink.cols + col + dc;
          if (candidates.has(neighbor) && !visited.has(neighbor)) {
            visited.add(neighbor); queue.push(neighbor);
          }
        }
      }
    }
    if (component.length > CONFIG.speckMaxComponent || maxCol - minCol + 1 > CONFIG.speckMaxExtent ||
        maxRow - minRow + 1 > CONFIG.speckMaxExtent) continue;
    const members = new Set(component), cleanBorder = new Set();
    let surrounded = true, snow = 0;
    for (const index of component) {
      const col = index % rink.cols, row = Math.floor(index / rink.cols);
      snow += rink.cells[index].snow;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if ((!dc && !dr) || col + dc < 0 || col + dc >= rink.cols || row + dr < 0 || row + dr >= rink.rows) continue;
          const neighborIndex = (row + dr) * rink.cols + col + dc;
          if (members.has(neighborIndex)) continue;
          const neighbor = rink.cells[neighborIndex];
          if (!neighbor.valid) continue;
          if (neighbor.wet || neighbor.snow > EPSILON || neighbor.water < CONFIG.waterMinimum - EPSILON) surrounded = false;
          else cleanBorder.add(neighborIndex);
        }
      }
    }
    if (!surrounded || cleanBorder.size < CONFIG.speckMinCleanBorder || game.tank + snow > CONFIG.tankCapacity + EPSILON) continue;
    game.tank = Math.min(CONFIG.tankCapacity, game.tank + snow);
    for (const index of component) {
      const cell = rink.cells[index];
      cell.snow = 0;
      cell.water = CONFIG.waterTarget;
      cell.wet = false;
      cell.freshUntil = 0;
      cell.driedAt = game.elapsed;
      markCellChanged(rink, cell);
    }
    changed = true;
  }
  if (changed) {
    bumpVersion(rink);
    game._smearPlans = null;
    limitFullTankSpeed(game);
  }
}

/** Snow that falls from an overloaded machine remains a real pickup task. */
function spillSnow(game, dt, x1, y1, x2, y2) {
  const length = Math.hypot(x2 - x1, y2 - y1), rink = game.rinks[game.level - 1];
  if (!game.overloaded || !game.clockStarted || length <= EPSILON || !roundedContains(x2, y2, rink)) return;
  const before = game._leakSeconds;
  game._leakSeconds += dt;
  if (game._leakSeconds < CONFIG.spillIntervalSeconds - EPSILON) return;
  // Interpolate the event position so leaked trails do not depend on the
  // render frame size. Only time actually moving on valid ice accumulates.
  const fraction = Math.max(0, Math.min(1, (CONFIG.spillIntervalSeconds - before) / dt));
  game._leakSeconds -= CONFIG.spillIntervalSeconds;
  const offset = CONFIG.vehicleLength / 2 + 1;
  const trailX = x1 + (x2 - x1) * fraction - (x2 - x1) / length * offset;
  const trailY = y1 + (y2 - y1) * fraction - (y2 - y1) / length * offset;
  const candidates = rink.cells.filter(cell => cell.valid && Math.hypot(cell.x - trailX, cell.y - trailY) <= 2.2)
    .sort((a, b) => Number(a.snow > EPSILON) - Number(b.snow > EPSILON)
      || Math.hypot(a.x - trailX, a.y - trailY) - Math.hypot(b.x - trailX, b.y - trailY)
      || a.y - b.y || a.x - b.x).slice(0, CONFIG.spillCells);
  let dropped = false;
  for (const cell of candidates) {
    const amount = Math.min(CONFIG.spillSnowPerCell, game.tank);
    if (amount <= EPSILON) break;
    game.tank -= amount;
    cell.snow += amount;
    cell.spilledSnow += amount;
    cell.freshUntil = 0;
    markCellChanged(rink, cell);
    dropped = true;
  }
  if (dropped) {
    game.spillEvents++;
    bumpVersion(rink);
    game._smearPlans = null;
  }
}

function boundaryFraction(rink, x1, y1, x2, y2, entering) {
  let low = 0, high = 1;
  for (let n = 0; n < 45; n++) {
    const mid = (low + high) / 2;
    const inside = roundedContains(x1 + (x2 - x1) * mid, y1 + (y2 - y1) * mid, rink);
    if (inside === entering) high = mid;
    else low = mid;
  }
  return entering ? high : low;
}

export function step(game, input = {}, dt = 1 / 60) {
  if (game.status !== 'running' || !Number.isFinite(dt) || dt <= 0) return;
  dt = Math.min(dt, .1);
  const throttle = Math.max(-1, Math.min(1, Number(input.throttle) || 0));
  const steer = Math.max(-1, Math.min(1, Number(input.steer) || 0));
  const oldX = game.vehicle.x, oldY = game.vehicle.y;
  const rink = game.rinks[game.level - 1], clockWasStarted = game.clockStarted;
  if (clockWasStarted) game.elapsed += dt;
  if (!throttle || game.pump === 0) game.exitBlocked = false;
  if (game.action && (throttle || steer)) cancelAction(game);

  if (game.action === 'inspect') {
    game.inspection = Math.min(1, game.inspection + dt / CONFIG.inspectDuration);
    if (game.inspection >= 1 - EPSILON) {
      game.lastChecked = game.tank;
      game.checkedAt = game.elapsed;
      game.inspection = 1;
      game.action = null;
      game.message = 'Snow reading updated. It stays here until your next check.';
    }
  } else {
    const vehicle = game.vehicle;
    limitFullTankSpeed(game);
    const speedFactor = game.overloaded ? CONFIG.fullTankSpeedFactor : 1;
    const targetSpeed = (input.brake ? 0 : throttle > 0 ? CONFIG.maxSpeed * throttle : CONFIG.reverseSpeed * throttle) * speedFactor;
    const acceleration = input.brake ? CONFIG.brakeDeceleration : throttle ? CONFIG.acceleration : CONFIG.deceleration;
    vehicle.speed = approach(vehicle.speed, targetSpeed, acceleration * dt);
    limitFullTankSpeed(game);
    vehicle.steering = approach(vehicle.steering || 0, steer,
      (steer ? CONFIG.steeringRampRate : CONFIG.steeringReturnRate) * dt);
    const travel = Math.abs(vehicle.speed * dt), maxTurn = travel / CONFIG.minTurnRadius;
    let requestedTurn = vehicle.steering * maxTurn * Math.sign(vehicle.speed);
    if (travel > EPSILON && !steer) {
      const cardinal = Math.round(vehicle.angle / (Math.PI / 2)) * Math.PI / 2;
      const error = Math.atan2(Math.sin(cardinal - vehicle.angle), Math.cos(cardinal - vehicle.angle));
      if (Math.abs(error) <= CONFIG.headingAssistAngle) {
        requestedTurn += error * (1 - Math.exp(-CONFIG.headingAssistRate * dt)) * (1 - Math.abs(vehicle.steering));
      }
    }
    requestedTurn = Math.max(-maxTurn, Math.min(maxTurn, requestedTurn));
    const oldX = vehicle.x, oldY = vehicle.y;
    const midpointAngle = vehicle.angle + requestedTurn / 2;
    const nextX = oldX + Math.cos(midpointAngle) * vehicle.speed * dt;
    const nextY = oldY + Math.sin(midpointAngle) * vehicle.speed * dt;
    if (canDrive(nextX, nextY)) {
      vehicle.x = nextX;
      vehicle.y = nextY;
    } else {
      // Sliding along boards is forgiving and still cannot cross a closed wall.
      if (canDrive(nextX, oldY)) vehicle.x = nextX;
      if (canDrive(vehicle.x, nextY)) vehicle.y = nextY;
      if (Math.hypot(vehicle.x - oldX, vehicle.y - oldY) < EPSILON) vehicle.speed = 0;
    }
    const startedInside = roundedContains(oldX, oldY, rink);
    const endedInside = roundedContains(vehicle.x, vehicle.y, rink);
    if (game.pump > 0 && startedInside && !endedInside) {
      const fraction = boundaryFraction(rink, oldX, oldY, vehicle.x, vehicle.y, false);
      vehicle.x = oldX + (vehicle.x - oldX) * fraction;
      vehicle.y = oldY + (vehicle.y - oldY) * fraction;
      vehicle.speed = 0;
      if (!game.exitBlocked) game.exitBlockedEvents++;
      game.exitBlocked = true;
      game.message = 'Switch the pump OFF before leaving the ice.';
    } else if (Math.hypot(vehicle.x - oldX, vehicle.y - oldY) > EPSILON) {
      game.exitBlocked = false;
    }
    const actualTravel = Math.hypot(vehicle.x - oldX, vehicle.y - oldY);
    if (travel > EPSILON && actualTravel > EPSILON) {
      vehicle.angle += requestedTurn * Math.min(1, actualTravel / travel);
      vehicle.angle = Math.atan2(Math.sin(vehicle.angle), Math.cos(vehicle.angle));
      let sweepX = oldX, sweepY = oldY, movingSeconds = dt;
      if (!game.clockStarted && roundedContains(vehicle.x, vehicle.y, rink)) {
        const fraction = startedInside ? 0 : boundaryFraction(rink, oldX, oldY, vehicle.x, vehicle.y, true);
        sweepX += (vehicle.x - oldX) * fraction;
        sweepY += (vehicle.y - oldY) * fraction;
        movingSeconds *= 1 - fraction;
        game.clockStarted = true;
        game.elapsed += movingSeconds;
      }
      // Before the first center entry, even an overhanging brush cannot clean
      // for free while the leaderboard clock remains at zero.
      if (game.clockStarted) {
        processSweep(game, sweepX, sweepY, vehicle.x, vehicle.y, game.pump);
        spillSnow(game, movingSeconds, sweepX, sweepY, vehicle.x, vehicle.y);
      }
    }
  }
  beginDump(game);
  if (game.clockStarted) {
    applyStationaryWater(game, dt, Math.hypot(game.vehicle.x - oldX, game.vehicle.y - oldY));
    dryPuddles(game);
    tidyTinySpecks(game);
    finishActiveLevel(game);
  }
}
