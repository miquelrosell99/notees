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
  it("renders linked references expanded, the rest collapsed; collapsed sections execute zero queries", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ nodeType: "page", name: "Quiet Page" });

    const linkedSpy = vi.spyOn(client, "getLinkedReferences");
    const unlinkedSpy = vi.spyOn(client, "getUnlinkedReferences");
    const childSpy = vi.spyOn(client, "getChildPages");

    render(<PageView client={client} pageId={pageId} />);

    // Linked references starts expanded (owner-approved default): its query
    // runs on mount. The other two stay collapsed and execute no query.
    const linkedHeader = screen.getByRole("button", { name: /Linked references/ });
    expect(linkedHeader.getAttribute("aria-expanded")).toBe("true");
    for (const name of [/Unlinked references/, /Child pages/]) {
      const header = screen.getByRole("button", { name });
      expect(header.getAttribute("aria-expanded")).toBe("false");
    }
    expect(linkedSpy).toHaveBeenCalledTimes(1);
    expect(unlinkedSpy).not.toHaveBeenCalled();
    expect(childSpy).not.toHaveBeenCalled();
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

    // Linked references is expanded on mount: one query, results listed.
    expect(linkedSpy).toHaveBeenCalledTimes(1);
    const linked = section(/Linked references/);
    within(linked).getByText("Linked Source");
    expect(within(linked).queryByText("Plain Source")).toBeNull();

    // Unlinked: the plain-text source shows, the already-linked source never does.
    fireEvent.click(screen.getByRole("button", { name: /Unlinked references/ }));
    const unlinked = section(/Unlinked references/);
    within(unlinked).getByText("Plain Source");
    expect(within(unlinked).queryByText("Linked Source")).toBeNull();

    // Collapse + re-expand without any change: the cached result serves, no re-query.
    fireEvent.click(screen.getByRole("button", { name: /Linked references/ }));
    fireEvent.click(screen.getByRole("button", { name: /Linked references/ }));
    expect(linkedSpy).toHaveBeenCalledTimes(1);
    within(section(/Linked references/)).getByText("Linked Source");
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

    // Unlinked references never shows an eager count.
    const unlinkedHeader = screen.getByRole("button", { name: /Unlinked references/ });
    expect(within(unlinkedHeader).queryByText(/^[0-9]+$/)).toBeNull();
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

  it("linked references roll up source-side containment: a block inside France linking Paris lists on France (in France), badge stays direct", async () => {
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

    // Linked references is expanded on mount (no click needed). The badge
    // reads the DIRECT count: no edge targets France.
    expect(
      within(screen.getByRole("button", { name: /Linked references/ })).getByText("0"),
    ).toBeInTheDocument();

    const linked = section(/Linked references/);
    // The containing-page breadcrumb is France…
    expect(linked.querySelector(".nt-section-crumb")?.textContent).toBe("France");
    // …annotated as a containment reference. Paris's direct view: same block, direct.
    within(linked).getByText("in France");
    expect(client.getLinkedReferences(franceId).map((r) => ({
      source: r.source.id,
      kind: r.kind,
      crumb: r.containingPageName,
    }))).toEqual([{ source: blockId, kind: "containment", crumb: "France" }]);
    expect(client.getLinkedReferences(parisId).map((r) => r.kind)).toEqual(["direct"]);

    // A DIRECT mention of France orders first and moves the badge to 1,
    // while the list shows two rows (list longer than the badge).
    const notesId = await client.createObject({ nodeType: "page", name: "Notes" });
    let notesBlockId = "";
    await act(async () => {
      notesBlockId = await client.createObject({
        nodeType: "block",
        parentId: notesId,
        contentAst: [{ type: "mention", targetNodeId: franceId, text: "France" }],
      });
    });

    expect(client.getLinkedReferences(franceId).map((r) => ({
      source: r.source.id,
      kind: r.kind,
    }))).toEqual([
      { source: notesBlockId, kind: "direct" },
      { source: blockId, kind: "containment" },
    ]);
    expect(
      within(screen.getByRole("button", { name: /Linked references/ })).getByText("1"),
    ).toBeInTheDocument();
    const items = Array.from(linked.querySelectorAll(".nt-section-item"));
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("Notes");
    expect(items[1]!.textContent).toContain("in France");
  });

  it("an expanded linked-references section updates when a remote change notifies", async () => {
    const relay = new MemoryRelay();
    const clientA = await seedClient(relay);
    const clientB = await seedClient(relay);

    const pageId = await clientA.createObject({ nodeType: "page", name: "Zebra" });
    await clientA.push();
    await clientB.pull();
    clientA.startRealtime();

    render(<PageView client={clientA} pageId={pageId} />);

    // Linked references starts expanded (no click needed); the badge reads
    // the materialized count (0).
    within(section(/Linked references/)).getByText("No linked references.");
    expect(
      within(screen.getByRole("button", { name: /Linked references/ })).getByText("0"),
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

    const linked = section(/Linked references/);
    await within(linked).findByText("Remote Source");
    expect(within(screen.getByRole("button", { name: /Linked references/ })).getByText("1")).toBeInTheDocument();
  });
});
