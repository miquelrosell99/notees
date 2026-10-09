/**
 * Workspace drag-session tests: ONE drag session across every mounted
 * surface (the host in App). jsdom has no layout, so
 * getBoundingClientRect is mocked — every block row stacks 40px apart in
 * document order (24px of indent per nesting depth), and a card frame's
 * header gets its own rect above the rows. PointerSensor is driven with
 * fireEvent pointer events targeted at the document, where dnd-kit attaches
 * its move/end listeners.
 *
 * Covered here (the block-dnd suite keeps the per-row intent model):
 *
 * - the pure per-zone candidate merge (every candidate tagged with its zone),
 * - a drop on a rail card's HEADER appends the dragged block as the LAST
 *   CHILD of the card's node (one code path with a child drop on that node),
 *   with the header's distinct active-drop state while it is the target,
 * - a COLLAPSED card under drag-hover transiently expands (drag-scoped —
 *   re-collapses at drag end; the card's own collapse state never mutates),
 * - a block dragged from the main body into a rail card lands re-parented
 *   (cross-zone drops are always MOVE — never copy/link),
 * - the card's document-level shortcuts stay off (main-surface-only).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";
import { NodeCardFrame } from "../src/ui/components/NodeCardFrame.js";
import { WorkspaceDndHost } from "../src/ui/useWorkspaceDnd.js";
import { mergeZoneCandidates } from "../src/ui/block-dnd.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

const clients: WorkspaceClient[] = [];

const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;

// jsdom has no PointerEvent: dnd-kit's PointerSensor activator rejects events
// without isPrimary, and testing-library falls back to MouseEvent (which lacks
// it). A minimal polyfill makes pointer events first-class in the harness.
class PointerEventPolyfill extends MouseEvent {
  pointerId: number;
  pointerType: string;
  isPrimary: boolean;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
    this.pointerType = init.pointerType ?? "mouse";
    this.isPrimary = init.isPrimary ?? true;
  }
}

beforeAll(async () => {
  sqlModule = await initSqlJs();
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
  // Synthetic layout for the block rows and the card headers (jsdom has none).
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    if (this instanceof HTMLElement && this.classList.contains("nt-sidebar-card__header")) {
      // The card headers ride above the document's rows, stacked in rail
      // order (two-header reorder drags need distinct rects per card).
      const headers = Array.from(document.querySelectorAll(".nt-sidebar-card__header"));
      const index = Math.max(0, headers.indexOf(this));
      const top = -48 + index * 48;
      return {
        x: 0,
        y: top,
        left: 0,
        top,
        width: 400,
        height: 32,
        right: 400,
        bottom: top + 32,
        toJSON: () => ({}),
      } as DOMRect;
    }
    const row = this.closest("[data-block-id]");
    if (row !== null) {
      const rows = Array.from(document.querySelectorAll("[data-block-id]"));
      const index = Math.max(0, rows.indexOf(row));
      let depth = 0;
      for (let el = row.parentElement; el !== null; el = el.parentElement) {
        if (el.classList.contains("nt-block-children")) depth += 1;
      }
      const left = depth * 24;
      const top = index * 40;
      return {
        x: left,
        y: top,
        left,
        top,
        width: 400,
        height: 32,
        right: left + 400,
        bottom: top + 32,
        toJSON: () => ({}),
      } as DOMRect;
    }
    return originalGetBoundingClientRect.call(this);
  };
  // Layout APIs dnd-kit touches but jsdom lacks.
  Element.prototype.scrollIntoView =
    Element.prototype.scrollIntoView ?? (() => undefined);
  window.scrollBy = window.scrollBy ?? (() => undefined);
});

afterAll(() => {
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
});

afterEach(async () => {
  // dnd-kit's pointer sensor detaches its document listeners on a 50ms
  // timer — among them a capture-phase click stopPropagation that suppresses
  // the trailing click after a drop. Settle past it so the NEXT test's
  // clicks aren't swallowed (upstream behavior, fine in real usage).
  await new Promise((resolve) => setTimeout(resolve, 60));
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

async function seedBlock(client: WorkspaceClient, parentId: string, text: string): Promise<string> {
  return client.createObject({
    parentId,
    contentAst: [{ type: "text", text }],
  });
}

function rowEl(container: HTMLElement, blockId: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-block-id="${blockId}"]`);
  if (el === null) throw new Error(`no row rendered for ${blockId}`);
  return el;
}

function gripOf(row: HTMLElement): HTMLElement {
  const el = row.querySelector<HTMLElement>(".nt-bullet");
  if (el === null) throw new Error("no drag handle (bullet) in row");
  return el;
}

/** Flush the microtasks the drop handler's async move chain runs on. */
async function flushMoves(): Promise<void> {
  await act(async () => {});
}

