/**
 * The fleet Button's at-least-a-square ruling — the CSS regression spec.
 * A button's visible box is never taller than it is wide: the width floor
 * rides the SAME height token as the size, so a short label ("+1") renders
 * as a square and a long label may grow wider, never narrower (owner ruling
 * 2026-10-28, born from the "+N" classes trigger reading as a tall sliver).
 * jsdom has no layout — the rule text is the spec (the chevron-test
 * precedent).
 */

import { describe, expect, it } from "vitest";

const process_ = globalThis.process as unknown as {
  getBuiltinModule(name: string): { readFileSync(path: unknown, enc: string): string };
  cwd(): string;
};
const path = process_.getBuiltinModule("node:path") as unknown as {
  join(...parts: string[]): string;
};
const css = process_.getBuiltinModule("node:fs").readFileSync(
  path.join(process_.cwd(), "src", "components", "ui", "fleet", "Button.css"),
  "utf8",
);

describe("Button.css at-least-a-square ruling", () => {
  it("every size carries a min-width floor equal to its own height token", () => {
    for (const size of ["xs", "sm", "md", "lg"]) {
      const rule = new RegExp(
        `\\.btn\\.btn\\.h-button-${size} \\{[^}]*\\}`,
      ).exec(css);
      expect(rule, `the ${size} floor rule`).not.toBeNull();
      expect(rule![0]).toContain(`min-width: var(--height-button-${size})`);
    }
  });

  it("the floor selector doubles the .btn specificity so it sits above the min-width: 0 reset", () => {
    // The reset (.btn.btn) stays for the touch-floor case; the ruling's rules
    // carry a third class — count the class tokens on each min-width rule.
    const floors = css.match(/\.btn\.btn\.h-button-(?:xs|sm|md|lg) \{[^}]*min-width: var\(--height-button/g) ?? [];
    expect(floors.length).toBe(4);
  });
});
