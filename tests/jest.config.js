'use strict';

module.exports = {
  testEnvironment:  'node',
  rootDir:          '../',
  testMatch:        ['**/tests/**/*.test.js'],
  clearMocks:       true,
  collectCoverageFrom: [
    'server/**/*.js',
    '!server/content-types/**',
    '!server/routes/**',
  ],
  coverageThreshold: {
    global: { lines: 60, functions: 60, branches: 50 },
  },
};
