/**
 * Progress — the determinate linear progress primitive:
 *
 *  - the root carries role=progressbar with the valuemin/valuemax/valuenow
 *    triple (valuemin always 0, valuemax the `max` prop, valuenow the
 *    clamped value);
 *  - the value clamps into [0, max] — both the ARIA triple and the fill
 *    width agree on the clamped figure;
 *  - an optional label renders as text above the bar and names the bar
 *    via aria-labelledby (the visible label is the accessible name);
 *  - max <= 0 never divides by zero: the fill renders empty at 0%.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { Progress } from "../src/components/ui/fleet/Progress.js";

describe("Progress", () => {
  it("renders a progressbar role with the correct aria values", () => {
    render(<Progress value={0.4} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveClass("progress");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "1");
    expect(bar).toHaveAttribute("aria-valuenow", "0.4");
  });

  it("honours an explicit max in the aria values", () => {
    render(<Progress value={30} max={120} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuemax", "120");
    expect(bar).toHaveAttribute("aria-valuenow", "30");
  });

  it("clamps out-of-range values for both aria-valuenow and the fill width", () => {
    const { rerender } = render(<Progress value={1.6} max={1} />);
    let bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "1");
    expect(bar.querySelector(".progress__fill")).toHaveStyle({ width: "100%" });

    rerender(<Progress value={-0.3} max={1} />);
    bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "0");
    expect(bar.querySelector(".progress__fill")).toHaveStyle({ width: "0%" });
  });

  it("renders the label text and names the bar through it", () => {
    render(<Progress value={0.5} label="Importing notes" />);
    const bar = screen.getByRole("progressbar", { name: "Importing notes" });
    const label = bar.querySelector(".progress__label");
    expect(label).not.toBeNull();
    expect(label).toHaveTextContent("Importing notes");
    expect(label!.id).toBe(bar.getAttribute("aria-labelledby"));
  });

  it("sizes the fill as the clamped percentage of the track", () => {
    render(<Progress value={0.25} max={1} />);
    const bar = screen.getByRole("progressbar");
    expect(bar.querySelector(".progress__track")).not.toBeNull();
    expect(bar.querySelector(".progress__fill")).toHaveStyle({ width: "25%" });

    // No label → no naming attribute.
    expect(bar).not.toHaveAttribute("aria-labelledby");
  });

  it("renders an empty fill when max <= 0 (no division by zero)", () => {
    const { rerender } = render(<Progress value={0.5} max={0} />);
    let bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "0");
    expect(bar.querySelector(".progress__fill")).toHaveStyle({ width: "0%" });

    rerender(<Progress value={0.5} max={-2} />);
    bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "0");
    expect(bar.querySelector(".progress__fill")).toHaveStyle({ width: "0%" });
  });
});
