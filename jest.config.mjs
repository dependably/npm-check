// jest.config.mjs
const config = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.js$': 'babel-jest'
  },
  setupFilesAfterEnv: ['<rootDir>/tests/unit/jest.setup.js'],
  moduleNameMapper: {
    '^src/(.*)$': '<rootDir>/src/$1'
  },
  moduleFileExtensions: ['js', 'json', 'node'],
  testMatch: [
    '<rootDir>/tests/unit/**/*.test.js',
    '<rootDir>/tests/integration/**/*.test.js'
  ],
  testTimeout: 300000, // 5 minutes for integration tests
  collectCoverageFrom: ['src/**/*.js'],
  coverageThreshold: {
    global: {
      lines: 70,
      functions: 70
    }
  }
};

// Run integration tests serially
if (process.env.CI || process.env.INTEGRATION_TESTS) {
  config.maxWorkers = 1;
}

// In CI, force Jest to exit once the run completes. The suite passes cleanly but
// an intermittent benign async handle (not reported by --detectOpenHandles) can
// outlive Jest's 1s post-run grace under maxWorkers=1, hanging the job until its
// timeout. forceExit is scoped to CI so local runs keep open-handle diagnostics.
if (process.env.CI) {
  config.forceExit = true;
}

export default config;