/**
 * A pointer drag of `fromId`'s drag handle (the bullet). The pointer streams
 * `to(x, y)` (document coordinates) — a header, a row rect, empty space —
 * until the drop. dnd-kit's dispatched onDragMove trails the collision
 * computation by one event (its over state commits in an effect), so each
 * position is sent a few times with slightly varying coordinates — identical
 * coordinates are deduped.
 */
function dragTo(
  container: HTMLElement,
  fromId: string,
  to: { x: number; y: number },
): void {
  const fromRect = rowEl(container, fromId).getBoundingClientRect();
  const grip = gripOf(rowEl(container, fromId));
  fireEvent.pointerDown(grip, {
    clientX: fromRect.left + 200,
    clientY: fromRect.top + 16,
    button: 0,
    pointerId: 1,
  });
  // First move beyond the 4px activation distance so the drag starts.
  fireEvent.pointerMove(document, {
    clientX: fromRect.left + 210,
    clientY: fromRect.top + 16,
    buttons: 1,
    pointerId: 1,
  });
  let lastY = to.y;
  for (let i = 0; i < 3; i += 1) {
    lastY = to.y + i;
    fireEvent.pointerMove(document, { clientX: to.x, clientY: lastY, buttons: 1, pointerId: 1 });
  }
  fireEvent.pointerUp(document, { clientX: to.x, clientY: lastY, button: 0, pointerId: 1 });
}

describe("mergeZoneCandidates", () => {
  it("tags every candidate with its zone, preserving the per-zone order", () => {
    const merged = mergeZoneCandidates([
      {
        zoneId: "zone-a",
        candidates: [
          { targetId: "a1", intent: "above", anchorX: 0, anchorY: 40 },
          { targetId: "a1", intent: "child", anchorX: 48, anchorY: 56 },
        ],
      },
      { zoneId: "zone-b", candidates: [{ targetId: "b1", intent: "below", anchorX: 0, anchorY: 96 }] },
    ]);

    expect(merged).toEqual([
      { targetId: "a1", intent: "above", anchorX: 0, anchorY: 40, zoneId: "zone-a" },
      { targetId: "a1", intent: "child", anchorX: 48, anchorY: 56, zoneId: "zone-a" },
      { targetId: "b1", intent: "below", anchorX: 0, anchorY: 96, zoneId: "zone-b" },
    ]);
  });

  it("returns an empty set for no zones, and keeps zones with no candidates", () => {
    expect(mergeZoneCandidates([])).toEqual([]);
    expect(
      mergeZoneCandidates([
        { zoneId: "empty", candidates: [] },
        { zoneId: "full", candidates: [{ targetId: "x", intent: "above", anchorX: 0, anchorY: 0 }] },
      ]).map((c) => c.zoneId),
    ).toEqual(["full"]);
  });
});

