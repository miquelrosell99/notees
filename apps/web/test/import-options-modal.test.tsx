/**
 * ImportOptionsModal specs — the unified hub (spec §2): the five sources
 * listed in v1 order (+ the new Logseq DB), the workspace-name field shown
 * only for workspace-creating sources, the per-source disabled logic, the
 * client-side name-taken check, the offline fail-loud for server sources,
 * the Markdown file happy path end to end (MemoryTransport client), the
 * Logseq DB dry-run preview → confirm → report ride, and report rendering.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { ImportOptionsModal } from "../src/features/import/ImportOptionsModal.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.unstubAllGlobals();
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

function renderModal(client: WorkspaceClient, overrides: Partial<Parameters<typeof ImportOptionsModal>[0]> = {}) {
  return render(
    <ImportOptionsModal
      isOpen
      client={client}
      serverUrl={null}
      credential=""
      onOpenWorkspace={() => {}}
      onClose={() => {}}
      {...overrides}
    />,
  );
}

/** The modal portals to document.body; the drop zone's input is the visible-source picker. */
function pickFile(file: File): void {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error("file input missing");
  fireEvent.change(input, { target: { files: [file] } });
}

function selectSource(label: string): void {
  const titles = [...document.querySelectorAll(".import-unified__radio-title")];
  const target = titles.find((el) => el.textContent === label);
  if (target === undefined) throw new Error(`source ${label} missing`);
  fireEvent.click(target.closest(".radio-container")!.querySelector("button")!);
}

const SOURCE_LABELS = [
  "Notees Dump",
  "Markdown",
  "Markdown file",
  "Logseq folder",
  "Logseq DB",
];

describe("ImportOptionsModal", () => {
  it("lists all five sources in the v1 order", async () => {
    const client = await seedClient();
    renderModal(client);
    expect(screen.getAllByRole("radio")).toHaveLength(5);
    const titles = [...document.querySelectorAll(".import-unified__radio-title")].map(
      (el) => el.textContent,
    );
    expect(titles).toEqual(SOURCE_LABELS);
  });

  it("shows the workspace-name field only for json and markdown", async () => {
    const client = await seedClient();
    renderModal(client);
    // Default source = json.
    expect(screen.getByPlaceholderText("my-notes")).not.toBeNull();

    selectSource("Markdown file");
    await waitFor(() => expect(screen.queryByPlaceholderText("my-notes")).toBeNull());

    selectSource("Markdown");
    expect(screen.getByPlaceholderText("my-notes")).not.toBeNull();

    selectSource("Logseq folder");
    expect(screen.queryByPlaceholderText("my-notes")).toBeNull();

    selectSource("Logseq DB");
    expect(screen.queryByPlaceholderText("my-notes")).toBeNull();
  });

  it("keeps Import disabled until the source is valid (json needs name + file)", async () => {
    const client = await seedClient();
    renderModal(client);
    const importButton = (): HTMLButtonElement =>
      screen.getByRole("button", { name: "Import" }) as HTMLButtonElement;
    expect(importButton().disabled).toBe(true);
    // Server sources fail loud offline: json disabled even with a file.
    pickFile(new File(["{}"], "dump.json"));
    expect(importButton().disabled).toBe(true);
  });

  it("fails loud for server sources while offline", async () => {
    const client = await seedClient();
    renderModal(client);
    expect(screen.getByText(/needs the sync server/i)).not.toBeNull();
    selectSource("Markdown file");
    await waitFor(() => expect(screen.queryByText(/needs the sync server/i)).toBeNull());
  });

  it("checks the workspace name client-side and blocks taken names", async () => {
    const client = await seedClient();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ workspaces: [{ id: "ws-1", name: "Taken" }] }),
        headers: new Headers(),
      }),
    );
    renderModal(client, { serverUrl: "http://server", credential: "token" });
    // json needs a name AND a file; the name check rides on top of that.
    pickFile(new File(["{}"], "dump.json"));
    const input = await screen.findByPlaceholderText("my-notes");
    fireEvent.change(input, { target: { value: "taken" } });
    expect(await screen.findByText("This name is already taken")).not.toBeNull();
    expect((screen.getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.change(input, { target: { value: "fresh-notes" } });
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
  });

  it("imports a Markdown file into the current workspace and reports", async () => {
    const client = await seedClient();
    renderModal(client);
    selectSource("Markdown file");
    const id = "0192a000-0000-7000-8000-0000000000bb";
    pickFile(
      new File(
        [`---\nuuid: ${id}\ntitle: Imported Page\n---\n\n# Ignored heading for title\n\nBody **bold**.`],
        "page.md",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    expect(await screen.findByText("Imported 1 item.")).not.toBeNull();
    expect(screen.getByText("Created")).not.toBeNull();

    const node = client.getNode(id);
    expect(node).not.toBeUndefined();
    expect(node!.contentAst).toEqual([{ type: "text", text: "Imported Page" }]);
    const children = client.getChildren(id);
    expect(children).toHaveLength(1);
    expect(children[0]!.contentAst[0]).toEqual({
      type: "heading",
      children: [{ type: "text", text: "Ignored heading for title" }],
    });
  });

  it("reports a fail-loud markdown error without a report phase", async () => {
    const client = await seedClient();
    renderModal(client);
    selectSource("Markdown file");
    pickFile(new File(["---\ntitle: [unclosed\n---\n\nBody"], "bad.md"));
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByText(/frontmatter/i)).not.toBeNull();
  });
});

