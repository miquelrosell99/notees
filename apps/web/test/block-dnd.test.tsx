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
  nearestCandidate,
  type DragRowRect,
} from "../src/ui/block-dnd.js";
import { PageView } from "../src/ui/PageView.js";
import { WorkspaceDndHost } from "../src/ui/useWorkspaceDnd.js";

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
    const [one] = ids;
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

    // The source row stays in place (no drag transform) and reads muted.
    const source = rowEl(container, one);
    expect(source.className).toContain("nt-block--drag-source");
    expect(source.style.transform).toBe("");
    // The floating overlay is the small name chip — no block preview inside.
    const ghost = document.querySelector<HTMLElement>(".nt-drag-ghost");
    expect(ghost).not.toBeNull();
    expect(ghost!.textContent).toContain("one");
    expect(ghost!.querySelector("[data-block-id]")).toBeNull();

    fireEvent.pointerUp(document, {
      clientX: fromRect.left + 210,
      clientY: fromRect.top + 16,
      button: 0,
      pointerId: 1,
    });
    await flushMoves();
    expect(rowEl(container, one).className).not.toContain("nt-block--drag-source");
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
    // child anchor rides at the child-offset x, vertically centered.
    expect(candidates[0]).toMatchObject({ targetId: "c", anchorX: 0, anchorY: 64 });
    expect(candidates[1]).toMatchObject({ targetId: "c", anchorX: 0, anchorY: 96 });
    expect(candidates[2]).toMatchObject({
      targetId: "c",
      anchorX: CHILD_DROP_OFFSET_PX,
      anchorY: 80,
    });
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
