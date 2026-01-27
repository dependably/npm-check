/**
 * Worker thread for validating lockfiles
 */

import { parentPort } from 'worker_threads';
import { validatePackageLock } from '../validator.js';

parentPort.on('message', async (task) => {
  try {
    const { chunk, options } = task;
    const result = validatePackageLock(chunk, null, options);
    parentPort.postMessage({ success: true, result, chunkIndex: task.chunkIndex });
  } catch (error) {
    parentPort.postMessage({ 
      success: false, 
      error: error.message, 
      chunkIndex: task.chunkIndex 
    });
  }
});
