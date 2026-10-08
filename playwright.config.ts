import { defineConfig, devices } from '@playwright/test';

const CONSOLE_PORT = 4599;
const FIXTURE_PORT = 4610;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${CONSOLE_PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Environments that ship a pre-installed Chromium (CI images, the
        // remote dev container) set this instead of downloading one.
        ...(process.env.CHROMIUM_PATH
          ? { launchOptions: { executablePath: process.env.CHROMIUM_PATH } }
          : {}),
      },
    },
  ],
  webServer: [
    {
      // The production build served by the standalone backend: the same request
      // path (browser -> console backend -> target) the embedded build uses.
      command: 'npm run build && node server/cli.mjs --port 4599',
      url: `http://127.0.0.1:${CONSOLE_PORT}/index.html`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
    {
      command: 'node e2e/fixtures/emulator.mjs',
      url: `http://127.0.0.1:${FIXTURE_PORT}/_fakecloud/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
