/**
 * System sections tests (SCHEMA.md lazy-loading contract, owner 2026-10-06
 * strip rework): below the page content the references ride ONE bottom
 * strip (`.nt-backlinks`) with TWO tabs — "Backlinks" and "Unlinked
 * mentions" (renamed) — always both visible even when empty; the outgoing
 * "References" tab no longer exists. The eager counts ride the tab labels
 * ("Backlinks 2"). The SELECTED tab's list query runs on mount (the Tabs
 * primitive swallows re-clicks on the active tab, so the first load cannot
 * ride onChange); the other tab stays lazy until its first switch, and the
 * loaded results cache across tab switches. An activated tab with zero rows
 * shows its empty text ("No backlinks." / "No unlinked mentions."); a live
 * client notification re-runs the loaded tabs' queries. The tab panels
 * render headerless (the tab IS the header — no nested Section headers).
 * Unlinked rows carry the Promote/Ignore action pair. The Child pages
 * section and the Activity feed are unchanged around the strip.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";
import { Breadcrumbs } from "../src/ui/components/Breadcrumbs.js";

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

async function seedClient(relay: MemoryRelay = new MemoryRelay()): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(relay),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

/** Flush the microtasks a fireEvent-triggered async write runs on. */
async function flushWrites(): Promise<void> {
  await act(async () => {});
}

/** Section header button + its containing <section> for within() scoping. */
function section(headerName: RegExp): HTMLElement {
  const header = screen.getByRole("button", { name: headerName });
  return header.closest("section")!;
}

/** The `.nt-backlinks` strip (the selected tab's rows load on mount). */
function backlinksStrip(): HTMLElement {
  const strip = document.querySelector(".nt-backlinks");
  if (strip === null) throw new Error("no .nt-backlinks strip rendered");
  return strip as HTMLElement;
}

/** Activate the lazy Unlinked mentions tab and return the strip. */
function activateUnlinkedMentions(): HTMLElement {
  fireEvent.click(screen.getByRole("tab", { name: /Unlinked mentions/ }));
  return backlinksStrip();
}

