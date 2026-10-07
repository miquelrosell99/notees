/**
 * Node hover preview + floating editor tests (issue #11).
 *
 * Hover preview: dwelling on a mention (~400ms, fake timers) raises a
 * bounded card anchored at the mention, rendering the shared NodeView in
 * preview mode — the real page chrome (the title row, the capped
 * first-level body) read-only, no corner menu / properties / section
 * stack; the footer carries the backlink count + the Pin button; leaving
 * hides it after a short grace; the pointer can travel into the card or
 * back to the mention to keep it alive; dismissal follows the shared layer
 * (Escape + pointer-down outside); a held button (a drag) never raises the
 * card; the card's pin promotes to a floating editor window.
 *
 * Floating editor: the pinned window renders the node's own view (the
 * Revision-11 cascade — PageView in embedded mode for pages) with a
 * draggable title bar (title + open-in-main + close); edits inside the
 * window write through the same client op path (undo/sync free); pinning an
 * already-pinned node raises instead of duplicating; close returns focus to
 * the element that held it at open.
 *
 * Same harness as node-link-gestures.test.tsx (PageView over the in-process
 * WorkspaceClient + MemoryRelay, jsdom) with the two app-shell hosts mounted
 * around the page exactly like App.tsx mounts them.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import type { ContentAst } from "@notees/protocol";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";
import {
  FloatingEditorHost,
  openFloatingEditor,
} from "../src/ui/components/FloatingEditor.js";
import {
  HOVER_DWELL_MS,
  HOVER_GRACE_MS,
  NodeHoverPreviewHost,
} from "../src/ui/components/NodeHoverPreview.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
const TARGET_TEXT = "The target's own words.";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
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

interface Seed {
  client: WorkspaceClient;
  pageId: string;
  targetId: string;
  blockId: string;
}

/** Home page with one block mentioning the target page. */
async function seedLinked(): Promise<Seed> {
  const client = await seedClient();
  const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
  const targetId = await client.createObject({
    presentAsMain: true,
    contentAst: [{ type: "text", text: TARGET_TEXT }],
  });
  const blockId = await client.createObject({
    parentId: pageId,
    contentAst: [
      { type: "text", text: "see " },
      {
        type: "mention",
        targetNodeId: targetId,
        text: TARGET_TEXT,
        linkId: "0192a000-0000-7000-8000-0000000000aa",
      },
      { type: "text", text: " again" },
    ],
  });
  return { client, pageId, targetId, blockId };
}

/** The two app-shell hosts around the page view, as App.tsx mounts them. */
function renderHosted(
  client: WorkspaceClient,
  pageId: string,
  handlers: { openNode?: (id: string) => void } = {},
) {
  const openNode = handlers.openNode ?? (() => {});
  return render(
    <NodeHoverPreviewHost client={client} openNode={openNode}>
      <FloatingEditorHost client={client} openNode={openNode}>
        <PageView client={client} pageId={pageId} />
      </FloatingEditorHost>
    </NodeHoverPreviewHost>,
  );
}

const previewCard = () => document.body.querySelector<HTMLElement>(".nt-hover-preview");
const floatingWindows = () =>
  Array.from(document.body.querySelectorAll<HTMLElement>(".nt-float-win"));
const mentionLink = (container: HTMLElement): HTMLElement => {
  const link = container.querySelector<HTMLElement>("button.nt-link");
  if (link === null) throw new Error("no mention link rendered");
  return link;
};
/** The NodeView preview's real chrome: the page shell + the header title row. */
const cardPageShell = (card: HTMLElement): HTMLElement | null =>
  card.querySelector<HTMLElement>(".nt-page");
const cardTitle = (card: HTMLElement): string =>
  card.querySelector<HTMLElement>(".nt-page-title")?.textContent ?? "";

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** Enter edit mode on a block inside a container and emulate typing. */
function typeInBlock(scope: HTMLElement, text: string): void {
  const content = scope.querySelector<HTMLElement>(".nt-block-content");
  if (content === null) throw new Error("no .nt-block-content in scope");
  fireEvent.click(content);
  const editor = content.querySelector<HTMLElement>(".nt-block-text");
  if (editor === null) throw new Error("editor did not mount after click");
  editor.textContent = text;
  fireEvent.input(editor);
  fireEvent.blur(editor); // blur flushes the debounced write
}

