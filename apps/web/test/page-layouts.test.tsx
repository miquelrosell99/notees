/**
 * Page layouts tests, over the in-process WorkspaceClient +
 * MemoryRelay (jsdom):
 *
 *  - View-mode persistence: deviceSettings read/write round-trips, the
 *    page blocks triad + hub modes survive remounts, stale values fall back
 *    to surface defaults, the card cover layout persists per device.
 *  - Page banner: renders above the title from the `cover` property,
 *    absent without one (and on whiteboard pages), collapse persists
 *    device-locally.
 *  - The context column's TOC: derivation (main children + the heading
 *    heuristic + one nesting level) and the section's hide rules.
 *  - Page chrome: the page footer word count + Created/Updated day links,
 *    the unlinked-mentions promote/ignore pair.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";
import { HubView } from "../src/ui/App.js";
import { ensureTaskFamily } from "../src/ui/components/taskFamily.js";
import { ensureCoverProperty } from "../src/ui/components/coverProperty.js";
import { Breadcrumbs } from "../src/ui/components/Breadcrumbs.js";
import { TocSection } from "../src/ui/components/sidebarSections.js";
import { headingTextOf, tocEntriesOf } from "../src/ui/components/sidebarToc.js";
import {
  readCardLayoutPref,
  readIgnoredUnlinkedRefs,
  readViewModePref,
  writeCardLayoutPref,
  writeViewModePref,
} from "../src/ui/viewPrefs.js";
import { DEVICE_SETTINGS_PREFIX } from "../src/ui/components/modals/deviceSettings.js";

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

/** Flush the microtasks an async client write runs on. */
async function flushWrites(): Promise<void> {
  await act(async () => {});
}

// --- L1: view-mode persistence -------------------------------------------------

