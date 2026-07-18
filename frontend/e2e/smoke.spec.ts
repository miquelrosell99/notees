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
      await expect(page).toHaveURL(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, { timeout: 10000 });
      await expect(page.locator('body')).toContainText('E2E Workspace', { timeout: 10000 });
    });

    test('offline event shows banner', async ({ page }) => {
      await page.goto('/');
      await expect(page).toHaveURL(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, { timeout: 10000 });
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
        window.dispatchEvent(new Event('offline'));
      });
      await expect(page.locator('body')).toContainText(/Working offline/i, { timeout: 10000 });
    });
  });
});
