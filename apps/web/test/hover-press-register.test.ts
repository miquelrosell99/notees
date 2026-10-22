/**
 * The drift-sweep alignment slices (2026-10-16) — CSS-source pins for the
 * hover/press/hit-area register, the §7 list-row register, the §8
 * range-syntax media queries across the palette, the hub rows, the settings
 * accents, and the two JS matchMedia call sites, plus the final six-note
 * closure (token literals, the badge radius, the control-width family, the
 * journals hover register, the calendar grid arity, the empty states
 * composing the kit EmptyState). jsdom applies no layout — the contracts
 * are asserted at the source level (the css-token-drift pattern). The hover
 * register is FLEET-STANDARD (foundations.md §4): hover is the
 * hover-overlay everywhere; primary-container is selected/active only, and
 * already-active controls keep their active fill while hovered (combined
 * `--active, --active:hover` rules).
 */

import { describe, expect, it } from "vitest";

const process_ = process as unknown as {
  getBuiltinModule(name: string): typeof import("node:fs");
};
const fs = process_.getBuiltinModule("node:fs");
const path = process_.getBuiltinModule("node:path") as unknown as typeof import("node:path");

function readCss(...segments: string[]): string {
  return fs.readFileSync(path.join(process.cwd(), "src", ...segments), "utf8");
}

const OVERLAY_WIDTH = "width: max(100%, var(--button-min-height))";
const OVERLAY_HEIGHT = "height: max(100%, var(--button-min-height))";

function expectHitAreaOverlay(css: string, selector: string): void {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const base = new RegExp(`${escaped} \\{[^}]*position: relative[^}]*\\}`).exec(css);
  expect(base, `${selector} positions the overlay`).not.toBeNull();
  const overlay = new RegExp(`${escaped}::after \\{[^}]*\\}`).exec(css);
  expect(overlay, `${selector}::after`).not.toBeNull();
  expect(overlay![0]).toContain(OVERLAY_WIDTH);
  expect(overlay![0]).toContain(OVERLAY_HEIGHT);
  expect(overlay![0]).toContain("pointer-events: auto");
}

const paletteCss = readCss("features", "command-palette", "CommandPalette.css");
const commentsCss = readCss("features", "page-sections", "CommentsSection.css");
const trashCss = readCss("features", "trash", "TrashHub.css");
const taskBucketsCss = readCss("features", "classview", "TaskBuckets.css");
const calendarViewCss = readCss("features", "calendar", "CalendarView.css");
const settingsPageCss = readCss("features", "settings", "SettingsPage.css");
const settingsModalCss = readCss("features", "settings", "settingsModal.css");
const journalsCss = readCss("features", "calendar", "JournalsView.css");

describe("command palette rows: the cursor is a genuine active state", () => {
  it("plain hover rides the hover overlay; the combined active rule keeps primary-container", () => {
    const hover = /\.nt-palette-item:hover \{[^}]*\}/.exec(paletteCss);
    expect(hover).not.toBeNull();
    expect(hover![0]).toContain("background: var(--md-sys-color-hover-overlay)");
    const active =
      /\.nt-palette-item\[data-active="true"\],\s*\.nt-palette-item\[data-active="true"\]:hover \{[^}]*\}/.exec(
        paletteCss,
      );
    expect(active).not.toBeNull();
    expect(active![0]).toContain("background: var(--md-sys-color-primary-container)");
    expect(active![0]).toContain("color: var(--md-sys-color-on-primary-container)");
  });

  it("the palette row carries the pressed layer", () => {
    const pressed = /\.nt-palette-item:active \{[^}]*\}/.exec(paletteCss);
    expect(pressed).not.toBeNull();
    expect(pressed![0]).toContain("background: var(--md-sys-color-pressed-overlay)");
  });
});

