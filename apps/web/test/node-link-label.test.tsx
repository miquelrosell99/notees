/**
 * Node-link chip rich-label tests: a mention whose target title itself
 * carries link elements (mentions, class links, hyperlinks) renders those
 * elements inside the chip via resolveLabelTokens — the chip stays ONE
 * link to its target, so the nested elements render inert (the link look,
 * no own click), one recursion level deep (link cycles terminate).
 * Titles without link elements keep the flat string label.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";

import { InlineTokens } from "../src/ui/InlineTokens.js";

const TARGET_ID = "target-node-id";

/** The target title: text + a nested mention + a class link + a hyperlink. */
const RICH_TITLE = [
  { type: "text", text: "formación " },
  { type: "mention", targetNodeId: "inner-mention-id" },
  { type: "text", text: " a " },
  { type: "class_link", classId: "class-id" },
  { type: "text", text: " y " },
  { type: "text", text: "[docs](https://example.com/d)" },
];

describe("InlineTokens node-link rich label", () => {
  it("renders the target's link elements inside the chip, inert", () => {
    const { container } = render(
      <InlineTokens
        tokens={[{ type: "mention", targetNodeId: TARGET_ID }]}
        resolveFullTitle={(id) => (id === TARGET_ID ? "flat title" : null)}
        resolveLabelTokens={() => RICH_TITLE}
        resolveName={(id) => (id === "inner-mention-id" ? "PMCF" : id === "class-id" ? "GMI Chile" : null)}
        onOpenNode={() => {}}
      />,
    );
    const chip = container.querySelector("button.nt-link")!;
    expect(chip).not.toBeNull();
    expect(chip.textContent).toBe("formación PMCF a GMI Chile y docs");
    // Nested elements render as inert spans — never interactive content
    // inside the chip's button.
    expect(chip.querySelector("button")).toBeNull();
    expect(chip.querySelector("a")).toBeNull();
    const innerMention = chip.querySelector("span.nt-link--inert")!;
    expect(innerMention.textContent).toBe("PMCF");
    expect(chip.querySelector("span.nt-class-link")!.textContent).toBe("GMI Chile");
    const hyperlink = chip.querySelector("span.nt-hyperlink--inert")!;
    expect(hyperlink.textContent).toBe("docs");
    expect(hyperlink.getAttribute("title")).toBe("https://example.com/d");
  });

  it("keeps the whole chip one link to the target (click opens the target)", () => {
    const onOpenNode = vi.fn();
    const { container } = render(
      <InlineTokens
        tokens={[{ type: "mention", targetNodeId: TARGET_ID }]}
        resolveFullTitle={() => "flat title"}
        resolveLabelTokens={() => RICH_TITLE}
        resolveName={(id) => (id === "inner-mention-id" ? "PMCF" : null)}
        onOpenNode={onOpenNode}
      />,
    );
    const chip = container.querySelector("button.nt-link")!;
    fireEvent.click(chip.querySelector("span.nt-link--inert")!);
    expect(onOpenNode).toHaveBeenCalledTimes(1);
    expect(onOpenNode).toHaveBeenCalledWith(TARGET_ID);
  });

  it("falls back to the flat string when the title has no link elements", () => {
    const { container } = render(
      <InlineTokens
        tokens={[{ type: "mention", targetNodeId: TARGET_ID }]}
        resolveFullTitle={() => "plain title"}
        resolveLabelTokens={() => [{ type: "text", text: "plain title" }]}
        onOpenNode={() => {}}
      />,
    );
    const chip = container.querySelector("button.nt-link")!;
    expect(chip.textContent).toBe("plain title");
    expect(chip.querySelector("span.nt-link--inert")).toBeNull();
  });

  it("falls back to the flat string when the title has block-scale tokens", () => {
    const { container } = render(
      <InlineTokens
        tokens={[{ type: "mention", targetNodeId: TARGET_ID }]}
        resolveFullTitle={() => "flat title"}
        resolveLabelTokens={() => [
          { type: "text", text: "see " },
          { type: "mention", targetNodeId: "inner-mention-id" },
          { type: "embed_ref", nodeId: "embed-id" },
        ]}
        resolveName={(id) => (id === "inner-mention-id" ? "PMCF" : null)}
        onOpenNode={() => {}}
      />,
    );
    const chip = container.querySelector("button.nt-link")!;
    expect(chip.textContent).toBe("flat title");
    expect(chip.querySelector("span.nt-link--inert")).toBeNull();
  });

  it("a customLabel wins over the rich label", () => {
    const { container } = render(
      <InlineTokens
        tokens={[{ type: "mention", targetNodeId: TARGET_ID, customLabel: "one-off wording" }]}
        resolveFullTitle={() => "flat title"}
        resolveLabelTokens={() => RICH_TITLE}
        onOpenNode={() => {}}
      />,
    );
    expect(container.querySelector("button.nt-link")!.textContent).toBe("one-off wording");
  });

  it("terminates on link cycles (nested mention of the source renders flat)", () => {
    const cycleTitle = [
      { type: "text", text: "see " },
      { type: "mention", targetNodeId: "cycle-a" },
    ];
    const { container } = render(
      <InlineTokens
        tokens={[{ type: "mention", targetNodeId: "cycle-a" }]}
        resolveFullTitle={(id) => (id === "cycle-a" ? "Cycle A" : "Cycle B")}
        resolveLabelTokens={(id) => (id === "cycle-a" ? cycleTitle : undefined)}
        resolveName={() => "Cycle B"}
        onOpenNode={() => {}}
      />,
    );
    const chip = container.querySelector("button.nt-link")!;
    expect(chip.textContent).toBe("see Cycle A");
    // Depth-1 chips never consult resolveLabelTokens again — the cycle
    // renders as a flat string instead of recursing forever.
    expect(chip.querySelector("button")).toBeNull();
  });

  it("renders the flat string when the resolver is absent (unwired projections)", () => {
    const { container } = render(
      <InlineTokens
        tokens={[{ type: "mention", targetNodeId: TARGET_ID }]}
        resolveFullTitle={() => "flat title"}
      />,
    );
    expect(container.querySelector("button.nt-link")).toBeNull();
    expect(container.querySelector("span.nt-chip")!.textContent).toBe("flat title");
  });
});

