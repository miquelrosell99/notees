/**
 * Popups inside modals — the layering contract.
 *
 * popups opened from inside a modal could not
 * be clicked and sometimes rendered below the modal. Three root causes, one
 * contract per fix, pinned here:
 *
 *  1. Radix `modal={true}` locked `document.body` pointer-events and
 *     hard-trapped focus, so any popup portaled to `document.body` was
 *     click-dead inside a dialog. The fleet Modal now runs `modal={false}`
 *     and owns the layer semantics (backdrop, scroll lock, background
 *     aria-hiding), and `usePopupDismissal` stamps its popup root with
 *     `data-fleet-popup` — one CSS rule re-enables pointer-events on the
 *     whole stamped subtree.
 *  2. A press inside a stamped popup is an INSIDE press for the dialog: the
 *     Modal's Radix outside-press handlers ignore it, so a portaled picker
 *     never dismisses the dialog under the user's click.
 *  3. The seam lifts the modal's `aria-hidden` background-hiding pass off the
 *     popup root (and re-asserts the lift against the pass's observer).
 *
 * What jsdom cannot see (paint order, pointer-events hit-testing, focus
 * geometry) is covered by the z-tier consolidation to `--z-floating` and the
 * `[data-fleet-popup]` pointer-events rule in fleet CSS, not asserted here.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { PageView } from "../src/ui/PageView.js";
import { Modal } from "../src/components/ui/kit/Modal.js";
import { usePopupDismissal } from "../src/components/ui/kit/usePopupDismissal.js";

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

/** Radix registers its document-level dismissal listeners on a macrotask. */
async function settleLayers(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** A minimal fleet popup: portal to body + the shared dismissal seam. */
function TestPopup({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const popupRef = useRef<HTMLDivElement>(null);
  usePopupDismissal({ popupRef, isOpen, onClose });
  if (!isOpen) return null;
  return createPortal(
    <div ref={popupRef} role="dialog" aria-label="Test popup">
      <button type="button">popup action</button>
    </div>,
    document.body,
  );
}

function Harness({ onModalClose }: { onModalClose: () => void }) {
  const [popupOpen, setPopupOpen] = useState(false);
  return (
    <Modal isOpen title="Test modal" onClose={onModalClose}>
      <button type="button" onClick={() => setPopupOpen(true)}>
        open popup
      </button>
      <TestPopup isOpen={popupOpen} onClose={() => setPopupOpen(false)} />
    </Modal>
  );
}

const popupRoot = () => document.body.querySelector<HTMLElement>('[data-fleet-popup]');

const popupAction = () => within(popupRoot()!).getByRole("button", { name: "popup action" });

describe("popup inside a modal: clicks", () => {
  it("a pointer-down inside the portaled popup does not dismiss the modal", async () => {
    const onModalClose = vi.fn();
    render(<Harness onModalClose={onModalClose} />);
    await settleLayers();

    fireEvent.click(screen.getByRole("button", { name: "open popup" }));
    expect(popupRoot()).not.toBeNull();
    await settleLayers();

    // The regression: Radix sees the press as "outside" the dialog content
    // (the popup is a body sibling) and used to dismiss the dialog.
    fireEvent.pointerDown(popupAction());
    fireEvent.click(popupAction());
    expect(onModalClose).not.toHaveBeenCalled();
    // The popup itself stays open — the press was inside it.
    expect(popupRoot()).not.toBeNull();
    expect(screen.getByRole("dialog", { name: "Test modal" })).toBeInTheDocument();
  });

  it("a pointer-down on the backdrop still dismisses the modal", async () => {
    const onModalClose = vi.fn();
    render(<Harness onModalClose={onModalClose} />);
    await settleLayers();

    fireEvent.click(document.querySelector<HTMLElement>(".modal-backdrop")!);
    expect(onModalClose).toHaveBeenCalledTimes(1);
  });

  it("closeOnBackdrop=false ignores the backdrop click", async () => {
    const onModalClose = vi.fn();
    render(
      <Modal isOpen title="Sticky modal" onClose={onModalClose} closeOnBackdrop={false}>
        <p>content</p>
      </Modal>,
    );
    await settleLayers();

    fireEvent.click(document.querySelector<HTMLElement>(".modal-backdrop")!);
    expect(onModalClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    await settleLayers();
    expect(onModalClose).not.toHaveBeenCalled();
  });

  it("Escape closes the popup first, then the modal (overlay-stack LIFO)", async () => {
    const onModalClose = vi.fn();
    render(<Harness onModalClose={onModalClose} />);
    await settleLayers();

    fireEvent.click(screen.getByRole("button", { name: "open popup" }));
    await settleLayers();
    expect(popupRoot()).not.toBeNull();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(popupRoot()).toBeNull();
    expect(onModalClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Test modal" })).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onModalClose).toHaveBeenCalledTimes(1);
  });
});

describe("stacked dialogs: the top one never collapses the one below", () => {
  function StackedHarness({ onLowerClose }: { onLowerClose: () => void }) {
    const [topOpen, setTopOpen] = useState(false);
    return (
      <>
        <Modal isOpen title="Lower dialog" onClose={onLowerClose}>
          <button type="button" onClick={() => setTopOpen(true)}>
            raise confirmation
          </button>
        </Modal>
        <Modal isOpen={topOpen} ariaLabel="Top dialog" onClose={() => setTopOpen(false)} size="sm">
          <p>the top dialog content</p>
        </Modal>
      </>
    );
  }

  it("clicking into the stacked dialog does not dismiss the lower one", async () => {
    const onLowerClose = vi.fn();
    render(<StackedHarness onLowerClose={onLowerClose} />);
    await settleLayers();

    fireEvent.click(screen.getByRole("button", { name: "raise confirmation" }));
    await settleLayers();
    expect(screen.getByRole("dialog", { name: "Top dialog" })).toBeInTheDocument();

    // The regression: the focus move into the stacked dialog rode Radix's
    // focus-outside path and dismissed the lower dialog. (The top dialog's
    // background-hiding pass correctly takes the lower one out of the a11y
    // tree while it is open — assert DOM presence, not accessibility.)
    expect(onLowerClose).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: "Lower dialog", hidden: true }),
    ).toBeInTheDocument();
    expect(screen.getByText("the top dialog content")).toBeInTheDocument();
  });
});

describe("popup inside a modal: the seam's stamp", () => {
  it("stamps the popup root while open and removes the stamp on close", async () => {
    render(<Harness onModalClose={vi.fn()} />);
    await settleLayers();
    expect(popupRoot()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "open popup" }));
    expect(popupRoot()).not.toBeNull();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(popupRoot()).toBeNull();
  });

  it("keeps the portaled popup reachable while the modal hides the background", async () => {
    const { container } = render(<Harness onModalClose={vi.fn()} />);
    await settleLayers();

    // The fleet Modal's own hideOthers pass: the app root is hidden from the
    // accessibility tree, the dialog is not.
    expect(container.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("dialog", { name: "Test modal" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "open popup" }));

    // The popup portaled to body AFTER the pass ran; the seam must keep it
    // un-hidden (the aria-hidden package re-hides dynamically added
    // siblings, which is why the lift re-asserts through an observer).
    await vi.waitFor(() => {
      const root = popupRoot();
      expect(root).not.toBeNull();
      expect(root!.hasAttribute("aria-hidden")).toBe(false);
    });

    // Even a direct re-hide is lifted again.
    popupRoot()!.setAttribute("aria-hidden", "true");
    await vi.waitFor(() => expect(popupRoot()!.hasAttribute("aria-hidden")).toBe(false));
  });
});