describe("compact hub actions reach the 48px floor and press", () => {
  it("the comments Reply/Delete actions: invisible overlay + pressed layer", () => {
    expectHitAreaOverlay(commentsCss, ".nt-comments__action");
    const pressed = /\.nt-comments__action:active \{[^}]*\}/.exec(commentsCss);
    expect(pressed).not.toBeNull();
    expect(pressed![0]).toContain("background: var(--md-sys-color-pressed-overlay)");
  });

  it("the trash restore/delete-permanently actions: invisible overlay + pressed layer", () => {
    expectHitAreaOverlay(trashCss, ".nt-trash-hub__action");
    const pressed = /\.nt-trash-hub__action:active \{[^}]*\}/.exec(trashCss);
    expect(pressed).not.toBeNull();
    expect(pressed![0]).toContain("background: var(--md-sys-color-pressed-overlay)");
  });
});

describe("hub/list row names ride the §7 list-row register", () => {
  it("task bucket rows: primary 14px/600, the single-line ellipsis contract kept", () => {
    const name = /\.task-buckets__row-name \{[^}]*\}/.exec(taskBucketsCss);
    expect(name).not.toBeNull();
    expect(name![0]).toContain("font-weight: 600");
    expect(name![0]).toContain("text-overflow: ellipsis");
    expect(name![0]).toContain("white-space: nowrap");
    const day = /\.task-buckets__row-day \{[^}]*\}/.exec(taskBucketsCss);
    expect(day).not.toBeNull();
    expect(day![0]).toContain("font-size: var(--font-size-sm)");
    expect(day![0]).toContain("var(--md-sys-color-on-surface-variant)");
  });

  it("calendar view rows: primary 14px/600, the single-line ellipsis contract kept", () => {
    // The ^ anchor keeps the variant rules
    // (.calendar-view__row--overdue .calendar-view__row-name) from matching.
    const name = /^\.calendar-view__row-name \{[^}]*\}/m.exec(calendarViewCss);
    expect(name).not.toBeNull();
    expect(name![0]).toContain("font-weight: 600");
    expect(name![0]).toContain("text-overflow: ellipsis");
    expect(name![0]).toContain("white-space: nowrap");
    const day = /^\.calendar-view__row-day \{[^}]*\}/m.exec(calendarViewCss);
    expect(day).not.toBeNull();
    expect(day![0]).toContain("font-size: var(--font-size-sm)");
    expect(day![0]).toContain("var(--md-sys-color-on-surface-variant)");
  });

  it("trash hub rows: the name joins the register at 14px/600", () => {
    const name = /\.nt-trash-hub__name \{[^}]*\}/.exec(trashCss);
    expect(name).not.toBeNull();
    expect(name![0]).toContain("font-size: var(--font-size-base)");
    expect(name![0]).toContain("font-weight: 600");
    expect(name![0]).toContain("text-overflow: ellipsis");
    const stamp = /\.nt-trash-hub__stamp \{[^}]*\}/.exec(trashCss);
    expect(stamp).not.toBeNull();
    expect(stamp![0]).toContain("font-size: var(--font-size-sm)");
    expect(stamp![0]).toContain("var(--md-sys-color-on-surface-variant)");
  });
});

describe("custom buttons carry the pressed layer (skill §6 tactile press)", () => {
  it("the journals Today button composes the kit Button — no custom pill (owner 2026-10-22)", () => {
    // The hand-rolled .journals-view__today-btn retired with the hub-surface
    // restructure: Today is a fleet ghost Button inside the SurfaceTopBar's
    // actions cluster now. Its pressed register lives in the kit Button —
    // pinned at the source by the empty-state CTA test below — so the view
    // CSS must carry no today-button rule of its own.
    expect(journalsCss).not.toMatch(/\.journals-view__today-btn/);
    const journalsSrc = fs.readFileSync(
      path.join(process.cwd(), "src", "features", "calendar", "JournalsView.tsx"),
      "utf8",
    );
    expect(journalsSrc).toContain('variant="ghost"');
    expect(journalsSrc).toContain("scrollToToday");
  });

  it("the journals empty state composes the kit EmptyState — the CTA register lives in the kit Button", () => {
    // The hand-rolled .journals-empty__action retired with the composition;
    // the CTA is the kit primary Button, whose pressed register is pinned
    // here as the single source of truth. The register lives in the Button
    // wrapper's variant classes since the shadcn-catalog migration
    // (Button.css retired 2026-10-19).
    expect(journalsCss).not.toMatch(/\.journals-empty__action/);
    const buttonSrc = fs.readFileSync(
      path.join(process.cwd(), "src", "components", "ui", "fleet", "Button.tsx"),
      "utf8",
    );
    expect(buttonSrc).toContain("active:bg-primary-pressed");
    const tailwindConfig = fs.readFileSync(
      path.join(process.cwd(), "tailwind.config.ts"),
      "utf8",
    );
    expect(tailwindConfig).toContain('role("primary-pressed")');
  });

  it("the settings theme buttons press with the overlay, before the active register", () => {
    const pressed = /\.settings-theme-btn:active \{[^}]*\}/.exec(settingsModalCss);
    expect(pressed).not.toBeNull();
    expect(pressed![0]).toContain("background: var(--md-sys-color-pressed-overlay)");
    // The active theme button keeps its container fill when pressed.
    expect(settingsModalCss.indexOf(".settings-theme-btn:active")).toBeLessThan(
      settingsModalCss.indexOf(".settings-theme-btn--active"),
    );
  });
});

