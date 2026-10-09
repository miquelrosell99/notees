/**
 * System sections tests (SCHEMA.md lazy-loading contract; the tab strip's
 * retirement, owner 2026-10-09): below the page content the references are
 * TWO normal NodeCollection sections — "Backlinks" and "Unlinked
 * mentions" — each riding the shared collapsible-section chrome (the
 * header IS the section header; no tab row). The hide-when-empty ruling
 * covers both: each section renders only while its OWN eager count reads
 * > 0 (a page with backlinks but no unlinked mentions shows Backlinks
 * only, and vice versa). Backlinks starts EXPANDED — its list query runs
 * on mount (the old selected tab's contract); Unlinked mentions starts
 * COLLAPSED — its query (the expensive FTS pass) stays lazy behind the
 * first expand and its rows cache across a silent collapse/expand. The
 * eager counts ride the header badges ("Backlinks 2"); a live client
 * notification re-runs the expanded section's query. An expanded section
 * with zero rows (a filter emptied it) shows its empty text ("No
 * backlinks." / "No unlinked mentions."). Unlinked rows carry the
 * Promote/Ignore action pair. Date pages (the deterministic
 * day/month/year family) carry no Unlinked mentions section at all and
 * skip the unlinked count read. The Child pages section and the Activity
 * feed are unchanged around them.
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

/** The Backlinks section (expanded by default — its rows load on mount). */
function backlinksSection(): HTMLElement {
  return section(/Backlinks/);
}

/** The Unlinked mentions section (collapsed until its first expand). */
function unlinkedSection(): HTMLElement {
  return section(/Unlinked mentions/);
}

/** Expand the lazy Unlinked mentions section and return its <section>. */
function expandUnlinkedMentions(): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: /Unlinked mentions/ }));
  return unlinkedSection();
}

