'use strict';
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  try {
    const { replayCommands, RULESET_VERSION } = await import('./rules/replay.js');
    if (RULESET_VERSION !== 'resurface-v1') throw new Error('Ruleset mismatch');
    const result = await replayCommands(workerData.commands);
    parentPort.postMessage({ ok: true, result });
  } catch (error) {
    parentPort.postMessage({ ok: false, code: error.code === 'MR_BONI_TRANSCRIPT_INVALID' ? error.code : 'MR_BONI_UNAVAILABLE' });
  }
})();
