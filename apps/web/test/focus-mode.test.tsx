/**
 * Focus mode (#12) — jsdom over the in-process WorkspaceClient:
 *
 *  - the device setting persists under `notees.settings.focusMode` and
 *    applies the `data-focus` attribute to <html> (via applyAppearance);
 *  - with the mode on, the page chrome is suppressed — top bar, classes
 *    pills, header icon, tags row, cover, properties side panel, system
 *    sections, footer — while the title row stays (the landmark that says
 *    where you are) and text editing still works;
 *  - BlockRow hides its backlink gutter + panel and the property
 *    icon buttons;
 *  - the command palette offers a "Focus mode" command that flips the
 *    setting, and the App-level chords (Ctrl/Cmd+Alt+F toggle, Esc exit)
 *    behave like the other global chords.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { EMPTY_UNDO_STATE } from "../src/core/undo-journal.js";
import { CommandPalette } from "../src/ui/components/CommandPalette.js";
import { ensureTaskFamily } from "../src/ui/components/taskFamily.js";
import { focusModeExitHandler, focusModeKeyHandler } from "../src/ui/App.js";
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
  localStorage.clear();
  document.documentElement.dataset.focus = "false";
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

/** Drain the microtasks a write's floating push+ack chain runs on. */
async function flushSync(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await act(async () => {});
}

function setFocusMode(on: boolean): void {
  localStorage.setItem("notees.settings.focusMode", JSON.stringify(on));
  document.documentElement.dataset.focus = on ? "true" : "false";
}

/**
 * A page carrying every chrome element focus mode suppresses: a class
 * (classes corner + header icon), a tag (tags row), a backlinked block
 * (gutter + panel), and a second page (system sections have a child page
 * to list).
 */
async function seedChromeWorld(): Promise<{ client: WorkspaceClient; pageId: string }> {
  const client = await seedClient();
  const classId = await client.createClass("Fiction");
  const pageId = await client.createObject({
    presentAsMain: true,
    name: "Novel Draft",
    classIds: [classId],
  });
  const tagId = await client.createObject({ presentAsMain: true, name: "tag: writing" });
  await client.assignTag(pageId, tagId);
  const blockId = await client.createObject({
    parentId: pageId,
    contentAst: [{ type: "text", text: "Chapter one" }],
  });
  const source = await client.createObject({ presentAsMain: true, name: "Sources" });
  await client.createObject({
    parentId: source,
    contentAst: [
      { type: "text", text: "see " },
      { type: "mention", targetNodeId: blockId, text: "Chapter one" },
    ],
  });
  const childId = await client.createObject({ presentAsMain: true, name: "Child Page" });
  await client.moveObject(childId, pageId);
  expect(client.getBacklinkCount(blockId)).toBe(1);
  await flushSync();
  return { client, pageId };
}

describe("focus mode page chrome (#12)", () => {
  it("mode off: the panelled chrome renders as usual", async () => {
    const { client, pageId } = await seedChromeWorld();
    setFocusMode(false);
    const { container } = render(<PageView client={client} pageId={pageId} />);
    await flushSync();
    // The panelled main layout: a left properties side panel, the nodeview
    // top bar (sidebar toggle + classes pills), tags row, footer — and no
    // reference sections (the fixture's page has neither backlinks nor
    // unlinked mentions, so the hide-when-empty ruling keeps them off).
    expect(container.querySelector(".nt-page-side-panel")).not.toBeNull();
    expect(container.querySelector(".nt-node-topbar")).not.toBeNull();
    expect(container.querySelector(".nt-node-topbar__classes")).not.toBeNull();
    expect(container.querySelector(".nt-tags-row")).not.toBeNull();
    expect(container.querySelector(".nt-page-footer")).not.toBeNull();
    // The backlinks section would ride below the content, but the hide-when-
    // empty ruling keeps it off: the mention here targets a block inside the
    // page (own-subtree, not a reference), so the page has neither backlinks
    // nor unlinked mentions.
    expect(screen.queryByRole("button", { name: /Backlinks/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Unlinked mentions/ })).toBeNull();
  });

  it("mode on: chrome is suppressed; the title and the editable body stay", async () => {
    const { client, pageId } = await seedChromeWorld();
    setFocusMode(true);
    const { container } = render(<PageView client={client} pageId={pageId} />);
    await flushSync();

    // The suppressed chrome list (no side panel, no top bar, no classes
    // corner/topbar, no tags, no footer, no backlinks section).
    expect(container.querySelector(".nt-page-side-panel")).toBeNull();
    expect(container.querySelector(".nt-node-topbar")).toBeNull();
    expect(container.querySelector(".nt-page-classes-corner")).toBeNull();
    expect(container.querySelector(".nt-node-topbar__classes")).toBeNull();
    expect(container.querySelector(".nt-tags-row")).toBeNull();
    expect(container.querySelector(".nt-page-footer")).toBeNull();
    expect(screen.queryByRole("button", { name: /Backlinks/ })).toBeNull();
    // No system sections (child pages) either.
    expect(container.querySelector(".nt-page-sections")).toBeNull();
    // The header icon + picker are gone; the title is not.
    expect(container.querySelector(".page-icon-btn")).toBeNull();

    // The title row stays — the landmark that says where you are.
    expect(container.querySelector(".nt-page-title")).not.toBeNull();
    // The block body renders and still enters edit mode on click.
    const blockContent = container.querySelector(".nt-block-content") as HTMLElement;
    expect(blockContent.textContent).toContain("Chapter one");
    fireEvent.click(blockContent);
    await flushSync();
    expect(container.querySelector(".nt-block-content [contenteditable]")).not.toBeNull();
  });
});

