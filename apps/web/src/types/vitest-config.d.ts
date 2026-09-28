/**
 * Augments the app's vite (v6) UserConfig with vitest's `test` key.
 *
 * `vitest/config`'s own augmentation targets the vite copy nested under
 * vitest 2.1 (vite v5, a different module identity than the app's vite v6),
 * so it never lands on the config this app typechecks. This local
 * augmentation applies to the app's vite copy directly — the same mechanism
 * vitest uses, bound to the right module.
 */

import type { InlineConfig } from "vitest";

declare module "vite" {
  interface UserConfig {
    test?: InlineConfig;
  }
}
