/**
 * Block drag-and-drop tests: dnd-kit-driven reorder/reparent over PageView
 * (jsdom). jsdom has no layout, so getBoundingClientRect is mocked to give
 * every block row a synthetic rect (stacked 40px apart in document order,
 * indented 24px per nesting depth; descendants resolve to their row's rect).
 * PointerSensor is driven with fireEvent pointer events targeted at the
 * document, where dnd-kit attaches its move/end listeners.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { MoveGuardError } from "@notees/store";

import type { OutlinePositionMap } from "../src/editor/outline.js";
import { WorkspaceClient } from "../src/core/workspace-client.js";
import {
  CHILD_DROP_OFFSET_PX,
  DROP_SNAP_MAX_DY_PX,
  dropCandidatesOf,
  edgeScrollVelocity,
  effectiveDragIds,
  executeStackPlan,
  nearestCandidate,
  planStackMove,
  scrollContainersOf,
  siblingFactsFromPositions,
  type DragRowRect,
} from "../src/ui/block-dnd.js";
import { PageView } from "../src/ui/PageView.js";
import { WorkspaceDndHost } from "../src/ui/useWorkspaceDnd.js";

/**
 * jsdom (without pretendToBeVisual) has no requestAnimationFrame: the drag
 * session's edge-scroll loop and the scroll re-measure ride a manual queue
 * the tests pump explicitly.
 */
const rafCallbacks = new Map<number, FrameRequestCallback>();
let rafNextId = 0;

/** Run `count` generations of queued rAF callbacks (each generation runs
 *  the callbacks scheduled by the previous one). */
function pumpFrames(count: number): void {
  for (let frame = 0; frame < count; frame += 1) {
    const pending = Array.from(rafCallbacks.values());
    rafCallbacks.clear();
    for (const callback of pending) callback(0);
  }
}

/** Simulated content scroll for the edge-scroll tests: row tops shift up by
 *  this many px, as after the scroller scrolled up. */
let layoutScrollShift = 0;

/**
 * The page renders inside the workspace drag session (the host owns the
 * DndContext now — PageView only registers its zone); every drag-driving
 * render wraps with it, as App does.
 */
