/**
 * The cmdk disabled-attribute register — source-level guard (the
 * css-token-drift pattern).
 *
 * cmdk 1.x renders `data-disabled="false"` on EVERY CommandItem (React
 * stringifies the boolean; the attribute is present even when the item is
 * enabled). A Tailwind `data-[disabled]:` utility compiles to a bare
 * `[data-disabled]` presence selector under this repo's Tailwind v3 bridge
 * — so the shadcn-style `data-[disabled]:opacity-50
 * data-[disabled]:pointer-events-none` pair dims and click-blocks EVERY
 * menu item of every fleet Dropdown, enabled or not (shipped bug,
 * 2026-10-19 cmdk rebuild; live symptom: every operator option in the
 * structured-filters panel rendered greyed and unclickable).
 *
 * The register: cmdk-state utilities must pin the value —
 * `data-[disabled="true"]:` — so the selector only matches the real state.
 * This gate fails the build if the bare presence form comes back.
 */
import { describe, expect, it } from "vitest";

const process_ = process as unknown as { getBuiltinModule(name: string): typeof import("node:fs") };
const fs = process_.getBuiltinModule("node:fs");
const path = process_.getBuiltinModule("node:path") as unknown as typeof import("node:path");

const FLEET_DIR = path.join(process.cwd(), "src", "components", "ui", "fleet");
// The cmdk surfaces only: Radix primitives (dropdown-menu/select/…) render
// data-disabled strictly when the state fires (presence-based by design) —
// the bare utility form is correct there. cmdk 1.x is the hazard: it
// renders data-disabled="false" on EVERY item. The cmdk command
// composition was absorbed into the fleet Dropdown when the catalog layer
// retired — the Dropdown file is the only cmdk surface.
const CMDK_FILES = ["Dropdown.tsx"];

describe("the cmdk disabled-attribute register", () => {
  it("the fleet Dropdown pins data-disabled to the true value — no presence form", () => {
    const offenders: string[] = [];
    for (const name of CMDK_FILES) {
      const file = path.join(FLEET_DIR, name);
      const source = fs.readFileSync(file, "utf8");
      // `data-[disabled]` NOT followed by `=value` is the presence form.
      // `data-[disabled="true"]:` pins the value and is the sanctioned
      // spelling; any explicit `=` value passes.
      for (const match of source.matchAll(/data-\[disabled\](?!=)/g)) {
        offenders.push(`${file}: ${match[0]}${source.slice(match.index! + match[0].length, match.index! + match[0].length + 8)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
