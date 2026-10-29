/**
 * MoreActions — the toolbar's secondary-action overflow (the kit component):
 * a "⋮ More actions" ghost button whose anchored panel lists the secondary
 * items (the SelectionButton tier vocabulary for bar actions: primary rides
 * inline, secondary rides this panel). The spec: empty items render NOTHING
 * (a host with no secondary actions contributes no chrome); the panel opens
 * on trigger click and lists icon + label rows; a row click closes the panel
 * and fires the item's onSelect; disabled items stay disabled.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { MoreActions, type MoreActionsItem } from "../src/components/ui/kit/index.js";

const ITEMS: MoreActionsItem[] = [
  { id: "export", icon: "mdi mdi-download", label: "Export results", onSelect: vi.fn() },
  { id: "archive", icon: "mdi mdi-archive-outline", label: "Archive", disabled: true, onSelect: vi.fn() },
];

describe("MoreActions", () => {
  it("renders nothing when there are no items", () => {
    const { container } = render(<MoreActions items={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("the panel lists the items; a row click closes the panel and selects", () => {
    render(<MoreActions items={ITEMS} />);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));

    const exportRow = screen.getByRole("menuitem", { name: "Export results" });
    const archiveRow = screen.getByRole("menuitem", { name: "Archive" });
    expect(archiveRow).toHaveProperty("disabled", true);

    fireEvent.click(exportRow);
    expect(ITEMS[0]!.onSelect).toHaveBeenCalledTimes(1);
    expect(ITEMS[1]!.onSelect).not.toHaveBeenCalled();
    // The panel closed on select — the rows are gone, the trigger remains.
    expect(screen.queryByRole("menuitem")).toBeNull();
    expect(screen.getByRole("button", { name: "More actions" })).not.toBeNull();
  });
});