describe("L1 view-mode persistence (deviceSettings)", () => {
  it("readViewModePref/writeViewModePref round-trip under the device prefix", () => {
    expect(readViewModePref("nodeBlocks.p1", ["outline", "prose", "cards"])).toBeNull();
    writeViewModePref("nodeBlocks.p1", "prose");
    expect(readViewModePref("nodeBlocks.p1", ["outline", "prose", "cards"])).toBe("prose");
    expect(localStorage.getItem(`${DEVICE_SETTINGS_PREFIX}viewMode.nodeBlocks.p1`)).toBe(
      '"prose"',
    );
  });

  it("the retired kanban mode reads back as cards (the board merged into cards)", () => {
    // A device that persisted kanban before the merge (raw legacy value —
    // the typed API no longer accepts it).
    localStorage.setItem(`${DEVICE_SETTINGS_PREFIX}viewMode.hub.x`, '"kanban"');
    // Kanban is cards now — the persisted choice survives as cards.
    expect(readViewModePref("hub.x", ["outline", "cards", "table"])).toBe("cards");
    // A surface that offers no cards mode still falls back to the default.
    expect(readViewModePref("hub.x", ["outline", "table"])).toBeNull();
  });

  it("garbage in localStorage reads as null, never crashes", () => {
    localStorage.setItem(`${DEVICE_SETTINGS_PREFIX}viewMode.hub.y`, "{not json");
    expect(readViewModePref("hub.y", ["table"])).toBeNull();
    localStorage.setItem(`${DEVICE_SETTINGS_PREFIX}viewMode.hub.y`, '"banana"');
    expect(readViewModePref("hub.y", ["table"])).toBeNull();
  });

  it("the page's blocks triad persists device-locally; a fresh page starts at outline", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Persisted Modes" });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "body" }],
    });

    // The switcher lives in the App-level NodeView chrome; its seam is the
    // per-page device preference — write it and the page renders prose.
    const first = render(<PageView client={client} pageId={pageId} />);
    expect(document.querySelector(".nt-block-tree")!.classList.contains("nt-prose")).toBe(false);
    act(() => writeViewModePref(`nodeBlocks.${pageId}`, "prose"));
    expect(document.querySelector(".nt-block-tree")!.classList.contains("nt-prose")).toBe(true);
    first.unmount();

    // Remount: the persisted mode survives…
    render(<PageView client={client} pageId={pageId} />);
    expect(document.querySelector(".nt-block-tree")!.classList.contains("nt-prose")).toBe(true);

    // …and a different page is unaffected (per-page keys).
    const otherId = await client.createObject({ presentAsMain: true, name: "Other Page" });
    await client.createObject({ parentId: otherId, contentAst: [{ type: "text", text: "x" }] });
    cleanup();
    const second = render(<PageView client={client} pageId={otherId} />);
    expect(document.querySelector(".nt-block-tree")!.classList.contains("nt-prose")).toBe(false);
    second.unmount();
  });

  it("hub modes persist per hub and fall back when the offered modes shrink", async () => {
    const client = await seedClient();
    await ensureTaskFamily(client);
    const host = await client.createObject({ presentAsMain: true, name: "Host" });
    const asset = await client.createObject({
      parentId: host,
      contentAst: [{ type: "text", text: "file.pdf" }],
    });
    await client.assignClass(asset, SYSTEM_CLASS_UUIDS.asset);

    const first = render(<HubView client={client} nav="assets" onOpenNode={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: "Table" }));
    first.unmount();

    // Remount: the persisted table mode survives (cards hub renders a grid).
    const second = render(<HubView client={client} nav="assets" onOpenNode={() => {}} />);
    expect(screen.getByRole("table")).not.toBeNull();
    second.unmount();

    // The tasks hub has its own key — table default intact (one member so
    // the hub renders its table rather than the empty state).
    const task = await client.createObject({ presentAsMain: true, name: "Solo Task" });
    await client.assignClass(task, SYSTEM_CLASS_UUIDS.task);
    const third = render(<HubView client={client} nav="tasks" onOpenNode={() => {}} />);
    expect(screen.getByRole("table")).not.toBeNull();
    third.unmount();
  });

  it("the card cover layout persists per device across views", async () => {
    const client = await seedClient();
    const host = await client.createObject({ presentAsMain: true, name: "Host" });
    const asset = await client.createObject({
      parentId: host,
      contentAst: [{ type: "text", text: "photo.png" }],
    });
    await client.assignClass(asset, SYSTEM_CLASS_UUIDS.asset);
    vi.spyOn(client, "getAssetDataUrl").mockResolvedValue("data:image/png;base64,AAAA");

    const first = render(<HubView client={client} nav="assets" onOpenNode={() => {}} />);
    // The hub defaults to cover-top without a persisted choice (re-clicking
    // the active placement is a no-op), so pick a different placement to
    // prove the choice persists across renders — and wins over the fallback.
    fireEvent.click(screen.getByRole("radio", { name: "Cover left" }));
    first.unmount();

    expect(readCardLayoutPref()).toBe("cover-left");
    render(<HubView client={client} nav="assets" onOpenNode={() => {}} />);
    const cover = await screen.findByAltText("");
    expect(cover.closest(".node-card")!.className).toContain("node-card--cover-left");

    // And the device setting round-trips on its own.
    writeCardLayoutPref("no-cover");
    expect(readCardLayoutPref()).toBe("no-cover");
  });
});

// --- L2: page banner --------------------------------------------------------------

