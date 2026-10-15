/**
 * appearance-bootstrap parity — the appearance-seam gate.
 *
 * The appearance data-* attributes have TWO writers:
 *
 *   1. `applyAppearance()` in src/ui/components/modals/deviceSettings.ts
 *      (runtime — boot + every settings change), which resolves through
 *      src/ui/appearance.ts's resolveAppearanceAttributes;
 *   2. the inline bootstrap script in index.html (pre-paint — it cannot
 *      import the module), which mirrors that function VERBATIM.
 *
 * A drift between them means first paint and post-boot disagree (theme
 * flash, stale OLED, unvalidated accent). This test executes BOTH
 * implementations against a scenario matrix — stored preferences crossed
 * with the system scheme, malformed values, the legacy fallback key — and
 * fails the gate on any divergence.
 */
import { describe, expect, it } from "vitest";

import { resolveAppearanceAttributes } from "../src/ui/appearance.js";

const process_ = process as unknown as { getBuiltinModule(name: string): typeof import("node:fs") };
const fs = process_.getBuiltinModule("node:fs");
const path = process_.getBuiltinModule("node:path") as unknown as typeof import("node:path");

const html = fs.readFileSync(path.join(process.cwd(), "index.html"), "utf8");
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) throw new Error("index.html: inline bootstrap <script> not found");
const BOOTSTRAP_SOURCE = scriptMatch[1]!;

interface Scenario {
  /** Raw localStorage entries (already JSON-encoded, as writeDeviceSetting stores). */
  store: Record<string, string>;
  systemDark: boolean;
}

const THEME_VALUES = [undefined, '"light"', '"dark"', '"system"', '"banana"', "42", "{oops"];
const OLED_VALUES = [undefined, "true", "false", '"true"', "null"];
const ACCENT_VALUES_STORED = [undefined, '"margin"', '"teal"', '"nope"', "7"];

const scenarios: Scenario[] = [];
for (const theme of THEME_VALUES) {
  for (const oled of OLED_VALUES) {
    for (const accent of ACCENT_VALUES_STORED) {
      for (const systemDark of [false, true]) {
        const store: Record<string, string> = {};
        if (theme !== undefined) store["notees.settings.theme"] = theme;
        if (oled !== undefined) store["notees.settings.oledMode"] = oled;
        if (accent !== undefined) store["notees.settings.accentColor"] = accent;
        scenarios.push({ store, systemDark });
      }
    }
  }
}
// The legacy fallback key, raw (unquoted) values, and its interaction with a
// stored preference and garbage.
for (const legacy of ["dark", "light", "banana", null]) {
  for (const stored of [undefined, '"system"', '"dark"']) {
    for (const systemDark of [false, true]) {
      const store: Record<string, string> = {};
      if (legacy !== null) store["notees.theme"] = legacy;
      if (stored !== undefined) store["notees.settings.theme"] = stored;
      scenarios.push({ store, systemDark });
    }
  }
}

/** Run the inline bootstrap with mocked globals; returns the dataset it wrote. */
function runBootstrap(store: Record<string, string>, systemDark: boolean): Record<string, string> {
  const dataset: Record<string, string> = {};
  const localStorage = {
    getItem: (key: string) => (Object.hasOwn(store, key) ? store[key]! : null),
  };
  const window = {
    matchMedia: () => ({ matches: systemDark }),
  };
  const document = { documentElement: { dataset } };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const run = new Function("window", "document", "localStorage", BOOTSTRAP_SOURCE) as (
    window: unknown,
    document: unknown,
    localStorage: unknown,
  ) => void;
  run(window, document, localStorage);
  return dataset;
}

/** Run the shared module with the same store; returns the same shape. */
function runModule(store: Record<string, string>, systemDark: boolean): Record<string, string> {
  const attrs = resolveAppearanceAttributes(
    (key) => (Object.hasOwn(store, key) ? store[key]! : null),
    systemDark,
  );
  return {
    theme: attrs.theme,
    oled: attrs.oled,
    accent: attrs.accent,
  };
}

describe("appearance bootstrap parity", () => {
  it(`index.html bootstrap matches resolveAppearanceAttributes across ${scenarios.length} scenarios`, () => {
    for (const { store, systemDark } of scenarios) {
      expect(runBootstrap(store, systemDark), `store=${JSON.stringify(store)} systemDark=${systemDark}`).toEqual(
        runModule(store, systemDark),
      );
    }
  });
});
