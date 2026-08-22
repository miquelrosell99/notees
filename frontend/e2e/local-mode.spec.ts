import { test, expect } from '@playwright/test';

/**
 * Local mode (local-first split, Task 2 / R2).
 *
 * With `notees.serverUrl` explicitly cleared, the login screen offers
 * "Continue locally" as the primary path and the app must boot to the local
 * workspace without issuing a single `/api/*` request.
 */
test.describe('Local mode', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('continue locally boots to the local workspace with zero API calls', async ({ page }) => {
    const apiCalls: string[] = [];
    // Match only real API endpoints — a glob like '**/api/**' would also catch
    // Vite source modules such as /src/features/auth/api/auth.ts.
    await page.route(
      (url) => url.pathname.startsWith('/api/'),
      (route) => {
        apiCalls.push(`${route.request().method()} ${route.request().url()}`);
        route.abort();
      },
    );
    // Explicit local mode: no server configured.
    await page.addInitScript(() => {
      localStorage.setItem('notees.serverUrl', '');
    });

    await page.goto('/auth');

    // Local mode is the primary path; the server form stays collapsed.
    const continueLocally = page.getByRole('button', { name: 'Continue locally' });
    await expect(continueLocally).toBeVisible();
    await continueLocally.click();

    // Boot lands on the well-known local workspace UUID.
    await expect(page).toHaveURL(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, { timeout: 30000 });

    // R2: local mode never calls /api/*.
    expect(apiCalls).toEqual([]);

    // Task 3: the client seeds the local workspace on open. The sidebar's
    // Inbox button is disabled until `useNodeByUuid(SYSTEM_PAGE_UUIDS.inbox)`
    // resolves, so an enabled button proves the seeded Inbox node exists.
    const inboxButton = page.getByRole('button', { name: 'Inbox', exact: true });
    await expect(inboxButton).toBeVisible();
    await expect(inboxButton).toBeEnabled();
  });
});
