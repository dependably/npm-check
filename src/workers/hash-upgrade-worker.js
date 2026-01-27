/**
 * Worker thread for upgrading integrity hashes
 */

import { parentPort } from 'worker_threads';
import { upgradeIntegrityHashes } from '../updater.js';

parentPort.on('message', async (task) => {
  try {
    const { chunk, options } = task;
    const result = upgradeIntegrityHashes(chunk, options);
    parentPort.postMessage({ success: true, result, chunkIndex: task.chunkIndex });
  } catch (error) {
    parentPort.postMessage({
      success: false,
      error: error.message,
      chunkIndex: task.chunkIndex
    });
  }
});
