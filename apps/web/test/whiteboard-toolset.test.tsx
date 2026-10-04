/**
 * Whiteboard toolset tests — the §34.19 whiteboard full-toolset row over the
 * live canvas (WorkspaceClient + MemoryRelay, jsdom): the tool palette
 * (select/move, card, sticky, rect/ellipse/line/arrow, stroke, text,
 * connector), one-shot tool switching, placements (sticky note = colored
 * child block, text = chrome-only layout element), drag-drawing with
 * connector anchor snapping and grid snap, keyboard affordances (Delete /
 * Backspace remove the selection, arrows nudge, Esc exits a tool, keys are
 * ignored while editing card text), multi-select + group gestures (shift
 * accumulation, multi-card drag coalesced to one write), alignment and
 * distribution helpers, the §34.43 color + stroke-width formatting surfaces,
 * and the minimap/zoom controls. Geometry always lands through the token
 * layout; cards stay child blocks (the model law).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import type { ContentAst } from "@notees/protocol";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";
import {
  parseWhiteboardLayout,
  serializeWhiteboardLayout,
} from "../src/ui/WhiteboardCanvas.js";
import type { WhiteboardLayout } from "../src/ui/WhiteboardCanvas.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

// jsdom has no PointerEvent (see whiteboard-canvas.test.tsx): a minimal
// polyfill makes pointer events first-class in the harness.
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

function text(value: string): ContentAst {
  return [{ type: "text", text: value }];
}

function whiteboardAst(layout?: unknown): ContentAst {
  return [{ type: "whiteboard", layout }] as unknown as ContentAst;
}

async function seedWhiteboardPage(client: WorkspaceClient, layout?: unknown): Promise<string> {
  return client.createObject({ presentAsMain: true, name: "Board", contentAst: whiteboardAst(layout) });
}

function storedLayout(client: WorkspaceClient, hostId: string): WhiteboardLayout {
  const host = client.getNode(hostId);
  expect(host).toBeDefined();
  const token = host!.contentAst[0] as { type: string; layout?: unknown };
  expect(token.type).toBe("whiteboard");
  return parseWhiteboardLayout(token.layout);
}

function surfaceEl(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>(".nt-wb-surface");
  if (el === null) throw new Error("no .nt-wb-surface rendered");
  return el;
}

function cardEl(container: HTMLElement, cardId: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-card-id="${cardId}"]`);
  if (el === null) throw new Error(`no card rendered for ${cardId}`);
  return el;
}

function shapeEls(container: HTMLElement): SVGGElement[] {
  return [...container.querySelectorAll<SVGGElement>(".nt-wb-shape")];
}

/** Drag on the surface with the given button/shift. */
function dragSurface(
  container: HTMLElement,
  from: { x: number; y: number },
  to: { x: number; y: number },
  opts: { shiftKey?: boolean } = {},
): void {
  const surface = surfaceEl(container);
  fireEvent.pointerDown(surface, { clientX: from.x, clientY: from.y, button: 0, pointerId: 1, shiftKey: opts.shiftKey });
  fireEvent.pointerMove(surface, { clientX: to.x, clientY: to.y, pointerId: 1 });
  fireEvent.pointerUp(surface, { pointerId: 1 });
}

async function flush(): Promise<void> {
  await act(async () => {});
}

describe("whiteboard toolset layout schema", () => {
  it("round-trips the toolset fields (line/text kinds, colors, widths)", () => {
    const layout: WhiteboardLayout = {
      cards: {},
      shapes: [
        { id: "s1", kind: "line", x: 0, y: 0, w: 100, h: 40, color: "red", strokeWidth: 4 },
        { id: "s2", kind: "text", x: 5, y: 6, w: 160, h: 24, label: "chrome" },
        { id: "s3", kind: "arrow", x: 1, y: 2, w: 3, h: 4, color: "#a1b2c3" },
      ],
      strokes: [
        { id: "p1", points: [1, 2, 3, 4], color: "sky", width: 8 },
        { id: "p2", points: [5, 6, 7, 8], highlight: true },
      ],
    };
    expect(parseWhiteboardLayout(serializeWhiteboardLayout(layout))).toEqual(layout);
  });

  it("tolerant parse: malformed toolset fields are dropped, never fatal", () => {
    const parsed = parseWhiteboardLayout({
      shapes: [
        // Retired §34.43 var() encoding and garbage colors do not survive.
        { id: "s1", kind: "line", x: 0, y: 0, w: 10, h: 0, color: "var(--color-preset-red)" },
        { id: "s2", kind: "rect", x: 0, y: 0, w: 10, h: 10, color: "not-a-color", strokeWidth: 0 },
        { id: "s3", kind: "text", x: 0, y: 0, w: 10, h: 10, strokeWidth: -3 },
      ],
      strokes: [
        { id: "p1", points: [1, 2, 3, 4], color: "#GGGGGG", width: Number.NaN, highlight: "yes" },
      ],
    });
    expect(parsed.shapes).toEqual([
      { id: "s1", kind: "line", x: 0, y: 0, w: 10, h: 0 },
      { id: "s2", kind: "rect", x: 0, y: 0, w: 10, h: 10 },
      { id: "s3", kind: "text", x: 0, y: 0, w: 10, h: 10 },
    ]);
    expect(parsed.strokes).toEqual([{ id: "p1", points: [1, 2, 3, 4] }]);
  });
});

