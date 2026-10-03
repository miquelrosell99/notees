/**
 * Slash breadth tests (§34.31 B1 `/query`, §34.28 #9 `/date`, §34.25 T3
 * `/template`) — the three rows that widened the slash command list beyond
 * the block-type actions, through PageView over the in-process
 * WorkspaceClient + MemoryRelay (same harness as capture.test.tsx).
 *
 * - /query inserts a query content token at the caret and opens the builder
 *   popover when the block re-renders in read mode (§34.31 B1's contract).
 * - /date parses the typed query (NL, same parser as the @-picker), ensures
 *   the journal chain, and links the day/month/year page; a bare /date is
 *   today; an unparseable query falls back like a no-match.
 * - /template opens the flat unfiltered template list (D1 amendment), and
 *   the pick instantiates a fresh page through the clone engine (provenance
 *   written), linking it at the caret; {{variables}} open the variable
 *   dialog first and substitute at apply time.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { chainNodeIds, SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";
import type { ContentAst } from "@notees/protocol";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";

const WS = "0192a000-0000-7000-8000-0000000000c9";
const ACTOR = "0192a000-0000-7000-8000-0000000000ca";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
  window.localStorage.clear();
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
function typeWithCaret(editor: HTMLElement, text: string, caret?: number): void {
  editor.textContent = text;
  const node = editor.firstChild;
  const offset = caret ?? text.length;
  if (node !== null) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  fireEvent.input(editor);
}

/**
 * Type a slash command the way keystrokes do: the trigger char first (the
 * capture opens on it), then the rest of the query in a second input.
 */
function typeSlashCommand(editor: HTMLElement, command: string, query = ""): void {
  typeWithCaret(editor, "/", 1);
  typeWithCaret(editor, `/${command}${query === "" ? "" : ` ${query}`}`);
}

const slashPopup = () => screen.queryByRole("listbox", { name: "/ Commands" });

async function setupPageWithBlock(): Promise<{
  client: WorkspaceClient;
  pageId: string;
  blockId: string;
  container: HTMLElement;
}> {
  const client = await seedClient();
  const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
  const blockId = await client.createObject({ parentId: pageId, contentAst: [] });
  const { container } = render(<PageView client={client} pageId={pageId} />);
  return { client, pageId, blockId, container };
}

describe("slash /query (§34.31 B1)", () => {
  it("inserts a query token at the caret and opens the builder popover", async () => {
    const { client, blockId, container } = await setupPageWithBlock();
    const editor = clickIntoBlock(container);
    typeSlashCommand(editor, "query");
    expect(slashPopup()).not.toBeNull();

    fireEvent.keyDown(editor, { key: "Enter" });

    // The token landed with the builder-default AST…
    await waitFor(() => {
      const ast = client.getNode(blockId)?.contentAst as ContentAst;
      expect(ast).toHaveLength(1);
      expect(ast[0]).toMatchObject({
        type: "query",
        queryAst: {
          version: 1,
          scope: { type: "entire_workspace" },
          root: { type: "group", logic: "and", children: [] },
        },
      });
    });
    // …and the builder popover opened on the read-mode token view.
    const builder = await screen.findByRole("dialog", { name: "Query builder" }, { timeout: 3000 });
    expect(within(builder).getByText("Scope")).toBeInTheDocument();
  });
});

describe("slash /date (§34.28 #9)", () => {
  it("links a typed date, creating the daily page on demand", async () => {
    const { client, blockId, container } = await setupPageWithBlock();
    const editor = clickIntoBlock(container);
    typeSlashCommand(editor, "date", "feb 14");
    fireEvent.keyDown(editor, { key: "Enter" });

    const iso = "2026-02-14"; // parseDate fills the current year
    const dayId = chainNodeIds(iso).day;
    await waitFor(() => {
      const ast = client.getNode(blockId)?.contentAst as ContentAst;
      expect(ast[0]).toMatchObject({ type: "mention", targetNodeId: dayId, text: "February 14, 2026" });
    });
    // The chain was ensured: the day page exists.
    expect(client.getNode(dayId)).toBeDefined();
  });

  it("a bare /date links today", async () => {
    const { client, blockId, container } = await setupPageWithBlock();
    const editor = clickIntoBlock(container);
    typeSlashCommand(editor, "date");
    fireEvent.keyDown(editor, { key: "Enter" });

    const d = new Date();
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const dayId = chainNodeIds(iso).day;
    await waitFor(() => {
      const ast = client.getNode(blockId)?.contentAst as ContentAst;
      expect(ast[0]).toMatchObject({ type: "mention", targetNodeId: dayId });
    });
  });

  it("an unparseable query falls back like a no-match (typed text stays)", async () => {
    const { client, blockId, container } = await setupPageWithBlock();
    const editor = clickIntoBlock(container);
    typeSlashCommand(editor, "date", "blahblah");
    fireEvent.keyDown(editor, { key: "Enter" });

    // The trigger word is consumed; the query text survives as plain prose.
    await waitFor(() => {
      expect(editor.textContent).toBe("date blahblah");
    });
    const ast = client.getNode(blockId)?.contentAst as ContentAst;
    expect(ast).toEqual([{ type: "text", text: "date blahblah" }]);
  });
});

