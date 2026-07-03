import {
  ProgressReporter,
  createProgressReporter,
  formatProgress,
  createProgressBar,
  formatCliProgressUpdate
} from '../../src/progress-reporter.js';

describe('Progress Reporter', () => {
  describe('ProgressReporter class', () => {
    it('creates a progress reporter with initial values', () => {
      const reporter = new ProgressReporter(100);
      expect(reporter.total).toBe(100);
      expect(reporter.current).toBe(0);
      expect(reporter.finished).toBe(false);
    });

    it('updates progress correctly', () => {
      const reporter = new ProgressReporter(100);
      reporter.update(50);
      expect(reporter.current).toBe(50);
    });

    it('increments progress by 1', () => {
      const reporter = new ProgressReporter(100);
      reporter.increment();
      expect(reporter.current).toBe(1);
      reporter.increment();
      expect(reporter.current).toBe(2);
    });

    it('does not exceed total', () => {
      const reporter = new ProgressReporter(100);
      reporter.update(150);
      expect(reporter.current).toBe(100);
    });

    it('emits progress events', (done) => {
      const reporter = new ProgressReporter(100);
      reporter.on('progress', (progressInfo) => {
        expect(progressInfo.current).toBe(50);
        expect(progressInfo.total).toBe(100);
        expect(progressInfo.percentage).toBe(50);
        done();
      });
      reporter.update(50);
    });

    it('calls progress callback if provided', () => {
      const callback = jest.fn();
      const reporter = new ProgressReporter(100, { onProgress: callback });
      reporter.update(50);
      expect(callback).toHaveBeenCalled();
      const progressInfo = callback.mock.calls[0][0];
      expect(progressInfo.current).toBe(50);
      expect(progressInfo.percentage).toBe(50);
    });

    it('finishes progress reporting', () => {
      const reporter = new ProgressReporter(100);
      reporter.finish();
      expect(reporter.finished).toBe(true);
      expect(reporter.current).toBe(100);
    });

    it('resets progress reporter', () => {
      const reporter = new ProgressReporter(100);
      reporter.update(50);
      reporter.reset();
      expect(reporter.current).toBe(0);
      expect(reporter.finished).toBe(false);
    });

    it('sets total dynamically', () => {
      const reporter = new ProgressReporter(100);
      reporter.setTotal(200);
      expect(reporter.total).toBe(200);
    });

    it('includes memory stats when enabled', () => {
      const reporter = new ProgressReporter(100, { showMemory: true });
      reporter.update(50);
      const progressInfo = reporter._getProgressInfo();
      expect(progressInfo.memory).toBeDefined();
    });

    it('calculates estimated time remaining', () => {
      const reporter = new ProgressReporter(100);
      // Simulate some progress
      reporter.update(50);
      // Wait a bit
      return new Promise((resolve) => {
        setTimeout(() => {
          reporter.update(75);
          const progressInfo = reporter._getProgressInfo();
          expect(progressInfo.estimated).toBeGreaterThan(0);
          resolve();
        }, 10);
      });
    });
  });

  describe('createProgressReporter', () => {
    it('creates a progress reporter instance', () => {
      const reporter = createProgressReporter(100);
      expect(reporter).toBeInstanceOf(ProgressReporter);
      expect(reporter.total).toBe(100);
    });

    it('accepts options', () => {
      const callback = jest.fn();
      const reporter = createProgressReporter(100, { onProgress: callback });
      reporter.update(50);
      expect(callback).toHaveBeenCalled();
    });
  });

  describe('formatProgress', () => {
    it('formats progress information', () => {
      const progress = {
        current: 50,
        total: 100,
        percentage: 50,
        elapsed: 1000,
        estimated: 1000,
        stage: 'Processing'
      };
      const formatted = formatProgress(progress);
      expect(formatted).toContain('50/100');
      expect(formatted).toContain('50%');
      expect(formatted).toContain('Processing');
    });

    it('includes elapsed time', () => {
      const progress = {
        current: 50,
        total: 100,
        percentage: 50,
        elapsed: 2500,
        estimated: 2500,
        stage: 'Processing'
      };
      const formatted = formatProgress(progress);
      expect(formatted).toContain('Elapsed:');
    });

    it('includes memory stats when available', () => {
      const progress = {
        current: 50,
        total: 100,
        percentage: 50,
        elapsed: 1000,
        estimated: 1000,
        stage: 'Processing',
        memory: { heapUsed: 50.5 }
      };
      const formatted = formatProgress(progress);
      expect(formatted).toContain('Memory:');
    });
  });

  describe('createProgressBar', () => {
    it('creates a progress bar string', () => {
      const progress = {
        percentage: 50
      };
      const bar = createProgressBar(progress);
      expect(bar).toContain('50%');
      expect(bar).toContain('█');
      expect(bar).toContain('░');
    });

    it('creates full bar at 100%', () => {
      const progress = {
        percentage: 100
      };
      const bar = createProgressBar(progress, 40);
      expect(bar).toContain('100%');
      // Should have mostly filled characters
      expect(bar.match(/█/g)?.length).toBeGreaterThan(35);
    });

    it('creates empty bar at 0%', () => {
      const progress = {
        percentage: 0
      };
      const bar = createProgressBar(progress, 40);
      expect(bar).toContain('0%');
      // Should have mostly empty characters
      expect(bar.match(/░/g)?.length).toBeGreaterThan(35);
    });

    it('respects custom width', () => {
      const progress = {
        percentage: 50
      };
      const bar = createProgressBar(progress, 20);
      // Check approximate length (accounting for brackets and percentage)
      expect(bar.length).toBeLessThan(30);
    });
  });

  describe('formatCliProgressUpdate (non-TTY progress suppression)', () => {
    const progressAt = (percentage, stage = 'Verifying integrity against registry') => ({
      current: percentage, total: 100, percentage, elapsed: 100, estimated: 0, stage
    });

    it('on a TTY, redraws an animated \\r bar for every percentage change', () => {
      const state = { lastPercentage: -1, lastMilestone: -1 };
      const first = formatCliProgressUpdate(progressAt(0), state, true);
      expect(first).toMatch(/^\r/);
      expect(first).toContain('0%');

      const second = formatCliProgressUpdate(progressAt(37), state, true);
      expect(second).toMatch(/^\r/);
      expect(second).toContain('37%');
    });

    it('on a TTY, suppresses a redraw when the percentage has not changed', () => {
      const state = { lastPercentage: -1, lastMilestone: -1 };
      formatCliProgressUpdate(progressAt(50), state, true);
      const repeat = formatCliProgressUpdate(progressAt(50), state, true);
      expect(repeat).toBeNull();
    });

    it('on a non-TTY, never emits a \\r-redrawn frame (would flood a piped/CI log)', () => {
      const state = { lastPercentage: -1, lastMilestone: -1 };
      for (const pct of [0, 5, 12, 24, 25, 33, 49, 50, 51, 74, 75, 99, 100]) {
        const line = formatCliProgressUpdate(progressAt(pct), state, false);
        if (line !== null) expect(line).not.toMatch(/\r/);
      }
    });

    it('on a non-TTY, collapses to periodic one-line milestones instead of one line per % change', () => {
      const state = { lastPercentage: -1, lastMilestone: -1 };
      const lines = [];
      // Simulate a real run: percentage advances 1-by-1 across 100 updates —
      // on a TTY this would be up to 101 separate frame writes.
      for (let pct = 0; pct <= 100; pct++) {
        const line = formatCliProgressUpdate(progressAt(pct), state, false);
        if (line !== null) lines.push(line);
      }
      // Milestones only: 0, 25, 50, 75, 100 — never one line per percentage point.
      expect(lines.length).toBe(5);
      lines.forEach((line) => expect(line.endsWith('\n')).toBe(true));
      expect(lines[0]).toContain('0%');
      expect(lines[lines.length - 1]).toContain('100%');
    });

    it('on a non-TTY, still reports the final 100% milestone even off a 25% cadence', () => {
      const state = { lastPercentage: -1, lastMilestone: -1 };
      formatCliProgressUpdate(progressAt(0), state, false);
      formatCliProgressUpdate(progressAt(83), state, false);
      const last = formatCliProgressUpdate(progressAt(100), state, false);
      expect(last).toContain('100%');
    });
  });
});
