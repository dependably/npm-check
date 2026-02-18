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

export default config;