describe("whiteboard tool palette", () => {
  it("switches tools with one active at a time; Esc exits to select", async () => {
    const client = await seedClient();
    const host = await seedWhiteboardPage(client);
    const { container } = render(<PageView client={client} pageId={host} />);

    fireEvent.click(screen.getByRole("button", { name: "Add rectangle" }));
    expect(screen.getByRole("button", { name: "Add rectangle" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Select / move" }).getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Draw stroke" }));
    expect(screen.getByRole("button", { name: "Draw stroke" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Add rectangle" }).getAttribute("aria-pressed")).toBe("false");

    fireEvent.keyDown(surfaceEl(container), { key: "Escape" });
    expect(screen.getByRole("button", { name: "Draw stroke" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Select / move" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("lists the full palette the §34.19 row names", async () => {
    const client = await seedClient();
    const host = await seedWhiteboardPage(client);
    render(<PageView client={client} pageId={host} />);
    for (const label of [
      "Select / move",
      "Add card",
      "Add sticky note",
      "Add rectangle",
      "Add ellipse",
      "Add line",
      "Add arrow",
      "Draw stroke",
      "Add text",
      "Add connector",
    ]) {
      expect(screen.getByRole("button", { name: label })).not.toBeNull();
    }
  });
});

describe("whiteboard placements", () => {
  it("sticky note = a child block with geometry AND the node's §34.43 color", async () => {
    const client = await seedClient();
    const host = await seedWhiteboardPage(client);
    const { container } = render(<PageView client={client} pageId={host} />);

    fireEvent.click(screen.getByRole("button", { name: "Add sticky note" }));
    fireEvent.pointerDown(surfaceEl(container), { clientX: 300, clientY: 220, button: 0, pointerId: 1 });
    fireEvent.pointerUp(surfaceEl(container), { pointerId: 1 });
    await flush();

    const children = client.getChildren(host);
    expect(children.length).toBe(1);
    const cardId = children[0]!.id;
    expect(storedLayout(client, host).cards[cardId]).toEqual({ x: 210, y: 130, w: 180, h: 180 });
    // The sticky's color is the NODE's color field (preset token on the wire).
    expect(client.getNode(cardId)!.color).toBe("yellow");
    // And the canvas renders it as a colored card.
    expect(cardEl(container, cardId).className).toContain("nt-wb-card-colored");
    // Inline editing is on, like any new card.
    expect(screen.getByRole("textbox", { name: "Card text" })).not.toBeNull();
  });

  it("text tool places a chrome-only text element (no card, no block)", async () => {
    const client = await seedClient();
    const host = await seedWhiteboardPage(client);
    const { container } = render(<PageView client={client} pageId={host} />);

    fireEvent.click(screen.getByRole("button", { name: "Add text" }));
    fireEvent.pointerDown(surfaceEl(container), { clientX: 120, clientY: 90, button: 0, pointerId: 1 });
    fireEvent.pointerUp(surfaceEl(container), { pointerId: 1 });
    await flush();

    const layout = storedLayout(client, host);
    expect(layout.shapes.length).toBe(1);
    expect(layout.shapes[0]!.kind).toBe("text");
    expect(layout.shapes[0]).toMatchObject({ x: 120, y: 90 });
    // Chrome only: the graph gained nothing.
    expect(client.getChildren(host).length).toBe(0);
    // The label editor opened on placement; committing writes chrome text.
    const input = screen.getByRole<HTMLInputElement>("textbox", { name: "Shape label" });
    fireEvent.change(input, { target: { value: "in passing" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await flush();
    expect(storedLayout(client, host).shapes[0]!.label).toBe("in passing");
    expect(client.getChildren(host).length).toBe(0);
  });
});

describe("whiteboard draw tools", () => {
  it("drag-draws lines and arrows into the token layout", async () => {
    const client = await seedClient();
    const host = await seedWhiteboardPage(client);
    const { container } = render(<PageView client={client} pageId={host} />);

    fireEvent.click(screen.getByRole("button", { name: "Add line" }));
    dragSurface(container, { x: 0, y: 0 }, { x: 100, y: 0 });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Add arrow" }));
    dragSurface(container, { x: 0, y: 50 }, { x: 100, y: 90 });
    await flush();

    const layout = storedLayout(client, host);
    expect(layout.shapes.map((s) => s.kind)).toEqual(["line", "arrow"]);
    expect(layout.shapes[0]).toMatchObject({ x: 0, y: 0, w: 100, h: 0 });
    expect(layout.shapes[1]).toMatchObject({ x: 0, y: 50, w: 100, h: 40 });
  });

  it("connector snaps its endpoints to card/shape anchors", async () => {
    const client = await seedClient();
    const cardId = "0192a000-0000-7000-8000-0000000000d1";
    const host = await seedWhiteboardPage(client, {
      cards: { [cardId]: { x: 100, y: 100, w: 200, h: 100 } },
    });
    await client.createObject({ id: cardId, parentId: host, contentAst: text("anchor") });
    const { container } = render(<PageView client={client} pageId={host} />);

    fireEvent.click(screen.getByRole("button", { name: "Add connector" }));
    // Start near the card's right-edge midpoint anchor (300,150); end free.
    dragSurface(container, { x: 296, y: 147 }, { x: 500, y: 400 });
    await flush();

    const layout = storedLayout(client, host);
    expect(layout.shapes.length).toBe(1);
    expect(layout.shapes[0]!.kind).toBe("arrow");
    // The start snapped to the anchor; the end stayed where dropped.
    expect(layout.shapes[0]).toMatchObject({ x: 300, y: 150, w: 200, h: 250 });
  });

  it("snap to grid quantizes drawn geometry to the 24-unit grid", async () => {
    const client = await seedClient();
    const host = await seedWhiteboardPage(client);
    const { container } = render(<PageView client={client} pageId={host} />);

    fireEvent.click(screen.getByRole("button", { name: "Snap to grid" }));
    expect(screen.getByRole("button", { name: "Snap to grid" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Add rectangle" }));
    dragSurface(container, { x: 10, y: 14 }, { x: 161, y: 111 });
    await flush();

    const shape = storedLayout(client, host).shapes[0]!;
    expect(shape.x % 24).toBe(0);
    expect(shape.y % 24).toBe(0);
    expect(shape.x + shape.w).toBe(168);
    expect(shape.y + shape.h).toBe(120);
  });
});

describe("whiteboard keyboard affordances", () => {
  it("Delete removes the selected shape; Backspace removes a selected card (block + geometry)", async () => {
    const client = await seedClient();
    const cardId = "0192a000-0000-7000-8000-0000000000d2";
    const host = await seedWhiteboardPage(client, {
      cards: { [cardId]: { x: 10, y: 10, w: 200, h: 100 } },
      shapes: [{ id: "s1", kind: "rect", x: 400, y: 400, w: 100, h: 100 }],
    });
    await client.createObject({ id: cardId, parentId: host, contentAst: text("delete me") });
    const { container } = render(<PageView client={client} pageId={host} />);
    const surface = surfaceEl(container);

    fireEvent.pointerDown(shapeEls(container)[0]!, { clientX: 0, clientY: 0, button: 0, pointerId: 1 });
    fireEvent.keyDown(surface, { key: "Delete" });
    await flush();
    expect(storedLayout(client, host).shapes.length).toBe(0);
    expect(client.getChildren(host).length).toBe(1);

    fireEvent.pointerDown(cardEl(container, cardId).querySelector<HTMLElement>(".nt-wb-card-title")!, {
      clientX: 20,
      clientY: 20,
      button: 0,
      pointerId: 1,
    });
    fireEvent.keyDown(surface, { key: "Backspace" });
    await flush();
    expect(client.getChildren(host).length).toBe(0);
    expect(storedLayout(client, host).cards[cardId]).toBeUndefined();
  });

  it("arrows nudge the selection by 1 world unit, Shift+arrows by one grid step, in one write", async () => {
    const client = await seedClient();
    const host = await seedWhiteboardPage(client, {
      shapes: [{ id: "s1", kind: "rect", x: 100, y: 100, w: 50, h: 50 }],
    });
    const { container } = render(<PageView client={client} pageId={host} />);
    const surface = surfaceEl(container);

    fireEvent.pointerDown(shapeEls(container)[0]!, { clientX: 0, clientY: 0, button: 0, pointerId: 1 });
    const updateSpy = vi.spyOn(client, "updateObject");

    fireEvent.keyDown(surface, { key: "ArrowRight" });
    fireEvent.keyDown(surface, { key: "ArrowDown" });
    await flush();
    expect(storedLayout(client, host).shapes[0]).toMatchObject({ x: 101, y: 101 });
    expect(updateSpy.mock.calls.filter((call) => call[0] === host).length).toBe(2);

    fireEvent.keyDown(surface, { key: "ArrowRight", shiftKey: true });
    await flush();
    expect(storedLayout(client, host).shapes[0]).toMatchObject({ x: 125, y: 101 });
  });

  it("keyboard is inert while card text is being edited", async () => {
    const client = await seedClient();
    const cardId = "0192a000-0000-7000-8000-0000000000d3";
    const host = await seedWhiteboardPage(client, {
      cards: { [cardId]: { x: 10, y: 10, w: 200, h: 100 } },
    });
    await client.createObject({ id: cardId, parentId: host, contentAst: text("keep me") });
    const { container } = render(<PageView client={client} pageId={host} />);

    fireEvent.click(cardEl(container, cardId).querySelector<HTMLElement>(".nt-wb-card-body")!);
    const editor = await screen.findByRole<HTMLElement>("textbox", { name: "Card text" });

    // Delete/Backspace inside the contentEditable must NOT touch the canvas.
    fireEvent.keyDown(editor, { key: "Delete" });
    fireEvent.keyDown(editor, { key: "Backspace" });
    fireEvent.keyDown(editor, { key: "Escape" });
    await flush();
    expect(client.getChildren(host).length).toBe(1);
    expect(storedLayout(client, host).cards[cardId]).toBeDefined();
  });
});

describe("whiteboard multi-select + group gestures", () => {
  it("shift+click accumulates; Delete clears the whole set in one write", async () => {
    const client = await seedClient();
    const host = await seedWhiteboardPage(client, {
      shapes: [
        { id: "s1", kind: "rect", x: 0, y: 0, w: 50, h: 50 },
        { id: "s2", kind: "rect", x: 200, y: 0, w: 50, h: 50 },
        { id: "s3", kind: "rect", x: 400, y: 0, w: 50, h: 50 },
      ],
    });
    const { container } = render(<PageView client={client} pageId={host} />);

    const [s1, s2, s3] = shapeEls(container);
    fireEvent.pointerDown(s1!, { clientX: 0, clientY: 0, button: 0, pointerId: 1 });
    fireEvent.pointerUp(surfaceEl(container), { pointerId: 1 });
    fireEvent.pointerDown(s2!, { clientX: 0, clientY: 0, button: 0, pointerId: 1, shiftKey: true });
    fireEvent.pointerUp(surfaceEl(container), { pointerId: 1 });
    expect(container.querySelectorAll(".nt-wb-selection-box").length).toBe(2);
    expect(s3!.querySelector(".nt-wb-selection-box")).toBeNull();

    const updateSpy = vi.spyOn(client, "updateObject");
    fireEvent.click(screen.getByRole("button", { name: "Delete selection" }));
    await flush();
    const layout = storedLayout(client, host);
    expect(layout.shapes.map((s) => s.id)).toEqual(["s3"]);
    expect(updateSpy.mock.calls.filter((call) => call[0] === host).length).toBe(1);
  });

  it("dragging any selected card moves the whole selection, coalesced to one write", async () => {
    const client = await seedClient();
    const cardA = "0192a000-0000-7000-8000-0000000000d4";
    const cardB = "0192a000-0000-7000-8000-0000000000d5";
    const host = await seedWhiteboardPage(client, {
      cards: {
        [cardA]: { x: 100, y: 100, w: 200, h: 100 },
        [cardB]: { x: 500, y: 100, w: 200, h: 100 },
      },
    });
    await client.createObject({ id: cardA, parentId: host, contentAst: text("a") });
    await client.createObject({ id: cardB, parentId: host, contentAst: text("b") });
    const { container } = render(<PageView client={client} pageId={host} />);
    const surface = surfaceEl(container);

    // Select A, shift+click B, then drag by A's title.
    fireEvent.pointerDown(cardEl(container, cardA).querySelector<HTMLElement>(".nt-wb-card-title")!, {
      clientX: 110,
      clientY: 110,
      button: 0,
      pointerId: 1,
    });
    fireEvent.pointerUp(surface, { pointerId: 1 });
    fireEvent.pointerDown(cardEl(container, cardB).querySelector<HTMLElement>(".nt-wb-card-title")!, {
      clientX: 510,
      clientY: 110,
      button: 0,
      pointerId: 1,
      shiftKey: true,
    });
    fireEvent.pointerUp(surface, { pointerId: 1 });

    const updateSpy = vi.spyOn(client, "updateObject");
    fireEvent.pointerDown(cardEl(container, cardA).querySelector<HTMLElement>(".nt-wb-card-title")!, {
      clientX: 110,
      clientY: 110,
      button: 0,
      pointerId: 1,
    });
    fireEvent.pointerMove(surface, { clientX: 160, clientY: 160, pointerId: 1 });
    fireEvent.pointerUp(surface, { pointerId: 1 });
    await flush();

    const layout = storedLayout(client, host);
    expect(layout.cards[cardA]).toEqual({ x: 150, y: 150, w: 200, h: 100 });
    expect(layout.cards[cardB]).toEqual({ x: 550, y: 150, w: 200, h: 100 });
    expect(updateSpy.mock.calls.filter((call) => call[0] === host).length).toBe(1);
  });
});

describe("whiteboard alignment + distribution", () => {
  it("aligns the selection on one edge in a single write", async () => {
    const client = await seedClient();
    const host = await seedWhiteboardPage(client, {
      shapes: [
        { id: "s1", kind: "rect", x: 0, y: 0, w: 100, h: 50 },
        { id: "s2", kind: "ellipse", x: 300, y: 200, w: 100, h: 50 },
      ],
    });
    const { container } = render(<PageView client={client} pageId={host} />);

    const [s1, s2] = shapeEls(container);
    fireEvent.pointerDown(s1!, { clientX: 0, clientY: 0, button: 0, pointerId: 1 });
    fireEvent.pointerUp(surfaceEl(container), { pointerId: 1 });
    fireEvent.pointerDown(s2!, { clientX: 0, clientY: 0, button: 0, pointerId: 1, shiftKey: true });
    fireEvent.pointerUp(surfaceEl(container), { pointerId: 1 });

    const updateSpy = vi.spyOn(client, "updateObject");
    fireEvent.click(screen.getByRole("button", { name: "Align left" }));
    await flush();
    const layout = storedLayout(client, host);
    expect(layout.shapes.find((s) => s.id === "s1")).toMatchObject({ x: 0 });
    expect(layout.shapes.find((s) => s.id === "s2")).toMatchObject({ x: 0, y: 200 });
    expect(updateSpy.mock.calls.filter((call) => call[0] === host).length).toBe(1);
  });

  it("distributes three boxes with equal gaps, preserving the span", async () => {
    const client = await seedClient();
    const host = await seedWhiteboardPage(client, {
      shapes: [
        { id: "s1", kind: "rect", x: 0, y: 0, w: 100, h: 50 },
        { id: "s2", kind: "rect", x: 200, y: 0, w: 100, h: 50 },
        { id: "s3", kind: "rect", x: 500, y: 0, w: 100, h: 50 },
      ],
    });
    const { container } = render(<PageView client={client} pageId={host} />);

    const [s1, s2, s3] = shapeEls(container);
    fireEvent.pointerDown(s1!, { clientX: 0, clientY: 0, button: 0, pointerId: 1 });
    fireEvent.pointerUp(surfaceEl(container), { pointerId: 1 });
    fireEvent.pointerDown(s2!, { clientX: 0, clientY: 0, button: 0, pointerId: 1, shiftKey: true });
    fireEvent.pointerUp(surfaceEl(container), { pointerId: 1 });
    fireEvent.pointerDown(s3!, { clientX: 0, clientY: 0, button: 0, pointerId: 1, shiftKey: true });
    fireEvent.pointerUp(surfaceEl(container), { pointerId: 1 });

    fireEvent.click(screen.getByRole("button", { name: "Distribute horizontally" }));
    await flush();
    const layout = storedLayout(client, host);
    expect(layout.shapes.find((s) => s.id === "s1")!.x).toBe(0);
    expect(layout.shapes.find((s) => s.id === "s2")!.x).toBe(250);
    expect(layout.shapes.find((s) => s.id === "s3")!.x).toBe(500);
  });
});

describe("whiteboard formatting surfaces", () => {
  it("colors a shape via the picker (preset token on the wire); Remove color clears it", async () => {
    const client = await seedClient();
    const host = await seedWhiteboardPage(client, {
      shapes: [{ id: "s1", kind: "rect", x: 0, y: 0, w: 100, h: 50 }],
    });
    const { container } = render(<PageView client={client} pageId={host} />);

    fireEvent.pointerDown(shapeEls(container)[0]!, { clientX: 0, clientY: 0, button: 0, pointerId: 1 });
    fireEvent.pointerUp(surfaceEl(container), { pointerId: 1 });

    fireEvent.click(screen.getByRole("button", { name: "Selection color" }));
    fireEvent.click(screen.getByRole("button", { name: "Red" }));
    await flush();
    expect(storedLayout(client, host).shapes[0]!.color).toBe("red");

    fireEvent.click(screen.getByRole("button", { name: "Selection color" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove color" }));
    await flush();
    expect(storedLayout(client, host).shapes[0]!.color).toBeUndefined();
  });

  it("applies a custom hex through the picker's hex input (§34.43 grammar)", async () => {
    const client = await seedClient();
    const host = await seedWhiteboardPage(client, {
      strokes: [{ id: "p1", points: [0, 0, 50, 50] }],
    });
    const { container } = render(<PageView client={client} pageId={host} />);

    fireEvent.pointerDown(container.querySelector<SVGGElement>(".nt-wb-stroke")!, {
      clientX: 0,
      clientY: 0,
      button: 0,
      pointerId: 1,
    });
    fireEvent.pointerUp(surfaceEl(container), { pointerId: 1 });

    fireEvent.click(screen.getByRole("button", { name: "Selection color" }));
    const hexInput = screen.getByPlaceholderText<HTMLInputElement>("3b82f6");
    fireEvent.change(hexInput, { target: { value: "aa3366" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply color" }));
    await flush();
    expect(storedLayout(client, host).strokes[0]!.color).toBe("#aa3366");
  });

  it("stroke-width tiers write shape strokeWidth / stroke width in one op", async () => {
    const client = await seedClient();
    const host = await seedWhiteboardPage(client, {
      shapes: [{ id: "s1", kind: "line", x: 0, y: 0, w: 100, h: 0 }],
      strokes: [{ id: "p1", points: [0, 0, 50, 50] }],
    });
    const { container } = render(<PageView client={client} pageId={host} />);

    // Both selected: shift-accumulate.
    fireEvent.pointerDown(shapeEls(container)[0]!, { clientX: 0, clientY: 0, button: 0, pointerId: 1 });
    fireEvent.pointerUp(surfaceEl(container), { pointerId: 1 });
    fireEvent.pointerDown(container.querySelector<SVGGElement>(".nt-wb-stroke")!, {
      clientX: 0,
      clientY: 0,
      button: 0,
      pointerId: 1,
      shiftKey: true,
    });
    fireEvent.pointerUp(surfaceEl(container), { pointerId: 1 });

    const updateSpy = vi.spyOn(client, "updateObject");
    fireEvent.click(screen.getByRole("radio", { name: "Stroke width L" }));
    await flush();
    const layout = storedLayout(client, host);
    expect(layout.shapes[0]!.strokeWidth).toBe(8);
    expect(layout.strokes[0]!.width).toBe(8);
    expect(updateSpy.mock.calls.filter((call) => call[0] === host).length).toBe(1);
  });

  it("card color writes the node's §34.43 color field, not the layout", async () => {
    const client = await seedClient();
    const cardId = "0192a000-0000-7000-8000-0000000000d6";
    const host = await seedWhiteboardPage(client, {
      cards: { [cardId]: { x: 10, y: 10, w: 200, h: 100 } },
    });
    await client.createObject({ id: cardId, parentId: host, contentAst: text("color me") });
    const { container } = render(<PageView client={client} pageId={host} />);

    fireEvent.pointerDown(cardEl(container, cardId).querySelector<HTMLElement>(".nt-wb-card-title")!, {
      clientX: 20,
      clientY: 20,
      button: 0,
      pointerId: 1,
    });
    fireEvent.pointerUp(surfaceEl(container), { pointerId: 1 });

    fireEvent.click(screen.getByRole("button", { name: "Selection color" }));
    fireEvent.click(screen.getByRole("button", { name: "Light blue" }));
    await flush();
    expect(client.getNode(cardId)!.color).toBe("sky");
    // The layout token carries no card color — geometry stays pure geometry.
    expect(storedLayout(client, host).cards[cardId]).toEqual({ x: 10, y: 10, w: 200, h: 100 });
  });
});

describe("whiteboard minimap + zoom controls", () => {
  it("zoom buttons, reset and the level readout drive the world transform", async () => {
    const client = await seedClient();
    const host = await seedWhiteboardPage(client);
    const { container } = render(<PageView client={client} pageId={host} />);
    const world = () => container.querySelector<HTMLElement>(".nt-wb-world")!.style.transform;

    expect(screen.getByLabelText("Zoom level").textContent).toBe("100%");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(world()).toContain("scale(1.25");
    expect(screen.getByLabelText("Zoom level").textContent).toBe("125%");

    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(world()).toContain("scale(0.8");
    expect(screen.getByLabelText("Zoom level").textContent).toBe("80%");

    fireEvent.click(screen.getByRole("button", { name: "Reset zoom" }));
    expect(world()).toBe("translate(0px, 0px) scale(1)");
  });

  it("zoom to fit frames the content (mocked surface size)", async () => {
    const client = await seedClient();
    const host = await seedWhiteboardPage(client, {
      shapes: [{ id: "s1", kind: "rect", x: 0, y: 0, w: 400, h: 200 }],
    });
    const { container } = render(<PageView client={client} pageId={host} />);
    surfaceEl(container).getBoundingClientRect = () =>
      ({ width: 840, height: 640, left: 0, top: 0, right: 840, bottom: 640 } as DOMRect);

    fireEvent.click(screen.getByRole("button", { name: "Zoom to fit" }));
    const world = container.querySelector<HTMLElement>(".nt-wb-world")!.style.transform;
    // k = min(760/400, 560/200) = 1.9, centered on (200,100): x = 420-380 = 40,
    // y = 320-190 = 130.
    expect(world).toContain("scale(1.9");
    expect(world).toContain("translate(40px, 130px)");
  });

  it("minimap click centers the viewport on the pointed world position", async () => {
    const client = await seedClient();
    const cardId = "0192a000-0000-7000-8000-0000000000d7";
    const host = await seedWhiteboardPage(client, {
      cards: { [cardId]: { x: 100, y: 100, w: 200, h: 100 } },
    });
    await client.createObject({ id: cardId, parentId: host, contentAst: text("mapped") });
    const { container } = render(<PageView client={client} pageId={host} />);
    const minimap = screen.getByTestId("whiteboard-minimap");

    // jsdom rect: 0×0 at (0,0); the map's scale is 160/(200+96) and its
    // padded origin is (52,52), so the map center lands on world
    // (52 + 80·296/160, 52 + 55·296/160) = (200, 153.75).
    fireEvent.pointerDown(minimap, { clientX: 80, clientY: 55, button: 0, pointerId: 1 });
    const transform = container.querySelector<HTMLElement>(".nt-wb-world")!.style.transform;
    const match = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([\d.]+)\)/.exec(transform);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeCloseTo(-200, 5);
    expect(Number(match![2])).toBeCloseTo(-153.75, 5);
    expect(Number(match![3])).toBeCloseTo(1, 5);
  });

  it("embedded mode ships no minimap or zoom cluster (contract unchanged)", async () => {
    const client = await seedClient();
    const host = await client.createObject({ presentAsMain: true, name: "Doc" });
    await client.createObject({ parentId: host, contentAst: whiteboardAst({ cards: {} }) });

    const { container } = render(<PageView client={client} pageId={host} />);
    expect(container.querySelector(".nt-wb-embedded")).not.toBeNull();
    expect(screen.queryByTestId("whiteboard-minimap")).toBeNull();
    expect(screen.queryByRole("button", { name: "Zoom in" })).toBeNull();
    // The toolset itself is present in embedded mode.
    expect(screen.getByRole("button", { name: "Add connector" })).not.toBeNull();
  });
});
