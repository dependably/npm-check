import {
  WorkerPool,
  processInParallel,
  parallelUpgradeIntegrityHashes,
  parallelDeduplicatePackages
} from '../src/parallel-processor.js';
import { upgradeIntegrityHashes } from '../src/updater.js';
import { chunkLockfile } from '../src/performance.js';

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
      expect(result.packages['node_modules/test'].integrity).toBe('sha256-test');
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