describe("PageView system sections", () => {
  it("renders the two reference sections: eager counts ride the badges, Backlinks expanded (query on mount), Unlinked mentions collapsed (no query yet)", async () => {
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

    render(<PageView client={client} pageId={pageId} />);

    // Both sections render — each count is 1. (A section at count 0 hides
    // entirely — the hide-when-empty ruling covers every reference
    // section.) Child pages (no children here) renders on the main
    // surface anyway — its header carries the create action
    // (owner 2026-10-09) — and its list query runs on the expanded
    // section's first read.
    expect(screen.getByRole("button", { name: "Backlinks 1" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Unlinked mentions 1" })).not.toBeNull();
    expect(screen.getByRole("button", { name: /Child pages/ })).not.toBeNull();

    // Lazy per the SCHEMA.md contract: Backlinks starts expanded, so its
    // query runs on mount; the collapsed Unlinked mentions section stays
    // silent until its first expand. (The eager COUNTS run at render —
    // they ride the badges above.) The Child pages section starts
    // expanded, so its read runs on mount too.
    expect(linkedSpy).toHaveBeenCalled();
    expect(unlinkedSpy).not.toHaveBeenCalled();
    expect(referencesSpy).not.toHaveBeenCalled();
    expect(childSpy).toHaveBeenCalled();
  });

  it("zero backlinks: no Backlinks section at all — hide-when-empty is per-section; the Unlinked mentions section renders collapsed with its count", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Quiet Page" });
    const plainSource = await client.createObject({ presentAsMain: true, name: "Plain Source" });
    await client.createObject({
      parentId: plainSource,
      contentAst: [{ type: "text", text: "Quiet Page" }],
    });

    const linkedSpy = vi.spyOn(client, "getLinkedReferences");
    const unlinkedSpy = vi.spyOn(client, "getUnlinkedReferences");
    render(<PageView client={client} pageId={pageId} />);

    // The Backlinks section hides at count 0 — no header, no empty text,
    // and its list query never runs.
    expect(screen.queryByRole("button", { name: /Backlinks/ })).toBeNull();
    expect(screen.queryByText("No backlinks.")).toBeNull();
    expect(linkedSpy).not.toHaveBeenCalled();
    // The unlinked count is 1: the section renders, collapsed — its query
    // stays lazy.
    expect(screen.getByRole("button", { name: "Unlinked mentions 1" })).toBeInTheDocument();
    expect(unlinkedSpy).not.toHaveBeenCalled();
  });

  it("the reference sections hide on a page nobody references — hide-when-empty covers them like every system section; Child pages still renders with its create action", async () => {
    const client = await seedClient();
    const lonelyId = await client.createObject({ presentAsMain: true, name: "Xylophone QV" });

    render(<PageView client={client} pageId={lonelyId} />);
    expect(screen.queryByRole("button", { name: /Backlinks/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Unlinked mentions/ })).toBeNull();
    expect(screen.queryByText("No backlinks.")).toBeNull();
    // The Child pages section is the exception to hide-when-empty on the
    // main surface (owner 2026-10-09): it always renders, its header action
    // creating the first child.
    expect(screen.getByRole("button", { name: /Child pages/ })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Add child page" })).not.toBeNull();
  });

  it("a page's first backlink reveals the Backlinks section: the count gate re-reads on the write notification", async () => {
    const client = await seedClient();
    const targetId = await client.createObject({ presentAsMain: true, name: "Stripped Target" });
    const sourceId = await client.createObject({ presentAsMain: true, name: "Stripped Source" });
    render(<PageView client={client} pageId={targetId} />);
    expect(screen.queryByRole("button", { name: /Backlinks/ })).toBeNull();

    await client.createObject({
      parentId: sourceId,
      contentAst: [{ type: "mention", targetNodeId: targetId, text: "Stripped Target" }],
    });

    // The count re-ran on the write notification: the expanded section
    // appears with the count badge; its rows resolve in the same beat.
    const header = await screen.findByRole("button", { name: "Backlinks 1" });
    expect(header).not.toBeNull();
    expect(await screen.findByText("Stripped Source")).not.toBeNull();
    // No unlinked mentions on this page: the collapsed section never
    // renders, its empty line neither.
    expect(screen.queryByText("No unlinked mentions.")).toBeNull();
  });

  it("Backlinks loads on mount; Unlinked mentions loads on its first expand and caches across a collapse/expand; mentions link, literal text does not", async () => {
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

    // The expanded Backlinks section loaded on mount: the mention source
    // renders (the plain-text source never does). The section header is
    // the collapsible chrome — no duplicated heading inside the body.
    const backlinks = backlinksSection();
    const mountQueries = linkedSpy.mock.calls.length;
    expect(mountQueries).toBeGreaterThan(0);
    expect(within(backlinks).getAllByText("Linked Source")).not.toHaveLength(0);
    expect(within(backlinks).queryByText("Plain Source")).toBeNull();
    // The section renders its own chrome exactly once — the header IS the
    // section header, the body carries no nested one.
    expect(backlinks.querySelectorAll(".node-view-section__header")).toHaveLength(1);
    const body = backlinks.querySelector(".node-view-section__content")!;
    expect(within(body as HTMLElement).queryByRole("button", { name: /^Backlinks/ })).toBeNull();

    // Unlinked: the first expand runs its query once — the plain-text
    // source shows, the already-linked source never does.
    const unlinked = expandUnlinkedMentions();
    expect(unlinkedSpy).toHaveBeenCalledTimes(1);
    expect(within(unlinked).getAllByText("Plain Source")).not.toHaveLength(0);
    expect(within(unlinked).queryByText("Linked Source")).toBeNull();

    // Collapse and re-expand at an unchanged version: the cached rows
    // serve the re-expand — neither query re-runs (the lazy contract).
    fireEvent.click(screen.getByRole("button", { name: /Unlinked mentions/ }));
    fireEvent.click(screen.getByRole("button", { name: /Unlinked mentions/ }));
    expect(unlinkedSpy).toHaveBeenCalledTimes(1);
    expect(within(unlinkedSection()).getAllByText("Plain Source")).not.toHaveLength(0);
    expect(linkedSpy.mock.calls.length).toBe(mountQueries);
  });

  it("promoting the only unlinked source retires the section (hide-when-empty) and grows Backlinks, which then lists the promoted source", async () => {
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

    // Expand the Unlinked mentions section and promote the only source: its
    // literal text becomes a mention.
    const unlinked = expandUnlinkedMentions();
    fireEvent.click(within(unlinked).getByRole("button", { name: /Promote Zebra to a link/ }));
    await flushWrites();

    // The write landed: the source block now carries a mention edge.
    expect(client.getNode(literalBlock)!.contentAst).toEqual([
      { type: "mention", targetNodeId: pageId, text: "Zebra" },
    ]);
    // The eager counts recompute per notification: unlinked drops to 0 and
    // the hide-when-empty ruling retires the section entirely; backlinks
    // grow to 2.
    expect(client.getUnlinkedReferenceCount(pageId)).toBe(0);
    expect(client.getBacklinkCount(pageId)).toBe(2);
    expect(screen.queryByRole("button", { name: /Unlinked mentions/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Backlinks 2" })).toBeInTheDocument();

    // The expanded Backlinks section re-queried on the notification: the
    // promoted source now rides it alongside the original.
    const backlinks = backlinksSection();
    expect(within(backlinks).getAllByText("Linked Source")).not.toHaveLength(0);
    expect(within(backlinks).getAllByText("Plain Source")).not.toHaveLength(0);
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

  it("a childless MAIN-surface page still renders the Child pages section — the header action creates the first child (owner 2026-10-09)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Lonely Parent" });

    render(<PageView client={client} pageId={pageId} onOpenPage={() => {}} />);

    // The section always renders on the main surface now (expanded by
    // default, the empty text honest); the create rides the section
    // header's trailing action.
    const header = screen.getByRole("button", { name: /Child pages/ });
    expect(header).not.toBeNull();
    const addButton = screen.getByRole("button", { name: "Add child page" });
    expect(addButton).not.toBeNull();
    expect(screen.getByText("No child pages.")).not.toBeNull();

    // The header action creates a main child: it lands in the pages zone
    // and the expanded section's re-query renders the row.
    fireEvent.click(addButton);
    await act(async () => {});
    expect(screen.queryByText("No child pages.")).toBeNull();
    const kids = client.getChildPages(pageId);
    expect(kids).toHaveLength(1);
    expect(kids[0]!.parentId).toBe(pageId);
    expect(kids[0]!.presentAsMain).toBe(true);
  });

  it("a childless EMBEDDED feed entry still hides the Child pages section — no create affordance on secondary surfaces", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Feed Entry" });
    const childSpy = vi.spyOn(client, "getChildPages");

    render(<PageView client={client} pageId={pageId} embedded />);

    expect(screen.queryByRole("button", { name: /Child pages/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add child page" })).toBeNull();
    expect(childSpy).not.toHaveBeenCalled();
  });

  it("creating the first child page lists it immediately: the write notification re-runs the eager count and the expanded section's query", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Soon Parent" });
    render(<PageView client={client} pageId={pageId} onOpenPage={() => {}} />);

    // The section is already there (childless main surface): the count
    // badge is suppressed at zero.
    expect(screen.getByRole("button", { name: /Child pages/ })).not.toBeNull();

    await client.createObject({ presentAsMain: true, parentId: pageId, name: "First Kid" });

    // The count read re-runs on the write notification: the row appears.
    expect(await screen.findByText("First Kid")).not.toBeNull();
    expect(
      within(screen.getByRole("button", { name: /Child pages/ })).getByText("1"),
    ).not.toBeNull();
  });

  it("a childless page without onOpenPage still renders the section and its create action — navigation is the only thing the missing prop gates", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Quiet Parent" });
    const childSpy = vi.spyOn(client, "getChildPages");

    render(<PageView client={client} pageId={pageId} />);

    // The always-render ruling (owner 2026-10-09) does not depend on a
    // navigation target — the create action works standalone.
    expect(screen.getByRole("button", { name: /Child pages/ })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Add child page" })).not.toBeNull();
    // The expanded section's list read runs on mount either way.
    expect(childSpy).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Add child page" }));
    await act(async () => {});
    expect(client.getChildPages(pageId)).toHaveLength(1);
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

    // Sanity: the stat the badge reads (distinct sources).
    expect(client.getBacklinkCount(targetId)).toBe(2);

    render(<PageView client={client} pageId={targetId} />);
    // The eager count rides the section header badge; a zero count hides
    // the section (the hide-when-empty ruling) — no unlinked mentions
    // here, so no Unlinked mentions section.
    expect(screen.getByRole("button", { name: "Backlinks 2" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Unlinked mentions/ })).toBeNull();
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
    // no edge targets France yet, so the hide-when-empty gate keeps the
    // Backlinks section off the page.
    expect(screen.queryByRole("button", { name: "Backlinks" })).toBeNull();
    expect(client.getLinkedReferences(parisId).map((r) => r.kind)).toEqual(["direct"]);
    // Paris still sees the direct reference from inside France.
    expect(client.getLinkedReferences(parisId).map((r) => r.containingPageName)).toEqual(["France"]);

    // A DIRECT mention of France makes the count appear (badge 1)…
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
    expect(screen.getByRole("button", { name: "Backlinks 1" })).toBeInTheDocument();

    // …and the expanded section's list re-queried on the notification:
    // exactly one row renders (the own-subtree roll-up stays hidden by the
    // owner rule).
    const backlinks = backlinksSection();
    const items = Array.from(backlinks.querySelectorAll(".nt-refblock-tree"));
    expect(items).toHaveLength(1);
    // Each reference renders the source block with its content (and children
    // recursively — the fixture's mention block has none, the tree still shows
    // the block row).
    expect(items[0]!.querySelector(".nt-block-content")?.textContent).toContain("France");
  });

  it("the expanded Backlinks section updates when a remote change notifies", async () => {
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

    // The expanded section loaded on mount; the badge reads the
    // materialized count (1 — the local source).
    const backlinks = backlinksSection();
    within(backlinks).getAllByText("Local Source");
    expect(screen.getByRole("button", { name: "Backlinks 1" })).toBeInTheDocument();

    // A second client adds a backlink; the relay frame notifies client A
    // and the expanded section's query re-runs.
    const remotePageId = await clientB.createObject({ presentAsMain: true, name: "Remote Source" });
    await clientB.createObject({
      parentId: remotePageId,
      contentAst: [{ type: "mention", targetNodeId: pageId, text: "Zebra" }],
    });
    await act(async () => {
      await clientB.push();
    });

    await within(backlinks).findAllByText("Remote Source");
    expect(screen.getByRole("button", { name: "Backlinks 2" })).toBeInTheDocument();
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


describe("date pages: no Unlinked mentions", () => {
  /** A plain source page whose block literally names the day (an unlinked
   *  match — the day title appears as plain text, never a mention). */
  async function seedLiteralDateMention(client: WorkspaceClient, dayName: string): Promise<void> {
    const plainSource = await client.createObject({ presentAsMain: true, name: "Plain Source" });
    await client.createObject({
      parentId: plainSource,
      contentAst: [{ type: "text", text: `busy on ${dayName}` }],
    });
  }

  /** The day page's title text — non-null for a materialized date chain. */
  function dayNameOf(client: WorkspaceClient, day: string): string {
    const name = client.getDisplayName(day);
    if (name === null) throw new Error(`day page ${day} has no display name`);
    return name;
  }

  it("a day page with only literal-date matches renders no reference sections at all and skips the unlinked count read", async () => {
    const client = await seedClient();
    const { day } = await client.ensureDateChain("2026-06-15");
    const dayName = dayNameOf(client, day);
    await seedLiteralDateMention(client, dayName);
    // Sanity: the match IS an unlinked reference at the read level.
    expect(client.getUnlinkedReferenceCount(day)).toBeGreaterThan(0);

    const countSpy = vi.spyOn(client, "getUnlinkedReferenceCount");
    render(<PageView client={client} pageId={day} onOpenPage={() => {}} />);

    expect(screen.queryByRole("button", { name: /Backlinks/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Unlinked mentions/ })).toBeNull();
    expect(countSpy).not.toHaveBeenCalled();
  });

  it("a day page with a real backlink renders ONLY the Backlinks section", async () => {
    const client = await seedClient();
    const { day } = await client.ensureDateChain("2026-06-15");
    const dayName = dayNameOf(client, day);
    await seedLiteralDateMention(client, dayName);
    const linkedSource = await client.createObject({ presentAsMain: true, name: "Linked Source" });
    await client.createObject({
      parentId: linkedSource,
      contentAst: [{ type: "mention", targetNodeId: day, text: dayName }],
    });

    const countSpy = vi.spyOn(client, "getUnlinkedReferenceCount");
    render(<PageView client={client} pageId={day} onOpenPage={() => {}} />);

    const backlinks = backlinksSection();
    expect(within(backlinks).getByText("Linked Source")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Unlinked mentions/ })).toBeNull();
    expect(countSpy).not.toHaveBeenCalled();
  });

  it("an ordinary page keeps the Unlinked mentions section (the ruling is date-family only)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Zebra" });
    const plainSource = await client.createObject({ presentAsMain: true, name: "Plain Source" });
    await client.createObject({
      parentId: plainSource,
      contentAst: [{ type: "text", text: "Zebra" }],
    });

    render(<PageView client={client} pageId={pageId} onOpenPage={() => {}} />);
    expect(screen.getByRole("button", { name: /Unlinked mentions/ })).not.toBeNull();
  });
});
