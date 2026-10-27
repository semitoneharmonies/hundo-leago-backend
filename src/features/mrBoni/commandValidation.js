'use strict';
const MAX_COMMANDS = 24000;
const MAX_TICKS = 216000;
function invalid() { throw Object.assign(new Error('Invalid driving record.'), { code: 'MR_BONI_INPUT_INVALID' }); }
function validatedCommands(commands) {
  if (!Array.isArray(commands) || commands.length > MAX_COMMANDS) invalid();
  let ticks = 0;
  return Array.from(commands, command => {
    if (!Array.isArray(command) || !command.every(Number.isSafeInteger)) invalid();
    const [type] = command;
    if (type === 0) {
      if (command.length !== 5 || command[1] < 1 || command[1] > 600 || ![-1, 0, 1].includes(command[2]) ||
          ![-1, 0, 1].includes(command[3]) || ![0, 1].includes(command[4])) invalid();
      ticks += command[1];
      if (ticks > MAX_TICKS) invalid();
    } else if (type === 1) {
      if (command.length !== 2 || ![0, 1, 2].includes(command[1])) invalid();
    } else if (![2, 3, 4].includes(type) || command.length !== 1) invalid();
    return [...command];
  });
}
module.exports = { validatedCommands, MAX_COMMANDS, MAX_TICKS };
