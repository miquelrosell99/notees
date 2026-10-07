/**
 * Whiteboard canvas tests: the live `whiteboard` content token
 * (WhiteboardCanvas) over PageView/BlockRow with the in-process
 * WorkspaceClient + MemoryRelay (jsdom). Covers the layout schema
 * (parse/serialize round-trip + migration-tolerant parsing), fullscreen and
 * embedded rendering from child blocks, coalesced card drags (one
 * object.update at drag end), double-click card creation + inline text
 * editing, shape add/select/delete, stroke drawing, shape labels staying
 * layout-only (never semantic content), live re-render on notify, and the
 * embedded mode caps (no pan/zoom — scroll priority).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import type { ContentAst } from "@notees/protocol";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";
import {
  EMBEDDED_HEIGHT_PX,
  parseWhiteboardLayout,
  serializeWhiteboardLayout,
} from "../src/ui/WhiteboardCanvas.js";
import type { WhiteboardLayout } from "../src/ui/WhiteboardCanvas.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

// jsdom has no PointerEvent (see block-dnd.test.tsx): a minimal polyfill
// makes pointer events first-class in the harness.
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

/** A content AST carrying a single whiteboard token with the given layout. */
function whiteboardAst(layout?: unknown): ContentAst {
  return [{ type: "whiteboard", layout }] as unknown as ContentAst;
}

/** Seed a fullscreen whiteboard page (whiteboard token in the page's own AST). */
async function seedWhiteboardPage(client: WorkspaceClient, layout?: unknown): Promise<string> {
  return client.createObject({ presentAsMain: true, name: "Board", contentAst: whiteboardAst(layout) });
}

/** The host's stored layout (what actually landed in the content token). */
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

function typeInto(editor: HTMLElement, value: string): void {
  editor.textContent = value;
  fireEvent.input(editor);
}

describe("whiteboard layout schema", () => {
  it("parse/serialize round-trips the typed layout", () => {
    const layout: WhiteboardLayout = {
      cards: { node1: { x: 10, y: 20, w: 240, h: 120 } },
      shapes: [
        { id: "s1", kind: "rect", x: 0, y: 0, w: 160, h: 100, label: "chrome" },
        { id: "s2", kind: "arrow", x: 5, y: 5, w: 140, h: 40 },
      ],
      strokes: [{ id: "p1", points: [1, 2, 3, 4, 5, 6] }],
    };
    expect(parseWhiteboardLayout(serializeWhiteboardLayout(layout))).toEqual(layout);
  });

  it("tolerant parse: unknown fields ignored, malformed entries dropped", () => {
    const parsed = parseWhiteboardLayout({
      cards: {
        good: { x: 1, y: 2, w: 3, h: 4 },
        bad: { x: "nope", y: 2, w: 3, h: 4 },
        junk: "not-an-object",
      },
      shapes: [
        { id: "s1", kind: "rect", x: 0, y: 0, w: 10, h: 10, futureFlag: true },
        { id: "s2", kind: "hologram", x: 0, y: 0, w: 10, h: 10 },
        "garbage",
      ],
      strokes: [
        { id: "p1", points: [1] },
        { id: "p2", points: [1, 2, "x", 4] },
      ],
      viewport: { x: 9 },
      version: 99,
    });
    expect(parsed.cards).toEqual({ good: { x: 1, y: 2, w: 3, h: 4 } });
    expect(parsed.shapes).toEqual([{ id: "s1", kind: "rect", x: 0, y: 0, w: 10, h: 10 }]);
    expect(parsed.strokes).toEqual([{ id: "p2", points: [1, 2, 4] }]);
    // Non-objects degrade to the empty layout, never a crash.
    expect(parseWhiteboardLayout(null)).toEqual({ cards: {}, shapes: [], strokes: [] });
    expect(parseWhiteboardLayout("nope")).toEqual({ cards: {}, shapes: [], strokes: [] });
  });
});

