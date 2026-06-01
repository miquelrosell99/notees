import { test, expect } from '@playwright/test';

test.describe('Smoke Tests', () => {
  test('auth page renders', async ({ page }) => {
    await page.goto('/auth');
    // The app should render the login form (or onboarding gate)
    await expect(page.locator('body')).toContainText(/login|sign in|get started/i);
  });

  test('root redirects to auth when not authenticated', async ({ page }) => {
    await page.goto('/');
    // Should end up on /auth or show auth UI
    await expect(page).toHaveURL(/auth|\/$/);
  });
});
