/**
 * SelectionButton tier overflow — the spec for the tier-declared overflow.
 *
 * Options declare `tier: "primary" | "secondary"` (default primary);
 * secondary options ride the "…" dropdown instead of the inline strip.
 * The overflow toggle carries an active state when the selection lives in
 * the dropdown. All-secondary configs fail soft: everything renders inline.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { SelectionButton } from "../src/components/ui/kit/SelectionButton.js";

const OUTLINE = { value: "outline", icon: "mdi-format-list-bulleted", label: "Outline" };
const TABLE = { value: "table", icon: "mdi-table", label: "Table" };
const CARDS = { value: "cards", icon: "mdi-view-grid-outline", label: "Cards" };
const GRAPH = { value: "graph", icon: "mdi-graph-outline", label: "Graph" };

function stripRadios() {
  return screen.queryAllByRole("radio");
}

function overflowToggle() {
  return screen.queryByRole("button", { name: "More options" });
}

describe("SelectionButton tiers", () => {
  it("renders every option inline as radios when no tier is declared", () => {
    render(
      <SelectionButton
        options={[OUTLINE, TABLE, CARDS, GRAPH]}
        value="outline"
        onChange={() => {}}
      />,
    );
    expect(stripRadios().map((el) => el.getAttribute("aria-label"))).toEqual([
      "Outline",
      "Table",
      "Cards",
      "Graph",
    ]);
    expect(overflowToggle()).toBeNull();
  });

  it("keeps secondary options out of the strip and puts them in the dropdown with icon + label", () => {
    render(
      <SelectionButton
        options={[OUTLINE, TABLE, CARDS, { ...GRAPH, tier: "secondary" }]}
        value="outline"
        onChange={() => {}}
      />,
    );
    expect(stripRadios().map((el) => el.getAttribute("aria-label"))).toEqual([
      "Outline",
      "Table",
      "Cards",
    ]);
    const toggle = overflowToggle();
    expect(toggle).not.toBeNull();
    fireEvent.click(toggle!);
    const item = screen.getByRole("menuitem", { name: /graph/i });
    expect(item.querySelector("svg")).not.toBeNull();
    expect(item).toHaveTextContent("Graph");
  });

  it("marks the overflow toggle active when the selection lives in the dropdown, with no selected radio on the strip", () => {
    const onChange = vi.fn();
    render(
      <SelectionButton
        options={[OUTLINE, TABLE, CARDS, { ...GRAPH, tier: "secondary" }]}
        value="graph"
        onChange={onChange}
      />,
    );
    const toggle = overflowToggle()!;
    expect(toggle).toHaveClass("selection-button__overflow-toggle--active");
    expect(toggle).not.toHaveClass("selection-button__overflow-toggle--open");
    expect(screen.queryByRole("radio", { checked: true })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveClass("selection-button__overflow-toggle--open");
    // The dropdown row is a real button: picking it closes the menu. (The
    // already-selected value is a no-op onChange by design — the close is
    // the observable behavior here.)
    fireEvent.click(screen.getByRole("menuitem", { name: /graph/i }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders everything inline when every option is secondary (fail-soft)", () => {
    render(
      <SelectionButton
        options={[
          { ...OUTLINE, tier: "secondary" },
          { ...TABLE, tier: "secondary" },
        ]}
        value="outline"
        onChange={() => {}}
      />,
    );
    expect(stripRadios().map((el) => el.getAttribute("aria-label"))).toEqual([
      "Outline",
      "Table",
    ]);
    expect(overflowToggle()).toBeNull();
  });
});