/**
 * The chip label's underline ownership spec (jsdom has no layout — the rule
 * text is the spec): the chip's own dashed line names the WHOLE label one
 * link; a second-level underline underneath it only doubles the line. The
 * nested elements keep their icons and names, and the hyperlink keeps its
 * color, but every nested underline is chip-scoped off.
 */

const process_ = globalThis.process as unknown as {
  getBuiltinModule(name: string): { readFileSync(path: unknown, enc: string): string };
  cwd(): string;
};
const path = process_.getBuiltinModule("node:path") as unknown as {
  join(...parts: string[]): string;
};
const css = process_.getBuiltinModule("node:fs").readFileSync(
  path.join(process_.cwd(), "src", "ui", "NodeLinks.css"),
  "utf8",
);

describe("chip label underline scoping (ui/NodeLinks.css)", () => {
  it("strips the nested mention underline inside a chip", () => {
    const scoped = /\.nt-link \.nt-link--inert \{[^}]*\}/.exec(css);
    expect(scoped).not.toBeNull();
    expect(scoped![0]).toContain("border-bottom: none");
  });

  it("strips the nested class-link, typed-link, and hyperlink underlines inside a chip", () => {
    const scoped = /\.nt-link \.nt-class-link,\s*\.nt-link \.nt-typed-link,\s*\.nt-link \.nt-hyperlink--inert \{[^}]*\}/.exec(
      css,
    );
    expect(scoped).not.toBeNull();
    expect(scoped![0]).toContain("text-decoration: none");
    // The hyperlink keeps its color — only the line goes.
    expect(scoped![0]).not.toContain("color:");
  });

  it("the chip's own underline rides text-decoration — it paints on EVERY wrapped line (border-bottom painted a single line on the button's fragmented inline box; verified in-browser 2026-10-28)", () => {
    const rule = /\.nt-link \{[^}]*\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule![0]).toContain(
      "text-decoration: underline dashed var(--md-sys-color-on-surface-variant)",
    );
    expect(rule![0]).not.toContain("border-bottom:");
  });
});
