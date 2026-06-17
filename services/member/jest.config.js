/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.js"],
  collectCoverageFrom: ["src/**/*.js"],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "text-summary", "lcov"],
  clearMocks: true,
  resetMocks: false,
  restoreMocks: false,
  testTimeout: 10000,
};
