/**
 * Parallel processing utilities using worker threads.
 * Distributes CPU-bound operations across multiple cores.
 */

import { Worker } from 'worker_threads';
import { cpus } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { chunkLockfile, mergeLockfileChunks, isLargeLockfile } from './performance.js';
import { migrateToVersion } from './migrator.js';

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
    this.workers = [];         // [{ worker, busy, index, current }]
    this.queue = [];           // [{ task, resolve, reject }]
    this.active = 0;
    this.terminated = false;
  }

  /**
   * Initialize workers
   */
  init() {
    if (this.workers.length > 0) {
      return; // Already initialized
    }

    this.terminated = false;
    for (let i = 0; i < this.size; i++) {
      this.workers.push(this._spawnWorker(i));
    }
  }

  /**
   * Spawn a single worker and register its persistent lifecycle handlers.
   * The 'error'/'exit' listeners are registered ONCE per worker (not per task),
   * so they never accumulate. Per-task handlers are added in _assign and always
   * removed in the settle path, preventing the listener leak.
   * @param {number} index - Worker id
   * @returns {Object} Worker info record
   */
  _spawnWorker(index) {
    const worker = new Worker(this.workerScript, {
      workerData: { workerId: index }
    });
    const info = { worker, busy: false, index, current: null, dead: false };

    // A worker 'error' means an uncaught exception in the thread — the thread has
    // exited and must not be reused. Reject its in-flight task and replace it.
    worker.on('error', (error) => this._handleWorkerFailure(info, error));
    worker.on('exit', (code) => {
      if (!this.terminated && code !== 0) {
        this._handleWorkerFailure(info, new Error(`Worker ${index} exited with code ${code}`));
      }
    });

    return info;
  }

  /**
   * Execute a task on the pool. Every task is enqueued and a single dispatcher
   * assigns queued tasks to idle workers, so queued tasks always drain (no
   * deadlock when tasks > workers).
   * @param {Object} task - Task data
   * @returns {Promise} Promise that resolves with the worker result
   */
  execute(task) {
    return new Promise((resolve, reject) => {
      if (this.terminated) {
        reject(new Error('WorkerPool has been terminated'));
        return;
      }
      this.queue.push({ task, resolve, reject });
      this._dispatch();
    });
  }

  /**
   * Assign as many queued tasks as there are idle workers. Called on every
   * enqueue and on every task completion/failure so the queue never stalls.
   */
  _dispatch() {
    if (this.terminated) return;

    while (this.queue.length > 0) {
      const workerInfo = this.workers.find(w => !w.busy);
      if (!workerInfo) return; // all workers busy; retry on next completion
      const job = this.queue.shift();
      this._assign(workerInfo, job);
    }
  }

  /**
   * Run one job on one worker, with a per-task 'message' handler that is always
   * removed once it fires (via once + explicit settle), so no handlers leak.
   * @param {Object} workerInfo - Worker record
   * @param {Object} job - { task, resolve, reject }
   */
  _assign(workerInfo, job) {
    workerInfo.busy = true;
    workerInfo.current = job;
    this.active++;

    const onMessage = (result) => {
      // Settle this worker before dispatching queued work.
      workerInfo.busy = false;
      workerInfo.current = null;
      this.active--;
      if (result && result.success === false) {
        job.reject(new Error(result.error || 'Worker task failed'));
      } else {
        job.resolve(result);
      }
      this._dispatch();
    };

    // `once` auto-removes the message listener when it fires. Task failures are
    // handled by the persistent 'error'/'exit' listeners (_handleWorkerFailure),
    // so no per-task error listener is registered — the source of the old leak.
    workerInfo.worker.once('message', onMessage);
    workerInfo.worker.postMessage(job.task);
  }

  /**
   * Handle a worker that has crashed/exited: reject its in-flight task, remove
   * the dead worker from the pool (so nothing posts to a dead thread), respawn a
   * replacement to keep capacity, and resume draining the queue.
   * @param {Object} info - Worker record
   * @param {Error} error - Failure cause
   */
  _handleWorkerFailure(info, error) {
    if (info.dead) return; // guard against error+exit firing for the same failure
    info.dead = true;

    // The thread is gone; drop any pending per-task message listener.
    info.worker.removeAllListeners('message');

    if (info.current) {
      const job = info.current;
      info.current = null;
      this.active--;
      job.reject(error);
    }
    info.busy = false;

    const idx = this.workers.indexOf(info);
    if (idx !== -1) {
      this.workers.splice(idx, 1);
      // Replace the dead worker so the pool keeps its configured capacity.
      if (!this.terminated) {
        this.workers.push(this._spawnWorker(info.index));
      }
    }

    this._dispatch();
  }

  /**
   * Terminate all workers
   */
  async terminate() {
    this.terminated = true;
    const workers = this.workers.slice();
    this.workers = [];
    // Reject any tasks still queued so callers don't hang.
    const pending = this.queue.splice(0, this.queue.length);
    for (const job of pending) {
      job.reject(new Error('WorkerPool has been terminated'));
    }
    this.active = 0;
    await Promise.all(workers.map(({ worker }) => worker.terminate()));
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

  // Migration between lockfile formats reconstructs the dependency tree from the
  // ENTIRE package graph, so it cannot be split across chunks: each chunk would see
  // only a slice of `packages`, and merging the results keeps only one chunk's
  // reconstructed `dependencies` tree (silent data loss). Run migration on the whole
  // lockfile via parallelMigrate() / migrateToVersion() instead.
  if (operation === 'migration') {
    throw new Error(
      'Migration is not chunk-parallelizable (tree reconstruction needs the whole graph); ' +
      'use migrateToVersion() on the whole lockfile'
    );
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

    // Merge results with an operation-appropriate aggregator. Validation produces
    // `{ valid, errors, warnings, info }` result objects, NOT lockfile chunks, so
    // merging them as lockfiles (via mergeLockfileChunks) is nonsensical.
    if (operation === 'validation') {
      return mergeValidationResults(results);
    }

    // hash-upgrade / dedupe operate per-entry on the packages map, so merging the
    // packages maps back together is correct.
    const merged = mergeLockfileChunks(results);
    return merged;
  } finally {
    await pool.terminate();
  }
}

/**
 * Aggregate per-chunk validation results into a single validation report.
 * @param {Array<Object>} results - Array of `{ valid, errors, warnings, info }`
 * @returns {Object} Combined validation result
 */
export function mergeValidationResults(results) {
  const merged = { valid: true, errors: [], warnings: [], info: [] };

  for (const result of results) {
    if (!result || typeof result !== 'object') continue;
    if (result.valid === false) merged.valid = false;
    if (Array.isArray(result.errors)) merged.errors.push(...result.errors);
    if (Array.isArray(result.warnings)) merged.warnings.push(...result.warnings);
    if (Array.isArray(result.info)) merged.info.push(...result.info);
  }

  return merged;
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
// eslint-disable-next-line no-unused-vars
export async function parallelMigrate(lockfile, targetVersion, options = {}) {
  // Migration is NOT chunk-parallelizable: reconstructing the dependency tree
  // (e.g. v3 -> v2/v1) requires the whole package graph, and the old chunked
  // implementation silently dropped every chunk's tree but the first, corrupting
  // the output. Run the migration on the whole lockfile instead. It stays async
  // for API compatibility (callers `await` it).
  return migrateToVersion(lockfile, targetVersion);
}

export default {
  WorkerPool,
  processInParallel,
  parallelUpgradeIntegrityHashes,
  parallelDeduplicatePackages,
  parallelMigrate
};
