import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

/**
 * Playwright configuration for E2E tests.
 *
 * On Alpine Linux dev containers, Playwright's bundled Chromium is linked
 * against glibc and cannot launch; fall back to the system chromium package.
 *
 * @see https://playwright.dev/docs/test-configuration
 */
const alpineChromiumPath = '/usr/lib/chromium/chromium';
const chromiumExecutablePath = existsSync(alpineChromiumPath) ? alpineChromiumPath : undefined;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'html',
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    storageState: './e2e/.auth/user.json',
    launchOptions: {
      executablePath: chromiumExecutablePath,
    },
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
