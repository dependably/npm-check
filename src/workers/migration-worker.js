/**
 * Worker thread for migrating lockfile versions
 */

import { parentPort } from 'worker_threads';
import { migrateToVersion } from '../migrator.js';

parentPort.on('message', async (task) => {
  try {
    const { chunk, options } = task;
    const { targetVersion } = options;
    const result = migrateToVersion(chunk, targetVersion);
    parentPort.postMessage({ success: true, result, chunkIndex: task.chunkIndex });
  } catch (error) {
    parentPort.postMessage({ 
      success: false, 
      error: error.message, 
      chunkIndex: task.chunkIndex 
    });
  }
});
