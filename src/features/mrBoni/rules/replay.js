import {createGame, step, setPump, beginInspection, cancelAction, advanceLevel} from './engine.js';

export const RULESET_VERSION = 'resurface-v1';
export const TICKS_PER_SECOND = 60;
export const LIMITS = Object.freeze({maxTicks: 216000, maxCommands: 24000, maxSegmentTicks: 600});
export const OPCODE = Object.freeze({STEP: 0, PUMP: 1, INSPECT: 2, STOP: 3, ADVANCE: 4});

export class MrBoniTranscriptError extends Error {
  constructor(message, code = 'MR_BONI_TRANSCRIPT_INVALID') {
    super(message);
    this.name = 'MrBoniTranscriptError';
    this.code = code;
  }
}

const invalid = message => { throw new MrBoniTranscriptError(message); };
const integer = (value, minimum, maximum) => Number.isInteger(value) && value >= minimum && value <= maximum;

function copyCommand(command) {
  if (!Array.isArray(command) || !integer(command[0], 0, 4)) invalid('Invalid Mr. Boni command.');
  switch (command[0]) {
    case OPCODE.STEP:
      if (command.length !== 5 || !integer(command[1], 1, LIMITS.maxSegmentTicks)
          || !integer(command[2], -1, 1) || !integer(command[3], -1, 1) || !integer(command[4], 0, 1)) {
        invalid('Invalid Mr. Boni driving segment.');
      }
      break;
    case OPCODE.PUMP:
      if (command.length !== 2 || !integer(command[1], 0, 2)) invalid('Invalid Mr. Boni pump selection.');
      break;
    default:
      if (command.length !== 1) invalid('Invalid Mr. Boni action.');
  }
  return [...command];
}

/** Copy untrusted JSON into a bounded, canonical transcript. No client time/state is accepted. */
export function validateCommands(commands) {
  if (!Array.isArray(commands) || commands.length > LIMITS.maxCommands) invalid('Mr. Boni command limit exceeded.');
  let ticks = 0;
  return Array.from(commands, command => {
    const copied = copyCommand(command);
    if (copied[0] === OPCODE.STEP) {
      ticks += copied[1];
      if (ticks > LIMITS.maxTicks) invalid('Mr. Boni simulation limit exceeded.');
    }
    return copied;
  });
}

/** Previously submitted segments are immutable, including their run lengths. */
export function extendsCommands(prefix, next) {
  if (!Array.isArray(prefix) || !Array.isArray(next) || next.length < prefix.length) return false;
  return prefix.every((command, index) => Array.isArray(command) && Array.isArray(next[index])
    && command.length === next[index].length && command.every((value, part) => value === next[index][part]));
}

/**
 * Pure replay for an isolated server worker. Inputs are exactly the controls available
 * to the player. Pauses have no ticks; their STOP action records the actual speed reset.
 * A server must bound worker concurrency and execution time in addition to these limits.
 */
export function replayCommands(untrustedCommands) {
  const commands = validateCommands(untrustedCommands);
  const game = createGame();
  game.status = 'running';
  let simulationTicks = 0;
  for (const command of commands) {
    switch (command[0]) {
      case OPCODE.STEP: {
        const input = {throttle: command[2], steer: command[3], brake: Boolean(command[4])};
        for (let tick = 0; tick < command[1]; tick++) {
          if (game.status !== 'running') invalid('Start the next Mr. Boni level before driving.');
          step(game, input, 1 / TICKS_PER_SECOND);
          simulationTicks++;
        }
        break;
      }
      case OPCODE.PUMP:
        if (game.status !== 'running' || !setPump(game, command[1] / 2)) invalid('Cannot change pump at this stage.');
        break;
      case OPCODE.INSPECT:
        if (game.status !== 'running') invalid('Cannot inspect at this stage.');
        // Pressing inspect while moving is a legal attempted input and has no effect.
        beginInspection(game);
        break;
      case OPCODE.STOP:
        game.vehicle.speed = 0;
        cancelAction(game);
        break;
      case OPCODE.ADVANCE:
        if (!advanceLevel(game)) invalid('Complete the current Mr. Boni level before advancing.');
        break;
    }
  }
  const highestLevelCompleted = game.levelTimes.length;
  return Object.freeze({
    highestLevelCompleted,
    cumulativeTimeMs: highestLevelCompleted ? Math.round(game.levelTimes.reduce((sum, time) => sum + time, 0) * 1000) : null,
    completed: highestLevelCompleted === 3 && game.status === 'complete',
    levelTimesMs: Object.freeze(game.levelTimes.map(time => Math.round(time * 1000))),
    simulationTicks,
  });
}

/** Compact recording whose flushed checkpoint prefixes can never be edited by later input. */
export function createRecorder() {
  let commands = [], pending = null, ticks = 0;
  const limit = message => { throw new MrBoniTranscriptError(message, 'MR_BONI_RECORDING_LIMIT'); };
  function flush() {
    if (pending) { commands.push(pending); pending = null; }
  }
  return Object.freeze({
    recordStep(input) {
      if (!input || !integer(input.throttle, -1, 1) || !integer(input.steer, -1, 1)
          || typeof input.brake !== 'boolean') invalid('Invalid Mr. Boni driving input.');
      if (ticks >= LIMITS.maxTicks) limit('This run reached the one-hour recording limit. Your saved levels are kept.');
      const brake = input.brake ? 1 : 0;
      const combine = pending && pending[1] < LIMITS.maxSegmentTicks && pending[2] === input.throttle
        && pending[3] === input.steer && pending[4] === brake;
      if (combine) pending[1]++;
      else {
        if (commands.length + (pending ? 1 : 0) >= LIMITS.maxCommands) {
          limit('This run reached the recording limit. Your saved levels are kept.');
        }
        flush();
        pending = [OPCODE.STEP, 1, input.throttle, input.steer, brake];
      }
      ticks++;
    },
    recordAction(command) {
      const action = copyCommand(command);
      if (action[0] === OPCODE.STEP) invalid('Use recordStep to record driving.');
      if (commands.length + (pending ? 1 : 0) >= LIMITS.maxCommands) {
        limit('This run reached the recording limit. Your saved levels are kept.');
      }
      flush();
      commands.push(action);
    },
    snapshot() {
      flush();
      return commands.map(command => [...command]);
    },
    reset() { commands = []; pending = null; ticks = 0; },
    getCounts() { return Object.freeze({commands: commands.length + (pending ? 1 : 0), ticks}); },
  });
}
