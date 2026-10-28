/**
 * The frame-owned body inset + the split panel-toggle placement:
 *
 * - The frame's body row OWNS the outer inset (window/card edge → panel
 *   card), universally: `.nt-main-frame__body` carries the horizontal
 *   padding register — the SAME measure the panelled nodeview's host shell
 *   used to carry per view (`.nt-page--panelled` padding-left/right,
 *   var(--spacing-4)); the calendar had already duplicated that host-side
 *   register (`.calendar-view`), the Sources hub had none at all (the
 *   owner's "I see no gap" screenshot). Hosts must NOT double-pad: the
 *   nodeview's page root keeps the top gap only, the calendar root drops
 *   its copy, and each frame host's top bar carries its own horizontal
 *   inset (the nodeview/calendar two-class overrides) so the bar position
 *   stays pixel-identical while the panels' gap becomes the frame's single
 *   register. The compact (<=768px) stacked adaptation keeps the inset
 *   (the media-query block must not reset the body padding).
 *
 * - The toggle split: the LEFT-panel toggle leads the bar (left of the
 *   title); the RIGHT-panel toggle rides the SurfaceTopBar's `trailing`
 *   slot — the FAR RIGHT END of the bar, after the actions cluster. The
 *   toggle + panel are LINKED at the component level (useSidePanel /
 *   SidePanelToggle, fleet): the side is declared once and the toggle's
 *   slot, dock icon, and pressed state derive from it — the Journal hub's
 *   navigator toggle rides trailing because its panel is the body's right
 *   column (the drift this replaces: the toggle led the bar while the
 *   panel rendered on the right).
 *
 * The CSS assertions read the stylesheets as text (the css-token-drift
 * gate's idiom — jsdom does not compute stylesheet rules), pinning the
 * register ownership; the renders assert the DOM/class membership that
 * makes the inset single (the frame body mediates between the panelled
 * wrapper and the panel cards).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { dayNodeId, SYSTEM_CLASS_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { PageView } from "../src/ui/PageView.js";
import { JournalsView } from "../src/features/calendar/JournalsView.js";
import { SurfaceTopBar } from "../src/components/ui/fleet/SurfaceTopBar.js";

const process_ = process as unknown as { getBuiltinModule(name: string): typeof import("node:fs") };
const fs = process_.getBuiltinModule("node:fs");
const path = process_.getBuiltinModule("node:path") as unknown as typeof import("node:path");

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
});

async function seedClient(): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(new MemoryRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

/** One existing day page — the journal feed (and its panel column) renders only when a day page exists. */
async function createDayPage(client: WorkspaceClient): Promise<void> {
  const now = new Date();
  const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  await client.createObject({
    id: dayNodeId(iso),
    isEmbedded: false,
    parentId: null,
    name: iso.replace(/-/g, ""),
    classIds: [SYSTEM_CLASS_UUIDS.day],
  });
}

function readCss(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), "src", rel), "utf8");
}

/**
 * Every declaration block of a rule whose selector list contains the exact
 * selector (media-query-nested rules included — the caller distinguishes
 * the base rule from the compact adaptation by index).
 */
function ruleBlocks(css: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("(?:^|[}\\n])\\s*" + escaped + "\\s*\\{([^}]*)\\}", "g");
  const blocks: string[] = [];
  for (const match of css.matchAll(re)) blocks.push(match[1]!);
  return blocks;
}

/** The whitespace-normalized value of a declaration, or null when absent. */
function declaration(block: string, prop: string): string | null {
  // Blocks are single-property-per-line in these registers.
  for (const line of block.split("\n")) {
    const m = line.match(new RegExp("^\\s*" + prop + "\\s*:\\s*([^;]+);\\s*$"));
    if (m) return m[1]!.trim().replace(/\s+/g, " ");
  }
  return null;
}

