/**
 * SidePanel tests — the linked panel + toggle unit (fleet):
 *
 *  - useSidePanel returns a toggle that lands in the SAME-side top-bar
 *    slot: side "left" → SurfaceTopBar's leading cluster, side "right" →
 *    trailing (the drift-proofing contract — the journal regression this
 *    replaces had the toggle leading the bar while the panel rendered in
 *    the right column).
 *  - The dock icon reads the side (mdi-dock-left / mdi-dock-right).
 *  - The toggle's pressed/active chrome reports the panel's EFFECTIVE
 *    visibility; the label flips Show/Hide with it.
 *  - The panel aside renders the host's className + landmark, and renders
 *    NULL while closed.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { SurfaceTopBar } from "../src/components/ui/kit/SurfaceTopBar.js";
import { SidePanelToggle, useSidePanel } from "../src/components/ui/kit/SidePanel.js";

function Harness({ side }: { side: "left" | "right" }) {
  const { toggle, panel } = useSidePanel({
    side,
    open: true,
    onToggle: () => {},
    label: "test panel",
    className: "host-panel-register",
    children: <p>panel body</p>,
  });
  return (
    <div>
      <SurfaceTopBar
        title="Hub"
        {...(side === "left" ? { leading: toggle } : { trailing: toggle })}
      />
      {panel}
    </div>
  );
}

describe("useSidePanel", () => {
  it("side left → toggle in the leading cluster, before the title", () => {
    const { container } = render(<Harness side="left" />);
    const toggle = screen.getByRole("button", { name: "Hide test panel" });
    const heading = screen.getByRole("heading", { name: "Hub" });
    expect(
      toggle.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(container.querySelector(".surface-topbar__leading")!.contains(toggle)).toBe(true);
    expect(container.querySelector(".surface-topbar__trailing")).toBeNull();
  });

  it("side right → toggle in the trailing cluster, after the title", () => {
    const { container } = render(<Harness side="right" />);
    const toggle = screen.getByRole("button", { name: "Hide test panel" });
    const heading = screen.getByRole("heading", { name: "Hub" });
    expect(
      toggle.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
    expect(container.querySelector(".surface-topbar__trailing")!.contains(toggle)).toBe(true);
    expect(container.querySelector(".surface-topbar__leading")).toBeNull();
  });

  it("the dock icon reads the side", () => {
    const { container, unmount } = render(<Harness side="left" />);
    const leftHref = container.querySelector(".nt-icon use")!.getAttribute("href");
    unmount();
    render(<Harness side="right" />);
    const rightHref = document.querySelector(".nt-icon use")!.getAttribute("href");
    expect(leftHref).toContain("dock-left");
    expect(rightHref).toContain("dock-right");
  });

  it("the panel aside carries the host register + landmark, and null while closed", () => {
    function Closed() {
      const { panel } = useSidePanel({
        side: "right",
        open: false,
        onToggle: () => {},
        label: "test panel",
        className: "host-panel-register",
        children: <p>panel body</p>,
      });
      return <>{panel}</>;
    }
    const open = render(
      <Harness side="right" />,
    );
    const aside = open.container.querySelector("aside.host-panel-register");
    expect(aside).not.toBeNull();
    expect(aside!.getAttribute("aria-label")).toBe("test panel");
    expect(aside!.textContent).toContain("panel body");
    open.unmount();
    const closed = render(<Closed />);
    expect(closed.container.querySelector("aside")).toBeNull();
  });

  it("SidePanelToggle pressed state + label ride the open prop", () => {
    const onToggle = vi.fn();
    render(
      <SidePanelToggle side="right" open={false} onToggle={onToggle} label="details panel" />,
    );
    const toggle = screen.getByRole("button", { name: "Show details panel" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
