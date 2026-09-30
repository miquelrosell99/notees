/**
 * CalendarPopup tests: days grid highlights today and existing day pages,
 * day/month/year picks call the right callbacks, and the zoom switch moves
 * between grids. The popup renders fixed-position; positioning comes from
 * useViewportFlip, which returns null under jsdom (no layout) — the popup
 * stays hidden but fully interactive.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useRef } from "react";

import { dayNodeId } from "@notees/domain";

import { CalendarPopup } from "../src/ui/components/ui/CalendarPopup.js";

const noop = () => {};

function CalendarHarness(props: Partial<Parameters<typeof CalendarPopup>[0]>) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  return (
    <div>
      <button type="button" ref={anchorRef}>
        anchor
      </button>
      <CalendarPopup
        isOpen
        onClose={noop}
        anchorRef={anchorRef}
        hasNote={() => false}
        onSelectDay={noop}
        onSelectMonth={noop}
        onSelectYear={noop}
        {...props}
      />
    </div>
  );
}

function renderPopup(overrides: Partial<Parameters<typeof CalendarPopup>[0]> = {}) {
  return render(<CalendarHarness {...overrides} />);
}

describe("CalendarPopup", () => {
  afterEach(() => vi.restoreAllMocks());

  it("marks today and existing day pages", () => {
    const today = new Date();
    const { container } = renderPopup({ hasNote: (iso) => iso.endsWith("-01") });

    const dialog = screen.getByRole("dialog", { name: "Calendar" });
    const todayButton = dialog.querySelector(".calendar-day.today");
    expect(todayButton).not.toBeNull();
    expect(todayButton?.getAttribute("aria-label")).toContain(String(today.getFullYear()));
    // hasNote flags the 1st of the visible month.
    const noted = dialog.querySelector(".calendar-day.has-note");
    expect(noted).not.toBeNull();
    expect(noted?.textContent?.trim()).toBe("1");
  });

  it("calls onSelectDay with the picked local ISO date", () => {
    const onSelectDay = vi.fn();
    const { container } = renderPopup({ onSelectDay });
    const dialog = screen.getByRole("dialog", { name: "Calendar" });
    // Pick the 20th of the visible month (button text = day number).
    const target = Array.from(dialog.querySelectorAll(".calendar-day")).find(
      (el) => el.textContent?.trim() === "20",
    );
    expect(target).not.toBeUndefined();
    fireEvent.click(target!);
    const now = new Date();
    expect(onSelectDay).toHaveBeenCalledWith(
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-20`,
    );
  });

  it("switches to months and years grids and picks from them", () => {
    const onSelectMonth = vi.fn();
    const onSelectYear = vi.fn();
    renderPopup({ onSelectMonth, onSelectYear });
    const dialog = screen.getByRole("dialog", { name: "Calendar" });

    fireEvent.click(within(dialog).getByRole("radio", { name: "Months" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Mar" }));
    const now = new Date();
    expect(onSelectMonth).toHaveBeenCalledWith(now.getFullYear(), 3);

    fireEvent.click(within(dialog).getByRole("radio", { name: "Years" }));
    const yearButton = within(dialog).getByRole("button", { name: "2026" });
    fireEvent.click(yearButton);
    expect(onSelectYear).toHaveBeenCalledWith(2026);
  });

  it("navigates periods with previous/next", () => {
    renderPopup();
    const dialog = screen.getByRole("dialog", { name: "Calendar" });
    const now = new Date();
    const monthLabel = dialog.querySelector(".calendar-title-btn--month");
    expect(monthLabel?.textContent).toBe(
      ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][
        now.getMonth()
      ],
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Next period" }));
    expect(dialog.querySelector(".calendar-title-btn--month")?.textContent).toBe(
      ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][
        (now.getMonth() + 1) % 12
      ],
    );
  });
});