describe("the frame owns the outer body inset (CSS registers)", () => {
  it(".nt-main-frame__body carries the horizontal inset — the nodeview's former host measure, var(--spacing-4)", () => {
    const css = readCss("ui/MainContentFrame.css");
    const blocks = ruleBlocks(css, ".nt-main-frame__body");
    expect(blocks.length).toBeGreaterThanOrEqual(2); // base + compact adaptation
    const base = blocks[0]!;
    expect(declaration(base, "padding")).toBe("0 var(--spacing-4)");
    // The inter-column gap survives untouched.
    expect(declaration(base, "gap")).toBe("var(--spacing-4)");
  });

  it("the compact (<=768px) stacked adaptation keeps the inset (no padding reset)", () => {
    const css = readCss("ui/MainContentFrame.css");
    const media = css.match(/@media \(width <= 768px\) \{([\s\S]*?)\n\}/);
    expect(media).not.toBeNull();
    const blocks = ruleBlocks(media![1]!, ".nt-main-frame__body");
    expect(blocks.length).toBe(1);
    expect(declaration(blocks[0]!, "padding")).toBeNull();
    expect(declaration(blocks[0]!, "flex-direction")).toBe("column");
  });

  it("the nodeview's page root no longer double-pads: top gap only, horizontal retired", () => {
    const css = readCss("ui/app/PanelLayout.css");
    const blocks = ruleBlocks(css, ".nt-page--panelled");
    expect(blocks.length).toBe(1);
    // Was `var(--spacing-2) var(--spacing-4) 0` — the horizontal inset
    // moved to the frame body; the root carries the bar's top gap only.
    expect(declaration(blocks[0]!, "padding")).toBe("var(--spacing-2) 0 0");
  });

  it("the nodeview top bar carries its own horizontal inset (the override), pixel-identical to the retired host padding", () => {
    const css = readCss("ui/app/PanelLayout.css");
    const blocks = ruleBlocks(css, ".surface-topbar.nt-node-topbar");
    expect(blocks.length).toBe(1);
    // The top padding retired (the host root's spacing-2
    // carries the top gap alone — the stacked pair read as double); the
    // bottom is spacing-2 + the bar's spacing-2 margin around the hairline.
    expect(declaration(blocks[0]!, "padding")).toBe(
      "0 var(--spacing-4) var(--spacing-2)",
    );
  });

  it("the calendar root drops its duplicated copy; its bar carries the inset instead", () => {
    const css = readCss("features/calendar/CalendarView.css");
    const rootBlocks = ruleBlocks(css, ".calendar-view");
    expect(rootBlocks.length).toBe(1);
    expect(declaration(rootBlocks[0]!, "padding")).toBe("0");
    const barBlocks = ruleBlocks(css, ".surface-topbar.calendar-view__topbar");
    expect(barBlocks.length).toBe(1);
    expect(declaration(barBlocks[0]!, "padding-left")).toBe("var(--spacing-4)");
    expect(declaration(barBlocks[0]!, "padding-right")).toBe("var(--spacing-4)");
  });

  it("the SurfaceTopBar base vertical rhythm: chrome-hugging top, real gap above the divider", () => {
    const css = readCss("components/ui/fleet/SurfaceTopBar.css");
    const blocks = ruleBlocks(css, ".surface-topbar");
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    // Tightened (was spacing-2 / spacing-3 — the bar is
    // chrome and hugs its content; hosts with their own top gap zero the
    // top in their override).
    expect(declaration(blocks[0]!, "padding")).toBe(
      "var(--spacing-1) var(--spacing-6) var(--spacing-2)",
    );
  });

  it("the Sources hub bar carries the frame's inset measure (the two-class override)", () => {
    const css = readCss("features/sources/SourcesHub.css");
    const blocks = ruleBlocks(css, ".surface-topbar.sources-hub__topbar");
    expect(blocks.length).toBe(1);
    expect(declaration(blocks[0]!, "padding-left")).toBe("var(--spacing-4)");
    expect(declaration(blocks[0]!, "padding-right")).toBe("var(--spacing-4)");
  });
});

