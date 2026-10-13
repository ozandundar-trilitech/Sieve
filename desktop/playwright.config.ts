import { defineConfig } from '@playwright/test';

// Drives the real Electron app (and the real bundled Go server) end to end.
// Each test gets its own userData dir and non-default ports, so a user's
// running Sieve on 19816/19817 is never touched.
export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: { screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