describe("the workspace drag session", () => {
  it("a drop on a rail card's header appends the block as the card node's last child", async () => {
    const client = await seedClient();
    const cardNodeId = await client.createObject({ presentAsMain: true, name: "Carded" });
    const a = await seedBlock(client, cardNodeId, "alpha");
    const b = await seedBlock(client, cardNodeId, "beta");
    const { container } = render(
      <WorkspaceDndHost>
        <NodeCardFrame client={client} nodeId={cardNodeId} onOpenNode={() => {}} onClose={() => {}} />
      </WorkspaceDndHost>,
    );
    const moveSpy = vi.spyOn(client, "moveObject");

    // Drag the card's first child onto the card header (header rect center).
    dragTo(container, a, { x: 40, y: -32 });
    await flushMoves();

    // Header drop ≡ a child drop on the card node: append as last child —
    // one moveObject with NO afterId, and the order flips to [beta, alpha].
    expect(moveSpy).toHaveBeenCalledTimes(1);
    expect(moveSpy).toHaveBeenCalledWith(a, cardNodeId);
    expect(client.getChildren(cardNodeId).map((child) => child.id)).toEqual([b, a]);
    expect(client.getNode(a)?.parentId).toBe(cardNodeId);
  });

  it("the header shows its distinct active-drop state while it is the target", async () => {
    const client = await seedClient();
    const cardNodeId = await client.createObject({ presentAsMain: true, name: "Carded" });
    const a = await seedBlock(client, cardNodeId, "alpha");
    const { container } = render(
      <WorkspaceDndHost>
        <NodeCardFrame client={client} nodeId={cardNodeId} onOpenNode={() => {}} onClose={() => {}} />
      </WorkspaceDndHost>,
    );

    // Press + activate + hover the header, then inspect BEFORE the drop.
    const fromRect = rowEl(container, a).getBoundingClientRect();
    const grip = gripOf(rowEl(container, a));
    fireEvent.pointerDown(grip, {
      clientX: fromRect.left + 200,
      clientY: fromRect.top + 16,
      button: 0,
      pointerId: 1,
    });
    fireEvent.pointerMove(document, {
      clientX: fromRect.left + 210,
      clientY: fromRect.top + 16,
      buttons: 1,
      pointerId: 1,
    });
    for (let i = 0; i < 3; i += 1) {
      fireEvent.pointerMove(document, { clientX: 40, clientY: -32 + i, buttons: 1, pointerId: 1 });
    }

    // Capture the during-drag state, then end the drag — an assertion must
    // not throw while a drag is live (the sensor keeps document listeners).
    const headerClass = container.querySelector<HTMLElement>(".nt-sidebar-card__header")!.className;
    fireEvent.pointerUp(document, { clientX: 40, clientY: -30, button: 0, pointerId: 1 });
    await flushMoves();

    // The header showed its distinct active-drop state while it was the
    // target; the translated line is the child drop on the card node (the
    // header path resolves to the same move the append test proves)…
    expect(headerClass).toContain("nt-sidebar-card__header--drop-active");
    // …and it clears at drag end.
    expect(container.querySelector(".nt-sidebar-card__header--drop-active")).toBeNull();
  });

  it("a collapsed card transiently expands under drag-hover and re-collapses at drag end", async () => {
    const client = await seedClient();
    const mainPageId = await client.createObject({ presentAsMain: true, name: "Main" });
    const x = await seedBlock(client, mainPageId, "wanderer");
    const cardNodeId = await client.createObject({ presentAsMain: true, name: "Carded" });
    const inside = await seedBlock(client, cardNodeId, "inside");
    const { container } = render(
      <WorkspaceDndHost>
        <PageView client={client} pageId={mainPageId} />
        <NodeCardFrame client={client} nodeId={cardNodeId} onOpenNode={() => {}} onClose={() => {}} />
      </WorkspaceDndHost>,
    );
    const moveSpy = vi.spyOn(client, "moveObject");

    // Collapse the card: the body unmounts, no rows inside the card.
    fireEvent.click(screen.getByRole("button", { name: "Collapse card" }));
    expect(container.querySelector(".nt-sidebar-card__body")).toBeNull();

    // Drag the main page's block onto the collapsed card's header.
    dragTo(container, x, { x: 40, y: -32 });
    await flushMoves();

    // The drop landed (append as the card node's last child — after the
    // child the card already had)…
    expect(moveSpy).toHaveBeenCalledTimes(1);
    expect(moveSpy).toHaveBeenCalledWith(x, cardNodeId);
    expect(client.getChildren(cardNodeId).map((child) => child.id)).toEqual([inside, x]);
    // …and the card re-collapsed: the body is gone again, and the collapse
    // button still owns the collapsed state (nothing persisted the expand).
    expect(container.querySelector(".nt-sidebar-card__body")).toBeNull();
    const collapseToggle = screen.getByRole("button", { name: "Expand card" });
    expect(collapseToggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("a block dragged from the main body into a rail card lands re-parented (cross-zone move)", async () => {
    const client = await seedClient();
    const mainPageId = await client.createObject({ presentAsMain: true, name: "Main" });
    const x = await seedBlock(client, mainPageId, "wanderer");
    const cardNodeId = await client.createObject({ presentAsMain: true, name: "Carded" });
    const r = await seedBlock(client, cardNodeId, "resident");
    const { container } = render(
      <WorkspaceDndHost>
        <PageView client={client} pageId={mainPageId} />
        <NodeCardFrame client={client} nodeId={cardNodeId} onOpenNode={() => {}} onClose={() => {}} />
      </WorkspaceDndHost>,
    );
    const moveSpy = vi.spyOn(client, "moveObject");

    // Drag the main block onto the LOWER half of the card's row: the drop
    // line below it — re-parented into the card node after that row.
    const target = rowEl(container, r).getBoundingClientRect();
    dragTo(container, x, { x: target.left + 4, y: target.top + 24 });
    await flushMoves();

    expect(moveSpy).toHaveBeenCalledTimes(1);
    expect(moveSpy).toHaveBeenCalledWith(x, cardNodeId, r);
    expect(client.getNode(x)?.parentId).toBe(cardNodeId);
    expect(client.getChildren(mainPageId).map((child) => child.id)).toEqual([]);
  });

  it("the card's document-level shortcuts stay off (main-surface-only)", async () => {
    const client = await seedClient();
    const cardNodeId = await client.createObject({ presentAsMain: true, name: "Carded" });
    await seedBlock(client, cardNodeId, "inside");
    const { unmount } = render(
      <WorkspaceDndHost>
        <NodeCardFrame client={client} nodeId={cardNodeId} onOpenNode={() => {}} onClose={() => {}} />
      </WorkspaceDndHost>,
    );

    fireEvent.keyDown(document, { key: "f", code: "KeyF", ctrlKey: true, shiftKey: true });
    await act(async () => {});
    expect(document.querySelector(".find-replace-widget")).toBeNull();

    unmount();
    // The main surface keeps the chord (control): the widget opens.
    const mainPageId = await client.createObject({ presentAsMain: true, name: "Main" });
    render(
      <WorkspaceDndHost>
        <PageView client={client} pageId={mainPageId} />
      </WorkspaceDndHost>,
    );
    fireEvent.keyDown(document, { key: "f", code: "KeyF", ctrlKey: true, shiftKey: true });
    await act(async () => {});
    expect(document.querySelector(".find-replace-widget")).not.toBeNull();
  });
});

describe("the rail card reorder", () => {
  function cardGrip(container: HTMLElement, cardNodeId: string): HTMLElement {
    const header = container.querySelector<HTMLElement>(
      `[data-header-droppable="workspace-card-header:${cardNodeId}"]`,
    );
    const grip = header?.querySelector<HTMLElement>(".nt-sidebar-card__grip");
    if (grip === null || grip === undefined) throw new Error("no reorder grip in card header");
    return grip;
  }

  /**
   * A pointer drag of `cardId`'s grip to document coordinates (x, y) —
   * over another card's header rect (its mock: -48 + index * 48, 32 tall).
   */
  function dragCardTo(container: HTMLElement, cardId: string, to: { x: number; y: number }): void {
    const grip = cardGrip(container, cardId);
    const origin = grip
      .closest(".nt-sidebar-card__header")!
      .getBoundingClientRect();
    fireEvent.pointerDown(grip, {
      clientX: origin.left + 20,
      clientY: origin.top + 16,
      button: 0,
      pointerId: 1,
    });
    // First move beyond the 4px activation distance so the drag starts.
    fireEvent.pointerMove(document, {
      clientX: origin.left + 24,
      clientY: origin.top + 20,
      buttons: 1,
      pointerId: 1,
    });
    let lastY = to.y;
    for (let i = 0; i < 3; i += 1) {
      lastY = to.y + i;
      fireEvent.pointerMove(document, { clientX: to.x, clientY: lastY, buttons: 1, pointerId: 1 });
    }
    fireEvent.pointerUp(document, { clientX: to.x, clientY: lastY, button: 0, pointerId: 1 });
  }

  function renderTwoCards(
    client: WorkspaceClient,
    first: string,
    second: string,
    onReorder: (active: string, target: string, position: "before" | "after") => void,
  ) {
    // Childless cards: the headers are the only droppables in play.
    return render(
      <WorkspaceDndHost onRailCardReorder={onReorder}>
        <NodeCardFrame client={client} nodeId={first} onOpenNode={() => {}} onClose={() => {}} />
        <NodeCardFrame client={client} nodeId={second} onOpenNode={() => {}} onClose={() => {}} />
      </WorkspaceDndHost>,
    );
  }

  it("dragging a card's grip below another card's header reorders after it", async () => {
    const client = await seedClient();
    const first = await client.createObject({ presentAsMain: true, name: "First" });
    const second = await client.createObject({ presentAsMain: true, name: "Second" });
    const calls: Array<[string, string, "before" | "after"]> = [];
    const { container } = renderTwoCards(client, first, second, (...args) => calls.push(args));

    // Card A's grip onto card B's header LOWER half (header mock: top 0,
    // midpoint 16).
    dragCardTo(container, first, { x: 40, y: 24 });
    await flushMoves();

    expect(calls).toEqual([[first, second, "after"]]);
    // A pure reorder report — the object graph never moved.
    expect(client.getNode(first)?.parentId ?? null).toBeNull();
  });

  it("dragging a card's grip above another card's header reorders before it", async () => {
    const client = await seedClient();
    const first = await client.createObject({ presentAsMain: true, name: "First" });
    const second = await client.createObject({ presentAsMain: true, name: "Second" });
    const calls: Array<[string, string, "before" | "after"]> = [];
    const { container } = renderTwoCards(client, first, second, (...args) => calls.push(args));

    // Card B's grip onto card A's header UPPER half (header mock: top -48,
    // midpoint -32).
    dragCardTo(container, second, { x: 40, y: -40 });
    await flushMoves();

    expect(calls).toEqual([[second, first, "before"]]);
  });

  it("shows the target header's reorder edge while a card drag hovers it", async () => {
    const client = await seedClient();
    const first = await client.createObject({ presentAsMain: true, name: "First" });
    const second = await client.createObject({ presentAsMain: true, name: "Second" });
    const { container } = renderTwoCards(client, first, second, () => {});

    const grip = cardGrip(container, first);
    const origin = grip.closest(".nt-sidebar-card__header")!.getBoundingClientRect();
    fireEvent.pointerDown(grip, {
      clientX: origin.left + 20,
      clientY: origin.top + 16,
      button: 0,
      pointerId: 1,
    });
    fireEvent.pointerMove(document, {
      clientX: origin.left + 24,
      clientY: origin.top + 20,
      buttons: 1,
      pointerId: 1,
    });
    for (let i = 0; i < 3; i += 1) {
      fireEvent.pointerMove(document, { clientX: 40, clientY: 24 + i, buttons: 1, pointerId: 1 });
    }

    // Capture the during-drag state, then end the drag — an assertion must
    // not throw while a drag is live (the sensor keeps document listeners).
    const secondHeader = container.querySelectorAll<HTMLElement>(".nt-sidebar-card__header")[1]!;
    const edgeClass = secondHeader.className;
    fireEvent.pointerUp(document, { clientX: 40, clientY: 26, button: 0, pointerId: 1 });
    await flushMoves();

    expect(edgeClass).toContain("nt-sidebar-card__header--reorder-after");
    // The edge clears at drag end.
    expect(container.querySelector(".nt-sidebar-card__header--reorder-after")).toBeNull();
  });

  it("dropping a card onto its own header reports nothing", async () => {
    const client = await seedClient();
    const first = await client.createObject({ presentAsMain: true, name: "First" });
    const second = await client.createObject({ presentAsMain: true, name: "Second" });
    const calls: Array<[string, string, "before" | "after"]> = [];
    const { container } = renderTwoCards(client, first, second, (...args) => calls.push(args));

    // Card A's grip back over its own header (upper half).
    dragCardTo(container, first, { x: 40, y: -40 });
    await flushMoves();

    expect(calls).toEqual([]);
  });

  it("the header drop keeps appending blocks while the reorder exists", async () => {
    // The two gestures share one header and must not conflict: a BLOCK
    // drag onto the grip-bearing header still appends as the last child.
    const client = await seedClient();
    const cardNodeId = await client.createObject({ presentAsMain: true, name: "Carded" });
    const a = await seedBlock(client, cardNodeId, "alpha");
    const b = await seedBlock(client, cardNodeId, "beta");
    const calls: Array<[string, string, "before" | "after"]> = [];
    const { container } = render(
      <WorkspaceDndHost onRailCardReorder={(...args) => calls.push(args)}>
        <NodeCardFrame client={client} nodeId={cardNodeId} onOpenNode={() => {}} onClose={() => {}} />
      </WorkspaceDndHost>,
    );
    const moveSpy = vi.spyOn(client, "moveObject");

    // Drag the card's first child onto the card header (header rect center).
    dragTo(container, a, { x: 40, y: -32 });
    await flushMoves();

    expect(moveSpy).toHaveBeenCalledTimes(1);
    expect(moveSpy).toHaveBeenCalledWith(a, cardNodeId);
    expect(client.getChildren(cardNodeId).map((child) => child.id)).toEqual([b, a]);
    // The reorder report stayed silent — no card drag happened.
    expect(calls).toEqual([]);
  });
});
