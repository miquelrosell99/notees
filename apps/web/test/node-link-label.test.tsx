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
