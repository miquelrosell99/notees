/**
 * The context-column + cards-only-rail tests: the panelled main layout
 * composes THREE columns (NodeView · properties · context); the context
 * column hosts the node-relevant widgets relocated from the right rail —
 * LocalGraphCard, TocSection, the Activity section, Comments —
 * with the references dedupe check's verdict recorded (the rail's
 * ReferencesSection rendered the same getLinkedReferences data as the
 * page's Backlinks section, so it was deleted; the section stays the one
 * home).
 * Each panel column keeps its own device-local collapse, toggled from the
 * nodeview top bar (the `layout` prop stays binary — per-column device
 * prefs replace the recorded "third state" option). Embedded/compact/class
 * surfaces render NO context column. The right rail hosts workspace cards
 * only — the generic NodeCardFrame around NodeView, whose
 * collapse is session-local; reorder is a registered follow-up.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";
import { NodeView } from "../src/ui/NodeView.js";
import { NodeCardFrame } from "../src/ui/components/NodeCardFrame.js";
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

describe("the context column (three-column panelled layout)", () => {
  it("the panelled main layout renders three columns; the context column hosts graph, TOC, Activity, Comments", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Doc" });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "Background" }],
    });

    const { container } = render(<PageView client={client} pageId={pageId} />);

    expect(container.querySelector(".nt-page-side-panel")).not.toBeNull();
    expect(container.querySelector(".nt-page-content")).not.toBeNull();
    const context = container.querySelector(".nt-page-context")!;
    expect(context).not.toBeNull();

    // Top-down: the local graph (collapsed by default — the card mounts,
    // and loads, only on the first expand), the tree-derived Contents, the
    // node's own Activity; Comments always renders (empty included).
    expect(context.querySelector(".nt-localgraph-card")).toBeNull();
    const graphHeader = within(context as HTMLElement).getByRole("button", { name: /Local graph/ });
    expect(graphHeader.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(graphHeader);
    expect(context.querySelector(".nt-localgraph-card")).not.toBeNull();
    expect(within(context as HTMLElement).getByText("Contents")).not.toBeNull();
    expect(
      within(context as HTMLElement).getByRole("button", { name: /^Activity/ }),
    ).not.toBeNull();
    expect(
      within(context as HTMLElement).getByRole("button", { name: /^Comments/ }),
    ).not.toBeNull();
  });

  it("the nodeview top bar toggles each panel column independently, device-locally", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Doc" });

    const { container, unmount } = render(<PageView client={client} pageId={pageId} />);
    expect(container.querySelector(".nt-page-context")).not.toBeNull();

    // The context toggle hides only the context column…
    fireEvent.click(screen.getByRole("button", { name: "Hide context panel" }));
    expect(container.querySelector(".nt-page-context")).toBeNull();
    expect(container.querySelector(".nt-page-side-panel")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Show context panel" })).not.toBeNull();

    // …and persists device-locally (the binary layout prop's per-column
    // replacement — the registered choice).
    expect(localStorage.getItem(`${DEVICE_SETTINGS_PREFIX}pageContextPanelCollapsed`)).toBe(
      "true",
    );
    unmount();

    render(<PageView client={client} pageId={pageId} />);
    expect(container.querySelector(".nt-page-context")).toBeNull();
  });

  it("compact, embedded, and class surfaces render no context column", async () => {
    const client = await seedClient();
    const plainId = await client.createObject({ presentAsMain: true, name: "Plain" });
    const compact = render(<PageView client={client} pageId={plainId} layout="compact" />);
    expect(compact.container.querySelector(".nt-page-context")).toBeNull();
    expect(compact.container.querySelector(".nt-node-topbar")).toBeNull();
    compact.unmount();

    const embedded = render(<PageView client={client} pageId={plainId} embedded />);
    expect(embedded.container.querySelector(".nt-page-context")).toBeNull();
    embedded.unmount();

    const classId = await client.createClass("agent");
    const klass = render(<PageView client={client} pageId={classId} />);
    expect(klass.container.querySelector(".nt-page-context")).toBeNull();
  });

  it("Activity relocated: one Activity section, living in the context column; the stack below the body is Child pages + backlinks", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Doc" });
    await client.createObject({ presentAsMain: true, parentId: pageId, name: "Kid" });
    // A reference so the backlinks strip renders under the hide-when-empty
    // gate.
    const sourceId = await client.createObject({ presentAsMain: true, name: "Ref Source" });
    await client.createObject({
      parentId: sourceId,
      contentAst: [{ type: "mention", targetNodeId: pageId, text: "Doc" }],
    });

    const { container } = render(<PageView client={client} pageId={pageId} />);

    const activityHeaders = screen.getAllByRole("button", { name: /^Activity/ });
    expect(activityHeaders).toHaveLength(1);
    expect(activityHeaders[0]!.closest(".nt-page-context")).not.toBeNull();

    // The card-bottom stack: Child pages + the Backlinks section — no
    // duplicate Activity, no references section.
    expect(screen.getByRole("button", { name: /Child pages/ })).not.toBeNull();
    expect(screen.getByRole("button", { name: /Backlinks/ })).not.toBeNull();
    expect(container.querySelector(".nt-rail-ref__list")).toBeNull();
  });

  it("the references dedupe verdict: the context column renders no references list; the Backlinks section owns the getLinkedReferences data", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Zebra" });
    const sourceId = await client.createObject({ presentAsMain: true, name: "Source" });
    await client.createObject({
      parentId: sourceId,
      contentAst: [{ type: "mention", targetNodeId: pageId, text: "Zebra" }],
    });

    const { container } = render(<PageView client={client} pageId={pageId} />);
    // One home: the Backlinks section of the section stack (expanded by
    // default — it renders the linked references on mount). No rail-style
    // references section anywhere in the composition.
    expect(container.querySelector(".nt-rail-ref__list")).toBeNull();
    expect(screen.getByRole("button", { name: "Backlinks 1" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /^References/ })).toBeNull();
  });
});

describe("NodeView preview surface", () => {
  it("preview renders compact chrome: no corner menu, no top bar, a read-only first-level body, no sections", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Peeked" });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "top level" }],
    });
    const nested = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "nested level" }],
    });
    await client.createObject({
      parentId: nested,
      contentAst: [{ type: "text", text: "deep level" }],
    });

    const { container } = render(
      <NodeView client={client} nodeId={pageId} onOpenNode={() => {}} preview />,
    );

    // No panelled chrome, no corner cluster.
    expect(container.querySelector(".nt-node-topbar")).toBeNull();
    expect(container.querySelector(".nt-node-view__corner")).toBeNull();
    expect(container.querySelector(".nt-page-context")).toBeNull();

    // The body is read-only…
    expect(container.querySelector(".nt-block-tree--readonly")).not.toBeNull();
    // …capped at the first body level: the direct child renders, its own
    // children do not.
    const tree = container.querySelector(".nt-block-tree")!;
    expect(tree.textContent).toContain("top level");
    expect(tree.textContent).toContain("nested level");
    expect(tree.textContent).not.toContain("deep level");

    // No section stack, no ghost add-row.
    expect(screen.queryByRole("button", { name: /Backlinks/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Unlinked mentions/ })).toBeNull();
    expect(container.querySelector(".nt-ghost-row")).toBeNull();
  });
});

describe("NodeCardFrame (the cards-only rail)", () => {
  it("the generic frame renders NodeView in its body with the breadcrumbs header; collapse is session-local", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Carded" });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "body block" }],
    });

    const { container } = render(
      <NodeCardFrame client={client} nodeId={pageId} onOpenNode={() => {}} onClose={() => {}} />,
    );
    const card = container.querySelector(".nt-sidebar-card")!;
    expect(card).not.toBeNull();
    // The header trails the breadcrumbs; the body hosts the node view.
    expect(card.querySelector(".node-breadcrumbs")).not.toBeNull();
    expect(card.querySelector(".nt-page")).not.toBeNull();

    // Collapse hides the body (session-local card management)…
    fireEvent.click(within(card as HTMLElement).getByRole("button", { name: "Collapse card" }));
    expect(card.querySelector(".nt-sidebar-card__body")).toBeNull();
    fireEvent.click(within(card as HTMLElement).getByRole("button", { name: "Expand card" }));
    expect(card.querySelector(".nt-sidebar-card__body")).not.toBeNull();
  });

  it("open-in-main navigates and closes; close dismisses; a missing node renders the honest not-found", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Carded" });
    const onOpenNode = vi.fn();
    const onClose = vi.fn();

    const { container, unmount } = render(
      <NodeCardFrame client={client} nodeId={pageId} onOpenNode={onOpenNode} onClose={onClose} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open in main view" }));
    expect(onOpenNode).toHaveBeenCalledWith(pageId);
    expect(onClose).toHaveBeenCalled();
    unmount();

    const onCloseSecond = vi.fn();
    render(
      <NodeCardFrame
        client={client}
        nodeId={pageId}
        onOpenNode={() => {}}
        onClose={onCloseSecond}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close card" }));
    expect(onCloseSecond).toHaveBeenCalled();

    // Missing node: the frame's header breadcrumbs skip and the body says so.
    const missing = render(
      <NodeCardFrame
        client={client}
        nodeId="0192a000-0000-7000-8000-000000000099"
        onOpenNode={() => {}}
        onClose={() => {}}
      />,
    );
    expect(missing.container.querySelector(".nt-page-missing")).not.toBeNull();
    void container;
  });
});
