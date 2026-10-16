/**
 * Calendar hit-area floor (owner ruling 2026-10-16, the 100%-alignment
 * program): every calendar cell — the shared day grid (top-bar popup +
 * MonthCalendar panel), the WeekStrip, the month/year picks — keeps its
 * visible grid geometry EXACTLY as-is and reaches the skill's 44×44 touch
 * floor through the invisible ::after hit-area overlay (the pattern the
 * icon-only button established; skill web-patterns.md → "Invisible hit-area
 * overlay"). The dated dot moved from `.dated::after` to a real span so the
 * overlay owns the pseudo-element. jsdom applies no layout — the contract
 * is asserted at the CSS-source level (the css-token-drift pattern).
 */

import { describe, expect, it } from "vitest";

const process_ = process as unknown as {
  getBuiltinModule(name: string): typeof import("node:fs");
};
const fs = process_.getBuiltinModule("node:fs");
const path = process_.getBuiltinModule("node:path") as unknown as typeof import("node:path");

function readCss(...segments: string[]): string {
  return fs.readFileSync(path.join(process.cwd(), "src", "ui", ...segments), "utf8");
}

const OVERLAY_WIDTH = "width: max(100%, var(--button-min-height))";
const OVERLAY_HEIGHT = "height: max(100%, var(--button-min-height))";

function expectOverlay(css: string, selector: string): void {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = new RegExp(`${escaped}::after \\{[^}]*\\}`).exec(css);
  expect(rule, `${selector}::after`).not.toBeNull();
  expect(rule![0]).toContain(OVERLAY_WIDTH);
  expect(rule![0]).toContain(OVERLAY_HEIGHT);
  expect(rule![0]).toContain("pointer-events: auto");
}

const gridCss = readCss("components", "ui", "calendar", "calendar-grid.css");
const stripCss = readCss("components", "ui", "calendar", "WeekStrip.css");
const monthCss = readCss("components", "ui", "calendar", "MonthCalendar.css");
const popupCss = readCss("components", "ui", "CalendarPopup.css");

describe("calendar cells carry the 44px invisible hit-area overlay", () => {
  it("the shared day grid: visible disc rides the grid, ::after reaches 44px", () => {
    // Visible geometry untouched — the cell still sizes from the grid.
    const cell = /\.calendar-day\.btn \{[^}]*\}/.exec(gridCss);
    expect(cell).not.toBeNull();
    expect(cell![0]).toContain("aspect-ratio: 1");
    expect(cell![0]).toContain("min-width: 0");
    expect(cell![0]).toContain("min-height: 0");
    expectOverlay(gridCss, ".calendar-day.btn");
  });

  it("the dated dot is a real span — the overlay owns ::after", () => {
    expect(gridCss).toContain(".calendar-day__dot");
    expect(gridCss).not.toContain(".calendar-day.btn.dated::after");
    // The today-variant recolor moved with the dot.
    expect(gridCss).toContain(".calendar-day.btn.today .calendar-day__dot");
  });

  it("the WeekStrip cells carry the same overlay contract", () => {
    expectOverlay(stripCss, ".week-strip__day.btn");
    expect(stripCss).toContain(".week-strip__dot");
    expect(stripCss).not.toContain(".week-strip__day.dated::after");
  });

  it("the MonthCalendar month/year picks carry the overlay", () => {
    const pick = /\.month-calendar__pick\.btn \{[^}]*\}/.exec(monthCss);
    expect(pick).not.toBeNull();
    expect(pick![0]).toContain("position: relative");
    expectOverlay(monthCss, ".month-calendar__pick.btn");
  });

  it("the popup + datepicker month/year picks carry the overlay", () => {
    expect(popupCss).toMatch(/\.calendar-month\.btn,\s*\.calendar-year-pick\.btn \{[^}]*position: relative/s);
    // The overlay is one combined rule for both pick families.
    const overlay = /\.calendar-month\.btn::after,\s*\.calendar-year-pick\.btn::after \{[^}]*\}/.exec(popupCss);
    expect(overlay).not.toBeNull();
    expect(overlay![0]).toContain(OVERLAY_WIDTH);
    expect(overlay![0]).toContain(OVERLAY_HEIGHT);
    expect(overlay![0]).toContain("pointer-events: auto");
  });
});
