module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: 'test/.*\\.e2e-spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: { experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true, target: 'ES2022' }, diagnostics: false }] },
  moduleNameMapper: { '^@rms/shared$': '<rootDir>/../../packages/shared/src/index.ts' },
  setupFiles: ['<rootDir>/test/env.ts'],
  testTimeout: 30000,
};
