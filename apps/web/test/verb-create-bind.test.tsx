/**
 * Schema-at-capture tests — the Tana flagship gesture: the verb
 * popover's create-and-bind row authors a property schema at capture
 * (propertySchema.create typed object/multi, empty targetClassFilter) and
 * binds the typed_link mark to it (`verb: { propertySchemaId }`); an exact
 * name hit binds to the EXISTING schema instead; the plain Link submit keeps
 * the free-string verb untouched; the bound verb renders the schema's name
 * (not the raw id); the mark's schema id flows into the derived edge index
 * (verb = propertySchemaId). Also the LinkEditModal verb field: the same
 * create-and-bind row, opened from a right-click on a typed-link word.
 * Harness: PageView over the in-process WorkspaceClient + MemoryRelay
 * (same as editor-popups.test.tsx); the modal row uses a direct render.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import type { ContentAst } from "@notees/protocol";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";
import { LinkEditModal } from "../src/ui/editor-popups/LinkEditModal.js";
import type { AnyClient } from "../src/ui/components/Sidebar.js";

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
  delete (document as unknown as Record<string, unknown>).caretRangeFromPoint;
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

function clickIntoBlock(container: HTMLElement): HTMLElement {
  const content = container.querySelector<HTMLElement>(".nt-block-content");
  if (content === null) throw new Error("no .nt-block-content");
  fireEvent.click(content);
  const editor = content.querySelector<HTMLElement>(".nt-block-text");
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

/** Select the prose range [start, end) inside the editor (Cmd+K reads it). */
function selectRange(editor: HTMLElement, start: number, end: number): void {
  const node = editor.firstChild;
  if (node === null) throw new Error("editor has no text node");
  const selection = window.getSelection();
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

const verbPopover = () => document.body.querySelector<HTMLElement>(".nt-verb-popover");

/** Derived edge rows for a source node (the edge index is never authored). */
function edgesOf(client: WorkspaceClient, sourceId: string): Array<{ type: string; verb: string | null }> {
  return client.store.database
    .prepare("SELECT type, verb FROM edge WHERE source_id = ?")
    .all(sourceId) as Array<{ type: string; verb: string | null }>;
}

describe("verb create-and-bind", () => {
  it("creates the property schema at capture and binds the mark to it", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "As Smith argues" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "As Smith argues");
    await waitFor(() => {
      expect(client.getNode(blockId)?.contentAst).toEqual([{ type: "text", text: "As Smith argues" }]);
    });

    selectRange(editor, 3, 8); // "Smith"
    fireEvent.keyDown(editor, { key: "k", ctrlKey: true });
    expect(verbPopover()).not.toBeNull();

    fireEvent.change(within(verbPopover()!).getByLabelText("Verb"), { target: { value: "supports" } });
    // No existing schema named "supports" → the create-and-bind row shows.
    const createRow = within(verbPopover()!).getByRole("button", {
      name: 'Create property "supports" and bind',
    });
    fireEvent.click(createRow);

    await waitFor(() => {
      const ast = client.getNode(blockId)?.contentAst as ContentAst;
      const mark = ast.find((t) => (t as { type?: string }).type === "typed_link") as
        | { verb: { propertySchemaId: string }; text: string; metadata?: { locator?: string } }
        | undefined;
      expect(mark).toBeDefined();
      expect(mark!.text).toBe("Smith");
      // The schema exists with the PG1 shape: object, multi, no class filter.
      const schema = client
        .listPropertySchemas()
        .find((s) => s.id === mark!.verb.propertySchemaId);
      expect(schema).toBeDefined();
      expect(schema!.name).toBe("supports");
      expect(schema!.type).toBe("object");
      expect(schema!.multi).toBe(true);
      expect(schema!.targetClassFilter ?? []).toEqual([]);
    });

    const ast = client.getNode(blockId)?.contentAst as ContentAst;
    const mark = ast.find((t) => (t as { type?: string }).type === "typed_link") as {
      verb: { propertySchemaId: string };
      text: string;
    };
    // The mark's schema id flows into the derived edge index (verb = schema id).
    await waitFor(() => {
      const edge = edgesOf(client, blockId).find((e) => e.type === "typed_link");
      expect(edge?.verb).toBe(mark.verb.propertySchemaId);
    });

    // Read mode renders the bound verb with the SCHEMA NAME, not the raw id.
    fireEvent.blur(editor);
    await waitFor(() => {
      const bound = container.querySelector<HTMLElement>(".nt-typed-link");
      expect(bound).not.toBeNull();
      expect(bound!.getAttribute("title")).toBe("supports");
      expect(bound!.getAttribute("data-verb-bound")).toBe(mark.verb.propertySchemaId);
    });
  });

  it("an exact name hit binds to the EXISTING schema — no schema is created", async () => {
    const client = await seedClient();
    const existingId = await client.createPropertySchema({
      name: "cites",
      type: "object",
      multi: true,
      targetClassFilter: [],
    });
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "Smith argues" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "Smith argues");
    // The view's self-heals (cover/alias families) settle before the count.
    await waitFor(() => {
      expect(client.getNode(blockId)?.contentAst).toEqual([{ type: "text", text: "Smith argues" }]);
    });
    await act(async () => {});
    const schemaIdsBefore = client.listPropertySchemas().map((s) => s.id);

    selectRange(editor, 0, 5); // "Smith"
    fireEvent.keyDown(editor, { key: "k", metaKey: true });
    fireEvent.change(within(verbPopover()!).getByLabelText("Verb"), { target: { value: "Cites" } });
    // Case-insensitive exact hit → the bind row (no create row).
    fireEvent.click(within(verbPopover()!).getByRole("button", { name: 'Bind to property "cites"' }));

    await waitFor(() => {
      const ast = client.getNode(blockId)?.contentAst as ContentAst;
      const mark = ast.find((t) => (t as { type?: string }).type === "typed_link") as
        | { verb: { propertySchemaId: string } }
        | undefined;
      expect(mark?.verb.propertySchemaId).toBe(existingId);
    });
    expect(client.listPropertySchemas().map((s) => s.id).sort()).toEqual(schemaIdsBefore.sort());
  });

  it("the free-string path is untouched: Link submits the plain verb", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "Smith argues" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    typeWithCaret(editor, "Smith argues");
    // The view's self-heals (cover/alias families) settle before the count.
    await waitFor(() => {
      expect(client.getNode(blockId)?.contentAst).toEqual([{ type: "text", text: "Smith argues" }]);
    });
    await act(async () => {});
    const schemaIdsBefore = client.listPropertySchemas().map((s) => s.id);

    selectRange(editor, 0, 5);
    fireEvent.keyDown(editor, { key: "k", ctrlKey: true });
    fireEvent.change(within(verbPopover()!).getByLabelText("Verb"), { target: { value: "nuances" } });
    // The create row is on offer, but the plain Link submit stays free-string.
    fireEvent.click(within(verbPopover()!).getByRole("button", { name: "Link" }));

    await waitFor(() => {
      const ast = client.getNode(blockId)?.contentAst as ContentAst;
      expect(ast).toEqual([
        {
          type: "typed_link",
          verb: "nuances",
          text: "Smith",
          metadata: { candidateSpans: [] },
        },
        { type: "text", text: " argues" },
      ]);
    });
    // No schema authored by the free-string path.
    expect(client.listPropertySchemas().map((s) => s.id).sort()).toEqual(schemaIdsBefore.sort());
  });

  it("right-clicking a typed-link word opens the modal's verb field; save rewrites the verb", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [
        { type: "text", text: "see " },
        { type: "typed_link", verb: "cites", text: "Smith", metadata: {} },
      ],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container);
    // Hit-test inside "Smith" (prose offsets 4..9).
    const doc = document as Document & { caretRangeFromPoint?: unknown };
    doc.caretRangeFromPoint = () => {
      const range = document.createRange();
      const node = editor.firstChild!.nextSibling!;
      range.setStart(node, 1);
      range.setEnd(node, 1);
      return range;
    };
    fireEvent.contextMenu(editor, { clientX: 40, clientY: 12 });

    const dialog = await screen.findByRole("dialog", { name: "Edit Link Verb" });
    const verbInput = within(dialog).getByLabelText("Verb") as HTMLInputElement;
    expect(verbInput.value).toBe("cites");

    fireEvent.change(verbInput, { target: { value: "contradicts" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(client.getNode(blockId)?.contentAst).toEqual([
        { type: "text", text: "see " },
        // An empty metadata record is not re-emitted (nothing to carry).
        { type: "typed_link", verb: "contradicts", text: "Smith" },
      ]);
    });
  });
});

