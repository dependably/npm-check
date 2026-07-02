import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  WorkerPool,
  processInParallel,
  parallelUpgradeIntegrityHashes,
  parallelDeduplicatePackages,
  parallelMigrate,
  mergeValidationResults
} from '../../src/parallel-processor.js';
import { upgradeIntegrityHashes } from '../../src/updater.js';
import { chunkLockfile } from '../../src/performance.js';
import { migrateToVersion } from '../../src/migrator.js';

describe('Parallel Processor', () => {
  // small helper fixture is available via factories if needed

  // Create a large mock lockfile for testing
  function createLargeLockfile(packageCount = 10000) {
    const lockfile = {
      lockfileVersion: 3,
      name: 'test-app',
      version: '1.0.0',
      packages: {
        '': { name: 'test-app', version: '1.0.0' }
      }
    };

    for (let i = 0; i < packageCount; i++) {
      lockfile.packages[`node_modules/pkg${i}`] = {
        name: `pkg${i}`,
        version: '1.0.0',
        integrity: i % 2 === 0 ? 'sha1-test' : 'sha512-test'
      };
    }

    return lockfile;
  }

  describe('WorkerPool', () => {
    it('creates a worker pool with default size', () => {
      // Note: We can't actually test worker pool without a real worker script
      // This test just verifies the class can be instantiated
      expect(WorkerPool).toBeDefined();
    });

    it('has terminate method', () => {
      const pool = new WorkerPool(1, 'dummy-script.js');
      expect(typeof pool.terminate).toBe('function');
    });
  });

  describe('WorkerPool dispatch (regression #11)', () => {
    // Temp worker fixtures written at runtime so the pool has a real worker script
    // to drive (no fixture files committed to src/workers).
    let echoWorkerPath;
    let crashWorkerPath;

    beforeAll(() => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-check-wp-'));
      echoWorkerPath = path.join(dir, 'echo-worker.mjs');
      crashWorkerPath = path.join(dir, 'crash-worker.mjs');

      fs.writeFileSync(
        echoWorkerPath,
        [
          "import { parentPort, workerData } from 'worker_threads';",
          'parentPort.on("message", (task) => {',
          '  if (task && task.fail) {',
          '    parentPort.postMessage({ success: false, error: "intentional failure", chunkIndex: task.chunkIndex });',
          '  } else {',
          '    parentPort.postMessage({ success: true, result: task, workerId: workerData.workerId, chunkIndex: task && task.chunkIndex });',
          '  }',
          '});'
        ].join('\n')
      );

      fs.writeFileSync(
        crashWorkerPath,
        [
          "import { parentPort } from 'worker_threads';",
          'parentPort.on("message", () => { throw new Error("worker crashed"); });'
        ].join('\n')
      );
    });

    afterAll(() => {
      for (const p of [echoWorkerPath, crashWorkerPath]) {
        try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
      }
    });

    // Guard so a regressed (deadlocking) pool fails cleanly instead of hanging
    // until the global 5-minute timeout.
    function withTimeout(promise, ms, label) {
      return Promise.race([
        promise,
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error(`timeout: ${label}`)), ms).unref()
        )
      ]);
    }

    it('drains queued tasks when tasks > workers (no deadlock)', async () => {
      // Old bug: with all workers busy, execute() queued the task but nothing ever
      // dispatched it, so Promise.all hung forever. Pool size 1, 4 concurrent tasks.
      const pool = new WorkerPool(1, echoWorkerPath);
      pool.init();
      try {
        const tasks = [0, 1, 2, 3].map((i) => pool.execute({ chunkIndex: i }));
        const results = await withTimeout(Promise.all(tasks), 8000, 'queued dispatch');
        expect(results).toHaveLength(4);
        expect(results.map((r) => r.chunkIndex).sort()).toEqual([0, 1, 2, 3]);
        expect(results.every((r) => r.success === true)).toBe(true);
      } finally {
        await pool.terminate();
      }
    });

    it('does not leak per-task listeners across many tasks', async () => {
      // Old bug: each task installed once('message') + once('error'); only the
      // fired one was removed, so stale 'error' handlers accumulated
      // (MaxListenersExceededWarning). Run tasks sequentially on a size-1 pool and
      // assert the per-worker listener counts stay bounded.
      const pool = new WorkerPool(1, echoWorkerPath);
      pool.init();
      try {
        for (let i = 0; i < 12; i++) {
          await withTimeout(pool.execute({ chunkIndex: i }), 8000, `task ${i}`);
        }
        const { worker } = pool.workers[0];
        // Per-task 'message' handlers must be fully cleaned up.
        expect(worker.listenerCount('message')).toBe(0);
        // Only the single persistent lifecycle handler should remain.
        expect(worker.listenerCount('error')).toBe(1);
      } finally {
        await pool.terminate();
      }
    });

    it('rejects the in-flight task on worker failure and stays usable (no dead-thread reuse)', async () => {
      const pool = new WorkerPool(1, crashWorkerPath);
      pool.init();
      try {
        // First task crashes the worker -> must reject (not hang).
        await expect(
          withTimeout(pool.execute({ chunkIndex: 0 }), 8000, 'crash 1')
        ).rejects.toThrow();
        // Second task must also settle (reject), proving we did not post to the
        // dead thread and hang.
        await expect(
          withTimeout(pool.execute({ chunkIndex: 1 }), 8000, 'crash 2')
        ).rejects.toThrow();
      } finally {
        await pool.terminate();
      }
    });

    it('propagates worker-reported task failures as a rejection', async () => {
      const pool = new WorkerPool(1, echoWorkerPath);
      pool.init();
      try {
        await expect(
          withTimeout(pool.execute({ chunkIndex: 0, fail: true }), 8000, 'fail task')
        ).rejects.toThrow('intentional failure');
      } finally {
        await pool.terminate();
      }
    });
  });

  describe('mergeValidationResults (regression #11)', () => {
    it('aggregates validation results instead of merging them as lockfiles', () => {
      const merged = mergeValidationResults([
        { valid: true, errors: [], warnings: ['w1'], info: ['i1'] },
        { valid: false, errors: ['e1'], warnings: ['w2'], info: [] },
        { valid: true, errors: [], warnings: [], info: ['i2'] }
      ]);
      expect(merged.valid).toBe(false);
      expect(merged.errors).toEqual(['e1']);
      expect(merged.warnings).toEqual(['w1', 'w2']);
      expect(merged.info).toEqual(['i1', 'i2']);
      // It must NOT masquerade as a lockfile chunk.
      expect(merged.packages).toBeUndefined();
    });

    it('is valid when every chunk is valid', () => {
      const merged = mergeValidationResults([
        { valid: true, errors: [], warnings: [] },
        { valid: true, errors: [], warnings: [] }
      ]);
      expect(merged.valid).toBe(true);
      expect(merged.errors).toEqual([]);
    });
  });

  describe('parallelMigrate (regression #11)', () => {
    it('migrates the WHOLE graph — output equals the canonical whole-lockfile migration', async () => {
      // Old bug: migration was routed through the chunk-parallel path, where
      // mergeLockfileChunks keeps only chunk 0's scalars/tree — migration
      // reconstructs the dependency tree from the whole graph and cannot be chunked.
      // Pin: parallelMigrate now delegates to migrateToVersion on the whole lockfile.
      const lockfile = createLargeLockfile(12000); // > 2 chunks at chunkSize 5000
      lockfile.lockfileVersion = 3;
      lockfile.packages[''].dependencies = {};
      for (let i = 0; i < 12000; i++) {
        lockfile.packages[''].dependencies[`pkg${i}`] = '1.0.0';
      }

      const migrated = await parallelMigrate(lockfile, 2);
      const canonical = migrateToVersion(lockfile, 2);

      expect(migrated).toBeDefined();
      expect(migrated.lockfileVersion).toBe(2);
      expect(migrated).toEqual(canonical);
      // Every package path survives.
      expect(Object.keys(migrated.packages).length).toBe(Object.keys(lockfile.packages).length);
    });

    it('is not routed through the chunk-parallel path (processInParallel rejects migration)', async () => {
      const lockfile = createLargeLockfile(12000);
      await expect(
        processInParallel(lockfile, 'migration')
      ).rejects.toThrow('not chunk-parallelizable');
    });
  });

  describe('processInParallel', () => {
    it('throws error for small files', async () => {
      const smallLockfile = {
        lockfileVersion: 3,
        name: 'test',
        version: '1.0.0',
        packages: {
          '': { name: 'test', version: '1.0.0' }
        }
      };

      await expect(
        processInParallel(smallLockfile, 'hash-upgrade')
      ).rejects.toThrow('large lockfiles');
    });

    it('throws error for unknown operation', async () => {
      const largeLockfile = createLargeLockfile(20000);
      await expect(
        processInParallel(largeLockfile, 'unknown-operation')
      ).rejects.toThrow('Unknown operation');
    });
  });

  describe('parallelUpgradeIntegrityHashes', () => {
    it('is defined and callable', () => {
      expect(typeof parallelUpgradeIntegrityHashes).toBe('function');
    });

    // Note: Actual parallel processing tests would require:
    // 1. Real worker scripts to be available
    // 2. More complex setup
    // These are integration tests that would be run separately
  });

  describe('parallelDeduplicatePackages', () => {
    it('is defined and callable', () => {
      expect(typeof parallelDeduplicatePackages).toBe('function');
    });
  });

  describe('Integration with updater.js', () => {
    it('updater functions accept parallel option', () => {
      const lockfile = createLargeLockfile(20000);

      // Should return a Promise when parallel is enabled
      const result = upgradeIntegrityHashes(lockfile, { parallel: true });
      expect(result).toBeInstanceOf(Promise);
    });

    it('updater functions use sequential processing by default', () => {
      const lockfile = {
        lockfileVersion: 3,
        name: 'test',
        version: '1.0.0',
        packages: {
          '': { name: 'test', version: '1.0.0' },
          'node_modules/test': {
            name: 'test',
            version: '1.0.0',
            integrity: 'sha1-test'
          }
        }
      };

      // Should return synchronously (not a Promise) when parallel is false
      const result = upgradeIntegrityHashes(lockfile, { parallel: false });
      expect(result).not.toBeInstanceOf(Promise);
      expect(result.packages['node_modules/test'].integrity).toBe('sha512-test');
    });
  });

  describe('Chunking for parallel processing', () => {
    it('chunkLockfile creates multiple chunks for large files', () => {
      const largeLockfile = createLargeLockfile(15000);
      const chunks = chunkLockfile(largeLockfile, 5000);

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0].lockfileVersion).toBe(3);
      expect(chunks[0].packages).toBeDefined();
    });

    it('chunkLockfile creates single chunk for small files', () => {
      const smallLockfile = {
        lockfileVersion: 3,
        name: 'test',
        version: '1.0.0',
        packages: {
          '': { name: 'test', version: '1.0.0' }
        }
      };

      const chunks = chunkLockfile(smallLockfile, 5000);
      expect(chunks.length).toBe(1);
    });
  });
});
