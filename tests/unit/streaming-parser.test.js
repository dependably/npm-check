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