describe("slash /template (§34.25 T3)", () => {
  /** A template with one child block; the template class is seeded by the flow's self-heal. */
  async function setupTemplate(client: WorkspaceClient, content = "Sync template") {
    const templateId = await client.createObject({
      presentAsMain: true,
      name: content,
      classIds: [SYSTEM_CLASS_UUIDS.template],
    });
    await client.createObject({
      parentId: templateId,
      contentAst: [{ type: "text", text: "Recurring agenda" }],
    });
    return templateId;
  }

  it("opens the flat template list; the pick instantiates at the caret and writes provenance", async () => {
    const { client, blockId, container } = await setupPageWithBlock();
    const templateId = await setupTemplate(client);
    const editor = clickIntoBlock(container);
    typeSlashCommand(editor, "template");
    fireEvent.keyDown(editor, { key: "Enter" });

    // The flat, unfiltered template list (its own search field, pre-filter empty).
    const list = await screen.findByRole("listbox", { name: "Templates" });
    expect(within(list).getByText("Sync template")).toBeInTheDocument();

    fireEvent.click(within(list).getByText("Sync template"));

    // A fresh root page instantiated from the template…
    await waitFor(() => {
      const ast = client.getNode(blockId)?.contentAst as ContentAst;
      expect(ast[0]).toMatchObject({ type: "mention", text: "Sync template" });
    });
    const mention = (client.getNode(blockId)?.contentAst as ContentAst)[0] as {
      targetNodeId: string;
    };
    const created = client.getNode(mention.targetNodeId);
    expect(created).toBeDefined();
    expect(created!.parentId).toBeNull();
    expect(created!.classIds).not.toContain(SYSTEM_CLASS_UUIDS.template);
    expect(created!.contentAst).toEqual([{ type: "text", text: "Sync template" }]);
    expect(client.getChildren(created!.id)).toHaveLength(1);
    // The template itself is untouched, and provenance was written (D1 amendment).
    expect(client.getChildren(templateId)).toHaveLength(1);
    const generatedFrom = client
      .getEffectiveProperties(created!.id)
      .find((entry) => entry.propertySchemaId === SYSTEM_PROPERTY_UUIDS.generatedFrom);
    expect(generatedFrom?.source).toBe("authored");
    expect(generatedFrom?.value).toEqual({ nodeId: templateId });
  });

  it("the typed remainder filters the flat list", async () => {
    const { client, container } = await setupPageWithBlock();
    await setupTemplate(client, "Meeting template");
    await setupTemplate(client, "Reading template");
    const editor = clickIntoBlock(container);
    typeSlashCommand(editor, "template", "meeting");
    fireEvent.keyDown(editor, { key: "Enter" });

    const list = await screen.findByRole("listbox", { name: "Templates" });
    // Pre-filtered by the remainder.
    expect(within(list).getByText("Meeting template")).toBeInTheDocument();
    expect(within(list).queryByText("Reading template")).toBeNull();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Filter templates" }), { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Templates" })).toBeNull();
  });

  it("{{variables}} open the apply-time dialog and substitute into the instance", async () => {
    const { client, blockId, container } = await setupPageWithBlock();
    const templateId = await client.createObject({
      presentAsMain: true,
      name: "Notes for {{topic}}",
      classIds: [SYSTEM_CLASS_UUIDS.template],
    });
    await client.createObject({
      parentId: templateId,
      contentAst: [{ type: "text", text: "Drafted on {{today}} by {{author}}" }],
    });
    const editor = clickIntoBlock(container);
    typeSlashCommand(editor, "template");
    fireEvent.keyDown(editor, { key: "Enter" });

    const list = await screen.findByRole("listbox", { name: "Templates" });
    fireEvent.click(within(list).getByText(/Notes for/));

    // The apply-time dialog: editable static rows + a readonly dynamic row.
    const dialog = await screen.findByRole("dialog", { name: /Use "Notes for/ });
    const authorInput = within(dialog).getByLabelText("author");
    fireEvent.change(authorInput, { target: { value: "Ada" } });
    // The dynamic row is computed, not editable.
    expect(within(dialog).getByText("today")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("today")).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => {
      const ast = client.getNode(blockId)?.contentAst as ContentAst;
      expect(ast[0]).toMatchObject({ type: "mention" });
    });
    const mention = (client.getNode(blockId)?.contentAst as ContentAst)[0] as {
      targetNodeId: string;
    };
    const created = client.getNode(mention.targetNodeId)!;
    // {{topic}} unfilled substitutes empty (deliberate, never silent; the
    // store trims the trailing space).
    expect(created.contentAst).toEqual([{ type: "text", text: "Notes for" }]);
    const child = client.getChildren(created.id)[0]!;
    const todayIso = new Date();
    const today = `${todayIso.getFullYear()}-${String(todayIso.getMonth() + 1).padStart(2, "0")}-${String(todayIso.getDate()).padStart(2, "0")}`;
    expect(child.contentAst).toEqual([
      { type: "text", text: `Drafted on ${today} by Ada` },
    ]);
    expect(created.id).not.toBe(templateId);
  });
});