describe("whiteboard canvas (fullscreen page)", () => {
  it("renders child blocks as cards at their layout geometry; child pages are not cards", async () => {
    const client = await seedClient();
    const cardId = "0192a000-0000-7000-8000-0000000000c9";
    const host = await seedWhiteboardPage(client, {
      cards: { [cardId]: { x: 100, y: 50, w: 200, h: 100 } },
    });
    await client.createObject({ id: cardId, parentId: host, contentAst: text("hello card") });
    const childPage = await client.createObject({ presentAsMain: true, name: "Not a card", parentId: host });

    const { container } = render(<PageView client={client} pageId={host} />);

    const canvas = container.querySelector(".nt-wb-fullscreen");
    expect(canvas).not.toBeNull();
    // The child page is a child page (projection rule 3: its own section, not
    // the canvas body) and never becomes a card.
    expect(client.getChildPages(host).map((page) => page.id)).toContain(childPage);
    expect(container.querySelector('[data-card-id="' + childPage + '"]')).toBeNull();

    const el = cardEl(container, cardId);
    expect(el.style.left).toBe("100px");
    expect(el.style.top).toBe("50px");
    expect(el.style.width).toBe("200px");
    // The content shows twice on the card: the title bar (display name) and
    // the body projection. (Scoped to the canvas: the context column's TOC
    // also lists the card's one-line text.)
    expect(within(canvas as HTMLElement).getAllByText("hello card").length).toBe(2);
    // Empty-state hint is gone once a card exists.
    expect(container.querySelector(".nt-wb-empty")).toBeNull();
  });

  it("shows the dashed empty-state hint for an empty board", async () => {
    const client = await seedClient();
    const host = await seedWhiteboardPage(client);
    const { container } = render(<PageView client={client} pageId={host} />);
    expect(container.querySelector(".nt-wb-empty")).not.toBeNull();
  });

  it("drag coalesces to ONE layout update at drag end (no per-mousemove ops)", async () => {
    const client = await seedClient();
    const cardId = "0192a000-0000-7000-8000-0000000000c1";
    const host = await seedWhiteboardPage(client, {
      cards: { [cardId]: { x: 100, y: 50, w: 200, h: 100 } },
    });
    await client.createObject({ id: cardId, parentId: host, contentAst: text("drag me") });

    const updateSpy = vi.spyOn(client, "updateObject");
    const { container } = render(<PageView client={client} pageId={host} />);
    const title = cardEl(container, cardId).querySelector<HTMLElement>(".nt-wb-card-title")!;

    fireEvent.pointerDown(title, { clientX: 110, clientY: 60, button: 0, pointerId: 1 });
    const surface = surfaceEl(container);
    fireEvent.pointerMove(surface, { clientX: 140, clientY: 90, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 150, clientY: 80, pointerId: 1 });
    // Live preview moved without any write.
    expect(cardEl(container, cardId).style.left).toBe("140px");
    expect(updateSpy).not.toHaveBeenCalled();

    fireEvent.pointerUp(surface, { pointerId: 1 });
    await act(async () => {});

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0]![0]).toBe(host);
    expect(storedLayout(client, host).cards[cardId]).toEqual({ x: 140, y: 70, w: 200, h: 100 });
  });

  it("double-click empty space creates a text card (child block + geometry) and edits inline", async () => {
    const client = await seedClient();
    const host = await seedWhiteboardPage(client);

    const { container } = render(<PageView client={client} pageId={host} />);
    const surface = surfaceEl(container);
    await act(async () => {
      fireEvent.doubleClick(surface, { clientX: 300, clientY: 200 });
    });

    // The card exists as a real child block…
    const children = client.getChildren(host);
    expect(children.length).toBe(1);
    const cardId = children[0]!.id;
    expect(children[0]!.isClass).toBe(false);
    expect(children[0]!.presentAsMain).toBe(false);
    // …with geometry centered on the double-click point, and inline editing on.
    expect(storedLayout(client, host).cards[cardId]).toEqual({
      x: 180, y: 140, w: 240, h: 120,
    });
    const editor = await screen.findByRole<HTMLElement>("textbox", { name: "Card text" });

    // Typing + blur saves through the structural edit path.
    typeInto(editor, "fresh idea");
    fireEvent.blur(editor);
    await act(async () => {});
    expect(client.getNode(cardId)!.contentAst).toEqual(text("fresh idea"));
    // Title bar (display name) + body projection both carry the text —
    // scoped to the canvas (the context column's TOC lists it too).
    const board = container.querySelector(".nt-wb-fullscreen")!;
    expect(within(board as HTMLElement).getAllByText("fresh idea").length).toBe(2);
  });

  it("card tool + surface click creates a child block with geometry at the click point", async () => {
    const client = await seedClient();
    const host = await seedWhiteboardPage(client);
    const { container } = render(<PageView client={client} pageId={host} />);

    fireEvent.click(screen.getByRole("button", { name: "Add card" }));
    // Tool armed (one-shot): a surface click places the card, then select returns.
    expect(screen.getByRole("button", { name: "Add card" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.pointerDown(surfaceEl(container), { clientX: 0, clientY: 0, button: 0, pointerId: 1 });
    fireEvent.pointerUp(surfaceEl(container), { pointerId: 1 });
    await act(async () => {});

    expect(screen.getByRole("button", { name: "Add card" }).getAttribute("aria-pressed")).toBe("false");
    const children = client.getChildren(host);
    expect(children.length).toBe(1);
    // The click lands at world (0,0) in jsdom (0×0 surface, default viewport),
    // so the card centers there.
    expect(storedLayout(client, host).cards[children[0]!.id]).toEqual({
      x: -120, y: -60, w: 240, h: 120,
    });
  });

  it("drag-draws a rectangle → token layout; select + delete shape → token layout", async () => {
    const client = await seedClient();
    const host = await seedWhiteboardPage(client);
    const { container } = render(<PageView client={client} pageId={host} />);

    fireEvent.click(screen.getByRole("button", { name: "Add rectangle" }));
    expect(screen.getByRole("button", { name: "Add rectangle" }).getAttribute("aria-pressed")).toBe("true");
    const surface = surfaceEl(container);
    fireEvent.pointerDown(surface, { clientX: 10, clientY: 10, button: 0, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 170, clientY: 110, pointerId: 1 });
    fireEvent.pointerUp(surface, { pointerId: 1 });
    await act(async () => {});

    // The tool is one-shot: back to select, shape committed + selected.
    expect(screen.getByRole("button", { name: "Add rectangle" }).getAttribute("aria-pressed")).toBe("false");
    let layout = storedLayout(client, host);
    expect(layout.shapes.length).toBe(1);
    expect(layout.shapes[0]!.kind).toBe("rect");
    expect(layout.shapes[0]).toMatchObject({ x: 10, y: 10, w: 160, h: 100 });

    // Select the shape (pointer down on the SVG group), then delete it.
    const shape = container.querySelector<SVGGElement>(".nt-wb-shape")!;
    fireEvent.pointerDown(shape, { clientX: 0, clientY: 0, button: 0, pointerId: 1 });
    const deleteButton = screen.getByRole("button", { name: "Delete selection" }) as HTMLButtonElement;
    fireEvent.click(deleteButton);
    await act(async () => {});

    layout = storedLayout(client, host);
    expect(layout.shapes.length).toBe(0);
  });

  it("a bare click with a shape tool places a default-sized shape", async () => {
    const client = await seedClient();
    const host = await seedWhiteboardPage(client);
    const { container } = render(<PageView client={client} pageId={host} />);

    fireEvent.click(screen.getByRole("button", { name: "Add ellipse" }));
    const surface = surfaceEl(container);
    fireEvent.pointerDown(surface, { clientX: 200, clientY: 150, button: 0, pointerId: 1 });
    fireEvent.pointerUp(surface, { pointerId: 1 });
    await act(async () => {});

    const layout = storedLayout(client, host);
    expect(layout.shapes.length).toBe(1);
    expect(layout.shapes[0]!.kind).toBe("ellipse");
    expect(layout.shapes[0]).toMatchObject({ x: 120, y: 100, w: 160, h: 100 });
  });

  it("stroke mode draws a polyline that commits to the token layout", async () => {
    const client = await seedClient();
    const host = await seedWhiteboardPage(client);
    const { container } = render(<PageView client={client} pageId={host} />);
    const surface = surfaceEl(container);

    fireEvent.click(screen.getByRole("button", { name: "Draw stroke" }));
    expect(screen.getByRole("button", { name: "Draw stroke" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.pointerDown(surface, { clientX: 10, clientY: 10, button: 0, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 30, clientY: 25, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 50, clientY: 15, pointerId: 1 });
    fireEvent.pointerUp(surface, { pointerId: 1 });
    await act(async () => {});

    const layout = storedLayout(client, host);
    expect(layout.strokes.length).toBe(1);
    expect(layout.strokes[0]!.points).toEqual([10, 10, 30, 25, 50, 15]);
    // Draw mode is a one-shot: it turns itself off after the gesture.
    expect(screen.getByRole("button", { name: "Draw stroke" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("shape labels stay layout-only: no card, no block, no semantic content", async () => {
    const client = await seedClient();
    const host = await seedWhiteboardPage(client);
    const { container } = render(<PageView client={client} pageId={host} />);

    fireEvent.click(screen.getByRole("button", { name: "Add ellipse" }));
    const surface = surfaceEl(container);
    fireEvent.pointerDown(surface, { clientX: 20, clientY: 20, button: 0, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 180, clientY: 120, pointerId: 1 });
    fireEvent.pointerUp(surface, { pointerId: 1 });
    await act(async () => {});
    expect(client.getChildren(host).length).toBe(0);

    const shape = container.querySelector<SVGGElement>(".nt-wb-shape")!;
    fireEvent.doubleClick(shape, { clientX: 0, clientY: 0 });
    const input = screen.getByRole<HTMLInputElement>("textbox", { name: "Shape label" });
    fireEvent.change(input, { target: { value: "chrome only" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => {});

    // The label lives in the layout token…
    expect(storedLayout(client, host).shapes[0]!.label).toBe("chrome only");
    // …and nowhere in the graph: no card, no child block was created.
    expect(client.getChildren(host).length).toBe(0);
    expect(container.querySelectorAll(".nt-wb-card").length).toBe(0);
    // The host's own content token is still exactly one whiteboard token.
    const hostNode = client.getNode(host)!;
    expect(hostNode.contentAst.length).toBe(1);
    expect((hostNode.contentAst[0] as { type: string }).type).toBe("whiteboard");
  });

  it("re-renders live when a second source updates the layout (notify flow)", async () => {
    const client = await seedClient();
    const cardId = "0192a000-0000-7000-8000-0000000000c2";
    const host = await seedWhiteboardPage(client, {
      cards: { [cardId]: { x: 0, y: 0, w: 200, h: 100 } },
    });
    await client.createObject({ id: cardId, parentId: host, contentAst: text("remote") });

    const { container } = render(<PageView client={client} pageId={host} />);
    expect(cardEl(container, cardId).style.left).toBe("0px");

    await act(async () => {
      await client.updateObject(host, {
        contentAst: whiteboardAst({ cards: { [cardId]: { x: 333, y: 77, w: 200, h: 100 } } }),
      });
    });

    const el = cardEl(container, cardId);
    expect(el.style.left).toBe("333px");
    expect(el.style.top).toBe("77px");
  });

  it("card × deletes the block and clears its geometry", async () => {
    const client = await seedClient();
    const cardId = "0192a000-0000-7000-8000-0000000000c3";
    const host = await seedWhiteboardPage(client, {
      cards: { [cardId]: { x: 10, y: 10, w: 200, h: 100 } },
    });
    await client.createObject({ id: cardId, parentId: host, contentAst: text("gone soon") });

    const { container } = render(<PageView client={client} pageId={host} />);
    fireEvent.click(screen.getByRole("button", { name: `Delete card gone soon` }));
    await act(async () => {});

    expect(client.getChildren(host).length).toBe(0);
    expect(storedLayout(client, host).cards[cardId]).toBeUndefined();
    expect(container.querySelector('[data-card-id="' + cardId + '"]')).toBeNull();
  });

  it("middle-drag pans the world; wheel zooms cursor-anchored (fullscreen)", async () => {
    const client = await seedClient();
    const host = await seedWhiteboardPage(client);
    const { container } = render(<PageView client={client} pageId={host} />);
    const surface = surfaceEl(container);
    const world = () => container.querySelector<HTMLElement>(".nt-wb-world")!.style.transform;

    expect(world()).toBe("translate(0px, 0px) scale(1)");

    // Left-drag is the marquee gesture; panning rides the middle button.
    fireEvent.pointerDown(surface, { clientX: 10, clientY: 10, button: 1, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 60, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(surface, { pointerId: 1 });
    expect(world()).toBe("translate(50px, 30px) scale(1)");

    surface.dispatchEvent(new WheelEvent("wheel", { clientX: 50, clientY: 30, deltaY: -100, bubbles: true, cancelable: true }));
    await act(async () => {});
    expect(world()).toContain("scale(1.16");
  });

  it("left-drag on the background box-selects; a bare click clears", async () => {
    const client = await seedClient();
    const cardId = "0192a000-0000-7000-8000-0000000000c5";
    const host = await seedWhiteboardPage(client, {
      cards: { [cardId]: { x: 100, y: 100, w: 200, h: 100 } },
      shapes: [{ id: "shape-far", kind: "rect", x: 900, y: 900, w: 100, h: 100 }],
    });
    await client.createObject({ id: cardId, parentId: host, contentAst: text("pick me") });

    const { container } = render(<PageView client={client} pageId={host} />);
    const surface = surfaceEl(container);

    // Marquee over the card only — the far shape stays unselected.
    fireEvent.pointerDown(surface, { clientX: 50, clientY: 50, button: 0, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 400, clientY: 300, pointerId: 1 });
    const marquee = container.querySelector<HTMLElement>(".nt-wb-marquee");
    expect(marquee).not.toBeNull();
    expect(cardEl(container, cardId).className).toContain("nt-wb-card-selected");
    fireEvent.pointerUp(surface, { pointerId: 1 });
    expect(container.querySelector<HTMLElement>(".nt-wb-marquee")).toBeNull();

    // Delete selection removes the card from the graph and its geometry.
    fireEvent.click(screen.getByRole("button", { name: "Delete selection" }));
    await act(async () => {});
    expect(client.getChildren(host).length).toBe(0);
    expect(storedLayout(client, host).cards[cardId]).toBeUndefined();
    expect(storedLayout(client, host).shapes.length).toBe(1);
  });
});

describe("whiteboard canvas (embedded block)", () => {
  it("renders the mini-canvas at the capped height inside the block row", async () => {
    const client = await seedClient();
    const host = await client.createObject({ presentAsMain: true, name: "Doc" });
    const boardBlock = await client.createObject({
      parentId: host,
      contentAst: whiteboardAst({ cards: {} }),
    });
    const cardId = "0192a000-0000-7000-8000-0000000000c4";
    await client.createObject({ id: cardId, parentId: boardBlock, contentAst: text("embedded card") });
    await client.updateObject(boardBlock, {
      contentAst: whiteboardAst({ cards: { [cardId]: { x: 20, y: 30, w: 180, h: 90 } } }),
    });

    const { container } = render(<PageView client={client} pageId={host} />);

    const embedded = container.querySelector<HTMLElement>(".nt-wb-embedded");
    expect(embedded).not.toBeNull();
    expect(embedded!.style.height).toBe(`${EMBEDDED_HEIGHT_PX}px`);
    expect(container.querySelector(".nt-wb-fullscreen")).toBeNull();
    const el = cardEl(container, cardId);
    expect(el.style.left).toBe("20px");
    expect(el.style.top).toBe("30px");
    // The card text renders on the canvas twice (title bar + body); the
    // outliner ALSO renders the same child as a nested bullet — same node,
    // two views, per SCHEMA.md.
    expect(within(embedded!).getAllByText("embedded card").length).toBe(2);
    expect(screen.getAllByText("embedded card").length).toBe(3);
  });

  it("embedded mode keeps interactions but gives the wheel to the page (no zoom/pan)", async () => {
    const client = await seedClient();
    const host = await client.createObject({ presentAsMain: true, name: "Doc" });
    await client.createObject({
      parentId: host,
      contentAst: whiteboardAst(),
    });

    const { container } = render(<PageView client={client} pageId={host} />);
    const world = () => container.querySelector<HTMLElement>(".nt-wb-world")!.style.transform;
    expect(world()).toBe("translate(0px, 0px) scale(1)");

    // Wheel scrolls the PAGE (scroll priority): the viewport must not change.
    const embedded = container.querySelector<HTMLElement>(".nt-wb-embedded .nt-wb-surface")!;
    embedded.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
    await act(async () => {});
    expect(world()).toBe("translate(0px, 0px) scale(1)");

    // Background drag does not pan either…
    fireEvent.pointerDown(embedded, { clientX: 5, clientY: 5, button: 0, pointerId: 1 });
    fireEvent.pointerMove(embedded, { clientX: 50, clientY: 50, pointerId: 1 });
    fireEvent.pointerUp(embedded, { pointerId: 1 });
    expect(world()).toBe("translate(0px, 0px) scale(1)");

    // …but card creation still works (double-click on the background).
    fireEvent.doubleClick(embedded, { clientX: 100, clientY: 80 });
    await act(async () => {});
    const boardBlock = client.getChildren(host)[0]!;
    expect(client.getChildren(boardBlock.id).length).toBe(1);
  });
});
