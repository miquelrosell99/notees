import { test, expect } from '@playwright/test';

test.describe('Smoke Tests', () => {
  test.describe('unauthenticated', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test('auth page renders', async ({ page }) => {
      await page.goto('/auth');
      await expect(page.locator('body')).toContainText(/login|sign in|get started/i);
    });

    test('root redirects to auth when not authenticated', async ({ page }) => {
      await page.goto('/');
      await expect(page).toHaveURL(/auth|\/$/);
    });
  });

  test.describe('authenticated', () => {
    test('workspace loads and redirects to active workspace', async ({ page }) => {
      await page.goto('/');
      await expect(page).toHaveURL(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, { timeout: 30000 });
      await expect(page.locator('body')).toContainText('E2E Workspace', { timeout: 10000 });
    });

    test('offline event shows banner', async ({ page }) => {
      await page.goto('/');
      await expect(page).toHaveURL(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, { timeout: 30000 });
      // The offline banner listens to window 'offline' events. Fire the event
      // repeatedly (and override navigator.onLine) until the banner renders.
      await page.waitForFunction(
        () => {
          Object.defineProperty(window.navigator, 'onLine', {
            value: false,
            configurable: true,
            writable: true,
          });
          window.dispatchEvent(new Event('offline'));
          return document.querySelector('.offline-banner') !== null;
        },
        { timeout: 10000, polling: 100 },
      );
      await expect(page.locator('.offline-banner')).toContainText(/Working offline/i, { timeout: 10000 });
    });
  });
});
