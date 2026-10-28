module.exports = {
  testEnvironment: 'node',
  testRegex: 'test/.*\\.spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: { esModuleInterop: true, target: 'ES2022', strict: true }, diagnostics: false }] },
  testTimeout: 15000,
};
