/**
 * CollapsibleSearchField — the search box that folds into its row (jsdom):
 * collapsed it rides as a ghost magnifier button; clicking it expands the
 * SearchField pill IN FLOW and the caret lands in the input; the pill's ×
 * clears while text is present and folds the field when empty; Escape folds
 * it from the keyboard; a hidden value keeps the collapsed button `active`.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";

import { CollapsibleSearchField } from "../src/components/ui/fleet/CollapsibleSearchField.js";

describe("CollapsibleSearchField", () => {
  it("renders collapsed as the magnifier toggle — no input until expanded", () => {
    const { container } = render(
      <CollapsibleSearchField value="" onChange={() => {}} />,
    );
    expect(container.querySelector("button[aria-label='Search rows']")).not.toBeNull();
    expect(container.querySelector("[aria-label='Filter by text']")).toBeNull();
  });

  it("expanding mounts the field and moves focus into it", () => {
    const { container } = render(
      <CollapsibleSearchField value="" onChange={() => {}} />,
    );
    fireEvent.click(container.querySelector("button[aria-label='Search rows']")!);
    const input = container.querySelector("[aria-label='Filter by text']")!;
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it("typing reports through onChange", () => {
    const onChange = vi.fn();
    const { container } = render(
      <CollapsibleSearchField value="" onChange={onChange} />,
    );
    fireEvent.click(container.querySelector("button[aria-label='Search rows']")!);
    fireEvent.change(container.querySelector("[aria-label='Filter by text']")!, {
      target: { value: "alpha" },
    });
    expect(onChange).toHaveBeenCalledWith("alpha");
  });

  it("the × clears while text is present (the field stays expanded)", () => {
    const onChange = vi.fn();
    const { container } = render(
      <CollapsibleSearchField value="alpha" onChange={onChange} onClear={() => onChange("")} />,
    );
    fireEvent.click(container.querySelector("button[aria-label='Search rows']")!);
    fireEvent.click(container.querySelector("button[aria-label='Clear search']")!);
    expect(onChange).toHaveBeenCalledWith("");
    expect(container.querySelector("[aria-label='Filter by text']")).not.toBeNull();
  });

  it("the × collapses when the field is empty", () => {
    const { container } = render(
      <CollapsibleSearchField value="" onChange={() => {}} />,
    );
    fireEvent.click(container.querySelector("button[aria-label='Search rows']")!);
    fireEvent.click(container.querySelector("button[aria-label='Close search']")!);
    expect(container.querySelector("[aria-label='Filter by text']")).toBeNull();
    expect(container.querySelector("button[aria-label='Search rows']")).not.toBeNull();
  });

  it("Escape folds the expanded field back to the toggle", () => {
    const { container } = render(
      <CollapsibleSearchField value="" onChange={() => {}} />,
    );
    fireEvent.click(container.querySelector("button[aria-label='Search rows']")!);
    fireEvent.keyDown(container.querySelector("[aria-label='Filter by text']")!, {
      key: "Escape",
    });
    expect(container.querySelector("[aria-label='Filter by text']")).toBeNull();
  });

  it("a hidden value keeps the collapsed toggle active", () => {
    const { container } = render(
      <CollapsibleSearchField value="alpha" onChange={() => {}} />,
    );
    const toggle = container.querySelector("button[aria-label='Search rows']")!;
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });
});
