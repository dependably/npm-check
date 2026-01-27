/**
 * Worker thread for deduplicating packages
 */

import { parentPort } from 'worker_threads';
import { deduplicatePackages } from '../updater.js';

parentPort.on('message', async (task) => {
  try {
    const { chunk, options } = task;
    const result = deduplicatePackages(chunk, options);
    parentPort.postMessage({ success: true, result, chunkIndex: task.chunkIndex });
  } catch (error) {
    parentPort.postMessage({
      success: false,
      error: error.message,
      chunkIndex: task.chunkIndex
    });
  }
});
