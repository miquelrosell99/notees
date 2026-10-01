/**
 * System sections tests (SCHEMA.md lazy-loading contract): collapsed sections
 * execute zero queries; expanding runs the section query once and caches;
 * a mention edge lands its source in linked references; the same literal text
 * without a link lands in unlinked references, while a source that links the
 * page never appears there; unlinked references is blocked for blocks (pages
 * only); child pages render in their own section and never in the body block
 * list; badges come from materialized counts; an expanded section re-runs its
 * query when a remote change notifies.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";

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

/** Section header button + its containing <section> for within() scoping. */
function section(headerName: RegExp): HTMLElement {
  const header = screen.getByRole("button", { name: headerName });
  return header.closest("section")!;
}

describe("PageView system sections", () => {
  it("renders all reference sections collapsed; collapsed sections execute zero queries", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ nodeType: "page", name: "Zebra" });
    // One mention backlink (keeps Linked references visible) and one literal
    // mention (keeps Unlinked references visible) — both sections render.
    const linkedSource = await client.createObject({ nodeType: "page", name: "Linked Source" });
    await client.createObject({
      nodeType: "block",
      parentId: linkedSource,
      contentAst: [{ type: "mention", targetNodeId: pageId, text: "Zebra" }],
    });
    const plainSource = await client.createObject({ nodeType: "page", name: "Plain Source" });
    await client.createObject({
      nodeType: "block",
      parentId: plainSource,
      contentAst: [{ type: "text", text: "Zebra" }],
    });

    const linkedSpy = vi.spyOn(client, "getLinkedReferences");
    const unlinkedSpy = vi.spyOn(client, "getUnlinkedReferences");
    const childSpy = vi.spyOn(client, "getChildPages");

    render(<PageView client={client} pageId={pageId} />);

    // Every reference section starts collapsed (note layout: identity →
    // properties → content → references): no query runs on mount. The
    // fixture page has no child pages, so that section hides entirely.
    for (const name of [/Linked references/, /Unlinked references/]) {
      const header = screen.getByRole("button", { name });
      expect(header.getAttribute("aria-expanded")).toBe("false");
    }
    expect(screen.queryByRole("button", { name: /Child pages/ })).toBeNull();
    expect(linkedSpy).not.toHaveBeenCalled();
    expect(unlinkedSpy).not.toHaveBeenCalled();
    expect(childSpy).not.toHaveBeenCalled();

    // Expanding runs the section's lazy query exactly once.
    fireEvent.click(screen.getByRole("button", { name: /Linked references/ }));
    expect(linkedSpy).toHaveBeenCalledTimes(1);
  });

  it("hides linked and unlinked reference sections when their count is 0", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ nodeType: "page", name: "Quiet Page" });
    const plainSource = await client.createObject({ nodeType: "page", name: "Plain Source" });
    await client.createObject({
      nodeType: "block",
      parentId: plainSource,
      contentAst: [{ type: "text", text: "Quiet Page" }],
    });

    render(<PageView client={client} pageId={pageId} />);

    // Zero backlinks: the linked-references section is gone entirely (the
    // literal "Quiet Page" text keeps the unlinked one alive).
    expect(screen.queryByRole("button", { name: /Linked references/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Unlinked references/ })).toBeInTheDocument();
  });

  it("hides every system section on a page nobody mentions and without children", async () => {
    const client = await seedClient();
    const lonelyId = await client.createObject({ nodeType: "page", name: "Xylophone QV" });

    render(<PageView client={client} pageId={lonelyId} />);
    expect(screen.queryByRole("button", { name: /Linked references/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Unlinked references/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Child pages/ })).toBeNull();
  });

  it("expands linked/unlinked references: mentions link, literal text does not", async () => {
    const client = await seedClient();
    const targetId = await client.createObject({ nodeType: "page", name: "Zebra" });
    const linkedPageId = await client.createObject({ nodeType: "page", name: "Linked Source" });
    await client.createObject({
      nodeType: "block",
      parentId: linkedPageId,
      contentAst: [{ type: "mention", targetNodeId: targetId, text: "Zebra" }],
    });
    const plainPageId = await client.createObject({ nodeType: "page", name: "Plain Source" });
    await client.createObject({
      nodeType: "block",
      parentId: plainPageId,
      contentAst: [{ type: "text", text: "Zebra" }],
    });

    const linkedSpy = vi.spyOn(client, "getLinkedReferences");
    render(<PageView client={client} pageId={targetId} />);

    // Linked references starts collapsed: expanding runs the query once and
    // lists the mention source (the plain-text source never appears).
    fireEvent.click(screen.getByRole("button", { name: /Linked references/ }));
    expect(linkedSpy).toHaveBeenCalledTimes(1);
    const linked = section(/Linked references/);
    within(linked).getAllByText("Linked Source");
    expect(within(linked).queryByText("Plain Source")).toBeNull();

    // Unlinked: the plain-text source shows, the already-linked source never does.
    fireEvent.click(screen.getByRole("button", { name: /Unlinked references/ }));
    const unlinked = section(/Unlinked references/);
    within(unlinked).getAllByText("Plain Source");
    expect(within(unlinked).queryByText("Linked Source")).toBeNull();

    // Collapse + re-expand without any change: the cached result serves, no re-query.
    fireEvent.click(screen.getByRole("button", { name: /Linked references/ }));
    fireEvent.click(screen.getByRole("button", { name: /Linked references/ }));
    expect(linkedSpy).toHaveBeenCalledTimes(1);
    within(section(/Linked references/)).getAllByText("Linked Source");
  });

  it("blocks unlinked references for blocks (pages only)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ nodeType: "page", name: "Zebra" });
    const blockId = await client.createObject({
      nodeType: "block",
      parentId: pageId,
      contentAst: [{ type: "text", text: "Zebra" }],
    });

    expect(client.getUnlinkedReferences(blockId)).toEqual([]);

    render(<PageView client={client} pageId={blockId} />);
    expect(screen.queryByText("Unlinked references")).toBeNull();
    expect(screen.getByText("Page not found.")).toBeInTheDocument();
  });

  it("renders child pages in their own section, never in the body block list", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ nodeType: "page", name: "Parent Page" });
    await client.createObject({
      nodeType: "block",
      parentId: pageId,
      contentAst: [{ type: "text", text: "body block" }],
    });
    const childId = await client.createObject({
      nodeType: "page",
      name: "Child Page",
      parentId: pageId,
    });

    const onOpenPage = vi.fn();
    const { container } = render(
      <PageView client={client} pageId={pageId} onOpenPage={onOpenPage} />,
    );

    // Collapsed: the child page appears nowhere.
    expect(screen.queryByText("Child Page")).toBeNull();

    // The body block list carries blocks only (projection rule 3).
    const body = container.querySelector(".nt-block-tree")!;
    expect(body.textContent).toContain("body block");
    expect(body.textContent).not.toContain("Child Page");

    // Expand: child page renders in the section and navigates on click.
    fireEvent.click(screen.getByRole("button", { name: /Child pages/ }));
    const childSection = section(/Child pages/);
    const row = within(childSection).getByText("Child Page");
    fireEvent.click(row.closest("button")!);
    expect(onOpenPage).toHaveBeenCalledWith(childId);
  });

  it("badges come from materialized counts", async () => {
    const client = await seedClient();
    const targetId = await client.createObject({ nodeType: "page", name: "Zebra" });
    const sourcePageId = await client.createObject({ nodeType: "page", name: "Source" });
    await client.createObject({
      nodeType: "block",
      parentId: sourcePageId,
      contentAst: [{ type: "mention", targetNodeId: targetId, text: "Zebra" }],
    });
    await client.createObject({
      nodeType: "block",
      parentId: sourcePageId,
      contentAst: [
        { type: "text", text: "again " },
        { type: "mention", targetNodeId: targetId, text: "Zebra" },
      ],
    });

    // Sanity: the stat the badge reads (distinct sources).
    expect(client.getBacklinkCount(targetId)).toBe(2);

    render(<PageView client={client} pageId={targetId} />);
    const linkedHeader = screen.getByRole("button", { name: /Linked references/ });
    expect(within(linkedHeader).getByText("2")).toBeInTheDocument();

    // Unlinked references hides entirely at 0 (owner rule); every source
    // here already links Zebra, so nothing literal remains.
    expect(screen.queryByRole("button", { name: /Unlinked references/ })).toBeNull();
  });

  it("child-pages badge counts the page-typed children", async () => {
    const client = await seedClient();
    const parentId = await client.createObject({ nodeType: "page", name: "Parent" });
    await client.createObject({ nodeType: "page", name: "Kid One", parentId });
    await client.createObject({ nodeType: "page", name: "Kid Two", parentId });

    // Sanity: the stat the badge reads.
    expect(client.getChildPageCount(parentId)).toBe(2);

    render(<PageView client={client} pageId={parentId} />);
    const childHeader = screen.getByRole("button", { name: /Child pages/ });
    expect(within(childHeader).getByText("2")).toBeInTheDocument();
  });

  it("own-subtree links are hidden from a page's linked references; other pages still see them (direct)", async () => {
    const client = await seedClient();
    const franceId = await client.createObject({ nodeType: "page", name: "France" });
    const parisId = await client.createObject({ nodeType: "page", name: "Paris" });
    // A block INSIDE France links Paris: an outward link — France lists it
    // by containment; Paris lists it as a direct backlink.
    const blockId = await client.createObject({
      nodeType: "block",
      parentId: franceId,
      contentAst: [{ type: "mention", targetNodeId: parisId, text: "Paris" }],
    });

    render(<PageView client={client} pageId={franceId} />);

    // Owner rule: with zero backlinks the linked-references section hides
    // entirely (links inside France's own subtree are content, not
    // references — no edge targets France yet).
    expect(screen.queryByRole("button", { name: /Linked references/ })).toBeNull();
    expect(client.getLinkedReferences(parisId).map((r) => r.kind)).toEqual(["direct"]);
    // Paris still sees the direct reference from inside France.
    expect(client.getLinkedReferences(parisId).map((r) => r.containingPageName)).toEqual(["France"]);

    // A DIRECT mention of France makes the section appear (badge 1), while
    // the list shows one row (own-subtree roll-up stays hidden).
    const notesId = await client.createObject({ nodeType: "page", name: "Notes" });
    let notesBlockId = "";
    await act(async () => {
      notesBlockId = await client.createObject({
        nodeType: "block",
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
    expect(
      within(screen.getByRole("button", { name: /Linked references/ })).getByText("1"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Linked references/ }));
    const linked = section(/Linked references/);
    const items = Array.from(linked.querySelectorAll(".nt-refblock-tree"));
    expect(items).toHaveLength(1);
    // Each reference renders the source block with its content (and children
    // recursively — the fixture's mention block has none, the tree still shows
    // the block row).
    expect(items[0]!.querySelector(".nt-block-content")?.textContent).toContain("France");
  });

  it("an expanded linked-references section updates when a remote change notifies", async () => {
    const relay = new MemoryRelay();
    const clientA = await seedClient(relay);
    const clientB = await seedClient(relay);

    const pageId = await clientA.createObject({ nodeType: "page", name: "Zebra" });
    // One local backlink so the section renders from the start (owner rule
    // hides a zero-count section entirely).
    const localSourceId = await clientA.createObject({ nodeType: "page", name: "Local Source" });
    await clientA.createObject({
      nodeType: "block",
      parentId: localSourceId,
      contentAst: [{ type: "mention", targetNodeId: pageId, text: "Zebra" }],
    });
    await clientA.push();
    await clientB.pull();
    clientA.startRealtime();

    render(<PageView client={clientA} pageId={pageId} />);

    // Expand linked references (collapsed by default in the note layout); the
    // badge reads the materialized count (1 — the local source).
    fireEvent.click(screen.getByRole("button", { name: /Linked references/ }));
    const linked = section(/Linked references/);
    within(linked).getAllByText("Local Source");
    expect(
      within(screen.getByRole("button", { name: /Linked references/ })).getByText("1"),
    ).toBeInTheDocument();

    // A second client adds a backlink; the relay frame notifies client A.
    const remotePageId = await clientB.createObject({ nodeType: "page", name: "Remote Source" });
    await clientB.createObject({
      nodeType: "block",
      parentId: remotePageId,
      contentAst: [{ type: "mention", targetNodeId: pageId, text: "Zebra" }],
    });
    await act(async () => {
      await clientB.push();
    });

    await within(linked).findAllByText("Remote Source");
    expect(within(screen.getByRole("button", { name: /Linked references/ })).getByText("2")).toBeInTheDocument();
  });
});
