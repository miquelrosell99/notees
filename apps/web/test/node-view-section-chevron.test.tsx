/**
 * NodeViewSection chevron scoping — the CSS regression spec for the nested-
 * sections bug: a collapsed section's chevron inside an EXPANDED section
 * rendered rotated (the bare descendant selector `.node-view-section.expanded
 * .node-view-section__chevron` matched every nested chevron), so a per-row
 * "Properties N" panel in the linked-references rows showed the DOWN chevron
 * in BOTH states. The live probe (scripts/screenshots/props-row-probe.mjs)
 * caught it against the deployed stack; jsdom has no layout, so the rule
 * text is the spec — the rotation and the hover wash must be child-scoped to
 * the section's OWN header. The render spec pins the nested-mount contract
 * the selector exists for.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { NodeViewSection } from "../src/features/page-sections/NodeViewSection.js";

const process_ = globalThis.process as unknown as {
  getBuiltinModule(name: string): { readFileSync(path: unknown, enc: string): string };
  cwd(): string;
};
const path = process_.getBuiltinModule("node:path") as unknown as {
  join(...parts: string[]): string;
};
const css = process_.getBuiltinModule("node:fs").readFileSync(
  path.join(process_.cwd(), "src", "features", "page-sections", "NodeViewSection.css"),
  "utf8",
);

describe("NodeViewSection.css nested-section scoping", () => {
  it("the expanded rotation applies to the section's OWN header chevron only", () => {
    const scoped = /\.node-view-section\.expanded > \.node-view-section__header-row \.node-view-section__chevron \{[^}]*\}/.exec(
      css,
    );
    expect(scoped).not.toBeNull();
    expect(scoped![0]).toContain("transform: rotate(90deg)");
    // The bare descendant rule must stay gone — it rotated nested collapsed
    // sections' chevrons inside any expanded ancestor.
    expect(css).not.toMatch(/\.node-view-section\.expanded \.node-view-section__chevron/);
  });

  it("the header hover wash applies to the header's OWN toggle only", () => {
    const scoped = /\.node-view-section__header:hover > \.node-view-section__toggle \{[^}]*\}/.exec(css);
    expect(scoped).not.toBeNull();
    expect(css).not.toMatch(/\.node-view-section__header:hover \.node-view-section__toggle/);
  });
});

describe("NodeViewSection nested mount", () => {
  it("an expanded section hosts a collapsed child section, each with its own state", () => {
    render(
      <NodeViewSection title="Outer" defaultExpanded>
        <NodeViewSection title="Inner" defaultExpanded={false}>
          <p>the inner content</p>
        </NodeViewSection>
      </NodeViewSection>,
    );
    const outer = screen.getByRole("button", { name: /Outer/ });
    const inner = screen.getByRole("button", { name: /Inner/ });
    expect(outer.getAttribute("aria-expanded")).toBe("true");
    expect(inner.getAttribute("aria-expanded")).toBe("false");
    // The collapsed child's content is not rendered; the outer's is.
    expect(screen.queryByText("the inner content")).toBeNull();
  });
});