describe("PageView system sections", () => {
  it("renders the two-tab strip: both tabs always visible, eager counts ride the labels, no list query runs before first activation", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Zebra" });
    // One mention backlink (Backlinks count 1) and one literal mention
    // (Unlinked mentions count 1).
    const linkedSource = await client.createObject({ presentAsMain: true, name: "Linked Source" });
    await client.createObject({
      parentId: linkedSource,
      contentAst: [{ type: "mention", targetNodeId: pageId, text: "Zebra" }],
    });
    const plainSource = await client.createObject({ presentAsMain: true, name: "Plain Source" });
    await client.createObject({
      parentId: plainSource,
      contentAst: [{ type: "text", text: "Zebra" }],
    });

    const linkedSpy = vi.spyOn(client, "getLinkedReferences");
    const unlinkedSpy = vi.spyOn(client, "getUnlinkedReferences");
    const referencesSpy = vi.spyOn(client, "getReferences");
    const childSpy = vi.spyOn(client, "getChildPages");

    const { container } = render(<PageView client={client} pageId={pageId} />);

    // The strip is always there, with exactly the two tabs — even when a
    // tab would be empty. The outgoing "References" tab no longer exists;
    // Child pages (no children here) stays hidden.
    expect(container.querySelector(".nt-backlinks")).not.toBeNull();
    // Scope to the strip's OWN tab list: the selected panel may host the
    // collection's views chrome (its Default tab) alongside.
    const refTabList = container.querySelector(".nt-ref-tabs > .tabs__list");
    expect(refTabList).not.toBeNull();
    expect(within(refTabList as HTMLElement).getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Backlinks 1",
      "Unlinked mentions 1",
    ]);
    expect(screen.queryByRole("tab", { name: "References" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Child pages/ })).toBeNull();

    // Lazy per the SCHEMA.md contract, except the SELECTED tab: Backlinks
    // is active from the first render, so its query runs on mount (the Tabs
    // primitive swallows re-clicks on the active tab — the first load
    // cannot ride onChange). The unselected Unlinked mentions tab stays
    // silent until its first switch. (The eager COUNTS run at render — they
    // ride the labels above.)
    expect(linkedSpy).toHaveBeenCalled();
    expect(unlinkedSpy).not.toHaveBeenCalled();
    expect(referencesSpy).not.toHaveBeenCalled();
    expect(childSpy).not.toHaveBeenCalled();
  });

  it("the selected Backlinks tab loads on mount — zero rows show the empty text", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Quiet Page" });
    const plainSource = await client.createObject({ presentAsMain: true, name: "Plain Source" });
    await client.createObject({
      parentId: plainSource,
      contentAst: [{ type: "text", text: "Quiet Page" }],
    });

    render(<PageView client={client} pageId={pageId} />);

    // Zero backlinks: the Backlinks tab stays, with no count suffix.
    expect(screen.getByRole("tab", { name: "Backlinks" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Unlinked mentions 1" })).toBeInTheDocument();

    // The selected tab loaded on mount: the empty state renders under the
    // headerless panel, no click needed.
    expect(screen.getByText("No backlinks.")).toBeInTheDocument();
  });

  it("the strip renders on a page nobody references, and both empty tabs show their empty text", async () => {
    const client = await seedClient();
    const lonelyId = await client.createObject({ presentAsMain: true, name: "Xylophone QV" });

    const { container } = render(<PageView client={client} pageId={lonelyId} />);
    expect(container.querySelector(".nt-backlinks")).not.toBeNull();
    const refTabList = container.querySelector(".nt-ref-tabs > .tabs__list");
    expect(refTabList).not.toBeNull();
    expect(within(refTabList as HTMLElement).getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Backlinks",
      "Unlinked mentions",
    ]);
    expect(screen.queryByRole("button", { name: /Child pages/ })).toBeNull();
    // The selected Backlinks tab shows its empty text right on mount…
    expect(screen.getByText("No backlinks.")).toBeInTheDocument();
    // …the lazy tab shows its after its first activation.
    activateUnlinkedMentions();
    expect(screen.getByText("No unlinked mentions.")).toBeInTheDocument();
  });

  it("the selected tab loads on mount and caches across switches; mentions link, literal text does not", async () => {
    const client = await seedClient();
    const targetId = await client.createObject({ presentAsMain: true, name: "Zebra" });
    const linkedPageId = await client.createObject({ presentAsMain: true, name: "Linked Source" });
    await client.createObject({
      parentId: linkedPageId,
      contentAst: [{ type: "mention", targetNodeId: targetId, text: "Zebra" }],
    });
    const plainPageId = await client.createObject({ presentAsMain: true, name: "Plain Source" });
    await client.createObject({
      parentId: plainPageId,
      contentAst: [{ type: "text", text: "Zebra" }],
    });

    const linkedSpy = vi.spyOn(client, "getLinkedReferences");
    const unlinkedSpy = vi.spyOn(client, "getUnlinkedReferences");
    render(<PageView client={client} pageId={targetId} />);

    // The selected Backlinks tab loaded on mount: the mention source
    // renders (the plain-text source never does). The panel is headerless —
    // the tab IS the header.
    const strip = backlinksStrip();
    const mountQueries = linkedSpy.mock.calls.length;
    expect(mountQueries).toBeGreaterThan(0);
    expect(within(strip).getAllByText("Linked Source")).not.toHaveLength(0);
    expect(within(strip).queryByText("Plain Source")).toBeNull();
    const panel = strip.querySelector<HTMLElement>('[role="tabpanel"]')!;
    // Headerless panel: no Section-component headers, no duplicated tab text
    // (the tab IS the header; the rows' Logseq-style groups are plain
    // <section class="outline-group"> outlines, not Section chrome).
    expect(panel.querySelector(".node-view-section__header")).toBeNull();
    expect(within(panel).queryByRole("button", { name: /Backlinks/ })).toBeNull();

    // Unlinked: first activation runs its query once — the plain-text
    // source shows, the already-linked source never does.
    activateUnlinkedMentions();
    expect(unlinkedSpy).toHaveBeenCalledTimes(1);
    expect(within(strip).getAllByText("Plain Source")).not.toHaveLength(0);
    expect(within(strip).queryByText("Linked Source")).toBeNull();

    // Switching back and forth: the loaded results cache ACROSS tab
    // switches — neither query re-runs (the owner 2026-10-06 contract).
    fireEvent.click(screen.getByRole("tab", { name: /Backlinks/ }));
    expect(linkedSpy.mock.calls.length).toBe(mountQueries);
    expect(within(strip).getAllByText("Linked Source")).not.toHaveLength(0);
    activateUnlinkedMentions();
    expect(unlinkedSpy).toHaveBeenCalledTimes(1);
    expect(within(strip).getAllByText("Plain Source")).not.toHaveLength(0);
  });

  it("tabs never disappear: promoting the only unlinked source empties the panel but keeps the tab; the counts update live", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Zebra" });
    const linkedSource = await client.createObject({ presentAsMain: true, name: "Linked Source" });
    await client.createObject({
      parentId: linkedSource,
      contentAst: [{ type: "mention", targetNodeId: pageId, text: "Zebra" }],
    });
    const plainSource = await client.createObject({ presentAsMain: true, name: "Plain Source" });
    const literalBlock = await client.createObject({
      parentId: plainSource,
      contentAst: [{ type: "text", text: "Zebra" }],
    });

    render(<PageView client={client} pageId={pageId} />);

    // Activate the Unlinked mentions tab and promote the only source: its
    // literal text becomes a mention.
    const strip = activateUnlinkedMentions();
    fireEvent.click(within(strip).getByRole("button", { name: /Promote Zebra to a link/ }));
    await flushWrites();

    // The write landed: the source block now carries a mention edge.
    expect(client.getNode(literalBlock)!.contentAst).toEqual([
      { type: "mention", targetNodeId: pageId, text: "Zebra" },
    ]);
    // The eager counts recompute per notification: unlinked drops to 0 (the
    // suffix disappears, the tab REMAINS), backlinks grow to 2.
    expect(client.getUnlinkedReferenceCount(pageId)).toBe(0);
    expect(client.getBacklinkCount(pageId)).toBe(2);
    expect(screen.getByRole("tab", { name: "Unlinked mentions" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Backlinks 2" })).toBeInTheDocument();

    // The loaded panels re-queried on the notification: the Unlinked panel
    // is now honestly empty…
    expect(within(backlinksStrip()).getByText("No unlinked mentions.")).toBeInTheDocument();
    // …and the promoted source now rides Backlinks.
    fireEvent.click(screen.getByRole("tab", { name: "Backlinks 2" }));
    expect(within(backlinksStrip()).getAllByText("Linked Source")).not.toHaveLength(0);
    expect(within(backlinksStrip()).getAllByText("Plain Source")).not.toHaveLength(0);
  });

  it("blocks unlinked references for blocks (pages only)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Zebra" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "Zebra" }],
    });

    expect(client.getUnlinkedReferences(blockId)).toEqual([]);

    render(<PageView client={client} pageId={blockId} />);
    expect(screen.queryByText("Unlinked mentions")).toBeNull();
    expect(screen.getByText("Page not found.")).toBeInTheDocument();
  });

  it("renders child pages in their own section, never in the body block list", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Parent Page" });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "body block" }],
    });
    const childId = await client.createObject({
      presentAsMain: true,
      name: "Child Page",
      parentId: pageId,
    });

    const onOpenPage = vi.fn();
    const { container } = render(
      <PageView client={client} pageId={pageId} onOpenPage={onOpenPage} />,
    );

    // Expanded by default: the child page row renders in the section
    // immediately (the read-only blocks list).
    expect(within(section(/Child pages/)).getByText("Child Page")).not.toBeNull();

    // The body block list carries blocks only (projection rule 3).
    const body = container.querySelector(".nt-block-tree")!;
    expect(body.textContent).toContain("body block");
    expect(body.textContent).not.toContain("Child Page");

    // The child page renders as a read-only blocks-list row and navigates on
    // click (the section starts expanded).
    const childSection = section(/Child pages/);
    const row = within(childSection).getByText("Child Page");
    fireEvent.click(row.closest(".nt-block-content")!);
    expect(onOpenPage).toHaveBeenCalledWith(childId);
  });

  it("a childless main-surface page renders the Child pages section with the create affordance; the create lands in the Pages zone and focuses the new child", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Lonely Parent" });
    const onOpenPage = vi.fn();

    render(<PageView client={client} pageId={pageId} onOpenPage={onOpenPage} />);

    // The section renders even with zero children: the kit EmptyState
    // carries the create affordance (the collection contract: flag AND
    // callback AND context — the main surface with a navigation target).
    const childSection = section(/Child pages/);
    expect(within(childSection).getByText("No child pages.")).not.toBeNull();
    const addButton = within(childSection).getByRole("button", { name: "Add child page" });
    // The zero count stays off the header (the tab-label convention).
    expect(childSection.querySelector(".node-view-section__count")).toBeNull();

    fireEvent.click(addButton);
    await flushWrites();

    // The create landed IN THE PAGES ZONE (presentAsMain child of the host)
    // and the section's focus behavior opened the new child.
    const children = client.getChildPages(pageId);
    expect(children).toHaveLength(1);
    expect(children[0]!.presentAsMain).toBe(true);
    expect(onOpenPage).toHaveBeenCalledWith(children[0]!.id);
    // The expanded section re-ran its query on the write notification: the
    // new child is a row now, and the empty state is gone.
    expect(within(section(/Child pages/)).queryByText("No child pages.")).toBeNull();
  });

  it("no navigation target, no create affordance: a childless page without onOpenPage keeps the section hidden", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Quiet Parent" });
    const childSpy = vi.spyOn(client, "getChildPages");

    render(<PageView client={client} pageId={pageId} />);

    // The context conjunct fails (no focus target) — the section stays
    // hidden exactly as before, and its list query never runs.
    expect(screen.queryByRole("button", { name: /Child pages/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add child page" })).toBeNull();
    expect(childSpy).not.toHaveBeenCalled();
  });

  it("the main-children zone lists present-as-main children of any node type (Revision 11)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Zone Parent" });
    // Two main children: one named like a classic page, one bare node
    // (no name/content at all) — the zone is render-state, not node kind.
    const namedChild = await client.createObject({
      presentAsMain: true,
      parentId: pageId,
      name: "Named Main Child",
    });
    await client.createObject({ presentAsMain: true, parentId: pageId });
    // An inline body child and a grandchild main node: the former never
    // appears in the section, the latter only under its own parent.
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "inline body child" }],
    });
    await client.createObject({ presentAsMain: true, parentId: namedChild, name: "Grandchild" });

    const { container } = render(<PageView client={client} pageId={pageId} onOpenPage={() => {}} />);

    const childSection = section(/Child pages/);
    // Both direct main children are rows; the count badge reads 2. The
    // recursive tree shows the grandchild nested under its own parent.
    expect(within(childSection).getByText("Named Main Child")).not.toBeNull();
    expect(childSection.querySelector(".node-view-section__count")?.textContent).toBe("2");
    expect(within(childSection).getByText("Grandchild")).not.toBeNull();
    // Two top-level rows + the nested grandchild row.
    expect(childSection.querySelectorAll(".nt-block").length).toBe(3);
    // The inline body child stays in the body tree, out of the section.
    expect(childSection.textContent).not.toContain("inline body child");
    const body = container.querySelector(".nt-block-tree")!;
    expect(body.textContent).toContain("inline body child");
    expect(body.textContent).not.toContain("Named Main Child");
  });

  it("badges come from materialized counts", async () => {
    const client = await seedClient();
    const targetId = await client.createObject({ presentAsMain: true, name: "Zebra" });
    const sourcePageId = await client.createObject({ presentAsMain: true, name: "Source" });
    await client.createObject({
      parentId: sourcePageId,
      contentAst: [{ type: "mention", targetNodeId: targetId, text: "Zebra" }],
    });
    await client.createObject({
      parentId: sourcePageId,
      contentAst: [
        { type: "text", text: "again " },
        { type: "mention", targetNodeId: targetId, text: "Zebra" },
      ],
    });

    // Sanity: the stat the label reads (distinct sources).
    expect(client.getBacklinkCount(targetId)).toBe(2);

    render(<PageView client={client} pageId={targetId} />);
    // The eager count rides the tab label; a zero count shows no suffix but
    // the tab stays (both tabs are always visible now).
    expect(screen.getByRole("tab", { name: "Backlinks 2" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Unlinked mentions" })).toBeInTheDocument();
  });

  it("child-pages badge counts the page-typed children", async () => {
    const client = await seedClient();
    const parentId = await client.createObject({ presentAsMain: true, name: "Parent" });
    await client.createObject({ presentAsMain: true, name: "Kid One", parentId });
    await client.createObject({ presentAsMain: true, name: "Kid Two", parentId });

    // Sanity: the stat the badge reads.
    expect(client.getChildPageCount(parentId)).toBe(2);

    render(<PageView client={client} pageId={parentId} />);
    const childHeader = screen.getByRole("button", { name: /Child pages/ });
    expect(within(childHeader).getByText("2")).toBeInTheDocument();
  });

  it("own-subtree links are hidden from a page's linked references; other pages still see them (direct)", async () => {
    const client = await seedClient();
    const franceId = await client.createObject({ presentAsMain: true, name: "France" });
    const parisId = await client.createObject({ presentAsMain: true, name: "Paris" });
    // A block INSIDE France links Paris: an outward link — France lists it
    // by containment; Paris lists it as a direct backlink.
    const blockId = await client.createObject({
      parentId: franceId,
      contentAst: [{ type: "mention", targetNodeId: parisId, text: "Paris" }],
    });

    render(<PageView client={client} pageId={franceId} />);

    // Owner rule: France's own-subtree links are content, not references —
    // no edge targets France yet, so the Backlinks tab carries no count.
    expect(screen.getByRole("tab", { name: "Backlinks" })).toBeInTheDocument();
    expect(client.getLinkedReferences(parisId).map((r) => r.kind)).toEqual(["direct"]);
    // Paris still sees the direct reference from inside France.
    expect(client.getLinkedReferences(parisId).map((r) => r.containingPageName)).toEqual(["France"]);

    // A DIRECT mention of France makes the count appear (label 1)…
    const notesId = await client.createObject({ presentAsMain: true, name: "Notes" });
    let notesBlockId = "";
    await act(async () => {
      notesBlockId = await client.createObject({
        parentId: notesId,
        contentAst: [{ type: "mention", targetNodeId: franceId, text: "France" }],
      });
    });

    // The Notes direct mention remains; the own-subtree containment roll-up
    // is hidden by the owner rule.
    expect(client.getLinkedReferences(franceId).map((r) => ({
      source: r.source.id,
      kind: r.kind,
    }))).toEqual([{ source: notesBlockId, kind: "direct" }]);
    expect(screen.getByRole("tab", { name: "Backlinks 1" })).toBeInTheDocument();

    // …and the selected tab's list re-queried on the notification: exactly
    // one row renders (the own-subtree roll-up stays hidden by the owner
    // rule).
    const strip = backlinksStrip();
    const items = Array.from(strip.querySelectorAll(".nt-refblock-tree"));
    expect(items).toHaveLength(1);
    // Each reference renders the source block with its content (and children
    // recursively — the fixture's mention block has none, the tree still shows
    // the block row).
    expect(items[0]!.querySelector(".nt-block-content")?.textContent).toContain("France");
  });

  it("the loaded backlinks tab updates when a remote change notifies", async () => {
    const relay = new MemoryRelay();
    const clientA = await seedClient(relay);
    const clientB = await seedClient(relay);

    const pageId = await clientA.createObject({ presentAsMain: true, name: "Zebra" });
    const localSourceId = await clientA.createObject({ presentAsMain: true, name: "Local Source" });
    await clientA.createObject({
      parentId: localSourceId,
      contentAst: [{ type: "mention", targetNodeId: pageId, text: "Zebra" }],
    });
    await clientA.push();
    await clientB.pull();
    clientA.startRealtime();

    render(<PageView client={clientA} pageId={pageId} />);

    // The selected tab loaded on mount; the label reads the materialized
    // count (1 — the local source).
    const strip = backlinksStrip();
    within(strip).getAllByText("Local Source");
    expect(screen.getByRole("tab", { name: "Backlinks 1" })).toBeInTheDocument();

    // A second client adds a backlink; the relay frame notifies client A
    // and the loaded tab's query re-runs.
    const remotePageId = await clientB.createObject({ presentAsMain: true, name: "Remote Source" });
    await clientB.createObject({
      parentId: remotePageId,
      contentAst: [{ type: "mention", targetNodeId: pageId, text: "Zebra" }],
    });
    await act(async () => {
      await clientB.push();
    });

    await within(strip).findAllByText("Remote Source");
    expect(screen.getByRole("tab", { name: "Backlinks 2" })).toBeInTheDocument();
  });
});

describe("crumb labels over class chips (issue #2)", () => {
  it("a page titled only by a class chip crumbs under its resolved class name", async () => {
    const client = await seedClient();
    const classId = await client.createClass("task");
    // The parent's title IS a bare class chip: the domain excerpt is ""
    // (the label is graph state), so the crumb must fall back to the
    // resolved class display name — never "Untitled page".
    // Blocks carry rich content (pages flatten titles to text-only): the
    // parent block's content IS a bare class chip.
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const parentId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "class_chip", classId }],
    });
    const childId = await client.createObject({ parentId, contentAst: [{ type: "text", text: "Child" }] });

    const { container } = render(
      <Breadcrumbs client={client} nodeId={childId} onOpenNode={() => {}} showCurrent />,
    );
    // Trail: Home / <chip-titled block> / Child.
    const crumbs = container.querySelectorAll(".node-breadcrumb-name");
    expect(crumbs.length).toBe(3);
    expect(crumbs[1]!.textContent).toBe("task");
    expect(container.querySelector(".node-breadcrumbs")!.textContent).not.toContain("Untitled");
  });

  it("a chip carrying one-off displayText crumbs under that wording", async () => {
    const client = await seedClient();
    const classId = await client.createClass("source");
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const parentId = await client.createObject({
      parentId: pageId,
      contentAst: [
        { type: "text", text: "on " },
        { type: "class_chip", classId, displayText: "the Republic" },
      ],
    });
    const childId = await client.createObject({ parentId, contentAst: [{ type: "text", text: "Child" }] });

    const { container } = render(
      <Breadcrumbs client={client} nodeId={childId} onOpenNode={() => {}} showCurrent />,
    );
    const crumbs = container.querySelectorAll(".node-breadcrumb-name");
    expect(crumbs[1]!.textContent).toBe("on the Republic");
  });
});
