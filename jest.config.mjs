// jest.config.mjs
export default {
  testEnvironment: 'node',
  transform: {
    '^.+\\.js$': 'babel-jest'
  },
  moduleNameMapper: {
    '^src/(.*)$': '<rootDir>/src/$1'
  },
  moduleFileExtensions: ['js', 'json', 'node']
};
