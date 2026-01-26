// jest.config.cjs
module.exports = {
  testEnvironment: 'node',
  // extensionsToTreatAsEsm: ['.js'],
  transform: {},
  moduleNameMapper: {
    '^src/(.*)$': '<rootDir>/src/$1'
  },
  moduleFileExtensions: ['js', 'json', 'node']
};