// ── Hover preview ────────────────────────────────────────────────────────────

describe("node hover preview", () => {
  it("dwell raises the card: the NodeView preview's real chrome, backlink count, pin", async () => {
    const { client, pageId } = await seedLinked();
    const { container } = renderHosted(client, pageId);
    vi.useFakeTimers();

    fireEvent.mouseEnter(mentionLink(container));
    expect(previewCard()).toBeNull();
    advance(HOVER_DWELL_MS);

    const card = previewCard();
    expect(card).not.toBeNull();
    // The shared NodeView in preview mode: the real page shell + the header
    // title row carry the target's identity (title-is-content).
    expect(cardPageShell(card!)).not.toBeNull();
    expect(cardTitle(card!)).toBe(TARGET_TEXT);
    // The preview surface carries none of the editing machinery.
    expect(card!.querySelector(".nt-node-view__corner")).toBeNull();
    expect(card!.querySelector(".nt-node-view__modes")).toBeNull();
    expect(card!.querySelector(".nt-metadata-divider")).toBeNull();
    expect(card!.querySelector(".find-replace-widget")).toBeNull();
    // The mention under the pointer is the target's one backlink.
    expect(within(card!).getByText("1 backlink")).toBeTruthy();
    expect(
      within(card!).getByRole("button", { name: "Pin — edit in a floating window" }),
    ).toBeTruthy();
  });

  it("leaving before the dwell elapses shows nothing", async () => {
    const { client, pageId } = await seedLinked();
    const { container } = renderHosted(client, pageId);
    vi.useFakeTimers();

    fireEvent.mouseEnter(mentionLink(container));
    advance(HOVER_DWELL_MS - 100);
    fireEvent.mouseLeave(mentionLink(container));
    advance(HOVER_DWELL_MS * 2);
    expect(previewCard()).toBeNull();
  });

  it("a held button (drag) never raises the card", async () => {
    const { client, pageId } = await seedLinked();
    const { container } = renderHosted(client, pageId);
    vi.useFakeTimers();

    fireEvent.mouseEnter(mentionLink(container), { buttons: 1 });
    advance(HOVER_DWELL_MS * 2);
    expect(previewCard()).toBeNull();
  });

  it("a pointer-down cancels a pending dwell", async () => {
    const { client, pageId } = await seedLinked();
    const { container } = renderHosted(client, pageId);
    vi.useFakeTimers();

    fireEvent.mouseEnter(mentionLink(container));
    advance(HOVER_DWELL_MS - 100);
    fireEvent.pointerDown(document.body);
    advance(HOVER_DWELL_MS * 2);
    expect(previewCard()).toBeNull();
  });

  it("leaving after the card opens hides it after the grace; re-enter cancels the hide", async () => {
    const { client, pageId } = await seedLinked();
    const { container } = renderHosted(client, pageId);
    vi.useFakeTimers();

    const link = mentionLink(container);
    fireEvent.mouseEnter(link);
    advance(HOVER_DWELL_MS);
    expect(previewCard()).not.toBeNull();

    fireEvent.mouseLeave(link);
    advance(HOVER_GRACE_MS - 50);
    // Re-enter the mention inside the grace window: the card stays.
    fireEvent.mouseEnter(link);
    advance(HOVER_GRACE_MS * 2);
    expect(previewCard()).not.toBeNull();

    // Leave again without re-entering: hidden once the grace elapses.
    fireEvent.mouseLeave(link);
    advance(HOVER_GRACE_MS);
    expect(previewCard()).toBeNull();
  });

  it("the pointer can travel into the card within the grace window", async () => {
    const { client, pageId } = await seedLinked();
    const { container } = renderHosted(client, pageId);
    vi.useFakeTimers();

    const link = mentionLink(container);
    fireEvent.mouseEnter(link);
    advance(HOVER_DWELL_MS);
    fireEvent.mouseLeave(link);
    advance(HOVER_GRACE_MS - 50);
    fireEvent.mouseEnter(previewCard()!);
    advance(HOVER_GRACE_MS * 2);
    expect(previewCard()).not.toBeNull();
  });

  it("dwelling a different mention re-targets the open card", async () => {
    const { client, pageId } = await seedLinked();
    const otherId = await client.createObject({ presentAsMain: true, name: "Elsewhere" });
    await client.createObject({
      parentId: pageId,
      contentAst: [
        {
          type: "mention",
          targetNodeId: otherId,
          text: "Elsewhere",
          linkId: "0192a000-0000-7000-8000-0000000000bb",
        },
      ],
    });
    const { container } = renderHosted(client, pageId);
    vi.useFakeTimers();

    const links = Array.from(container.querySelectorAll<HTMLElement>("button.nt-link"));
    const first = links[0]!;
    const second = links.find((l) => l.textContent === "Elsewhere")!;
    fireEvent.mouseEnter(first);
    advance(HOVER_DWELL_MS);
    expect(cardTitle(previewCard()!)).toBe(TARGET_TEXT);

    fireEvent.mouseLeave(first);
    fireEvent.mouseEnter(second);
    advance(HOVER_DWELL_MS);
    expect(cardTitle(previewCard()!)).toBe("Elsewhere");
  });

  it("Escape (from outside) and pointer-down outside close the card; inside presses do not", async () => {
    const { client, pageId } = await seedLinked();
    const { container } = renderHosted(client, pageId);
    vi.useFakeTimers();

    const link = mentionLink(container);
    fireEvent.mouseEnter(link);
    advance(HOVER_DWELL_MS);

    // A press inside the card (the pin button lives there) does not dismiss.
    fireEvent.pointerDown(
      within(previewCard()!).getByRole("button", { name: "Pin — edit in a floating window" }),
    );
    expect(previewCard()).not.toBeNull();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(previewCard()).toBeNull();

    // Reopen, then a pointer-down outside closes (dismissal layer).
    fireEvent.mouseEnter(link);
    advance(HOVER_DWELL_MS);
    expect(previewCard()).not.toBeNull();
    fireEvent.pointerDown(document.body);
    expect(previewCard()).toBeNull();
  });

  it("clicking the preview's title opens the node in the main view", async () => {
    const { client, pageId, targetId } = await seedLinked();
    const opened: string[] = [];
    const { container } = renderHosted(client, pageId, { openNode: (id) => opened.push(id) });
    vi.useFakeTimers();

    fireEvent.mouseEnter(mentionLink(container));
    advance(HOVER_DWELL_MS);
    // The preview's title row is read-only — a click navigates (the
    // trampoline contract), it never mounts the block editor.
    const titleContent = previewCard()!.querySelector<HTMLElement>(".nt-page-title .nt-title-content");
    if (titleContent === null) throw new Error("no preview title row");
    fireEvent.click(titleContent);

    expect(opened).toEqual([targetId]);
    expect(previewCard()).toBeNull();
    expect(document.querySelector(".nt-block-text")).toBeNull();
  });

  it("the preview's body rows are read-only — clicking navigates instead of editing", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const targetId = await client.createObject({ presentAsMain: true, name: "Target" });
    const childId = await client.createObject({
      parentId: targetId,
      contentAst: [{ type: "text", text: "child words" }],
    });
    await client.createObject({
      parentId: pageId,
      contentAst: [
        { type: "text", text: "see " },
        {
          type: "mention",
          targetNodeId: targetId,
          text: "Target",
          linkId: "0192a000-0000-7000-8000-0000000000dd",
        },
      ],
    });
    const opened: string[] = [];
    const { container } = renderHosted(client, pageId, { openNode: (id) => opened.push(id) });
    vi.useFakeTimers();

    fireEvent.mouseEnter(mentionLink(container));
    advance(HOVER_DWELL_MS);
    const card = previewCard()!;
    // The capped first-level body renders the real row, readonly-classed.
    const row = card.querySelector<HTMLElement>(`.nt-block--readonly[data-block-id="${childId}"]`);
    if (row === null) throw new Error("no readonly body row in the preview");
    fireEvent.click(row.querySelector<HTMLElement>(".nt-block-content")!);

    expect(opened).toEqual([childId]);
    expect(previewCard()).toBeNull();
    expect(document.querySelector(".nt-block-text")).toBeNull();
  });

  it("a broken mention previews honestly and cannot be pinned", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    await client.createObject({
      parentId: pageId,
      contentAst: [
        { type: "mention", targetNodeId: "0192a000-0000-7000-8000-0000000000ff", text: "Ghost" },
      ],
    });
    const { container } = renderHosted(client, pageId);
    vi.useFakeTimers();

    fireEvent.mouseEnter(mentionLink(container));
    advance(HOVER_DWELL_MS);
    const card = previewCard();
    expect(card).not.toBeNull();
    expect(within(card!).getByText(/broken reference/)).toBeTruthy();
    expect(
      within(card!).queryByRole("button", { name: "Pin — edit in a floating window" }),
    ).toBeNull();
  });

  it("pressing the mention hides the card before navigation", async () => {
    const { client, pageId } = await seedLinked();
    const { container } = renderHosted(client, pageId);
    vi.useFakeTimers();

    const link = mentionLink(container);
    fireEvent.mouseEnter(link);
    advance(HOVER_DWELL_MS);
    expect(previewCard()).not.toBeNull();
    fireEvent.pointerDown(link);
    expect(previewCard()).toBeNull();
  });
});

