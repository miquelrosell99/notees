/**
 * System sections tests (SCHEMA.md lazy-loading contract): the three
 * reference sections share one tab strip (#5) — empty tabs hide entirely,
 * only the active tab's section mounts, and a collapsed section executes
 * no query (switching tabs mounts the section but still runs nothing until
 * the section itself expands); expanding runs the section query once and
 * caches per tab visit; a mention edge lands its source in linked
 * references; the References tab lists the pages the node points at; the
 * same literal text without a link lands in unlinked references, while a
 * source that links the page never appears there; unlinked references is
 * blocked for blocks (pages only); child pages render in their own section
 * and never in the body block list; badges come from materialized counts;
 * an expanded section re-runs its query when a remote change notifies.
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
  it("renders the reference tabs; only the active tab's section mounts; collapsed sections execute zero queries", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Zebra" });
    // One mention backlink (keeps the Linked references tab) and one literal
    // mention (keeps the Unlinked references tab) — no outgoing references,
    // so the References tab stays hidden.
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

    // The strip shows exactly the two non-empty tabs; References (no
    // outgoing refs) and Child pages (no children) hide entirely.
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Linked references",
      "Unlinked references",
    ]);
    expect(screen.queryByRole("tab", { name: "References" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Child pages/ })).toBeNull();

    // Only the active tab's section mounts, collapsed (note layout: identity
    // → properties → content → references): no query runs on mount — not
    // even the active tab's (the Section lazy contract) — and the inactive
    // tab's section is not mounted at all.
    const linkedHeader = screen.getByRole("button", { name: /Linked references/ });
    expect(linkedHeader.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: /Unlinked references/ })).toBeNull();
    expect(linkedSpy).not.toHaveBeenCalled();
    expect(unlinkedSpy).not.toHaveBeenCalled();
    expect(referencesSpy).not.toHaveBeenCalled();
    expect(childSpy).not.toHaveBeenCalled();

    // Expanding the active tab's section runs its lazy query exactly once.
    fireEvent.click(linkedHeader);
    expect(linkedSpy).toHaveBeenCalledTimes(1);

    // Switching tabs mounts the other section — still collapsed, so its
    // query runs only when the section itself expands.
    fireEvent.click(screen.getByRole("tab", { name: "Unlinked references" }));
    const unlinkedHeader = screen.getByRole("button", { name: /Unlinked references/ });
    expect(unlinkedHeader.getAttribute("aria-expanded")).toBe("false");
    expect(unlinkedSpy).not.toHaveBeenCalled();
    fireEvent.click(unlinkedHeader);
    expect(unlinkedSpy).toHaveBeenCalledTimes(1);
  });

  it("hides empty reference tabs (the References tab has no outgoing refs here)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Quiet Page" });
    const plainSource = await client.createObject({ presentAsMain: true, name: "Plain Source" });
    await client.createObject({
      parentId: plainSource,
      contentAst: [{ type: "text", text: "Quiet Page" }],
    });

    render(<PageView client={client} pageId={pageId} />);

    // Zero backlinks and zero outgoing references: only the unlinked tab
    // remains (the literal "Quiet Page" text keeps it alive).
    expect(screen.queryByRole("tab", { name: "Linked references" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "References" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Unlinked references" })).toBeInTheDocument();
  });

  it("hides the whole tab strip on a page nobody mentions, references, and without children", async () => {
    const client = await seedClient();
    const lonelyId = await client.createObject({ presentAsMain: true, name: "Xylophone QV" });

    render(<PageView client={client} pageId={lonelyId} />);
    expect(screen.queryByRole("tab", { name: "Linked references" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "References" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Unlinked references" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Child pages/ })).toBeNull();
  });

  it("expands linked/unlinked references: mentions link, literal text does not; switching tabs remounts (cache is per tab visit)", async () => {
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
    render(<PageView client={client} pageId={targetId} />);

    // Linked references (the active tab) starts collapsed: expanding runs
    // the query once and lists the mention source (the plain-text source
    // never appears).
    fireEvent.click(screen.getByRole("button", { name: /Linked references/ }));
    expect(linkedSpy).toHaveBeenCalledTimes(1);
    const linked = section(/Linked references/);
    within(linked).getAllByText("Linked Source");
    expect(within(linked).queryByText("Plain Source")).toBeNull();

    // Collapse + re-expand within the same tab visit: the cached result
    // serves, no re-query.
    fireEvent.click(screen.getByRole("button", { name: /Linked references/ }));
    fireEvent.click(screen.getByRole("button", { name: /Linked references/ }));
    expect(linkedSpy).toHaveBeenCalledTimes(1);
    within(section(/Linked references/)).getAllByText("Linked Source");

    // Unlinked: switching tabs mounts its section (collapsed); expanding
    // runs its query — the plain-text source shows, the already-linked
    // source never does.
    fireEvent.click(screen.getByRole("tab", { name: "Unlinked references" }));
    fireEvent.click(screen.getByRole("button", { name: /Unlinked references/ }));
    const unlinked = section(/Unlinked references/);
    within(unlinked).getAllByText("Plain Source");
    expect(within(unlinked).queryByText("Linked Source")).toBeNull();

    // Switching back remounts the linked section (fresh collapsed state) —
    // expanding re-queries: the result cache lives one tab visit.
    fireEvent.click(screen.getByRole("tab", { name: "Linked references" }));
    fireEvent.click(screen.getByRole("button", { name: /Linked references/ }));
    expect(linkedSpy).toHaveBeenCalledTimes(2);
    within(section(/Linked references/)).getAllByText("Linked Source");
  });

  it("the References tab lists the pages this page points at (outgoing); rows open the target", async () => {
    const client = await seedClient();
    const franceId = await client.createObject({ presentAsMain: true, name: "France" });
    const parisId = await client.createObject({ presentAsMain: true, name: "Paris" });
    const romeId = await client.createObject({ presentAsMain: true, name: "Rome" });
    // France's body blocks point at Paris and Rome (mentions authored in a
    // block roll up to the containing page — the source-side roll-up).
    await client.createObject({
      parentId: franceId,
      contentAst: [
        { type: "mention", targetNodeId: parisId, text: "Paris" },
        { type: "mention", targetNodeId: romeId, text: "Rome" },
      ],
    });

    const referencesSpy = vi.spyOn(client, "getReferences");
    const onOpenPage = vi.fn();
    render(<PageView client={client} pageId={franceId} onOpenPage={onOpenPage} />);

    // France has no backlinks, only outgoing references: the Linked
    // references tab hides and References is the strip's first tab.
    expect(screen.queryByRole("tab", { name: "Linked references" })).toBeNull();
    expect(screen.getByRole("tab", { name: "References" })).toBeInTheDocument();

    // Lazy per active tab: nothing queries until the section expands.
    expect(referencesSpy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /References/ }));
    expect(referencesSpy).toHaveBeenCalledTimes(1);

    const references = section(/References/);
    expect(within(references).getByText("Paris")).not.toBeNull();
    expect(within(references).getByText("Rome")).not.toBeNull();

    // A row click opens the target page (the read-only outline row path).
    fireEvent.click(within(references).getByText("Paris").closest("button.outline-row__main")!);
    expect(onOpenPage).toHaveBeenCalledWith(parisId);
  });

  it("an emptied active tab disappears and the strip falls back to the first non-empty tab", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Zebra" });
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

    render(<PageView client={client} pageId={pageId} />);

    // Activate the Unlinked tab and expand it.
    fireEvent.click(screen.getByRole("tab", { name: "Unlinked references" }));
    fireEvent.click(screen.getByRole("button", { name: /Unlinked references/ }));
    const unlinked = section(/Unlinked references/);
    within(unlinked).getAllByText("Plain Source");

    // Promote the only unlinked source: its literal text becomes a mention,
    // the unlinked count drops to 0, the tab disappears, and the strip
    // falls back to the Linked references tab.
    fireEvent.click(within(unlinked).getByRole("button", { name: /Promote Zebra to a link/ }));

    expect(screen.queryByRole("tab", { name: "Unlinked references" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Linked references" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Linked references/ }));
    const linked = section(/Linked references/);
    within(linked).getAllByText("Linked Source");
    within(linked).getAllByText("Plain Source");
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
    expect(screen.queryByText("Unlinked references")).toBeNull();
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
    const linkedHeader = screen.getByRole("button", { name: /Linked references/ });
    expect(within(linkedHeader).getByText("2")).toBeInTheDocument();

    // Unlinked references hides entirely at 0 (owner rule); every source
    // here already links Zebra, so nothing literal remains.
    expect(screen.queryByRole("button", { name: /Unlinked references/ })).toBeNull();
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

    // Owner rule: with zero backlinks the linked-references section hides
    // entirely (links inside France's own subtree are content, not
    // references — no edge targets France yet).
    expect(screen.queryByRole("button", { name: /Linked references/ })).toBeNull();
    expect(client.getLinkedReferences(parisId).map((r) => r.kind)).toEqual(["direct"]);
    // Paris still sees the direct reference from inside France.
    expect(client.getLinkedReferences(parisId).map((r) => r.containingPageName)).toEqual(["France"]);

    // A DIRECT mention of France makes the section appear (badge 1), while
    // the list shows one row (own-subtree roll-up stays hidden).
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

    const pageId = await clientA.createObject({ presentAsMain: true, name: "Zebra" });
    // One local backlink so the section renders from the start (owner rule
    // hides a zero-count section entirely).
    const localSourceId = await clientA.createObject({ presentAsMain: true, name: "Local Source" });
    await clientA.createObject({
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
    const remotePageId = await clientB.createObject({ presentAsMain: true, name: "Remote Source" });
    await clientB.createObject({
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