describe("LinkEditModal verb field (PG1 modal row)", () => {
  function renderVerbModal(overrides: {
    schemas?: Array<{ id: string; name: string }>;
    createSchema?: (input: { name: string; type: string; multi: boolean; targetClassFilter: string[] }) => Promise<string>;
    onSave?: (result: unknown) => void;
  } = {}) {
    const schemas = overrides.schemas ?? [];
    const created: Array<{ name: string; type: string; multi: boolean; targetClassFilter: string[] }> = [];
    const client = {
      listPropertySchemas: () => schemas,
      createPropertySchema:
        overrides.createSchema ??
        ((input: { name: string; type: string; multi: boolean; targetClassFilter: string[] }) => {
          created.push(input);
          return Promise.resolve(`schema-${input.name}`);
        }),
      getNode: () => undefined,
    } as unknown as AnyClient;
    const onSave = vi.fn(overrides.onSave ?? (() => {}));
    render(
      <LinkEditModal
        isOpen
        client={client}
        initialMode="verb"
        currentVerb=""
        currentLocator=""
        onSave={onSave}
        onClose={() => {}}
      />,
    );
    return { onSave, created };
  }

  it("offers 'Create property … and bind' for an unknown verb and saves the bound shape", async () => {
    const { onSave, created } = renderVerbModal();
    const dialog = screen.getByRole("dialog", { name: "Edit Link" });
    fireEvent.change(within(dialog).getByLabelText("Verb"), { target: { value: "extends" } });
    fireEvent.change(within(dialog).getByLabelText("Locator"), { target: { value: "ch. 4" } });
    fireEvent.click(
      within(dialog).getByRole("button", { name: 'Create property "extends" and bind' }),
    );
    await waitFor(() => {
      expect(created).toEqual([
        { name: "extends", type: "object", multi: true, targetClassFilter: [] },
      ]);
      expect(onSave).toHaveBeenCalledWith({
        mode: "verb",
        verb: { propertySchemaId: "schema-extends" },
        locator: "ch. 4",
        label: null,
      });
    });
  });

  it("an exact schema-name hit saves bound to the existing schema (no create row)", () => {
    const { onSave, created } = renderVerbModal({ schemas: [{ id: "s-1", name: "cites" }] });
    const dialog = screen.getByRole("dialog", { name: "Edit Link" });
    fireEvent.change(within(dialog).getByLabelText("Verb"), { target: { value: "cites" } });
    expect(within(dialog).queryByRole("button", { name: /Create property/ })).toBeNull();
    expect(within(dialog).getByText(/Saves bound to the "cites" property/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({
      mode: "verb",
      verb: { propertySchemaId: "s-1" },
      locator: "",
      label: null,
    });
    expect(created).toEqual([]);
  });

  it("a miss without the bind row saves the free-text verb", () => {
    const { onSave, created } = renderVerbModal();
    const dialog = screen.getByRole("dialog", { name: "Edit Link" });
    fireEvent.change(within(dialog).getByLabelText("Verb"), { target: { value: "nuances" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({ mode: "verb", verb: "nuances", locator: "", label: null });
    expect(created).toEqual([]);
  });
});