function renderPage(client: WorkspaceClient, pageId: string) {
  return render(
    <WorkspaceDndHost>
      <PageView client={client} pageId={pageId} />
    </WorkspaceDndHost>,
  );
}

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
  window.requestAnimationFrame = ((callback: FrameRequestCallback): number => {
    rafNextId += 1;
    rafCallbacks.set(rafNextId, callback);
    return rafNextId;
  }) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number): void => {
    rafCallbacks.delete(id);
  }) as typeof window.cancelAnimationFrame;
  // Synthetic layout for the block rows (jsdom has none).
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const row = this.closest("[data-block-id]");
    if (row !== null) {
      const rows = Array.from(document.querySelectorAll("[data-block-id]"));
      const index = Math.max(0, rows.indexOf(row));
      let depth = 0;
      for (let el = row.parentElement; el !== null; el = el.parentElement) {
        if (el.classList.contains("nt-block-children")) depth += 1;
      }
      const left = depth * 24;
      const top = index * 40 - layoutScrollShift;
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

/** Page with three root blocks "one"/"two"/"three", in creation order. */
async function seedThreeBlocks(client: WorkspaceClient): Promise<{ pageId: string; ids: [string, string, string] }> {
  const pageId = await client.createObject({ presentAsMain: true, name: "DnD" });
  const one = await client.createObject({
    parentId: pageId,
    contentAst: [{ type: "text", text: "one" }],
  });
  const two = await client.createObject({
    parentId: pageId,
    contentAst: [{ type: "text", text: "two" }],
  });
  const three = await client.createObject({
    parentId: pageId,
    contentAst: [{ type: "text", text: "three" }],
  });
  return { pageId, ids: [one, two, three] };
}

function rowEl(container: HTMLElement, blockId: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-block-id="${blockId}"]`);
  if (el === null) throw new Error(`no row rendered for ${blockId}`);
  return el;
}

function gripOf(row: HTMLElement): HTMLElement {
  const el = row.querySelector<HTMLElement>(".nt-block-grip");
  if (el === null) throw new Error("no drag grip in row");
  return el;
}

function rootOrder(client: WorkspaceClient, pageId: string): string[] {
  return client.getBlockTree(pageId).map((t) => t.node.id);
}

/**
 * A minimal outline position map for the pure snap-model tests: [id,
 * parentId] pairs in document order; the previous sibling follows from the
 * order within each parent.
 */
function positionsOf(...entries: Array<[string, string | null]>): OutlinePositionMap {
  const map = new Map<
    string,
    { parentId: string | null; previousSiblingId: string | null; grandParentId: string | null }
  >();
  const lastSibling = new Map<string, string>();
  for (const [id, parentId] of entries) {
    const group = parentId ?? "(root)";
    map.set(id, {
      parentId,
      previousSiblingId: lastSibling.get(group) ?? null,
      grandParentId: null,
    });
    lastSibling.set(group, id);
  }
  return map;
}

/** Flush the microtasks the drop handler's async move chain runs on. */
async function flushMoves(): Promise<void> {
  await act(async () => {});
}

/**
 * Simulate a pointer drag of `fromId`'s grip onto `targetId`'s row.
 * `offsetX` within the shallow zone (< 48px) keeps the reorder intent;
 * `offsetX` 60 sits in the deep zone (child intent). `half` picks the drop
 * line within the row for reorder intents.
 */
function dragOnto(
  container: HTMLElement,
  fromId: string,
  targetId: string,
  opts: { offsetX?: number; half?: "top" | "bottom" } = {},
): { dropClass: string | undefined } {
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
  const target = rowEl(container, targetId).getBoundingClientRect();
  const x = target.left + (opts.offsetX ?? 4);
  const y = target.top + (opts.half === "top" ? 8 : 24);
  // A real pointer streams continuous moves. dnd-kit's dispatched onDragMove
  // trails the collision computation by one event (its over state commits in
  // an effect), so the final position is sent a few times with slightly
  // varying coordinates — identical coordinates are deduped — until the drop
  // indicator lands on the target row.
  let lastY = y;
  for (let i = 0; i < 3; i += 1) {
    lastY = y + i;
    fireEvent.pointerMove(document, { clientX: x, clientY: lastY, buttons: 1, pointerId: 1 });
  }
  const dropClass = rowEl(container, targetId).className.match(/nt-drop-(above|below|child)/)?.[0];
  fireEvent.pointerUp(document, { clientX: x, clientY: lastY, button: 0, pointerId: 1 });
  return { dropClass };
}

describe("block drag-and-drop", () => {
  it("reorders within a group: the drop line below a row lands after it", async () => {
    const client = await seedClient();
    const { pageId, ids } = await seedThreeBlocks(client);
    const [one, two, three] = ids;
    const { container } = renderPage(client, pageId);
    const moveSpy = vi.spyOn(client, "moveObject");

    // Drag "one" onto the lower half of "three": the drop line is below
    // "three", so it must land AFTER "three" — [two, three, one].
    const { dropClass } = dragOnto(container, one, three, { half: "bottom" });
    await flushMoves();

    // The indicator showed the below-line while dragging.
    expect(dropClass).toBe("nt-drop-below");
    expect(moveSpy).toHaveBeenCalledTimes(1);
    expect(moveSpy).toHaveBeenCalledWith(one, pageId, three);
    expect(rootOrder(client, pageId)).toEqual([two, three, one]);
  });

  it("reorders to the top of a group via the two-move first-slot swap", async () => {
    const client = await seedClient();
    const { pageId, ids } = await seedThreeBlocks(client);
    const [one, two, three] = ids;
    const { container } = renderPage(client, pageId);
    const moveSpy = vi.spyOn(client, "moveObject");

    // Drag "three" onto the upper half of "one": the drop line is above the
    // first sibling (no "row above" to anchor afterId to), executed as
    // three-after-one then one-after-three.
    const { dropClass } = dragOnto(container, three, one, { half: "top" });
    await flushMoves();

    expect(dropClass).toBe("nt-drop-above");
    expect(moveSpy).toHaveBeenCalledTimes(2);
    expect(moveSpy).toHaveBeenNthCalledWith(1, three, pageId, one);
    expect(moveSpy).toHaveBeenNthCalledWith(2, one, pageId, three);
    expect(rootOrder(client, pageId)).toEqual([three, one, two]);
  });

  it("deep drop (pointer in the row's right zone) reparents as a child", async () => {
    const client = await seedClient();
    const { pageId, ids } = await seedThreeBlocks(client);
    const [one, two, three] = ids;
    const { container } = renderPage(client, pageId);
    const moveSpy = vi.spyOn(client, "moveObject");

    // Drag "two" onto the deep zone of "one": child intent.
    const { dropClass } = dragOnto(container, two, one, { offsetX: 60 });
    await flushMoves();

    expect(dropClass).toBe("nt-drop-child");
    expect(moveSpy).toHaveBeenCalledTimes(1);
    expect(moveSpy).toHaveBeenCalledWith(two, one);
    const tree = client.getBlockTree(pageId);
    // "three" stays a root; "two" moved under "one".
    expect(tree.map((t) => t.node.id)).toEqual([one, three]);
    expect(tree[0]!.children.map((t) => t.node.id)).toEqual([two]);
    expect(client.getNode(two)?.parentId).toBe(one);
  });

  it("refuses a drop into the block's own subtree: banner, no move issued", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Cycle" });
    const parent = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "parent" }],
    });
    const child = await client.createObject({
      parentId: parent,
      contentAst: [{ type: "text", text: "child" }],
    });
    const { container } = renderPage(client, pageId);
    const moveSpy = vi.spyOn(client, "moveObject");

    // Drag "parent" onto its own child (deep zone → child intent).
    dragOnto(container, parent, child, { offsetX: 60 });
    await flushMoves();

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("own subtree");
    expect(moveSpy).not.toHaveBeenCalled();
    // State untouched.
    const tree = client.getBlockTree(pageId);
    expect(tree.map((t) => t.node.id)).toEqual([parent]);
    expect(tree[0]!.children.map((t) => t.node.id)).toEqual([child]);
  });

  it("surfaces a store MoveGuardError as the transient message, state unchanged", async () => {
    const client = await seedClient();
    const { pageId, ids } = await seedThreeBlocks(client);
    const [one, two, three] = ids;
    const { container } = renderPage(client, pageId);
    vi.spyOn(client, "moveObject").mockRejectedValueOnce(
      new MoveGuardError(
        "object.move: node 0192a000-0000-7000-8000-0000000000c1 is a class; classes are tree-external and cannot have children",
        "object.move",
      ),
    );

    dragOnto(container, one, three, { half: "bottom" });
    await flushMoves();

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("classes are tree-external");
    expect(rootOrder(client, pageId)).toEqual([one, two, three]);
  });

  it("keyboard sensor moves the block down one slot", async () => {
    const client = await seedClient();
    const { pageId, ids } = await seedThreeBlocks(client);
    const [one, two, three] = ids;
    const { container } = renderPage(client, pageId);
    const moveSpy = vi.spyOn(client, "moveObject");

    const grip = gripOf(rowEl(container, one));
    grip.focus();
    // Lift.
    fireEvent.keyDown(grip, { code: "Space", key: " " });
    // The sensor attaches its document keydown listener on a timer.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Arrow down → over "two"; the keyboard drop anchors below it.
    fireEvent.keyDown(grip, { code: "ArrowDown", key: "ArrowDown" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.keyDown(grip, { code: "Space", key: " " });
    await flushMoves();

    expect(moveSpy).toHaveBeenCalledTimes(1);
    expect(moveSpy).toHaveBeenCalledWith(one, pageId, two);
    expect(rootOrder(client, pageId)).toEqual([two, one, three]);
  });

  it("keeps the dragged row pinned and muted; the overlay chip is the only preview", async () => {
    const client = await seedClient();
    const { pageId, ids } = await seedThreeBlocks(client);
    const [one, two] = ids;
    const { container } = renderPage(client, pageId);

    const fromRect = rowEl(container, one).getBoundingClientRect();
    const grip = gripOf(rowEl(container, one));
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

    // In free flight (no drop target near) the filled card rides the pointer.
    const ghost = document.querySelector<HTMLElement>(".nt-drag-ghost");
    expect(ghost).not.toBeNull();
    expect(ghost!.textContent).toContain("one");
    expect(ghost!.querySelector("[data-block-id]")).toBeNull();
    expect(document.querySelector(".nt-drop-preview")).toBeNull();

    // The source row stays in place (no drag transform) and reads muted.
    const source = rowEl(container, one);
    expect(source.className).toContain("nt-block--drag-source");
    expect(source.style.transform).toBe("");

    // Onto a target: the card parks below the indicator line and the
    // pointer-riding chip steps aside.
    const target = rowEl(container, two).getBoundingClientRect();
    for (let i = 0; i < 3; i += 1) {
      fireEvent.pointerMove(document, {
        clientX: target.left + 4,
        clientY: target.top + 24 + i,
        buttons: 1,
        pointerId: 1,
      });
    }
    expect(rowEl(container, two).className).toContain("nt-drop-below");
    expect(document.querySelector(".nt-drag-ghost")).toBeNull();
    const preview = document.body.querySelector<HTMLElement>(".nt-drop-preview");
    expect(preview).not.toBeNull();
    expect(preview!.textContent).toContain("one");
    // Parked at the anchor: left = the row's gutter x, top just below the line.
    expect(preview!.style.left).toBe(`${target.left}px`);
    expect(preview!.style.top).toBe(`${target.top + target.height + 4}px`);

    fireEvent.pointerUp(document, {
      clientX: target.left + 4,
      clientY: target.top + 26,
      button: 0,
      pointerId: 1,
    });
    await flushMoves();
    expect(document.body.querySelector(".nt-drop-preview")).toBeNull();
    expect(rowEl(container, one).className).not.toContain("nt-block--drag-source");
  });

  it("the drag preview is frozen: no row carries a transform, only the line renders", async () => {
    const client = await seedClient();
    const { pageId, ids } = await seedThreeBlocks(client);
    const [one, two] = ids;
    const { container } = renderPage(client, pageId);

    const fromRect = rowEl(container, one).getBoundingClientRect();
    const grip = gripOf(rowEl(container, one));
    fireEvent.pointerDown(grip, {
      clientX: fromRect.left + 200,
      clientY: fromRect.top + 16,
      button: 0,
      pointerId: 1,
    });
    const target = rowEl(container, two).getBoundingClientRect();
    for (let i = 0; i < 3; i += 1) {
      fireEvent.pointerMove(document, {
        clientX: target.left + 4,
        clientY: target.top + 24 + i,
        buttons: 1,
        pointerId: 1,
      });
    }

    // The highlight line is the only live feedback — every row sits exactly
    // where it started (no sortable strategy transform anywhere).
    expect(rowEl(container, two).className).toContain("nt-drop-below");
    for (const row of container.querySelectorAll<HTMLElement>("[data-block-id]")) {
      expect(row.style.transform).toBe("");
      expect(row.style.transition).toBe("");
    }

    fireEvent.pointerUp(document, {
      clientX: target.left + 4,
      clientY: target.top + 26,
      button: 0,
      pointerId: 1,
    });
    await flushMoves();
  });

  it("dragging the grip of a selected row drags the whole stack: roots only, order kept", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "DnD" });
    const texts = ["one", "two", "three", "four"];
    const ids: string[] = [];
    for (const text of texts) {
      ids.push(await client.createObject({
        parentId: pageId,
        contentAst: [{ type: "text", text }],
      }));
    }
    const [one, two, , four] = ids as [string, string, string, string];
    const { container } = renderPage(client, pageId);
    const moveSpy = vi.spyOn(client, "moveObject");

    // Ctrl+click "one" and "three" — the level-capped stack {one, three}.
    const contents = Array.from(container.querySelectorAll<HTMLElement>(".nt-block-content"));
    fireEvent.click(contents[0]!, { ctrlKey: true });
    fireEvent.click(contents[2]!, { ctrlKey: true });

    // Drag the grip of "three" (any selected row's grip drags the stack).
    const fromRect = rowEl(container, ids[2]!).getBoundingClientRect();
    const grip = gripOf(rowEl(container, ids[2]!));
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
    const target = rowEl(container, four).getBoundingClientRect();
    const x = target.left + 4;
    const y = target.top + 24;
    for (let i = 0; i < 3; i += 1) {
      fireEvent.pointerMove(document, { clientX: x, clientY: y + i, buttons: 1, pointerId: 1 });
    }

    // The card parked below the line names the stack and carries the lead
    // block's text; the pointer-riding chip steps aside once snapped.
    const ghost = document.querySelector<HTMLElement>(".nt-drag-ghost");
    expect(ghost).toBeNull();
    const preview = document.body.querySelector<HTMLElement>(".nt-drop-preview");
    expect(preview).not.toBeNull();
    expect(preview!.textContent).toContain("2 blocks");
    expect(preview!.textContent).toContain("one");
    expect(rowEl(container, one).className).toContain("nt-block--drag-source");
    expect(rowEl(container, ids[2]!).className).toContain("nt-block--drag-source");
    expect(rowEl(container, two).className).not.toContain("nt-block--drag-source");

    fireEvent.pointerUp(document, { clientX: x, clientY: y + 2, button: 0, pointerId: 1 });
    await flushMoves();

    // one lands after four, three after one — internal order kept.
    expect(moveSpy).toHaveBeenCalledTimes(2);
    expect(moveSpy).toHaveBeenNthCalledWith(1, one, pageId, four);
    expect(moveSpy).toHaveBeenNthCalledWith(2, ids[2], pageId, one);
    expect(rootOrder(client, pageId)).toEqual([two, four, one, ids[2]]);
  });

  it("the portaled indicator repaints the line above the chip at the snapped anchor", async () => {
    const client = await seedClient();
    const { pageId, ids } = await seedThreeBlocks(client);
    const [one, two] = ids;
    const { container } = renderPage(client, pageId);

    const fromRect = rowEl(container, one).getBoundingClientRect();
    const grip = gripOf(rowEl(container, one));
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
    const target = rowEl(container, two).getBoundingClientRect();
    for (let i = 0; i < 3; i += 1) {
      fireEvent.pointerMove(document, {
        clientX: 4,
        clientY: target.top + 8 + i,
        buttons: 1,
        pointerId: 1,
      });
    }

    // The portal rides in document.body, above the DragOverlay chip, at the
    // snapped anchor: "above two" anchors at (two.left, two.top) with the
    // row's width (synthetic layout: left 0, top 80, width 400).
    const portal = document.body.querySelector<HTMLElement>(".nt-drop-indicator");
    expect(portal).not.toBeNull();
    expect(portal!.style.left).toBe("0px");
    expect(portal!.style.top).toBe("79px");
    expect(portal!.style.width).toBe("400px");

    fireEvent.pointerUp(document, { clientX: 4, clientY: target.top + 10, button: 0, pointerId: 1 });
    await flushMoves();
    expect(document.body.querySelector(".nt-drop-indicator")).toBeNull();
  });

  it("edge auto-scroll scrolls a scrollable view at the pointer's edge; a scroll re-anchors the drop line", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Scroll" });
    const ids: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      ids.push(await client.createObject({
        parentId: pageId,
        contentAst: [{ type: "text", text: `b${i}` }],
      }));
    }
    const { container } = render(
      <WorkspaceDndHost>
        <div data-testid="scroller" style={{ overflowY: "auto" }}>
          <PageView client={client} pageId={pageId} />
        </div>
      </WorkspaceDndHost>,
    );
    const scroller = screen.getByTestId("scroller");
    Object.defineProperty(scroller, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 400, configurable: true });
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 400, width: 800, height: 400,
      toJSON: () => ({}),
    } as DOMRect);
    const moveSpy = vi.spyOn(client, "moveObject");

    const fromRect = rowEl(container, ids[0]!).getBoundingClientRect();
    const grip = gripOf(rowEl(container, ids[0]!));
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
    // Into the bottom edge band of the scroller (y 380 of 400), shallow x so
    // a reorder intent (not the child anchor) wins the projection.
    fireEvent.pointerMove(document, {
      clientX: 10,
      clientY: 380,
      buttons: 1,
      pointerId: 1,
    });

    // The frozen preview means no row is near y 380 yet — no drop line.
    expect(rowEl(container, ids[17]!).className).not.toContain("nt-drop-above");
    act(() => {
      pumpFrames(3);
    });
    // The pointer sat in the edge band: the scroller scrolled on its own.
    expect(scroller.scrollTop).toBeGreaterThan(0);

    // The scroll reveals row 17 at the pointer: the scroll listener
    // re-measures every zone and re-projects the line at the last pointer.
    // (The page title row occupies mock index 0, so b17's row top is
    // 18 * 40 − shift — a 340px shift parks its divider at the pointer.)
    layoutScrollShift = 340;
    fireEvent.scroll(scroller);
    act(() => {
      pumpFrames(2);
    });
    expect(rowEl(container, ids[17]!).className).toContain("nt-drop-above");

    // The drop resolves against the re-anchored set: b0 lands below b16.
    layoutScrollShift = 0;
    fireEvent.pointerUp(document, {
      clientX: 10,
      clientY: 380,
      button: 0,
      pointerId: 1,
    });
    await flushMoves();
    expect(moveSpy).toHaveBeenCalledWith(ids[0], pageId, ids[16]);
    // b0 moved out of slot 0: it lands right after b16, b17+ shift down.
    expect(rootOrder(client, pageId).slice(15, 19)).toEqual([ids[16], ids[0], ids[17], ids[18]]);
  });
});

describe("drag-session snap model", () => {
  it("builds a sibling pair plus a child candidate per row, excluding the dragged subtree", () => {
    const positions = positionsOf(["a", null], ["b", "a"], ["c", null]);
    const rows: DragRowRect[] = [
      { id: "a", left: 0, top: 0, width: 400, height: 32 },
      { id: "b", left: 28, top: 32, width: 372, height: 32 },
      { id: "c", left: 0, top: 64, width: 400, height: 32 },
    ];
    const candidates = dropCandidatesOf(positions, "a", rows);

    // The dragged block and its descendant are not drop targets.
    expect(candidates.filter((c) => c.targetId === "a" || c.targetId === "b")).toEqual([]);
    expect(candidates.map((c) => `${c.targetId}:${c.intent}`)).toEqual([
      "c:above",
      "c:below",
      "c:child",
    ]);
    // Sibling anchors sit at the row's divider at the row's gutter x; the
    // child anchor rides the row's BOTTOM divider at the child-offset x —
    // every anchor's y is an element boundary, and sibling + child
    // candidates share the bottom divider so indentation picks the level.
    expect(candidates[0]).toMatchObject({ targetId: "c", anchorX: 0, anchorY: 64 });
    expect(candidates[1]).toMatchObject({ targetId: "c", anchorX: 0, anchorY: 96 });
    expect(candidates[2]).toMatchObject({
      targetId: "c",
      anchorX: CHILD_DROP_OFFSET_PX,
      anchorY: 96,
    });
  });

  it("stacks every nesting level at one divider: the pointer's indentation picks the level", () => {
    // p (top level) with one child c; x is dragged. The boundary below p's
    // subtree — p's element bottom, which is also c's element bottom — hosts
    // three candidates at the same y: a top-level sibling after p, a depth-1
    // sibling after c, and a first child of either (p's child slot == after
    // c; c's child slot is one indent deeper). x picks among them.
    const positions = positionsOf(["x", null], ["p", null], ["c", "p"]);
    const rows: DragRowRect[] = [
      { id: "x", left: 0, top: 60, width: 400, height: 15 },
      { id: "p", left: 0, top: 0, width: 400, height: 30 },
      { id: "c", left: 24, top: 15, width: 376, height: 15 },
    ];
    const candidates = dropCandidatesOf(positions, "x", rows);
    const at = (x: number) => nearestCandidate({ x, y: 30 }, candidates);

    // Page gutter: a top-level sibling after p (≡ right before the next
    // top-level row).
    expect(at(0)).toMatchObject({ targetId: "p", intent: "below" });
    // The child's gutter: a sibling after c, one level deep under p.
    expect(at(24)).toMatchObject({ targetId: "c", intent: "below" });
    // The child-offset bands: p's child slot (48px) vs c's (72px).
    expect(at(56)).toMatchObject({ targetId: "p", intent: "child" });
    expect(at(64)).toMatchObject({ targetId: "c", intent: "child" });
  });

  it("projects a shallow mid-row pointer to above or below by the row half", () => {
    const positions = positionsOf(["x", null], ["r", null]);
    const rows: DragRowRect[] = [
      { id: "x", left: 0, top: 0, width: 400, height: 32 },
      { id: "r", left: 24, top: 40, width: 376, height: 32 },
    ];
    const candidates = dropCandidatesOf(positions, "x", rows);

    // Upper half → the line above the row.
    expect(nearestCandidate({ x: 26, y: 51 }, candidates)).toMatchObject({
      targetId: "r",
      intent: "above",
    });
    // Lower half → the line below the row.
    expect(nearestCandidate({ x: 26, y: 59 }, candidates)).toMatchObject({
      targetId: "r",
      intent: "below",
    });
  });

  it("projects a deep-x pointer mid-row to the child intent", () => {
    const positions = positionsOf(["x", null], ["r", null]);
    const rows: DragRowRect[] = [
      { id: "x", left: 0, top: 0, width: 400, height: 32 },
      { id: "r", left: 24, top: 40, width: 376, height: 32 },
    ];
    const candidates = dropCandidatesOf(positions, "x", rows);

    expect(nearestCandidate({ x: 80, y: 56 }, candidates)).toMatchObject({
      targetId: "r",
      intent: "child",
    });
  });

  it("disambiguates the hierarchy-end gap by x bands across three nearby candidates", () => {
    // An expanded parent with one child; the pointer hovers the gap right
    // below the child's bottom edge. The compact rows keep the gap-adjacent
    // anchors inside the default snap band: the parent's below-divider, the
    // child's below-divider, and the child-slot anchors at the child-offset
    // x. Three candidates compete for the same strip, nearest x wins, and
    // the line renders at the winning depth.
    const positions = positionsOf(["x", null], ["p", null], ["c", "p"]);
    const rows: DragRowRect[] = [
      { id: "x", left: 0, top: 60, width: 400, height: 15 },
      { id: "p", left: 0, top: 0, width: 400, height: 15 },
      { id: "c", left: 24, top: 15, width: 376, height: 15 },
    ];
    const candidates = dropCandidatesOf(positions, "x", rows);
    const at = (x: number) => nearestCandidate({ x, y: 31 }, candidates);

    // Near the parent's gutter: a sibling after the parent, the line at the
    // parent's depth.
    expect(at(0)).toMatchObject({ targetId: "p", intent: "below" });
    // Near the last child's gutter: a sibling after the child, the line at
    // the child's depth.
    expect(at(24)).toMatchObject({ targetId: "c", intent: "below" });
    // Deep at the child offset: the child slot of the row above the gap —
    // appending there fills the same slot a parent-append would, nested
    // under the nearest row.
    expect(at(60)).toMatchObject({ targetId: "c", intent: "child" });
  });

  it("returns null when nothing is near", () => {
    const positions = positionsOf(["x", null], ["r", null]);
    const rows: DragRowRect[] = [
      { id: "x", left: 0, top: 0, width: 400, height: 32 },
      { id: "r", left: 24, top: 40, width: 376, height: 32 },
    ];
    const candidates = dropCandidatesOf(positions, "x", rows);

    expect(DROP_SNAP_MAX_DY_PX).toBe(24);
    // Far in y from every anchor.
    expect(nearestCandidate({ x: 26, y: 400 }, candidates)).toBeNull();
    // A tighter threshold turns a near miss into nothing.
    expect(nearestCandidate({ x: 26, y: 51 }, candidates, { maxDyPx: 4 })).toBeNull();
    expect(nearestCandidate({ x: 26, y: 51 }, [])).toBeNull();
  });
});

describe("selection-stack planner", () => {
  const factsOf = (...entries: Array<[string, string | null]>) =>
    siblingFactsFromPositions(positionsOf(...entries));

  it("orders the effective drag set in document order", () => {
    const positions = positionsOf(["a", null], ["b", "a"], ["c", null]);
    expect(effectiveDragIds(new Set(["c", "a"]), positions)).toEqual(["a", "c"]);
    expect(effectiveDragIds(new Set(), positions)).toEqual([]);
  });

  it("plans a reorder drop as one chained move per stack block", () => {
    const facts = factsOf(["a", "root"], ["b", "root"], ["c", "root"], ["d", "root"]);
    const plan = planStackMove(["a", "b"], { targetId: "d", intent: "below" }, facts);

    expect(plan.status).toBe("move");
    if (plan.status !== "move") return;
    expect(plan.moves.map((move) => [move.id, move.command])).toEqual([
      ["a", { kind: "reorder", parentId: "root", afterId: "d" }],
      ["b", { kind: "reorder", parentId: "root", afterId: "a" }],
    ]);
    // a moves, so b must be re-anchored on it even though b's current
    // previous sibling already IS a (the prefix gate).
    expect(plan.moves.map((move) => move.alreadyThere)).toEqual([false, false]);
  });

  it("skips a block only while the stack prefix before it stays put", async () => {
    // The stack [a, c] already sits right after x; b stays behind.
    const facts = factsOf(["x", "root"], ["a", "root"], ["b", "root"], ["c", "root"]);
    const plan = planStackMove(["a", "c"], { targetId: "x", intent: "below" }, facts);
    expect(plan.status).toBe("move");
    if (plan.status !== "move") return;
    expect(plan.moves.map((move) => [move.id, move.command, move.alreadyThere])).toEqual([
      ["a", { kind: "reorder", parentId: "root", afterId: "x" }, true],
      ["c", { kind: "reorder", parentId: "root", afterId: "a" }, false],
    ]);

    const calls: Array<[string, string | null, string | undefined]> = [];
    await executeStackPlan(plan.moves, async (id, parentId, afterId) => {
      calls.push([id, parentId, afterId]);
    });
    // Only c issues — a already sits at the anchor.
    expect(calls).toEqual([["c", "root", "a"]]);
  });

  it("the whole plan is a noop when the stack already sits at the drop spot", () => {
    const facts = factsOf(["x", "root"], ["a", "root"], ["b", "root"]);
    expect(planStackMove(["a", "b"], { targetId: "x", intent: "below" }, facts).status).toBe("noop");
  });

  it("plans the first-slot reorder as the three-phase swap and executes it in order", async () => {
    // Current [x, a, c, b]: the stack [a, b] drops ABOVE x (first slot).
    const facts = factsOf(["x", "root"], ["a", "root"], ["c", "root"], ["b", "root"]);
    const plan = planStackMove(["a", "b"], { targetId: "x", intent: "above" }, facts);

    expect(plan.status).toBe("move");
    if (plan.status !== "move") return;
    expect(plan.moves[0]).toMatchObject({
      id: "a",
      command: { kind: "reorder", parentId: "root", afterId: null },
      firstSlotSwapWith: "x",
    });
    expect(plan.moves[1]).toMatchObject({
      id: "b",
      command: { kind: "reorder", parentId: "root", afterId: "a" },
    });

    const calls: Array<[string, string | null, string | undefined]> = [];
    await executeStackPlan(plan.moves, async (id, parentId, afterId) => {
      calls.push([id, parentId, afterId]);
    });
    expect(calls).toEqual([
      ["a", "root", "x"],
      ["b", "root", "a"],
      ["x", "root", "b"],
    ]);
  });

  it("plans a child drop appending the stack in order", async () => {
    const facts = factsOf(["p", "root"], ["a", "root"], ["b", "root"]);
    const plan = planStackMove(["a", "b"], { targetId: "p", intent: "child" }, facts);

    expect(plan.status).toBe("move");
    if (plan.status !== "move") return;
    expect(plan.moves.map((move) => [move.id, move.command])).toEqual([
      ["a", { kind: "child", parentId: "p" }],
      ["b", { kind: "child", parentId: "p" }],
    ]);
    const calls: Array<[string, string | null, string | undefined]> = [];
    await executeStackPlan(plan.moves, async (id, parentId, afterId) => {
      calls.push([id, parentId, afterId]);
    });
    expect(calls).toEqual([
      ["a", "p", undefined],
      ["b", "p", undefined],
    ]);
  });

  it("refuses dropping the stack into its own subtree, per block", () => {
    const facts = factsOf(["p", "root"], ["k", "p"], ["s", "root"]);
    const plan = planStackMove(["p", "s"], { targetId: "k", intent: "child" }, facts);
    expect(plan.status).toBe("refused");
    if (plan.status === "refused") expect(plan.reason).toContain("own subtree");
  });
});

describe("drag edge auto-scroll", () => {
  it("ramps the scroll speed by edge proximity and gates on scrollability", () => {
    const rect = { rectTop: 100, rectHeight: 400 };
    const both = { canScrollUp: true, canScrollDown: true };
    // At the very edges: full speed; the ramp floors at zero past the band.
    expect(edgeScrollVelocity({ pointerY: 100, ...rect, ...both })).toBe(-6);
    expect(edgeScrollVelocity({ pointerY: 500, ...rect, ...both })).toBe(6);
    expect(edgeScrollVelocity({ pointerY: 120, ...rect, ...both })).toBe(-3);
    expect(edgeScrollVelocity({ pointerY: 480, ...rect, ...both })).toBe(3);
    // Deep inside or outside the rect: nothing.
    expect(edgeScrollVelocity({ pointerY: 300, ...rect, ...both })).toBe(0);
    expect(edgeScrollVelocity({ pointerY: 560, ...rect, ...both })).toBe(0);
    // No scrollable room in that direction: nothing.
    expect(edgeScrollVelocity({ pointerY: 100, ...rect, canScrollUp: false, canScrollDown: true })).toBe(0);
    expect(edgeScrollVelocity({ pointerY: 500, ...rect, canScrollUp: true, canScrollDown: false })).toBe(0);
  });

  it("the nearer edge wins on a container shorter than twice the band", () => {
    // A 60px container with a 40px band: the middle is in both bands.
    expect(
      edgeScrollVelocity({ pointerY: 130, rectTop: 100, rectHeight: 60, canScrollUp: true, canScrollDown: true }),
    ).toBe(-2);
    expect(
      edgeScrollVelocity({ pointerY: 135, rectTop: 100, rectHeight: 60, canScrollUp: true, canScrollDown: true }),
    ).toBe(3);
  });

  it("collects overflowing overflow-y ancestors, innermost first, and skips the rest", () => {
    const root = document.createElement("div");
    const mid = document.createElement("div");
    const outer = document.createElement("div");
    mid.style.overflowY = "auto";
    outer.style.overflowY = "auto";
    outer.appendChild(mid);
    mid.appendChild(root);
    document.body.appendChild(outer);
    const mockScroll = (el: HTMLElement, scrollHeight: number, clientHeight: number) => {
      Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
      Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
    };

    mockScroll(mid, 1000, 400);
    mockScroll(outer, 400, 400); // not overflowing
    expect(scrollContainersOf(root)).toEqual([mid]);

    mockScroll(outer, 900, 400);
    expect(scrollContainersOf(root)).toEqual([mid, outer]);
    expect(scrollContainersOf(null)).toEqual([]);
    outer.remove();

    // The PageView case: the zone root WRAPS the scroller — the scrolling
    // cell is the root's descendant, not an ancestor (owner 2026-10-14:
    // without the subtree sweep, edge auto-scroll never armed).
    const wrapRoot = document.createElement("div");
    const inner = document.createElement("div");
    inner.style.overflowY = "auto";
    wrapRoot.appendChild(inner);
    document.body.appendChild(wrapRoot);
    mockScroll(inner, 1200, 400);
    mockScroll(wrapRoot, 400, 400); // not overflowing itself
    expect(scrollContainersOf(wrapRoot)).toEqual([inner]);
    wrapRoot.remove();
  });
});
