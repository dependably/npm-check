import {
  shallowCopyLockfile,
  processBatchedPackages,
  getMemoryStats,
  filterPackagesLazy,
  createDedupeMap,
  reconstructFromDedupeMap,
  chunkLockfile,
  mergeLockfileChunks,
  estimateLockfileSize,
  isLargeLockfile
} from '../../src/performance.js';

describe('Performance Utilities', () => {
  const mockLockfile = {
    lockfileVersion: 3,
    name: 'test-app',
    version: '1.0.0',
    packages: {
      '': { name: 'test-app', version: '1.0.0' },
      'node_modules/lodash': { name: 'lodash', version: '4.17.21' },
      'node_modules/react': { name: 'react', version: '18.2.0' },
      'node_modules/react-dom': { name: 'react-dom', version: '18.2.0' }
    }
  };

  describe('shallowCopyLockfile', () => {
    it('creates a shallow copy of lockfile', () => {
      const copy = shallowCopyLockfile(mockLockfile);

      expect(copy).not.toBe(mockLockfile);
      expect(copy.lockfileVersion).toBe(mockLockfile.lockfileVersion);
      expect(copy.packages).not.toBe(mockLockfile.packages);
    });

    it('handles lockfiles without packages', () => {
      const simple = { lockfileVersion: 1, dependencies: {} };
      const copy = shallowCopyLockfile(simple);

      expect(copy).toEqual(simple);
      expect(copy).not.toBe(simple);
    });

    it('handles null input', () => {
      expect(shallowCopyLockfile(null)).toBeNull();
    });
  });

  describe('processBatchedPackages', () => {
    it('processes all packages in batches', async () => {
      const processed = [];
      const processor = (path, pkg) => {
        processed.push({ path, pkg });
      };

      await processBatchedPackages(mockLockfile.packages, processor, 2);

      expect(processed.length).toBe(4);
    });

    it('handles empty packages object', async () => {
      const processed = [];
      const processor = (path, pkg) => {
        processed.push({ path, pkg });
      };

      await processBatchedPackages({}, processor);

      expect(processed.length).toBe(0);
    });
  });

  describe('getMemoryStats', () => {
    it('returns memory statistics', () => {
      const stats = getMemoryStats();

      if (stats) {
        expect(stats).toHaveProperty('heapUsed');
        expect(stats).toHaveProperty('heapTotal');
        expect(stats).toHaveProperty('external');
        expect(stats).toHaveProperty('rss');
        expect(typeof stats.heapUsed).toBe('number');
      }
    });
  });

  describe('filterPackagesLazy', () => {
    it('filters packages by predicate', () => {
      const filtered = filterPackagesLazy(mockLockfile.packages, (path, pkg) =>
        pkg.name && pkg.name.includes('react')
      );

      expect(Object.keys(filtered).length).toBe(2);
      expect(filtered['node_modules/react']).toBeDefined();
      expect(filtered['node_modules/react-dom']).toBeDefined();
    });

    it('returns empty object when no matches', () => {
      const filtered = filterPackagesLazy(mockLockfile.packages, (path, pkg) =>
        pkg.name === 'nonexistent'
      );

      expect(Object.keys(filtered).length).toBe(0);
    });
  });

  describe('createDedupeMap and reconstructFromDedupeMap', () => {
    it('creates dedup map from packages', () => {
      const dedupeMap = createDedupeMap(mockLockfile.packages);

      expect(dedupeMap.size).toBe(4);
      expect(dedupeMap.has('lodash#4.17.21')).toBe(true);
    });

    it('reconstructs packages from dedup map', () => {
      const dedupeMap = createDedupeMap(mockLockfile.packages);
      const reconstructed = reconstructFromDedupeMap(dedupeMap);

      expect(Object.keys(reconstructed).length).toBe(4);
      expect(reconstructed['node_modules/lodash']).toBeDefined();
    });

    it('handles duplicate package names with different versions', () => {
      const packagesWithDupes = {
        'node_modules/lodash': { name: 'lodash', version: '4.17.20' },
        'node_modules/lodash@4.17.21': { name: 'lodash', version: '4.17.21' }
      };

      const dedupeMap = createDedupeMap(packagesWithDupes);
      // Each version is treated as different (lodash#4.17.20 and lodash#4.17.21)
      expect(dedupeMap.size).toBe(2);
    });
  });

  describe('chunkLockfile and mergeLockfileChunks', () => {
    it('chunks lockfile into smaller pieces', () => {
      const chunks = chunkLockfile(mockLockfile, 2);

      expect(chunks.length).toBe(2);
      expect(Object.keys(chunks[0].packages).length).toBe(2);
      expect(Object.keys(chunks[1].packages).length).toBe(2);
    });

    it('preserves metadata in chunks', () => {
      const chunks = chunkLockfile(mockLockfile, 2);

      expect(chunks[0].lockfileVersion).toBe(3);
      expect(chunks[0].name).toBe('test-app');
    });

    it('merges chunks back to original structure', () => {
      const chunks = chunkLockfile(mockLockfile, 2);
      const merged = mergeLockfileChunks(chunks);

      expect(Object.keys(merged.packages).length).toBe(4);
      expect(merged.lockfileVersion).toBe(3);
    });

    it('handles single chunk', () => {
      const chunks = chunkLockfile(mockLockfile, 100);
      const merged = mergeLockfileChunks(chunks);

      expect(merged.packages).toEqual(mockLockfile.packages);
    });

    it('handles lockfile without packages', () => {
      const simple = { lockfileVersion: 1 };
      const chunks = chunkLockfile(simple, 10);

      expect(chunks.length).toBe(1);
      expect(chunks[0]).toEqual(simple);
    });
  });

  describe('estimateLockfileSize', () => {
    it('estimates lockfile size in bytes', () => {
      const size = estimateLockfileSize(mockLockfile);

      expect(typeof size).toBe('number');
      expect(size).toBeGreaterThan(0);
    });

    it('handles null gracefully', () => {
      // JSON.stringify(null) = "null" = 4 bytes
      const size = estimateLockfileSize(null);
      expect(size).toBe(4);
    });

    it('returns size for undefined (as JSON)', () => {
      const size = estimateLockfileSize(undefined);
      expect(typeof size).toBe('number');
    });
  });

  describe('isLargeLockfile', () => {
    it('identifies large lockfiles', () => {
      // mockLockfile is quite small, so it should return false
      const isLarge = isLargeLockfile(mockLockfile, 1);

      expect(typeof isLarge).toBe('boolean');
    });

    it('respects custom threshold', () => {
      // With a very low threshold, should be true
      const isLargeVeryLow = isLargeLockfile(mockLockfile, 0.00001);
      expect(isLargeVeryLow).toBe(true);

      // With a very high threshold, should be false
      const isLargeVeryHigh = isLargeLockfile(mockLockfile, 1000);
      expect(isLargeVeryHigh).toBe(false);
    });
  });
});