describe("popup inside a modal: anchored NodeSelector from the mention picker", () => {
  /** Enter edit mode on the first block and return its editor element. */
  function clickIntoBlock(container: HTMLElement): HTMLElement {
    const content = container.querySelector<HTMLElement>(".nt-block-content");
    if (content === null) throw new Error("no .nt-block-content");
    fireEvent.click(content);
    const editor = content.querySelector<HTMLElement>(".nt-block-text");
    if (editor === null) throw new Error("editor did not mount after click");
    return editor;
  }

  /** Emulate typing with the caret at the end, firing input. */
  function typeWithCaret(editor: HTMLElement, text: string): void {
    editor.textContent = text;
    const node = editor.firstChild;
    if (node !== null) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.setStart(node, text.length);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    fireEvent.input(editor);
  }

  async function settleClient(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  it("the editor's mention picker (a portaled fleet popup) carries the seam stamp", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    await client.createObject({ parentId: pageId, contentAst: [] });
    const { container, unmount } = render(<PageView client={client} pageId={pageId} />);
    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "@");

    const picker = () => document.body.querySelector<HTMLElement>(".node-selector__picker");
    expect(picker()).not.toBeNull();
    // The anchored picker composes the seam: it carries the stamp, so the
    // overlay system's pointer-events/outside-press contracts apply to it.
    expect(picker()!.hasAttribute("data-fleet-popup")).toBe(true);

    unmount();
    await settleClient();
  });
});