describe("settings accents: state layers, not hover-scale", () => {
  it("the swatch has no hover-scale — feedback rides the state-layer overlay", () => {
    expect(settingsPageCss).not.toMatch(/\.settings-accent-swatch:hover \{\s*transform: scale/);
    // Hover + press share one combined overlay rule (the ::after rides the
    // inline accent fill).
    const overlay =
      /\.settings-accent-swatch:hover::after,\s*\.settings-accent-swatch:active::after \{[^}]*\}/.exec(
        settingsPageCss,
      );
    expect(overlay).not.toBeNull();
    expect(overlay![0]).toContain("opacity: 1");
    const base = /^\.settings-accent-swatch::after \{[^}]*\}/m.exec(settingsPageCss);
    expect(base).not.toBeNull();
    expect(base![0]).toContain("background: var(--md-sys-color-hover-overlay)");
    const pressed =
      /\.settings-accent-swatch:active::after \{[^}]*background: var\(--md-sys-color-pressed-overlay\)[^}]*\}/.exec(
        settingsPageCss,
      );
    expect(pressed).not.toBeNull();
  });

  it("the selected register survives: border + ring on the active swatch", () => {
    const active = /\.settings-accent-swatch--active \{[^}]*\}/.exec(settingsPageCss);
    expect(active).not.toBeNull();
    expect(active![0]).toContain("border-color: var(--md-sys-color-primary)");
  });
});

describe("media queries ride the range syntax (skill §8 — no legacy min/max-width)", () => {
  const overlayHooksSrc = readCss("components", "ui", "fleet", "overlay-hooks.ts");
  const appSrc = readCss("ui", "App.tsx");

  it("useIsMobile builds range-syntax queries from the token breakpoint", () => {
    expect(overlayHooksSrc).toContain("window.matchMedia(`(width <= ${getMobileBreakpoint()}px)`)");
    expect(overlayHooksSrc).not.toContain("(max-width:");
  });

  it("the sidebar open-by-default gate keeps its deliberate 801px threshold in range syntax", () => {
    expect(appSrc).toContain('window.matchMedia("(width >= 801px)")');
    expect(appSrc).not.toContain("(min-width:");
    // 801px is a deliberate non-register threshold — behavior preservation
    // over breakpoint purity (noted at the call site).
    expect(appSrc).toMatch(/non-register threshold/);
  });
});

describe("token citations", () => {
  it("the shortcuts group title cites --letter-spacing-section", () => {
    const title = /\.settings-shortcuts__group-title \{[^}]*\}/.exec(settingsModalCss);
    expect(title).not.toBeNull();
    expect(title![0]).toContain("letter-spacing: var(--letter-spacing-section)");
    expect(title![0]).not.toContain("letter-spacing: 0.08em");
  });
});

