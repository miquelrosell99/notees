/**
 * Code-block editing tests (§34.34 B3 owed editor): a block whose content IS
 * one code_block token swaps the prose contentEditable for the
 * CodeTextarea-integrated surface — typing writes the token's `text`
 * (debounced, the standard content path), the language badge stays, Esc/blur
 * exits back to read mode, and `/code`-created blocks edit in place. Harness:
 * PageView over the in-process WorkspaceClient + MemoryRelay (same as
 * table-nodes.test.tsx).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import type { ContentAst } from "@notees/protocol";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";
import { SAVE_DEBOUNCE_MS } from "../src/ui/BlockTextEditor.js";

const WS = "0192a000-0000-7000-8000-0000000000e1";
const ACTOR = "0192a000-0000-7000-8000-0000000000e2";

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

function clickIntoBlock(container: HTMLElement, index = 0): HTMLElement {
  const content = container.querySelectorAll<HTMLElement>(".nt-block-content")[index];
  if (content === undefined) throw new Error(`no .nt-block-content at index ${index}`);
  fireEvent.click(content);
  const editor = content.querySelector<HTMLElement>(".nt-block-text, .nt-code-editor");
  if (editor === null) throw new Error("editor did not mount after click");
  return editor;
}

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

function typeSlashCommand(editor: HTMLElement, command: string, argument = ""): void {
  typeWithCaret(editor, "/");
  typeWithCaret(editor, `/${command}${argument === "" ? "" : ` ${argument}`}`);
}

describe("code_block editing surface (§34.34 B3)", () => {
  it("clicking a code block mounts the textarea with the language badge; typing writes the token's text", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Code" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "code_block", language: "python", text: "print('hi')" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    // Read mode renders the mono pre + badge.
    expect(container.querySelector(".nt-code-block__pre")?.textContent).toBe("print('hi')");
    expect(container.querySelector(".nt-code-block__lang")?.textContent).toBe("python");

    clickIntoBlock(container);
    // Edit mode swaps the pre for the CodeTextarea (the kit primitive).
    const textarea = screen.getByRole("textbox", { name: "Code" }) as HTMLTextAreaElement;
    expect(textarea.value).toBe("print('hi')");
    // The language badge survives into the editing surface.
    expect(container.querySelector(".nt-code-block__lang")?.textContent).toBe("python");
    // The prose contentEditable is NOT mounted for a code block.
    expect(container.querySelector(".nt-block-text")).toBeNull();

    vi.useFakeTimers();
    fireEvent.change(textarea, { target: { value: "print('hi')\nprint('bye')" } });
    // Debounced: nothing written before the window elapses.
    expect(client.getNode(blockId)?.contentAst).toEqual([
      { type: "code_block", language: "python", text: "print('hi')" },
    ]);
    act(() => {
      vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    });
    vi.useRealTimers();
    await waitFor(() => {
      expect(client.getNode(blockId)?.contentAst).toEqual([
        { type: "code_block", language: "python", text: "print('hi')\nprint('bye')" },
      ]);
    });

    // Blur exits edit mode and read mode shows the new source.
    fireEvent.blur(textarea);
    await waitFor(() => {
      expect(container.querySelector(".nt-code-block__pre")?.textContent).toBe("print('hi')\nprint('bye')");
    });
  });

  it("a /code-created block is editable in place; the sentence became the code", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Code" });
    const blockId = await client.createObject({ parentId: pageId, contentAst: [] });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "SELECT * FROM t");
    await waitFor(() => {
      expect(client.getNode(blockId)?.contentAst).toEqual([{ type: "text", text: "SELECT * FROM t" }]);
    });
    // Append the slash trigger as its own keystroke at a word boundary (the
    // capture opens on the "/" input), then the command text.
    typeWithCaret(editor, "SELECT * FROM t /");
    typeWithCaret(editor, "SELECT * FROM t /code sql");
    fireEvent.keyDown(editor, { key: "Enter" });

    await waitFor(() => {
      expect(client.getNode(blockId)?.contentAst).toEqual([
        { type: "code_block", language: "sql", text: "SELECT * FROM t" },
      ]);
    });

    // Click into the converted block: the code surface mounts with the text.
    const surface = clickIntoBlock(container);
    expect(surface.classList.contains("nt-code-editor")).toBe(true);
    const textarea = screen.getByRole("textbox", { name: "Code" }) as HTMLTextAreaElement;
    expect(textarea.value).toBe("SELECT * FROM t");
    expect(container.querySelector(".nt-code-block__lang")?.textContent).toBe("sql");

    // Escape flushes + exits.
    vi.useFakeTimers();
    fireEvent.change(textarea, { target: { value: "SELECT 1" } });
    fireEvent.keyDown(textarea, { key: "Escape" });
    act(() => {
      vi.advanceTimersByTime(0);
    });
    vi.useRealTimers();
    await waitFor(() => {
      expect(client.getNode(blockId)?.contentAst).toEqual([
        { type: "code_block", language: "sql", text: "SELECT 1" },
      ]);
    });
  });

  it("a language-less code block edits without a badge and keeps it language-less", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Code" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "code_block", text: "plain" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);
    clickIntoBlock(container);
    const textarea = screen.getByRole("textbox", { name: "Code" }) as HTMLTextAreaElement;
    expect(container.querySelector(".nt-code-block__lang")).toBeNull();

    vi.useFakeTimers();
    fireEvent.change(textarea, { target: { value: "plain\nmore" } });
    fireEvent.blur(textarea);
    act(() => {
      vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    });
    vi.useRealTimers();
    await waitFor(() => {
      expect(client.getNode(blockId)?.contentAst).toEqual([
        { type: "code_block", text: "plain\nmore" },
      ]);
    });
  });

  it("mixed content keeps the ordinary prose editor (the surface is the pure-code block only)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Code" });
    await client.createObject({
      parentId: pageId,
      contentAst: [
        { type: "text", text: "see " },
        { type: "code_block", text: "x = 1" },
      ],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const editor = clickIntoBlock(container);
    // The prose contentEditable mounts (mixed block), not the code surface.
    expect(editor.classList.contains("nt-block-text")).toBe(true);
    expect(screen.queryByRole("textbox", { name: "Code" })).toBeNull();
  });
});
