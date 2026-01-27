/**
 * Parallel processing utilities using worker threads.
 * Distributes CPU-bound operations across multiple cores.
 */

import { Worker } from 'worker_threads';
import { cpus } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { chunkLockfile, mergeLockfileChunks } from './performance.js';
import { isLargeLockfile } from './performance.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Worker pool for managing worker threads
 */
export class WorkerPool {
  /**
   * Create a worker pool
   * @param {number} size - Number of workers (default: CPU count - 1)
   * @param {string} workerScript - Path to worker script
   */
  constructor(size = null, workerScript = null) {
    this.size = size || Math.max(1, cpus().length - 1);
    this.workerScript = workerScript;
    this.workers = [];
    this.queue = [];
    this.active = 0;
  }

  /**
   * Initialize workers
   */
  init() {
    if (this.workers.length > 0) {
      return; // Already initialized
    }

    for (let i = 0; i < this.size; i++) {
      const worker = new Worker(this.workerScript, {
        workerData: { workerId: i }
      });

      // Global error handler for unhandled worker errors
      worker.on('error', (error) => {
        console.error(`Worker ${i} error: ${error.message}`);
        // Don't decrement active here - it's handled in execute/processQueue
      });

      this.workers.push({
        worker,
        busy: false
      });
    }
  }

  /**
   * Execute task on worker
   * @param {Object} task - Task data
   * @returns {Promise} Promise that resolves with result
   */
  async execute(task) {
    return new Promise((resolve, reject) => {
      const workerInfo = this.workers.find(w => !w.busy);
      
      if (workerInfo) {
        workerInfo.busy = true;
        this.active++;
        
      const messageHandler = (result) => {
        workerInfo.busy = false;
        this.active--;
        if (result.success === false) {
          reject(new Error(result.error || 'Worker task failed'));
        } else {
          resolve(result);
        }
      };
      
      const errorHandler = (error) => {
        workerInfo.busy = false;
        this.active--;
        reject(error);
      };
      
      workerInfo.worker.once('message', messageHandler);
      workerInfo.worker.once('error', errorHandler);
      
      workerInfo.worker.postMessage(task);
      } else {
        // No available worker, queue the task
        this.queue.push({ task, resolve, reject });
      }
    });
  }

  /**
   * Process queued tasks
   */
  _processQueue() {
    if (this.queue.length === 0) return;
    
    const workerInfo = this.workers.find(w => !w.busy);
    if (!workerInfo) return;
    
    const { task, resolve, reject } = this.queue.shift();
    workerInfo.busy = true;
    this.active++;
    
    const messageHandler = (result) => {
      workerInfo.busy = false;
      this.active--;
      if (result.success === false) {
        reject(new Error(result.error || 'Worker task failed'));
      } else {
        resolve(result);
      }
      this._processQueue();
    };
    
    const errorHandler = (error) => {
      workerInfo.busy = false;
      this.active--;
      reject(error);
      this._processQueue();
    };
    
    workerInfo.worker.once('message', messageHandler);
    workerInfo.worker.once('error', errorHandler);
    
    workerInfo.worker.postMessage(task);
  }

  /**
   * Terminate all workers
   */
  async terminate() {
    const terminations = this.workers.map(({ worker }) => worker.terminate());
    await Promise.all(terminations);
    this.workers = [];
    this.queue = [];
    this.active = 0;
  }
}

/**
 * Process lockfile chunks in parallel
 * @param {Object} lockfile - Lockfile to process
 * @param {string} operation - Operation name (hash-upgrade, dedupe, migration, validation)
 * @param {Object} options - Options
 * @param {number} options.workerCount - Number of workers (default: CPU count - 1)
 * @param {number} options.chunkSize - Packages per chunk (default: 5000)
 * @param {Function} options.onProgress - Progress callback
 * @param {Object} options.operationOptions - Options specific to operation
 * @returns {Promise<Object>} Processed lockfile
 */
export async function processInParallel(lockfile, operation, options = {}) {
  const {
    workerCount = Math.max(1, cpus().length - 1),
    chunkSize = 5000,
    onProgress = null,
    operationOptions = {}
  } = options;

  // Only use parallel processing for large files
  if (!isLargeLockfile(lockfile, 10)) {
    // For smaller files, parallel overhead isn't worth it
    throw new Error('Parallel processing is only recommended for large lockfiles (>10MB)');
  }

  // Chunk the lockfile
  const chunks = chunkLockfile(lockfile, chunkSize);
  
  if (chunks.length === 1) {
    // Single chunk, no need for parallel processing
    return chunks[0];
  }

  // Determine worker script based on operation
  const workerScripts = {
    'hash-upgrade': path.join(__dirname, 'workers', 'hash-upgrade-worker.js'),
    'dedupe': path.join(__dirname, 'workers', 'dedupe-worker.js'),
    'migration': path.join(__dirname, 'workers', 'migration-worker.js'),
    'validation': path.join(__dirname, 'workers', 'validation-worker.js')
  };

  const workerScript = workerScripts[operation];
  if (!workerScript) {
    throw new Error(`Unknown operation: ${operation}`);
  }

  // Create worker pool
  const pool = new WorkerPool(workerCount, workerScript);
  pool.init();

  try {
    // Process chunks in parallel
    const tasks = chunks.map((chunk, index) => ({
      chunk,
      operation,
      options: operationOptions,
      chunkIndex: index
    }));

    let completed = 0;
    const results = await Promise.all(
      tasks.map(async (task) => {
        const response = await pool.execute(task);
        completed++;
        
        if (onProgress) {
          onProgress({
            current: completed,
            total: tasks.length,
            percentage: Math.round((completed / tasks.length) * 100),
            stage: `Processing chunk ${completed}/${tasks.length}`
          });
        }
        
        // Extract result from worker response
        return response.result || response;
      })
    );

    // Merge results
    const merged = mergeLockfileChunks(results);
    return merged;
  } finally {
    await pool.terminate();
  }
}

/**
 * Parallel hash upgrade
 * @param {Object} lockfile - Lockfile to process
 * @param {Object} options - Options
 * @returns {Promise<Object>} Processed lockfile
 */
export async function parallelUpgradeIntegrityHashes(lockfile, options = {}) {
  return processInParallel(lockfile, 'hash-upgrade', {
    ...options,
    operationOptions: {
      all: options.all || false
    }
  });
}

/**
 * Parallel deduplication
 * @param {Object} lockfile - Lockfile to process
 * @param {Object} options - Options
 * @returns {Promise<Object>} Processed lockfile
 */
export async function parallelDeduplicatePackages(lockfile, options = {}) {
  return processInParallel(lockfile, 'dedupe', {
    ...options,
    operationOptions: {
      keepLatest: options.keepLatest || false
    }
  });
}

/**
 * Parallel migration
 * @param {Object} lockfile - Lockfile to process
 * @param {number} targetVersion - Target version
 * @param {Object} options - Options
 * @returns {Promise<Object>} Processed lockfile
 */
export async function parallelMigrate(lockfile, targetVersion, options = {}) {
  return processInParallel(lockfile, 'migration', {
    ...options,
    operationOptions: {
      targetVersion
    }
  });
}

export default {
  WorkerPool,
  processInParallel,
  parallelUpgradeIntegrityHashes,
  parallelDeduplicatePackages,
  parallelMigrate
};
