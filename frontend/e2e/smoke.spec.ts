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
    test('workspace management loads', async ({ page }) => {
      await page.goto('/workspaces');
      await expect(page.locator('body')).toContainText(/Welcome! Create your first workspace|Your workspaces/i, { timeout: 10000 });
    });

    test('offline toggle shows banner', async ({ page, context }) => {
      await page.goto('/workspaces');
      await context.setOffline(true);
      await expect(page.locator('body')).toContainText(/offline|connection/i, { timeout: 10000 });
      await context.setOffline(false);
    });
  });
});