describe("L2 page banner", () => {
  /** A source-classed page with the cover property pointing at an asset. */
  async function seedCoveredPage(client: WorkspaceClient): Promise<string> {
    await ensureCoverProperty(client);
    const host = await client.createObject({ presentAsMain: true, name: "Assets" });
    const asset = await client.createObject({
      parentId: host,
      contentAst: [{ type: "text", text: "cover.png" }],
    });
    await client.assignClass(asset, SYSTEM_CLASS_UUIDS.asset);
    const pageId = await client.createObject({ presentAsMain: true, name: "Covered" });
    await client.assignClass(pageId, SYSTEM_CLASS_UUIDS.source);
    await client.setProperty(pageId, SYSTEM_PROPERTY_UUIDS.cover, { nodeId: asset }, 0);
    return pageId;
  }

  it("renders the cover as the right-side header card; the empty element shows collapsed", async () => {
    const client = await seedClient();
    vi.spyOn(client, "getAssetDataUrl").mockResolvedValue("data:image/png;base64,BBBB");
    const coveredId = await seedCoveredPage(client);
    const plainId = await client.createObject({ presentAsMain: true, name: "Plain Page" });

    const { container, unmount } = render(<PageView client={client} pageId={coveredId} />);
    // A set cover auto-expands the card; the image rides inside.
    await screen.findByRole("button", { name: "Collapse cover" });
    const card = container.querySelector(".nt-covercard")!;
    expect(card.querySelector("img")!.getAttribute("src")).toContain("data:image/png");
    // The card sits in the header row's right column, beside the header.
    expect(card.closest(".page-header-section__cover")).not.toBeNull();
    unmount();

    // No cover: the element still renders — collapsed to the chevron.
    render(<PageView client={client} pageId={plainId} />);
    expect(screen.getByRole("button", { name: "Expand cover" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Collapse cover" })).toBeNull();
  });

  it("collapse toggles the card away; the toggle is session-local (no persistence)", async () => {
    const client = await seedClient();
    vi.spyOn(client, "getAssetDataUrl").mockResolvedValue("data:image/png;base64,CCCC");
    const pageId = await seedCoveredPage(client);

    const { unmount } = render(<PageView client={client} pageId={pageId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Collapse cover" }));
    expect(screen.getByRole("button", { name: "Expand cover" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Collapse cover" })).toBeNull();
    unmount();

    // The collapse derives from whether a cover is SET — remounting
    // with a cover re-expands (no per-node persistence).
    render(<PageView client={client} pageId={pageId} />);
    expect(await screen.findByRole("button", { name: "Collapse cover" })).not.toBeNull();
  });

  it("whiteboard pages and embedded entries render no banner", async () => {
    const client = await seedClient();
    vi.spyOn(client, "getAssetDataUrl").mockResolvedValue("data:image/png;base64,DDDD");
    const pageId = await seedCoveredPage(client);
    await client.updateObject(pageId, {
      contentAst: [
        { type: "text", text: "Covered" },
        { type: "whiteboard", layout: {} },
      ],
    });

    render(<PageView client={client} pageId={pageId} />);
    expect(screen.queryByRole("button", { name: /cover image/i })).toBeNull();

    // Strip the whiteboard token; an embedded feed entry still skips it.
    await client.updateObject(pageId, { contentAst: [{ type: "text", text: "Covered" }] });
    const { unmount } = render(<PageView client={client} pageId={pageId} embedded />);
    expect(screen.queryByRole("button", { name: /cover image/i })).toBeNull();
    unmount();
  });

  it("unreadable asset bytes render no banner (honest absence)", async () => {
    const client = await seedClient();
    vi.spyOn(client, "getAssetDataUrl").mockResolvedValue(null);
    const pageId = await seedCoveredPage(client);
    render(<PageView client={client} pageId={pageId} />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: /cover image/i })).toBeNull();
  });
});

// --- L3: sidebar context sections --------------------------------------------------

describe("L3 TOC derivation (sidebarToc)", () => {
  it("headingTextOf: single short text lines qualify; sentences and long lines do not", () => {
    type NodeLike = Parameters<typeof headingTextOf>[0];
    const node = (text: string) => ({ contentAst: [{ type: "text", text }] }) as NodeLike;
    expect(headingTextOf(node("Context"))).toBe("Context");
    expect(headingTextOf(node("  Padded head  "))).toBe("Padded head");
    expect(headingTextOf(node("A sentence, with punctuation."))).toBeNull();
    expect(headingTextOf(node("Asks a question?"))).toBeNull();
    expect(headingTextOf(node("A very long line that goes on and on ".repeat(4)))).toBeNull();
    // Multi-token / non-text content never qualifies.
    expect(
      headingTextOf({
        contentAst: [
          { type: "text", text: "Two" },
          { type: "text", text: "tokens" },
        ],
      } as NodeLike),
    ).toBeNull();
    expect(
      headingTextOf({ contentAst: [{ type: "query", queryAst: {} }] } as unknown as NodeLike),
    ).toBeNull();
  });

  it("entries mix main children and heading-like blocks in child order, one level deep", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Doc" });
    await client.createObject({
      parentId: pageId,
      contentAst: [
        { type: "text", text: "Intro paragraph that is long enough to be a sentence, clearly." },
      ],
    });
    const head = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "Background" }],
    });
    await client.createObject({
      parentId: head,
      contentAst: [{ type: "text", text: "Early work" }],
    });
    await client.createObject({
      parentId: head,
      contentAst: [{ type: "text", text: "A nested sentence, too long to be a head." }],
    });
    const sub = await client.createObject({
      parentId: pageId,
      presentAsMain: true,
      name: "Sub Page",
    });

    const entries = tocEntriesOf(client, pageId);
    expect(entries.map((e) => [e.label, e.depth, e.kind])).toEqual([
      ["Background", 0, "heading"],
      ["Early work", 1, "heading"],
      ["Sub Page", 0, "page"],
    ]);
    expect(entries[2]!.node.id).toBe(sub);
  });

  it("TocSection hides with no entries; highlights and navigates the active one", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Doc" });

    const empty = render(
      <TocSection client={client} pageId={pageId} activeId={null} onOpenNode={() => {}} />,
    );
    expect(empty.container.firstElementChild).toBeNull();
    empty.unmount();

    const head = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "Section One" }],
    });
    const sub = await client.createObject({
      parentId: pageId,
      presentAsMain: true,
      name: "Sub",
    });

    const onOpenNode = vi.fn();
    render(<TocSection client={client} pageId={pageId} activeId={sub} onOpenNode={onOpenNode} />);
    expect(screen.getByText("Contents")).not.toBeNull();
    expect(screen.getByText("Section One")).not.toBeNull();
    // The active main child carries the highlight.
    const activeEntry = screen.getByRole("button", { name: /Sub/ });
    expect(activeEntry.getAttribute("aria-current")).toBe("location");
    expect(activeEntry.closest("li")!.className).toContain("nt-rail-toc__item--active");

    fireEvent.click(screen.getByRole("button", { name: "Section One" }));
    expect(onOpenNode).toHaveBeenCalledWith(head);
    fireEvent.click(activeEntry);
    expect(onOpenNode).toHaveBeenCalledWith(sub);
  });
});