describe("the final sweep notes close (2026-10-16)", () => {
  const monthCalendarCss = readCss("features", "calendar", "MonthCalendar.css");
  const journalsSrc = readCss("features", "calendar", "JournalsView.tsx");
  const trashSrc = readCss("features", "trash", "TrashHub.tsx");

  it("the palette row gap cites the micro spacing token (no magic literal)", () => {
    const item = /\.nt-palette-item \{[^}]*\}/.exec(paletteCss);
    expect(item).not.toBeNull();
    expect(item![0]).toContain("gap: var(--spacing-micro)");
  });

  it("the month/year picker grids keep their deliberate fixed arity", () => {
    const months = /\.month-calendar__grid--months \{[^}]*\}/.exec(monthCalendarCss);
    const years = /\.month-calendar__grid--years \{[^}]*\}/.exec(monthCalendarCss);
    expect(months).not.toBeNull();
    expect(months![0]).toContain("repeat(4, 1fr)");
    expect(years).not.toBeNull();
    expect(years![0]).toContain("repeat(3, 1fr)");
  });

  it("the embedded feed title is a plain heading — no hover overlay, no pointer cursor", () => {
    // Owner 2026-10-22: the feed title stopped being a navigation link;
    // the hover register rides the explicit "Open page" ghost button
    // (the kit Button's own overlay), not the headline.
    expect(/\.nt-page-title-link/.test(journalsCss)).toBe(false);
    const text = /\.nt-page-title-embed__text \{[^}]*\}/.exec(journalsCss);
    expect(text).not.toBeNull();
    expect(text![0]).toContain("font: var(--font-headline-medium)");
    expect(text![0]).not.toContain("cursor");
    // The heading itself never hovers; the title ROW is the hover target
    // for the button reveal below.
    const hover = /\.nt-page-title-embed(?!_)[^{]*:hover/.exec(journalsCss);
    expect(hover).toBeNull();
  });

  it("the embedded Open-page button reveals on title-row hover (fine pointers only)", () => {
    // Owner 2026-10-22 follow-up: hidden at rest so the feed stays clean;
    // the wrap spans the row's free width, so hovering the words OR the
    // space beside them reveals it. Opacity (not visibility) keeps the
    // hidden button in the tab order — focus-within reveals it — and touch
    // devices (no hover) keep it always visible.
    expect(journalsCss).toContain("@media (hover: hover) and (pointer: fine)");
    expect(journalsCss).toContain(".nt-page-title-wrap:hover .nt-page-title-embed__open");
    expect(journalsCss).toContain(".nt-page-title-wrap:focus-within .nt-page-title-embed__open");
    const rest = /\.nt-page-title-embed__open \{[^}]*\}/.exec(journalsCss);
    expect(rest).not.toBeNull();
    expect(rest![0]).toContain("opacity: 0");
    expect(rest![0]).toContain("transition: opacity");
  });

  it("the settings badge rides the §7 tag/badge radius tier (the kit Badge's --shape-large)", () => {
    const badge = /\.settings-badge \{[^}]*\}/.exec(settingsModalCss);
    expect(badge).not.toBeNull();
    expect(badge![0]).toContain("border-radius: var(--shape-large)");
    expect(badge![0]).not.toContain("--shape-full");
  });

  it("the retention-days input width rides the layout-size family, not the spacing scale", () => {
    const input = /\.retention-days-input \{[^}]*\}/.exec(settingsModalCss);
    expect(input).not.toBeNull();
    expect(input![0]).toContain("width: var(--layout-size-2xs)");
    expect(input![0]).not.toContain("--spacing-16");
  });

  it("journals and trash compose the kit EmptyState — the local empty CSS is dead", () => {
    // Journals: the EmptyState carries the sentence-as-title + the CTA;
    // the local stylesheet keeps only the flex-1 feed anchor.
    expect(journalsSrc).toContain('from "../../components/ui/fleet/EmptyState.js"');
    expect(journalsSrc).toContain("Open today");
    expect(/\.journals-empty \{\s*flex: 1;\s*\}/.test(journalsCss)).toBe(true);
    // Trash: the icon/title/description map onto the kit; the hand-rolled
    // empty block and its styles are gone.
    expect(trashSrc).toContain('from "../../components/ui/fleet/EmptyState.js"');
    expect(trashSrc).toContain("Trash is empty.");
    expect(trashCss).not.toMatch(/nt-trash-hub__empty/);
  });
});
