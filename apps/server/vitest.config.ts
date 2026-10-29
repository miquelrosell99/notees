import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // CI-only flake mitigation: workspace-snapshot-rebuild (and friends,
    // under CPU contention with the sibling packages in the pnpm chain)
    // flakes intermittently on the Actions runner. Retry failed specs up
    // to twice when CI is set; local runs stay single-attempt.
    retry: process.env.CI ? 2 : 0,
  },
});
