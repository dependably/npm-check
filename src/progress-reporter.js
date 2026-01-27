/**
 * Progress reporting utilities for long-running operations.
 * Provides real-time progress updates with time estimates and memory tracking.
 */

import { EventEmitter } from 'events';
import { getMemoryStats } from './performance.js';

/**
 * Progress information object structure
 * @typedef {Object} ProgressInfo
 * @property {number} current - Current item count
 * @property {number} total - Total items
 * @property {number} percentage - Progress percentage (0-100)
 * @property {number} elapsed - Milliseconds elapsed
 * @property {number} estimated - Estimated time remaining (ms)
 * @property {Object|null} memory - Memory stats if enabled
 * @property {string} stage - Current operation stage
 */

/**
 * ProgressReporter class for tracking operation progress
 * Supports both callback and event emitter patterns
 */
export class ProgressReporter extends EventEmitter {
  /**
   * Create a new ProgressReporter
   * @param {number} total - Total number of items to process
   * @param {Object} options - Options
   * @param {Function} options.onProgress - Callback function(progressInfo)
   * @param {number} options.updateInterval - Update interval in ms (default: 100)
   * @param {boolean} options.showMemory - Include memory stats (default: false)
   * @param {string} options.stage - Initial stage name (default: 'Processing')
   */
  constructor(total = 0, options = {}) {
    super();
    this.total = total;
    this.current = 0;
    this.startTime = Date.now();
    this.lastUpdateTime = this.startTime;
    this.onProgressCallback = options.onProgress || null;
    this.updateInterval = options.updateInterval || 100;
    this.showMemory = options.showMemory || false;
    this.stage = options.stage || 'Processing';
    this.finished = false;
    this.lastReportedPercentage = -1;
  }

  /**
   * Update progress to a specific value
   * @param {number} current - Current item count
   * @param {string} stage - Optional stage name
   */
  update(current, stage = null) {
    if (this.finished) return;

    this.current = Math.min(current, this.total);
    if (stage) {
      this.stage = stage;
    }

    const now = Date.now();
    const timeSinceLastUpdate = now - this.lastUpdateTime;

      // If consumers are listening or a callback is provided, report immediately
      if (this.onProgressCallback || this.listenerCount('progress') > 0) {
        this._report();
        this.lastUpdateTime = now;
        return;
      }

      // Otherwise throttle updates to avoid overhead
      if (timeSinceLastUpdate >= this.updateInterval || this.current === this.total) {
        this._report();
        this.lastUpdateTime = now;
      }
  }

  /**
   * Increment progress by 1
   * @param {string} stage - Optional stage name
   */
  increment(stage = null) {
    this.update(this.current + 1, stage);
  }

  /**
   * Set total items (useful when total is unknown initially)
   * @param {number} total - Total number of items
   */
  setTotal(total) {
    this.total = total;
    // Recalculate and report immediately
    this._report();
  }

  /**
   * Finish progress reporting
   * @param {string} message - Optional completion message
   */
  finish(message = null) {
    if (this.finished) return;

    this.current = this.total;
    this.finished = true;
    this._report(true);

    if (message) {
      this.emit('complete', message);
      if (this.onProgressCallback) {
        this.onProgressCallback(this._getProgressInfo(), message);
      }
    }
  }

  /**
   * Reset progress reporter
   * @param {number} total - New total (optional)
   */
  reset(total = null) {
    this.current = 0;
    this.startTime = Date.now();
    this.lastUpdateTime = this.startTime;
    this.finished = false;
    this.lastReportedPercentage = -1;
    if (total !== null) {
      this.total = total;
    }
  }

  /**
   * Get current progress information
   * @returns {ProgressInfo} Progress information object
   */
  _getProgressInfo() {
    const elapsed = Date.now() - this.startTime;
    const percentage = this.total > 0
      ? Math.min(100, Math.round((this.current / this.total) * 100))
      : 0;

    // Calculate estimated time remaining
    let estimated = 0;
    if (this.current > 0 && this.current < this.total) {
      const rate = this.current / elapsed; // items per ms
      const remaining = this.total - this.current;
      estimated = Math.round(remaining / rate);
    }

    const progressInfo = {
      current: this.current,
      total: this.total,
      percentage,
      elapsed,
      estimated,
      stage: this.stage,
      memory: null
    };

    if (this.showMemory) {
      progressInfo.memory = getMemoryStats();
    }

    return progressInfo;
  }

  /**
   * Report progress (internal)
   * @param {boolean} force - Force report even if percentage unchanged
   */
  _report(force = false) {
    const progressInfo = this._getProgressInfo();

    // Only report if percentage changed or forced
    if (force || progressInfo.percentage !== this.lastReportedPercentage) {
      this.lastReportedPercentage = progressInfo.percentage;

      // Emit event
      this.emit('progress', progressInfo);

      // Call callback if provided
      if (this.onProgressCallback) {
        this.onProgressCallback(progressInfo);
      }
    }
  }
}

/**
 * Create a progress reporter with callback
 * @param {number} total - Total number of items
 * @param {Object} options - Options (see ProgressReporter constructor)
 * @returns {ProgressReporter} Progress reporter instance
 */
export function createProgressReporter(total, options = {}) {
  return new ProgressReporter(total, options);
}

/**
 * Format progress as a simple text string
 * @param {ProgressInfo} progress - Progress information
 * @returns {string} Formatted progress string
 */
export function formatProgress(progress) {
  const { current, total, percentage, elapsed, estimated, stage } = progress;

  const elapsedSec = (elapsed / 1000).toFixed(1);
  const estimatedSec = estimated > 0 ? (estimated / 1000).toFixed(1) : '?';

  let text = `[${stage}] ${current}/${total} (${percentage}%)`;

  if (elapsed > 0) {
    text += ` | Elapsed: ${elapsedSec}s`;
    if (estimated > 0) {
      text += ` | ETA: ${estimatedSec}s`;
    }
  }

  if (progress.memory) {
    text += ` | Memory: ${progress.memory.heapUsed.toFixed(1)}MB`;
  }

  return text;
}

/**
 * Create a simple progress bar string
 * @param {ProgressInfo} progress - Progress information
 * @param {number} width - Bar width in characters (default: 40)
 * @returns {string} Progress bar string
 */
export function createProgressBar(progress, width = 40) {
  const { percentage } = progress;
  const filled = Math.round((percentage / 100) * width);
  const empty = width - filled;

  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  return `[${bar}] ${percentage}%`;
}

export default {
  ProgressReporter,
  createProgressReporter,
  formatProgress,
  createProgressBar
};
