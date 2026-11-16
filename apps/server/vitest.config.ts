import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The auth/E2EE suites derive keys (scrypt) and seal/reopen envelopes —
    // on the contended shared Actions runner a single derivation-heavy test
    // exceeds vitest's 5 s default (observed: 16 s for the recovery-codes
    // round-trip, 2026-11-16), and the per-test reds migrate across whichever
    // scrypt-bound test trips first. 30 s is the suite-wide budget; a
    // genuinely hung test still fails, just without punishing slow crypto.
    testTimeout: 30_000,
    // CI-only flake mitigation: workspace-snapshot-rebuild (and friends,
    // under CPU contention with the sibling packages in the pnpm chain)
    // flakes intermittently on the Actions runner. Retry failed specs up
    // to twice when CI is set; local runs stay single-attempt.
    retry: process.env.CI ? 2 : 0,
  },
});