// --- L4: page footer ---------------------------------------------------------------

describe("L4 page footer", () => {
  it("counts words over the title + block tree and links Created/Updated to day pages", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Footer Doc" });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "one two three" }],
    });
    const nested = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "four" }],
    });
    await client.createObject({
      parentId: nested,
      contentAst: [{ type: "text", text: "five six" }],
    });

    const onOpenPage = vi.fn();
    render(<PageView client={client} pageId={pageId} onOpenPage={onOpenPage} />);

    // "Footer Doc" (2) + 3 + 1 + 2 = 8 words.
    expect(screen.getByText("8 words")).not.toBeNull();

    const created = screen.getByRole("button", { name: /^Created / });
    const updated = screen.getByRole("button", { name: /^Updated / });
    expect(created.textContent).toMatch(/Created .+/);
    expect(updated.textContent).toMatch(/Updated .+/);

    fireEvent.click(created);
    await flushWrites();
    expect(onOpenPage).toHaveBeenCalledTimes(1);
    const opened = onOpenPage.mock.calls[0]![0] as string;
    // The opened node is the local-midnight day page of the created stamp.
    expect(client.getNode(opened)!.classIds).toContain(SYSTEM_CLASS_UUIDS.day);
  });

  it("skips the footer in embedded feed entries", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Feed Entry" });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "body words" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} embedded />);
    expect(container.querySelector(".nt-page-footer")).toBeNull();
  });
});

// --- L4: breadcrumb edit gestures --------------------------------------------------