describe("the frame mediates the panelled nodeview's inset (render)", () => {
  it("the panelled wrapper hosts the frame; the frame body sits between the wrapper and both panel cards", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Doc" });

    const { container } = render(<PageView client={client} pageId={pageId} />);

    // The outer wrapper: the panelled page root — host-side padding retired
    // (the CSS register above pins it to the top gap only).
    const wrapper = container.querySelector(".nt-page--panelled");
    expect(wrapper).not.toBeNull();
    // The frame root + the inset-owning body row render between the wrapper
    // and the raised-card panels — one inset authority, no host copy.
    const frame = wrapper!.querySelector(".nt-main-frame");
    expect(frame).not.toBeNull();
    const body = frame!.querySelector(".nt-main-frame__body");
    expect(body).not.toBeNull();
    expect(body!.querySelector(".nt-page-context")).not.toBeNull();
    expect(body!.querySelector(".nt-page-side-panel")).not.toBeNull();
  });
});

describe("the toggle split", () => {
  it("SurfaceTopBar renders `trailing` after `actions`, at the bar's far right end; absent renders nothing", () => {
    const { container, rerender } = render(
      <SurfaceTopBar
        title="Hub"
        leading={<button data-testid="leading-toggle" aria-label="Left panel" />}
        actions={<button data-testid="action" aria-label="Search" />}
        trailing={<button data-testid="right-toggle" aria-label="Right panel" />}
      />,
    );
    const bar = container.querySelector(".surface-topbar")!;
    const order = (a: HTMLElement | null, b: HTMLElement | null) =>
      (a!.compareDocumentPosition(b!) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    const leadingToggle = screen.getByTestId("leading-toggle");
    const heading = screen.getByRole("heading", { name: "Hub" });
    const action = screen.getByTestId("action");
    const rightToggle = screen.getByTestId("right-toggle");
    expect(order(leadingToggle, heading)).toBe(true);
    expect(order(heading, action)).toBe(true);
    expect(order(action, rightToggle)).toBe(true);
    expect(bar.lastElementChild!.contains(rightToggle)).toBe(true);

    // Additive slot: without `trailing` no trailing cluster renders and the
    // actions stay the bar's last cluster (no existing bar's layout shifts).
    rerender(
      <SurfaceTopBar
        title="Hub"
        actions={<button data-testid="action" aria-label="Search" />}
      />,
    );
    expect(container.querySelector(".surface-topbar__trailing")).toBeNull();
    expect(
      container.querySelector(".surface-topbar")!.lastElementChild!.classList.contains(
        "surface-topbar__actions",
      ),
    ).toBe(true);
  });

  it("Journal's navigator toggle rides the TRAILING cluster — the panel is the right column (useSidePanel links the two)", async () => {
    const client = await seedClient();
    await createDayPage(client);
    const { container } = render(
      <JournalsView client={client} onOpenPage={() => {}} />,
    );
    const heading = screen.getByRole("heading", { name: "Journal" });
    const toggle = screen.getByRole("button", { name: "Hide navigator panel" });
    // The toggle sits in the far-right cluster, AFTER the title (the linked
    // useSidePanel unit places it on the panel's own side).
    expect(
      toggle.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
    const trailing = container.querySelector(".surface-topbar__trailing");
    expect(trailing).not.toBeNull();
    expect(trailing!.contains(toggle)).toBe(true);
    // The dock icon renders the side (the sprite-sheet use href, no inline path).
    expect(toggle.querySelector(".nt-icon use")?.getAttribute("href")).toContain("dock-right");
    // The panel it drives renders in the body (right column register).
    expect(container.querySelector(".journals-panel")).not.toBeNull();
  });

  it("collapsing from the toggle drops the panel and flips the label (the linked unit)", async () => {
    const client = await seedClient();
    await createDayPage(client);
    const { container } = render(
      <JournalsView client={client} onOpenPage={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Hide navigator panel" }));
    expect(container.querySelector(".journals-panel")).toBeNull();
    expect(screen.getByRole("button", { name: "Show navigator panel" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Show navigator panel" }));
    expect(container.querySelector(".journals-panel")).not.toBeNull();
  });
});
