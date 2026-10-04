/**
 * Page layouts §34.27 L1–L4 tests, over the in-process WorkspaceClient +
 * MemoryRelay (jsdom):
 *
 *  - L1 view-mode persistence: deviceSettings read/write round-trips, the
 *    page blocks triad + hub modes survive remounts, stale values fall back
 *    to surface defaults, the card cover layout persists per device.
 *  - L2 page banner: renders above the title from the `cover` property,
 *    absent without one (and on whiteboard pages), collapse persists
 *    device-locally.
 *  - L3 sidebar context sections: TOC derivation (main children + the
 *    heading heuristic + one nesting level), the rail sections' hide rules.
 *  - L4 chrome: the page footer word count + Created/Updated day links,
 *    the unlinked-references promote/ignore pair.
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
import { TocSection, ReferencesSection } from "../src/ui/components/sidebarSections.js";
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

  it("a mode the surface no longer offers reads back as null (falls to the default)", () => {
    writeViewModePref("hub.x", "kanban");
    // Kanban disappears (no grouping select) → the persisted value is stale.
    expect(readViewModePref("hub.x", ["outline", "cards", "table"])).toBeNull();
    expect(readViewModePref("hub.x", ["outline", "cards", "kanban", "table"])).toBe("kanban");
  });

  it("garbage in localStorage reads as null, never crashes", () => {
    localStorage.setItem(`${DEVICE_SETTINGS_PREFIX}viewMode.hub.y`, "{not json");
    expect(readViewModePref("hub.y", ["table"])).toBeNull();
    localStorage.setItem(`${DEVICE_SETTINGS_PREFIX}viewMode.hub.y`, '"banana"');
    expect(readViewModePref("hub.y", ["table"])).toBeNull();
  });

  it("the page's blocks triad survives a remount; a fresh page starts at outline", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Persisted Modes" });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "body" }],
    });

    const first = render(<PageView client={client} pageId={pageId} />);
    fireEvent.click(screen.getByRole("radio", { name: "Prose" }));
    first.unmount();

    render(<PageView client={client} pageId={pageId} />);
    expect(screen.getByRole("radio", { name: "Prose" })).toHaveAttribute("aria-checked", "true");

    // A different page is unaffected (per-page keys).
    const otherId = await client.createObject({ presentAsMain: true, name: "Other Page" });
    await client.createObject({ parentId: otherId, contentAst: [{ type: "text", text: "x" }] });
    cleanup();
    const second = render(<PageView client={client} pageId={otherId} />);
    expect(screen.getByRole("radio", { name: "Outline" })).toHaveAttribute("aria-checked", "true");
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
    fireEvent.click(screen.getByRole("radio", { name: "Cover top" }));
    first.unmount();

    expect(readCardLayoutPref()).toBe("cover-top");
    render(<HubView client={client} nav="assets" onOpenNode={() => {}} />);
    const cover = await screen.findByAltText("");
    expect(cover.closest(".node-card")!.className).toContain("node-card--cover-top");

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

  it("renders the cover above the title; absent when no cover is set", async () => {
    const client = await seedClient();
    vi.spyOn(client, "getAssetDataUrl").mockResolvedValue("data:image/png;base64,BBBB");
    const coveredId = await seedCoveredPage(client);
    const plainId = await client.createObject({ presentAsMain: true, name: "Plain Page" });

    const { container, unmount } = render(<PageView client={client} pageId={coveredId} />);
    const toggle = await screen.findByRole("button", { name: "Collapse cover image" });
    // §34.56: the banner is a wrapper (toolbar chrome) around the toggle.
    const banner = toggle.closest(".nt-page-banner")!;
    expect(toggle.querySelector("img")!.getAttribute("src")).toContain("data:image/png");
    // Above the title in the header.
    const header = container.querySelector(".nt-page-header")!;
    expect(header.firstElementChild).toBe(banner);
    unmount();

    render(<PageView client={client} pageId={plainId} />);
    expect(screen.queryByRole("button", { name: /cover image/i })).toBeNull();
  });

  it("collapse toggles to the slim strip and persists per page", async () => {
    const client = await seedClient();
    vi.spyOn(client, "getAssetDataUrl").mockResolvedValue("data:image/png;base64,CCCC");
    const pageId = await seedCoveredPage(client);

    const { unmount } = render(<PageView client={client} pageId={pageId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Collapse cover image" }));
    expect(
      screen.getByRole("button", { name: "Expand cover image" }).closest(".nt-page-banner")!
        .className,
    ).toContain("nt-page-banner--collapsed");
    unmount();

    render(<PageView client={client} pageId={pageId} />);
    expect(
      (await screen.findByRole("button", { name: "Expand cover image" })).closest(
        ".nt-page-banner",
      )!.className,
    ).toContain("nt-page-banner--collapsed");
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

  it("ReferencesSection hides at zero backlinks and lazy-loads on expand", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Zebra" });

    const { unmount } = render(
      <ReferencesSection client={client} pageId={pageId} onOpenNode={() => {}} />,
    );
    expect(screen.queryByRole("button", { name: /References/ })).toBeNull();
    unmount();

    const sourceId = await client.createObject({ presentAsMain: true, name: "Source" });
    await client.createObject({
      parentId: sourceId,
      contentAst: [{ type: "mention", targetNodeId: pageId, text: "Zebra" }],
    });
    const spy = vi.spyOn(client, "getLinkedReferences");
    render(<ReferencesSection client={client} pageId={pageId} onOpenNode={() => {}} />);

    const header = screen.getByRole("button", { name: /References/ });
    expect(spy).not.toHaveBeenCalled();
    fireEvent.click(header);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /Zebra/ })).not.toBeNull();
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

  it("the leaf's context menu removes its parent (detach to the root)", async () => {
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
    // The crumb menu edits the CRUMB's own parentage; detaching the child
    // from its parent means editing the leaf (the current crumb).
    fireEvent.contextMenu(screen.getByRole("button", { name: "Child Page" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove parent" }));
    await flushWrites();

    expect(client.getNode(child)!.parentId).toBeNull();
  });

  it("reassign parent moves the node under the picked page", async () => {
    const client = await seedClient();
    const firstParent = await client.createObject({ presentAsMain: true, name: "First" });
    const secondParent = await client.createObject({ presentAsMain: true, name: "Second" });
    const child = await client.createObject({
      parentId: firstParent,
      presentAsMain: true,
      name: "Child Page",
    });

    render(
      <Breadcrumbs client={client} nodeId={child} onOpenNode={() => {}} showCurrent editable />,
    );
    fireEvent.contextMenu(screen.getByRole("button", { name: "Child Page" }));
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
});

// --- L4: unlinked references promote/ignore -----------------------------------------

describe("L4 unlinked references promote/ignore", () => {
  it("promote rewrites the literal match into a mention (the source becomes linked)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Zebra" });
    const sourceId = await client.createObject({ presentAsMain: true, name: "Plain Source" });
    const blockId = await client.createObject({
      parentId: sourceId,
      contentAst: [{ type: "text", text: "the Zebra runs" }],
    });

    render(<PageView client={client} pageId={pageId} />);
    fireEvent.click(screen.getByRole("button", { name: /Unlinked references/ }));
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
    fireEvent.click(screen.getByRole("button", { name: /Unlinked references/ }));
    fireEvent.click(screen.getByRole("button", { name: /Ignore/ }));
    await flushWrites();
    unmount();

    expect(readIgnoredUnlinkedRefs(pageId)).toContain(blockId);

    // Reopen: the section's query result is filtered — empty text renders.
    render(<PageView client={client} pageId={pageId} />);
    fireEvent.click(screen.getByRole("button", { name: /Unlinked references/ }));
    expect(screen.getByText("No unlinked references.")).not.toBeNull();
    void sourceId;
  });
});