// ── Floating editor ──────────────────────────────────────────────────────────

describe("floating editor", () => {
  it("pinning renders the node in a window with a title bar (title, open-in-main, close)", async () => {
    const { client, pageId, targetId } = await seedLinked();
    const { container } = renderHosted(client, pageId);
    vi.useFakeTimers();

    fireEvent.mouseEnter(mentionLink(container));
    advance(HOVER_DWELL_MS);
    fireEvent.click(
      within(previewCard()!).getByRole("button", { name: "Pin — edit in a floating window" }),
    );

    expect(previewCard()).toBeNull();
    const win = floatingWindows();
    expect(win).toHaveLength(1);
    expect(
      win[0]!.querySelector<HTMLElement>(".nt-float-win__title-text")?.textContent,
    ).toBe(TARGET_TEXT);
    expect(within(win[0]!).getByRole("button", { name: "Open in main view" })).toBeTruthy();
    expect(within(win[0]!).getByRole("button", { name: "Close floating editor" })).toBeTruthy();
    expect(win[0]!.getAttribute("data-floating-editor")).toBe(targetId);
  });

  it("edits inside the window write through the client and project into the main view", async () => {
    const { client, pageId, targetId } = await seedLinked();
    const targetBlockId = await client.createObject({
      parentId: targetId,
      contentAst: [{ type: "text", text: "inside target" }],
    });
    const { container } = renderHosted(client, pageId);
    vi.useFakeTimers();

    fireEvent.mouseEnter(mentionLink(container));
    advance(HOVER_DWELL_MS);
    fireEvent.click(
      within(previewCard()!).getByRole("button", { name: "Pin — edit in a floating window" }),
    );
    const win = floatingWindows()[0]!;

    // The window carries the target's block tree (PageView, embedded mode).
    expect(within(win).getByText("inside target")).toBeTruthy();

    typeInBlock(win, "edited from the floating window");
    await act(async () => {});

    const ast = client.getNode(targetBlockId)?.contentAst as ContentAst;
    expect(ast).toEqual([{ type: "text", text: "edited from the floating window" }]);
    // Every surface re-projects through the same client notification.
    expect(within(win).getByText("edited from the floating window")).toBeTruthy();
  });

  it("open-in-main navigates and closes the window", async () => {
    const { client, pageId, targetId } = await seedLinked();
    const opened: string[] = [];
    const { container } = renderHosted(client, pageId, { openNode: (id) => opened.push(id) });
    vi.useFakeTimers();

    fireEvent.mouseEnter(mentionLink(container));
    advance(HOVER_DWELL_MS);
    fireEvent.click(
      within(previewCard()!).getByRole("button", { name: "Pin — edit in a floating window" }),
    );
    fireEvent.click(
      within(floatingWindows()[0]!).getByRole("button", { name: "Open in main view" }),
    );

    expect(opened).toEqual([targetId]);
    expect(floatingWindows()).toHaveLength(0);
  });

  it("close removes the window and returns focus to the pre-open element", async () => {
    const { client, pageId } = await seedLinked();
    const { container } = renderHosted(client, pageId);

    // A focusable element outside the flow: focus lives here before pinning.
    const prior = document.createElement("button");
    prior.textContent = "prior-focus";
    document.body.appendChild(prior);
    act(() => prior.focus());
    expect(document.activeElement).toBe(prior);

    // Pin via the card (the real path) — deliberate focus moves to the
    // window's title bar; closing returns focus to the pre-open element.
    vi.useFakeTimers();
    fireEvent.mouseEnter(mentionLink(container));
    advance(HOVER_DWELL_MS);
    fireEvent.click(
      within(previewCard()!).getByRole("button", { name: "Pin — edit in a floating window" }),
    );
    const win = floatingWindows()[0]!;
    expect(document.activeElement).toBe(
      win.querySelector<HTMLElement>(".nt-float-win__title"),
    );

    fireEvent.click(within(win).getByRole("button", { name: "Close floating editor" }));
    expect(floatingWindows()).toHaveLength(0);
    expect(document.activeElement).toBe(prior);
    prior.remove();
  });

  it("pinning an already-pinned node raises its window instead of duplicating", async () => {
    const { client, pageId, targetId } = await seedLinked();
    renderHosted(client, pageId);

    act(() => openFloatingEditor(targetId));
    expect(floatingWindows()).toHaveLength(1);
    const first = floatingWindows()[0]!;

    act(() => openFloatingEditor(targetId));
    expect(floatingWindows()).toHaveLength(1);
    expect(floatingWindows()[0]).toBe(first);
  });

  it("a block target previews the focused-block chrome read-only; pinning opens it editable", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const targetId = await client.createObject({ presentAsMain: true, name: "Target" });
    const blockId = await client.createObject({
      parentId: targetId,
      contentAst: [{ type: "text", text: "the block body" }],
    });
    await client.createObject({
      parentId: pageId,
      contentAst: [
        { type: "text", text: "deep " },
        {
          type: "mention",
          targetNodeId: blockId,
          text: "the block body",
          linkId: "0192a000-0000-7000-8000-0000000000cc",
        },
      ],
    });
    const { container } = renderHosted(client, pageId);
    vi.useFakeTimers();

    fireEvent.mouseEnter(mentionLink(container));
    advance(HOVER_DWELL_MS);
    // The preview renders the real block chrome — and stays a trampoline:
    // the subtree rows are read-only there.
    expect(previewCard()!.querySelector(".nt-focused-block")).not.toBeNull();
    expect(
      previewCard()!.querySelector(`.nt-block--readonly[data-block-id="${blockId}"]`),
    ).not.toBeNull();
    fireEvent.click(
      within(previewCard()!).getByRole("button", { name: "Pin — edit in a floating window" }),
    );

    const win = floatingWindows()[0]!;
    expect(win.querySelector(".nt-focused-block")).not.toBeNull();
    typeInBlock(win, "edited block from the window");
    await act(async () => {});
    expect(client.getNode(blockId)?.contentAst).toEqual([
      { type: "text", text: "edited block from the window" },
    ]);
  });

  it("the title bar drags the window (clamped to the viewport)", async () => {
    const { client, pageId, targetId } = await seedLinked();
    renderHosted(client, pageId);

    act(() => openFloatingEditor(targetId));
    const win = floatingWindows()[0]!;
    const before = { left: win.style.left, top: win.style.top };

    const titlebar = win.querySelector<HTMLElement>(".nt-float-win__titlebar")!;
    // jsdom has no PointerEvent — the mouse fallback drives the drag.
    fireEvent.mouseDown(titlebar, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 220, clientY: 160 });
    fireEvent.mouseUp(window);

    expect(win.style.left).not.toBe(before.left);
    expect(win.style.top).not.toBe(before.top);

    // Dragging far past the edge clamps instead of losing the window.
    fireEvent.mouseDown(titlebar, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 100000, clientY: 100000 });
    fireEvent.mouseUp(window);
    expect(Number.parseFloat(win.style.left)).toBeLessThanOrEqual(window.innerWidth);
    expect(Number.parseFloat(win.style.top)).toBeLessThanOrEqual(window.innerHeight - 48);
  });
});
