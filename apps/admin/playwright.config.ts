import { defineConfig } from '@playwright/test';

/**
 * Browser E2E against the real stack: Postgres (pnpm db:up + migrate + seed) and the BUILT api/admin
 * (pnpm build). Uses dedicated ports (API 3190, admin 3191) so it never reuses a dev server that has
 * different rate-limit settings; webServer starts and stops both.
 */
export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: [['list']],
  use: { baseURL: 'http://localhost:3191', trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'node ../api/dist/main.js',
      url: 'http://localhost:3190/health',
      reuseExistingServer: false,
      env: { PORT: '3190', THROTTLE_AUTH_PER_MIN: '1000', THROTTLE_DEFAULT_PER_MIN: '100000' },
    },
    {
      command: 'npx next start -p 3191',
      url: 'http://localhost:3191/login',
      reuseExistingServer: false,
      env: { API_URL: 'http://localhost:3190' },
    },
  ],
});