describe("L4 breadcrumb edit gestures", () => {
  it("a parentless page offers '+ Add parent'; the pick writes object.move", async () => {
    const client = await seedClient();
    const parent = await client.createObject({ presentAsMain: true, name: "Parent Page" });
    const child = await client.createObject({ presentAsMain: true, name: "Child Page" });

    render(
      <Breadcrumbs client={client} nodeId={child} onOpenNode={() => {}} showCurrent editable />,
    );
    fireEvent.click(screen.getByRole("button", { name: "+ Add parent" }));
    fireEvent.change(screen.getByLabelText("Search pages…"), { target: { value: "Parent" } });
    await flushWrites();
    fireEvent.click(
      document.querySelector(
        ".node-result-item:not(.node-result-item--create):not(.node-result-item--date)",
      )!,
    );
    await flushWrites();

    expect(client.getNode(child)!.parentId).toBe(parent);
  });

  it("the parent crumb's menu removes it (the child detaches to the root)", async () => {
    const client = await seedClient();
    const parent = await client.createObject({ presentAsMain: true, name: "Parent Page" });
    const child = await client.createObject({
      parentId: parent,
      presentAsMain: true,
      name: "Child Page",
    });

    render(
      <Breadcrumbs client={client} nodeId={child} onOpenNode={() => {}} showCurrent editable />,
    );
    // The edit lives on the PARENT's crumb (the edge below it: the child).
    fireEvent.contextMenu(screen.getByRole("button", { name: "Parent Page" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove parent" }));
    await flushWrites();

    expect(client.getNode(child)!.parentId).toBeNull();
  });

  it("crumbs keep the capped display name for a >80-char title (dense chrome budget)", async () => {
    const client = await seedClient();
    const longTitle = "Crumb ".repeat(20).trimEnd(); // 119 chars — beyond the display-name budget
    const parent = await client.createObject({ presentAsMain: true, name: longTitle });
    const child = await client.createObject({
      parentId: parent,
      presentAsMain: true,
      name: "Child Page",
    });

    const { container } = render(
      <Breadcrumbs client={client} nodeId={child} onOpenNode={() => {}} showCurrent />,
    );
    // The breadcrumb reads the capped display name (80 chars) — and the
    // per-crumb clip tightens it further; the complete title never renders
    // (owner ruling: full titles are for node links, not dense chrome).
    const crumbName = container.querySelector(".node-breadcrumb-name")?.textContent ?? "";
    expect(crumbName.endsWith("…")).toBe(true);
    expect(crumbName).toBe(`${longTitle.slice(0, 27)}…`);
    expect(container.textContent).not.toContain(longTitle);
  });

  it("reassign parent (from the parent crumb) moves the child under the picked page", async () => {
    const client = await seedClient();
    const firstParent = await client.createObject({ presentAsMain: true, name: "First" });
    const secondParent = await client.createObject({ presentAsMain: true, name: "Second" });
    const child = await client.createObject({
      parentId: firstParent,
      presentAsMain: true,
      name: "Child Page",
    });

    render(      <Breadcrumbs client={client} nodeId={child} onOpenNode={() => {}} showCurrent editable />,
    );
    fireEvent.contextMenu(screen.getByRole("button", { name: "First" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Reassign parent…" }));
    fireEvent.change(screen.getByLabelText("Search pages…"), { target: { value: "Second" } });
    await flushWrites();
    fireEvent.click(
      document.querySelector(
        ".node-result-item:not(.node-result-item--create):not(.node-result-item--date)",
      )!,
    );
    await flushWrites();

    expect(client.getNode(child)!.parentId).toBe(secondParent);
  });

  it("owner rule: the self crumb carries no edit button — the parent crumb carries it", async () => {
    const client = await seedClient();
    const parent = await client.createObject({ presentAsMain: true, name: "Parent Page" });
    const child = await client.createObject({
      parentId: parent,
      presentAsMain: true,
      name: "Child Page",
    });

    const { container } = render(
      <Breadcrumbs client={client} nodeId={child} onOpenNode={() => {}} showCurrent editable />,
    );
    // The parent crumb's edit button names the child below (the edge).
    expect(
      screen.getByRole("button", { name: "Edit parent of Child Page" }),
    ).not.toBeNull();
    // Self: no edit affordance at all.
    const self = container.querySelector(".node-breadcrumb-current")!;
    expect(self.querySelector(".node-breadcrumb-edit")).toBeNull();
    // The edge edit opens the parent's menu with Open first.
    fireEvent.click(screen.getByRole("button", { name: "Edit parent of Child Page" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open" }));
    // (Navigation is the host's job; the menu opening at all is the assert.)
  });

  it("nav-only by default: no edit affordances without the editable prop", async () => {
    const client = await seedClient();
    const parent = await client.createObject({ presentAsMain: true, name: "Parent Page" });
    const child = await client.createObject({
      parentId: parent,
      presentAsMain: true,
      name: "Child Page",
    });
    render(<Breadcrumbs client={client} nodeId={child} onOpenNode={() => {}} showCurrent />);
    expect(screen.queryByRole("button", { name: "+ Add parent" })).toBeNull();
    expect(document.querySelector(".node-breadcrumb-edit")).toBeNull();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Parent Page" }));
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("owner rule: a parentless page hides its own crumb — only '+ Add parent' renders", async () => {
    const client = await seedClient();
    const page = await client.createObject({ presentAsMain: true, name: "Lonely Page" });

    const { container } = render(
      <Breadcrumbs client={client} nodeId={page} onOpenNode={() => {}} showCurrent editable />,
    );
    // No self crumb (there is no chain to trail)…
    expect(screen.queryByRole("button", { name: "Lonely Page" })).toBeNull();
    expect(container.querySelector(".node-breadcrumb-current")).toBeNull();
    // …only the Add parent affordance.
    expect(screen.getByRole("button", { name: "+ Add parent" })).not.toBeNull();
  });

  it("owner rule: class nodes render no breadcrumbs at all — no self crumb, no Add parent", async () => {
    const client = await seedClient();
    const classId = await client.createClass("agent");

    const { container } = render(
      <Breadcrumbs client={client} nodeId={classId} onOpenNode={() => {}} showCurrent editable />,
    );
    // Classes are always roots: a parent is unrepresentable, so the whole
    // trail (self + affordance) stays hidden.
    expect(container.querySelector(".node-breadcrumbs")).toBeNull();
    expect(screen.queryByRole("button", { name: "+ Add parent" })).toBeNull();
    expect(screen.queryByRole("button", { name: "agent" })).toBeNull();
  });
});

// --- L4: unlinked references promote/ignore -----------------------------------------

describe("L4 unlinked mentions promote/ignore", () => {
  it("promote rewrites the literal match into a mention (the source becomes linked)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Zebra" });
    const sourceId = await client.createObject({ presentAsMain: true, name: "Plain Source" });
    const blockId = await client.createObject({
      parentId: sourceId,
      contentAst: [{ type: "text", text: "the Zebra runs" }],
    });

    render(<PageView client={client} pageId={pageId} />);
    // The Unlinked mentions tab is lazy: one click activates it.
    fireEvent.click(screen.getByRole("tab", { name: /Unlinked mentions/ }));
    fireEvent.click(screen.getByRole("button", { name: /Promote/ }));
    await flushWrites();

    const block = client.getNode(blockId)!;
    expect(block.contentAst).toEqual([
      { type: "text", text: "the " },
      { type: "mention", targetNodeId: pageId, text: "Zebra" },
      { type: "text", text: " runs" },
    ]);
    // The edge now exists: the source reads as a linked reference.
    expect(
      client.getLinkedReferences(pageId).some((entry) => entry.source.id === blockId),
    ).toBe(true);
  });

  it("ignore dismisses the source device-locally; the dismissed list persists", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Zebra" });
    const sourceId = await client.createObject({ presentAsMain: true, name: "Plain Source" });
    // The unlinked row's source is the matching BLOCK itself.
    const blockId = await client.createObject({
      parentId: sourceId,
      contentAst: [{ type: "text", text: "Zebra" }],
    });

    const { unmount } = render(<PageView client={client} pageId={pageId} />);
    fireEvent.click(screen.getByRole("tab", { name: /Unlinked mentions/ }));
    fireEvent.click(screen.getByRole("button", { name: /Ignore/ }));
    await flushWrites();
    unmount();

    expect(readIgnoredUnlinkedRefs(pageId)).toContain(blockId);

    // Reopen: the section's query result is filtered — the dismissed source
    // stays out and the empty text renders.
    render(<PageView client={client} pageId={pageId} />);
    fireEvent.click(screen.getByRole("tab", { name: /Unlinked mentions/ }));
    expect(screen.getByText("No unlinked mentions.")).not.toBeNull();
    void sourceId;
  });
});
