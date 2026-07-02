import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  StreamingParser,
  parseLockfileStream,
  parseLockfileStreamSync
} from '../../src/streaming-parser.js';
import { parseLockfile } from '../../src/parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Streaming Parser', () => {
  const testLockfile = {
    lockfileVersion: 3,
    name: 'test-app',
    version: '1.0.0',
    packages: {
      '': { name: 'test-app', version: '1.0.0' },
      'node_modules/lodash': { name: 'lodash', version: '4.17.21', integrity: 'sha512-test' },
      'node_modules/react': { name: 'react', version: '18.2.0', integrity: 'sha512-test2' }
    }
  };

  let testFilePath;

  beforeEach(() => {
    // Create a temporary test file
    testFilePath = path.join(__dirname, 'test-lockfile.json');
    fs.writeFileSync(testFilePath, JSON.stringify(testLockfile, null, 2));
  });

  afterEach(() => {
    // Clean up test file
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }
  });

  describe('parseLockfileStreamSync', () => {
    it('parses lockfile synchronously', () => {
      const result = parseLockfileStreamSync(testFilePath);
      expect(result.lockfileVersion).toBe(3);
      expect(result.name).toBe('test-app');
      expect(result.packages).toBeDefined();
    });

    it('uses standard parsing for small files', () => {
      const result = parseLockfileStreamSync(testFilePath, {
        streamingThreshold: 100 * 1024 * 1024 // 100MB threshold
      });
      expect(result.lockfileVersion).toBe(3);
    });

    it('handles missing file gracefully', () => {
      expect(() => {
        parseLockfileStreamSync('nonexistent.json');
      }).toThrow();
    });
  });

  describe('parseLockfileStream', () => {
    it('parses lockfile asynchronously', async () => {
      const result = await parseLockfileStream(testFilePath);
      expect(result.lockfileVersion).toBe(3);
      expect(result.name).toBe('test-app');
      expect(result.packages).toBeDefined();
    });

    it('calls progress callback if provided', async () => {
      const progressCalls = [];
      const result = await parseLockfileStream(testFilePath, {
        onProgress: (bytesRead, totalBytes) => {
          progressCalls.push({ bytesRead, totalBytes });
        }
      });
      expect(result).toBeDefined();
      // Progress may or may not be called depending on file size
    });

    it('uses standard parsing for small files', async () => {
      const result = await parseLockfileStream(testFilePath, {
        streamingThreshold: 100 * 1024 * 1024 // 100MB threshold
      });
      expect(result.lockfileVersion).toBe(3);
    });

    it('does not inject an empty dependencies/packages skeleton the file lacks', async () => {
      // Regression: the parser used to spread a { packages:{}, dependencies:{} }
      // skeleton under the result, so a v3 file came back with a spurious
      // top-level `dependencies: {}` (and a v1 file with `packages: {}`), which a
      // write-back would then persist.
      const v3Result = await parseLockfileStream(testFilePath);
      expect(v3Result.dependencies).toBeUndefined();

      const v1Path = path.join(__dirname, 'test-lockfile-v1.json');
      fs.writeFileSync(v1Path, JSON.stringify({
        lockfileVersion: 1,
        name: 'v1-app',
        version: '1.0.0',
        dependencies: { lodash: { version: '4.17.21', integrity: 'sha512-test' } }
      }, null, 2));
      try {
        const v1Result = await parseLockfileStream(v1Path);
        expect(v1Result.packages).toBeUndefined();
        expect(v1Result.dependencies).toBeDefined();
      } finally {
        fs.unlinkSync(v1Path);
      }
    });
  });

  describe('StreamingParser class', () => {
    it('creates a streaming parser instance', () => {
      const parser = new StreamingParser();
      expect(parser).toBeInstanceOf(StreamingParser);
      expect(parser.buffer).toBe('');
      expect(parser.state).toBe('initial');
    });

    it('accepts options in constructor', () => {
      const onPackage = jest.fn();
      const onProgress = jest.fn();
      const parser = new StreamingParser({
        onPackage,
        onProgress,
        chunkSize: 32 * 1024
      });
      expect(parser.onPackageCallback).toBe(onPackage);
      expect(parser.onProgressCallback).toBe(onProgress);
      expect(parser.chunkSize).toBe(32 * 1024);
    });

    it('processes chunks', () => {
      const parser = new StreamingParser();
      parser.processChunk('{"test":');
      expect(parser.buffer).toBe('{"test":');
      expect(parser.bytesRead).toBeGreaterThan(0);
    });

    it('emits error on invalid JSON', () => {
      const parser = new StreamingParser();
      return new Promise((resolve) => {
        parser.on('error', (error) => {
          expect(error).toBeDefined();
          resolve();
        });
        parser.buffer = 'invalid json';
        parser.finish();
      });
    });

    it('fails loudly (does not emit an empty complete) on an empty buffer', () => {
      // Regression (#13): an empty stream must NOT resolve an empty lockfile —
      // that would make every downstream check pass vacuously.
      const parser = new StreamingParser();
      return new Promise((resolve, reject) => {
        parser.on('complete', () => reject(new Error('empty buffer should not complete')));
        parser.on('error', (error) => {
          expect(error).toBeDefined();
          resolve();
        });
        parser.buffer = '';
        parser.finish();
      });
    });
  });

  describe('StreamingParser.parseLockfileStream (static)', () => {
    it('returns the ACTUAL parsed packages, not an empty skeleton', async () => {
      // Regression (#13): the static streaming entry point used to always resolve
      // { packages: {} } regardless of input, so every integrity/vuln/license
      // check downstream reported clean on zero packages (vacuous pass).
      const result = await StreamingParser.parseLockfileStream(testFilePath);

      expect(result.lockfileVersion).toBe(3);
      expect(result.name).toBe('test-app');
      expect(result.packages).toBeDefined();
      expect(Object.keys(result.packages)).toEqual(
        expect.arrayContaining(['', 'node_modules/lodash', 'node_modules/react'])
      );
      expect(result.packages['node_modules/lodash'].version).toBe('4.17.21');
      expect(result.packages['node_modules/react'].version).toBe('18.2.0');
    });

    it('rejects (does not resolve empty) for an empty file', async () => {
      const emptyPath = path.join(__dirname, 'test-empty-lockfile.json');
      fs.writeFileSync(emptyPath, '');
      try {
        await expect(StreamingParser.parseLockfileStream(emptyPath)).rejects.toThrow();
      } finally {
        if (fs.existsSync(emptyPath)) fs.unlinkSync(emptyPath);
      }
    });

    it('rejects for a malformed lockfile stream', async () => {
      const badPath = path.join(__dirname, 'test-bad-lockfile.json');
      fs.writeFileSync(badPath, '{ not valid json ');
      try {
        await expect(StreamingParser.parseLockfileStream(badPath)).rejects.toThrow();
      } finally {
        if (fs.existsSync(badPath)) fs.unlinkSync(badPath);
      }
    });
  });

  describe('Integration with parser.js', () => {
    it('parser.js uses streaming for large files', () => {
      // Create a larger test file
      const largeLockfile = {
        ...testLockfile,
        packages: {}
      };
      // Add many packages to make it larger
      for (let i = 0; i < 1000; i++) {
        largeLockfile.packages[`node_modules/pkg${i}`] = {
          name: `pkg${i}`,
          version: '1.0.0',
          integrity: 'sha512-test'
        };
      }
      
      const largeFilePath = path.join(__dirname, 'test-large-lockfile.json');
      fs.writeFileSync(largeFilePath, JSON.stringify(largeLockfile, null, 2));
      
      try {
        // With low threshold, should use streaming
        const result = parseLockfile(largeFilePath, {
          streamingThreshold: 1024 // 1KB threshold
        });
        expect(result).toBeDefined();
        expect(result.lockfileVersion).toBe(3);
      } finally {
        if (fs.existsSync(largeFilePath)) {
          fs.unlinkSync(largeFilePath);
        }
      }
    });

    it('parser.js uses standard parsing for small files by default', () => {
      const result = parseLockfile(testFilePath);
      expect(result.lockfileVersion).toBe(3);
      expect(result.name).toBe('test-app');
    });
  });
});
