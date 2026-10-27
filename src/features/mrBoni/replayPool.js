'use strict';
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { validatedCommands } = require('./commandValidation');
// Bound CPU and memory independently of HTTP request concurrency.
function createReplayPool({ workerFile = path.join(__dirname, 'replayWorker.js'), timeoutMs = 45000, maxQueued = 2 } = {}) {
  let active = false;
  const queue = [];
  const error = code => Object.assign(new Error('Score verification unavailable.'), { code });
  function drain() {
    if (active || !queue.length) return;
    const item = queue.shift(); active = true;
    clearTimeout(item.queueTimer);
    let worker, timer, settled = false;
    async function done(failure, result) {
      if (settled) return; settled = true; clearTimeout(timer);
      if (worker) await worker.terminate();
      active = false;
      failure ? item.reject(failure) : item.resolve(result);
      drain();
    }
    try {
      worker = new Worker(workerFile, { workerData: { commands: item.commands }, resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
      timer = setTimeout(() => done(error('MR_BONI_REPLAY_TIMEOUT')), timeoutMs);
      worker.once('message', message => message?.ok ? done(null, message.result) : done(error(message?.code === 'MR_BONI_TRANSCRIPT_INVALID' ? message.code : 'MR_BONI_UNAVAILABLE')));
      worker.once('error', () => done(error('MR_BONI_UNAVAILABLE')));
      worker.once('exit', () => { if (!settled) done(error('MR_BONI_UNAVAILABLE')); });
    } catch { void done(error('MR_BONI_UNAVAILABLE')); }
  }
  function verifyRun({ commands }) {
    const record = validatedCommands(commands);
    if (active && queue.length >= maxQueued) return Promise.reject(error('MR_BONI_REPLAY_BUSY'));
    return new Promise((resolve, reject) => {
      const item = { commands: record, resolve, reject };
      item.queueTimer = setTimeout(() => { const index = queue.indexOf(item); if (index !== -1) { queue.splice(index, 1); reject(error('MR_BONI_REPLAY_BUSY')); } }, timeoutMs);
      queue.push(item); drain();
    });
  }
  return { verifyRun };
}
const pool = createReplayPool();
module.exports = { createReplayPool, verifyRun: pool.verifyRun };
