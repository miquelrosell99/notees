/**
 * Playwright config — the design-bridge fixture suite (e2e/). The spec
 * needs a real browser: jsdom cannot resolve var() chains, and the bridge
 * contract is computed behavior (rosellramos-design-system →
 * components/shadcn-bridge.md → "CI fixture").
 *
 * The webServer boots the Vite dev server on the fixed fixture port; the
 * fixture route itself needs no sync server (main.tsx branches before the
 * app boots).
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // Generous timeout: the fleet host runs backups and media services
  // alongside the browser; a quiet CI runner finishes in seconds.
  timeout: 120_000,
  use: {
    baseURL: "http://127.0.0.1:8479",
    // The full chromium build (not the headless shell) — proven stable
    // on the loaded fleet host.
    channel: "chromium",
  },
  webServer: {
    command: "pnpm --filter @notees/web exec vite --port 8479 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:8479/__design-bridge-fixture",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