describe("focus mode block chrome (#12)", () => {
  it("the task status icon button and the collapsed properties hide", async () => {
    const client = await seedClient();
    await ensureTaskFamily(client);
    const pageId = await client.createObject({ presentAsMain: true, name: "Tasks" });
    await client.createObject({
      parentId: pageId,
      classIds: [SYSTEM_CLASS_UUIDS.task],
      contentAst: [{ type: "text", text: "Water the plants" }],
    });
    await flushSync();

    setFocusMode(false);
    const off = render(<PageView client={client} pageId={pageId} />);
    await flushSync();
    expect(off.container.querySelector(".nt-block-bullet-props")).not.toBeNull();
    off.unmount();

    setFocusMode(true);
    const on = render(<PageView client={client} pageId={pageId} />);
    await flushSync();
    expect(on.container.querySelector(".nt-block-bullet-props")).toBeNull();
  });
});

describe("focus mode surfaces (#12)", () => {
  function renderPalette(client: WorkspaceClient) {
    render(
      <CommandPalette
        client={client}
        open
        onRequestOpen={() => {}}
        onClose={() => {}}
        onOpenNode={() => {}}
        onNewPage={() => {}}
        onSignOut={() => {}}
        undoState={EMPTY_UNDO_STATE}
        onUndo={() => {}}
        onRedo={() => {}}
        cacheVersion={0}
      />,
    );
  }

  it("the command palette offers a Focus mode command that flips the setting", async () => {
    const client = await seedClient();
    document.documentElement.dataset.focus = "false";
    renderPalette(client);
    const row = await screen.findByText("Focus mode: enter");
    fireEvent.click(row);
    expect(document.documentElement.dataset.focus).toBe("true");
    expect(localStorage.getItem("notees.settings.focusMode")).toBe("true");
  });

  it("Ctrl/Cmd+Alt+F toggles and Esc exits (guarded from text fields)", () => {
    const toggle = vi.fn();
    const chord = focusModeKeyHandler({ onToggle: toggle });
    document.addEventListener("keydown", chord);
    const event = new KeyboardEvent("keydown", {
      key: "f",
      ctrlKey: true,
      altKey: true,
      cancelable: true,
    });
    document.dispatchEvent(event);
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);

    // Text fields keep the keystroke.
    const input = document.createElement("input");
    document.body.appendChild(input);
    const guarded = new KeyboardEvent("keydown", {
      key: "f",
      ctrlKey: true,
      altKey: true,
      cancelable: true,
    });
    input.dispatchEvent(guarded);
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(guarded.defaultPrevented).toBe(false);
    document.removeEventListener("keydown", chord);

    // Esc exits only while the mode is on, and yields to text fields.
    const exit = vi.fn();
    const exitHandler = focusModeExitHandler({ focusMode: () => true, onExit: exit });
    document.addEventListener("keydown", exitHandler);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(exit).toHaveBeenCalledTimes(1);
    const exitGuarded = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    input.dispatchEvent(exitGuarded);
    expect(exit).toHaveBeenCalledTimes(1);
    document.removeEventListener("keydown", exitHandler);

    const offHandler = focusModeExitHandler({ focusMode: () => false, onExit: exit });
    document.addEventListener("keydown", offHandler);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(exit).toHaveBeenCalledTimes(1);
    document.removeEventListener("keydown", offHandler);
    input.remove();
  });
});