/** Build a tiny Logseq DB .sqlite export in-test (the kvs datom store). */
function buildSqliteBytes(): Uint8Array {
  const KW = (s: string) => `~:${s}`;
  const UU = (s: string) => `~u${s}`;
  const page = (datoms: unknown[]) => JSON.stringify(["^ ", KW("keys"), datoms]);
  const db = new sqlModule.Database();
  db.run("CREATE TABLE kvs (addr INTEGER PRIMARY KEY, content TEXT)");
  db.run("INSERT INTO kvs (addr, content) VALUES (0, ?)", [page([[1, KW("schema"), 1, 1]])]);
  db.run("INSERT INTO kvs (addr, content) VALUES (1000, ?)", [
    page([
      [10, KW("db/ident"), KW("user.class/person-aaaa"), 1],
      [10, KW("block/title"), "Person", 1],
      [10, KW("block/uuid"), UU("aaaaaaaa-0000-4000-8000-000000000010"), 1],
      [50, KW("block/uuid"), UU("50505050-0000-4000-8000-000000000050"), 1],
      [50, KW("block/title"), "New Person", 1],
      [50, KW("block/tags"), 10, 1],
    ]),
  ]);
  const bytes = db.export();
  db.close();
  return bytes;
}

describe("ImportOptionsModal — Logseq DB source", () => {
  it("previews the dry run, confirms explicitly, and reports the reconcile", async () => {
    const client = await seedClient();
    await client.createClass("Person");
    renderModal(client);
    selectSource("Logseq DB");
    pickFile(new File([buildSqliteBytes().buffer as ArrayBuffer], "logseq.sqlite"));

    // Dry-run preview is the default: counts + no writes yet.
    const preview = await screen.findByTestId("import-db-preview");
    expect(preview.textContent).toContain("1 new node");
    expect(preview.textContent).toContain("Person");
    expect(client.getNodeRaw("50505050-0000-4000-8000-000000000050")).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: /Import 1 changes/ }));
    expect(await screen.findByText("Created")).not.toBeNull();

    const created = client.getNodeRaw("50505050-0000-4000-8000-000000000050");
    expect(created).not.toBeUndefined();
    expect(created!.contentAst).toEqual([{ type: "text", text: "New Person" }]);
  });
});
