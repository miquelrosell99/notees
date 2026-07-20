import { test, expect } from '@playwright/test';

const UUID_PATH_RE = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function extractWorkspaceId(url: string): string {
  const path = new URL(url).pathname;
  return path.split('/')[1];
}

test.describe('Whiteboard save and reload', () => {
  test('creates a whiteboard, draws a rectangle, navigates away, and keeps the shape', async ({ page }) => {
    page.on('console', (msg) => console.log(`[console ${msg.type()}] ${msg.text()}`));
    page.on('pageerror', (err) => console.log(`[pageerror] ${err.message}\n${err.stack}`));

    // 1. Land on the workspace root and capture the workspace UUID.
    await page.goto('/');
    await page.waitForURL(UUID_PATH_RE, { timeout: 30000 });
    const workspaceId = extractWorkspaceId(page.url());
    await expect(page.locator('body')).toContainText('E2E Workspace', { timeout: 10000 });

    // 2. Open the whiteboards list.
    await page.goto(`/${workspaceId}/whiteboards`);
    await expect(page.locator('body')).toContainText('Whiteboards', { timeout: 10000 });

    // 3. Create a new whiteboard.
    const newButton = page.locator('button:has-text("New whiteboard")');
    await expect(newButton).toBeVisible({ timeout: 10000 });
    await expect(newButton).toBeEnabled({ timeout: 10000 });
    await newButton.click();

    // 4. Wait for the whiteboard canvas to render.
    const canvas = page.getByRole('application', { name: 'Whiteboard canvas' });
    await expect(canvas).toBeVisible({ timeout: 10000 });

    // Remember the whiteboard URL so we can return directly to it.
    const whiteboardUrl = page.url();

    // 5. Draw a rectangle on the canvas.
    await page.keyboard.press('r');
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    const startX = box!.x + box!.width / 2;
    const startY = box!.y + box!.height / 2;
    const endX = startX + 120;
    const endY = startY + 80;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(endX, endY, { steps: 5 });
    await page.mouse.up();

    // 6. Confirm the shape was created and wait for the debounced save + IndexedDB persist.
    await expect(page.locator('.whiteboard-shape')).toHaveCount(1, { timeout: 5000 });
    await page.waitForTimeout(3000);

    // 7. Navigate away to the Pages view.
    await page.goto(`/${workspaceId}/pages`);
    await expect(page.locator('body')).toContainText('Pages', { timeout: 10000 });

    // 8. Return to the whiteboard URL directly and reopen it.
    await page.goto(whiteboardUrl);
    await expect(canvas).toBeVisible({ timeout: 10000 });

    // 9. The rectangle must still be present.
    await expect(page.locator('.whiteboard-shape')).toHaveCount(1, { timeout: 5000 });
  });
});
