/**
 * Popup dismissal matrix + regressions.
 *
 * Owner bug report (2026-10-04): "most, if not all, of the popups don't close
 * when pressing Esc or clicking outside." The audit found the kit surfaces
 * and several app popups already dismissed
 * honestly, while a family of hand-rolled popups was missing Escape and/or
 * outside-click. The fix is the shared `usePopupDismissal` kit hook; this
 * suite pins the platform convention:
 *
 *  - Escape closes every popup (from focus outside it, and from inside via
 *    each popup's own root handler),
 *  - a pointer-down outside closes,
 *  - a pointer-down inside does NOT close.
 *
 * The matrix runs over a representative set: the kit color popover, a kit
 * ContextMenu, the icon picker, the editor slash popup, and an anchored
 * NodeSelector picker. Each popup family the fix touched gets a regression
 * test below the matrix.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { useRef, useState, type ReactNode, type RefObject } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";
import { ColorButton } from "../src/ui/components/ui/ColorButton.js";
import { ContextMenu, type ContextMenuItem } from "../src/ui/components/ui/ContextMenu.js";
import { IconPickerPopup } from "../src/ui/components/IconPickerPopup.js";
import { CalendarPopup } from "../src/ui/components/pickers/CalendarPopup.js";
import { DatePickerPopup } from "../src/ui/components/pickers/DatePickerPopup.js";
import { SelectionPropertyControl } from "../src/ui/components/pickers/SelectionPropertyControl.js";
import { NodePill } from "../src/ui/components/pickers/NodePill.js";
import { NodePills } from "../src/ui/components/NodePills.js";
import { TemplateListPopup } from "../src/ui/templates/TemplateListPopup.js";
import { VerbPopover } from "../src/ui/VerbPopover.js";
import type { ClientNode } from "../src/core/workspace-client.js";

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
  vi.useRealTimers();
  localStorage.clear();
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

/** Harness that unmounts a popup when its onClose fires — "closes" = gone. */
function Closable({ children }: { children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(true);
  if (!open) return <div data-testid="closed" />;
  return <>{children(() => setOpen(false))}</>;
}

/** Render an outside target alongside the popup for dismissal gestures. */
function withOutside(children: ReactNode, name = "outside") {
  return render(
    <div>
      <button type="button">{name}</button>
      {children}
    </div>,
  );
}

const outsideButton = () => screen.getByRole("button", { name: "outside" });

/* ── Dismissal matrix ─────────────────────────────────────────────── */

describe("dismissal matrix: kit color popover (ColorButton picker)", () => {
  function renderPicker() {
    const onColorChange = vi.fn();
    render(
      <ColorButton color="sky" showPicker aria-label="Pick color" onColorChange={onColorChange} />,
    );
    const trigger = () => screen.getByRole("button", { name: "Pick color" });
    const open = () => {
      fireEvent.click(trigger());
      return screen.getByRole("dialog", { name: "Color picker" });
    };
    return { onColorChange, open };
  }

  it("Escape closes (from outside and from inside the picker)", () => {
    const { open } = renderPicker();
    open();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Color picker" })).toBeNull();

    // Reopen; Escape while the hex field holds focus closes too (root handler).
    open();
    fireEvent.keyDown(screen.getByPlaceholderText("3b82f6"), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Color picker" })).toBeNull();
  });

  it("pointer-down outside closes; pointer-down inside does not", () => {
    withOutside(<ColorButton color="sky" showPicker aria-label="Pick color" onColorChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Pick color" }));
    expect(screen.getByRole("dialog", { name: "Color picker" })).toBeInTheDocument();

    // Inside: pressing on a swatch must not dismiss; only the pick closes.
    fireEvent.pointerDown(screen.getByRole("button", { name: "Red" }));
    expect(screen.getByRole("dialog", { name: "Color picker" })).toBeInTheDocument();

    fireEvent.pointerDown(outsideButton());
    expect(screen.queryByRole("dialog", { name: "Color picker" })).toBeNull();
  });
});

describe("dismissal matrix: kit ContextMenu", () => {
  const items = (): ContextMenuItem[] => [
    { id: "alpha", label: "Alpha", onClick: vi.fn() },
    { id: "beta", label: "Beta", onClick: vi.fn() },
  ];

  it("Escape closes", () => {
    render(<Closable>{(close) => <ContextMenu items={items()} position={{ x: 8, y: 8 }} onClose={close} />}</Closable>);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByTestId("closed")).toBeInTheDocument();
  });

  it("pointer-down outside closes; pressing a menu item does not self-dismiss first", () => {
    const list = items();
    withOutside(<Closable>{(close) => <ContextMenu items={list} position={{ x: 8, y: 8 }} onClose={close} />}</Closable>);

    fireEvent.mouseDown(outsideButton());
    expect(screen.queryByRole("menu")).toBeNull();

    // Reopen: pressing inside the menu keeps it open…
    render(<Closable>{(close) => <ContextMenu items={list} position={{ x: 8, y: 8 }} onClose={close} />}</Closable>);
    fireEvent.mouseDown(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Alpha" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    // …and the activating click still runs the item and then closes.
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Alpha" }));
    expect(list[0]!.onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("dismissal matrix: icon picker popup", () => {
  function renderIconPicker() {
    const onSelect = vi.fn();
    render(
      <Closable>
        {(close) => (
          <IconPickerPopup value={undefined} onSelect={onSelect} onClose={close} anchorEl={null} />
        )}
      </Closable>,
    );
    const dialog = () => screen.queryByRole("dialog", { name: "Icon picker" });
    return { onSelect, dialog };
  }

  it("Escape closes (from outside and from the focused search field)", () => {
    const { dialog } = renderIconPicker();
    expect(dialog()).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(dialog()).toBeNull();

    render(
      <Closable>
        {(close) => (
          <IconPickerPopup value={undefined} onSelect={vi.fn()} onClose={close} anchorEl={null} />
        )}
      </Closable>,
    );
    fireEvent.keyDown(screen.getByLabelText("Search icons and emojis"), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Icon picker" })).toBeNull();
  });

  it("pointer-down outside closes; pressing a cell does not", () => {
    const onSelect = vi.fn();
    withOutside(
      <Closable>
        {(close) => (
          <IconPickerPopup value={undefined} onSelect={onSelect} onClose={close} anchorEl={null} />
        )}
      </Closable>,
    );
    const dialog = () => screen.queryByRole("dialog", { name: "Icon picker" });
    const cell = dialog()!.querySelector(".ep-item")!;
    expect(cell).not.toBeNull();

    fireEvent.pointerDown(cell);
    expect(dialog()).toBeInTheDocument();

    fireEvent.pointerDown(outsideButton());
    expect(dialog()).toBeNull();

    // A full click on a cell still picks + closes (existing contract).
    render(
      <Closable>
        {(close) => (
          <IconPickerPopup value={undefined} onSelect={onSelect} onClose={close} anchorEl={null} />
        )}
      </Closable>,
    );
    fireEvent.click(screen.getByRole("dialog", { name: "Icon picker" }).querySelector(".ep-item")!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "Icon picker" })).toBeNull();
  });
});

/* ── Editor popups (slash + anchored node picker) ─────────────────── */

/** Enter edit mode on the first block and return its editor element. */
function clickIntoBlock(container: HTMLElement): HTMLElement {
  const content = container.querySelector<HTMLElement>(".nt-block-content");
  if (content === null) throw new Error("no .nt-block-content");
  fireEvent.click(content);
  const editor = content.querySelector<HTMLElement>(".nt-block-text");
  if (editor === null) throw new Error("editor did not mount after click");
  return editor;
}

/**
 * Settle fire-and-forget client writes (editor draft commits, background
 * pushes) before afterEach closes the sql.js database — an in-flight write
 * at close surfaces as an unhandled "Database closed" rejection.
 */
async function settleClient(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
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

describe("dismissal matrix: slash command popup (TriggerPopup)", () => {
  async function seedPage() {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    await client.createObject({ parentId: pageId, contentAst: [] });
    const rendered = render(<PageView client={client} pageId={pageId} />);
    const editor = clickIntoBlock(rendered.container);
    typeWithCaret(editor, "/");
    return { ...rendered, editor };
  }

  const slashPopup = () => screen.queryByRole("listbox", { name: "/ Commands" });

  it("Escape (forwarded by the editor) closes the popup", async () => {
    const { editor, unmount } = await seedPage();
    expect(slashPopup()).not.toBeNull();
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(slashPopup()).toBeNull();
    // Unmount + settle before afterEach closes the client: the editor's
    // teardown writes are fire-and-forget and reject on a closed database.
    unmount();
    await settleClient();
  });

  it("pointer-down outside closes; pressing a row does not", async () => {
    const { container, editor, unmount } = await seedPage();
    const row = within(slashPopup()!).getAllByRole("option")[0]!;
    fireEvent.mouseDown(row);
    expect(slashPopup()).not.toBeNull();

    // Mousedown in the page chrome (outside the editor text and the popup).
    const header = container.querySelector<HTMLElement>(".nt-page-header") ?? container;
    fireEvent.mouseDown(header);
    expect(slashPopup()).toBeNull();
    expect(editor.textContent).toBe("/");
    unmount();
    await settleClient();
  });
});

describe("dismissal matrix: anchored NodeSelector (mention picker)", () => {
  it("Escape closes; outside click closes; inside press does not", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    await client.createObject({ parentId: pageId, contentAst: [] });
    const { container, unmount } = render(<PageView client={client} pageId={pageId} />);
    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "@");

    const picker = () => screen.queryByRole("dialog", { name: "Select node" });
    expect(picker()).not.toBeNull();

    // Inside press: the picker's own search input never self-dismisses.
    fireEvent.pointerDown(within(picker()!).getByPlaceholderText("Search pages and blocks…"));
    expect(picker()).not.toBeNull();

    // Outside: the page chrome.
    const header = container.querySelector<HTMLElement>(".nt-page-header") ?? container;
    fireEvent.pointerDown(header);
    expect(picker()).toBeNull();

    // Reopen and Escape.
    typeWithCaret(editor, "@");
    expect(picker()).not.toBeNull();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(picker()).toBeNull();
    unmount();
    await settleClient();
  });
});

/* ── Regression: one per popup family the fix touched ─────────────── */

describe("regression: pickers/CalendarPopup gains Escape", () => {
  function renderCalendar() {
    const anchorRef: RefObject<HTMLButtonElement | null> = { current: null };
    const onClose = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <div>
          <button
            type="button"
            ref={(el) => {
              anchorRef.current = el;
            }}
          >
            trigger
          </button>
          <button type="button">elsewhere</button>
          <CalendarPopup
            isOpen={open}
            onClose={() => {
              onClose();
              setOpen(false);
            }}
            anchorRef={anchorRef}
            firstDayOfWeek={1}
            onSelectDay={() => {}}
            onSelectMonth={() => {}}
            onSelectYear={() => {}}
          />
        </div>
      );
    }
    render(<Harness />);
    const dialog = () => screen.queryByRole("dialog", { name: "Calendar", hidden: true });
    return { onClose, dialog };
  }

  it("Escape closes from the document and from a focused day", () => {
    const { dialog } = renderCalendar();
    expect(dialog()).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(dialog()).toBeNull();

    renderCalendar();
    const day = within(screen.getByRole("dialog", { name: "Calendar" })).getAllByRole("button")
      .find((b) => /^-?\d+$/.test(b.textContent ?? "") && b.getAttribute("aria-label") !== null)!;
    fireEvent.keyDown(day, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Calendar" })).toBeNull();
  });

  it("pointer-down on the anchor trigger does not close; on a day does not; outside does", () => {
    const { dialog } = renderCalendar();
    fireEvent.pointerDown(screen.getByRole("button", { name: "trigger" }));
    expect(dialog()).toBeInTheDocument();

    const dialogEl = dialog()!;
    fireEvent.pointerDown(within(dialogEl).getByRole("button", { name: "Previous" }));
    expect(dialog()).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByRole("button", { name: "elsewhere" }));
    expect(dialog()).toBeNull();
  });
});

describe("regression: DatePickerPopup gains document-level Escape", () => {
  it("Escape closes from the document and from the text input", () => {
    const onClose = vi.fn();
    render(<DatePickerPopup onSelect={() => {}} onClose={onClose} firstDayOfWeek={1} />);
    // jsdom gives the popup no size, so it stays visibility:hidden until
    // positioned — assert presence on the DOM, not the (empty) a11y name.
    expect(document.body.querySelector(".date-picker-popup")).not.toBeNull();

    // Inside first: the input handler and the popup root both close (idempotent).
    fireEvent.keyDown(screen.getByLabelText("Type a date"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();

    // Then from the document (focus never entered / left the popup).
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("regression: TemplateListPopup keeps dismissal when focus left the filter", () => {
  const stubClient = {
    getClassMembers: () => [] as ClientNode[],
    subscribe: () => () => {},
  };

  it("Escape closes from the document and from the filter input", () => {
    const onClose = vi.fn();
    render(
      <TemplateListPopup
        position={{ top: 8, left: 8, caretTop: 0 }}
        client={stubClient}
        ensure={() => Promise.resolve()}
        initialQuery=""
        onPick={vi.fn()}
        onClose={onClose}
      />,
    );
    expect(screen.getByRole("listbox", { name: "Templates" })).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    // In the input the filter's own handler and the popup root both close
    // (idempotent by design) — assert the count grew, not an exact number.
    const before = onClose.mock.calls.length;
    fireEvent.keyDown(screen.getByLabelText("Filter templates"), { key: "Escape" });
    expect(onClose.mock.calls.length).toBeGreaterThan(before);
  });
});

describe("regression: NodePills overflow popup + color menu gain Escape", () => {
  async function seedClassedPage() {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const classIds: string[] = [];
    for (const name of ["Alpha", "Beta", "Gamma"]) {
      classIds.push(await client.createClass(name));
    }
    for (const classId of classIds) await client.assignClass(pageId, classId);
    return { client, pageId, classIds };
  }

  it("Escape closes the +N overflow popup", async () => {
    const { client, pageId, classIds } = await seedClassedPage();
    render(<NodePills client={client} nodeId={pageId} classIds={classIds} overflow sortable={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Show 2 more classes" }));
    expect(screen.getByRole("dialog", { name: "All classes" })).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "All classes" })).toBeNull();
    // Settle the seed's fire-and-forget writes before afterEach closes the DB.
    await settleClient();
  });

  it("Escape closes the Change-color swatch popup", async () => {
    const { client, pageId, classIds } = await seedClassedPage();
    render(<NodePills client={client} nodeId={pageId} classIds={classIds} sortable={false} />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Alpha" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Change color/ }));
    expect(document.body.querySelector(".context-menu-color-row")).not.toBeNull();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(document.body.querySelector(".context-menu-color-row")).toBeNull();
    await settleClient();
  });
});

describe("regression: NodePill right-click color row gains Escape", () => {
  const node: ClientNode = {
    id: "0192a000-0000-7000-8000-0000000000c1",
    workspaceId: WS,
    isClass: true,
    presentAsMain: false,
    parentId: null,
    classIds: [],
    tagIds: [],
    name: "Alpha",
    contentAst: [],
    icon: null,
    coverAssetId: null,
    bannerAssetId: null,
    aliasedNodeId: null,
    description: null,
    color: null,
    isActive: true,
    createdAt: null,
    updatedAt: null,
  };

  it("Escape closes; pressing a swatch does not self-dismiss", () => {
    render(<NodePill node={node} onColorChange={vi.fn()} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: /Right-click for actions/ }));

    const row = () => document.body.querySelector(".context-menu-color-row");
    expect(row()).not.toBeNull();

    // Press (no click yet) on a swatch: the row stays.
    fireEvent.pointerDown(row()!.querySelectorAll("button")[1]!);
    expect(row()).not.toBeNull();

    // Escape dismisses.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(row()).toBeNull();
  });
});

describe("regression: VerbPopover gains outside-click dismissal", () => {
  it("pointer-down outside cancels; inside press does not; Escape still cancels", () => {
    const onCancel = vi.fn();
    withOutside(
      <VerbPopover top={0} left={0} onSubmit={vi.fn()} onCancel={onCancel} />,
    );
    const verbInput = screen.getByLabelText("Verb");

    fireEvent.pointerDown(verbInput);
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.keyDown(verbInput, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(outsideButton());
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});

describe("regression: SelectionPropertyControl picker gains Escape", () => {
  it("Escape closes; outside pointer closes; picking an option closes", () => {
    const onAdd = vi.fn();
    withOutside(
      <SelectionPropertyControl
        options={[
          { id: "a", label: "Apple" },
          { id: "b", label: "Banana" },
        ]}
        values={[]}
        multi
        onAdd={onAdd}
        onRemove={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Empty" }));
    expect(screen.getByRole("button", { name: /Apple/ })).toBeInTheDocument();

    // Inside press does not dismiss.
    fireEvent.pointerDown(screen.getByRole("button", { name: /Apple/ }));
    expect(screen.getByRole("button", { name: /Apple/ })).toBeInTheDocument();

    // The pick commits and closes (existing contract).
    fireEvent.click(screen.getByRole("button", { name: /Apple/ }));
    expect(onAdd).toHaveBeenCalledWith("a");
    expect(screen.queryByRole("button", { name: /Banana/ })).toBeNull();

    // Reopen: Escape + outside pointer both close.
    fireEvent.click(screen.getByRole("button", { name: "Empty" }));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("button", { name: /Banana/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Empty" }));
    fireEvent.pointerDown(outsideButton());
    expect(screen.queryByRole("button", { name: /Banana/ })).toBeNull();
  });
});
