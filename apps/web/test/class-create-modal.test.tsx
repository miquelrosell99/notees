/**
 * ClassCreateModal + system-class deployment (#14) — jsdom over the
 * in-process WorkspaceClient:
 *
 *  - blank mode creates a class through client.createClass (name carried
 *    from the picker's query);
 *  - deploy mode authors a seeded system class at its FIXED uuid —
 *    ancestors first (extends edges), then the property family from the
 *    seed manifest — convergent with the server seed;
 *  - re-deploying is a complete no-op (the per-step existence checks);
 *  - the catalog excludes classes the workspace already has;
 *  - the Classes hub header hosts the modal (button → modal → created
 *    class opens), and the command palette offers "New class…".
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { EMPTY_UNDO_STATE } from "../src/core/undo-journal.js";
import { ClassCreateModal } from "../src/ui/components/modals/ClassCreateModal.js";
import { CommandPalette } from "../src/ui/components/CommandPalette.js";
import { HubView } from "../src/ui/App.js";

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

describe("ClassCreateModal blank mode (#14)", () => {
  it("creates a class with the typed name", async () => {
    const client = await seedClient();
    const created = vi.fn();
    render(
      <ClassCreateModal isOpen client={client} onClose={() => {}} onCreated={created} />,
    );
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Character" } });
    fireEvent.click(screen.getByRole("button", { name: /create class/i }));
    await waitFor(() => expect(created).toHaveBeenCalledTimes(1));
    const id = created.mock.calls[0]![0] as string;
    const node = client.getNode(id);
    expect(node?.isClass).toBe(true);
    await flushSync();
  });

  it("carries the picker's query in as the initial name", async () => {
    const client = await seedClient();
    render(
      <ClassCreateModal
        isOpen
        client={client}
        initialName="Loca"
        onClose={() => {}}
      />,
    );
    expect(screen.getByLabelText("Name")).toHaveValue("Loca");
  });
});

describe("ClassCreateModal deploy mode (#14)", () => {
  it("deploys a system class at its fixed uuid, family + ancestors included", async () => {
    const client = await seedClient();
    const created = vi.fn();
    render(
      <ClassCreateModal isOpen client={client} onClose={() => {}} onCreated={created} />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /deploy system class/i }));

    const personRow = await screen.findByRole("button", { name: /deploy person/i });
    fireEvent.click(personRow);

    await waitFor(() => expect(created).toHaveBeenCalledTimes(1));
    expect(created.mock.calls[0]![0]).toBe(SYSTEM_CLASS_UUIDS.person);
    await flushSync();

    // The class node landed at the reserved seed id, with the seed icon.
    const person = client.getNode(SYSTEM_CLASS_UUIDS.person);
    expect(person).not.toBeUndefined();
    expect(person!.isClass).toBe(true);
    // The ancestor chain deployed first (person extends agent): both rows
    // exist and the edge is in place.
    expect(client.getNode(SYSTEM_CLASS_UUIDS.agent)).not.toBeUndefined();
    expect(client.getClassParents(SYSTEM_CLASS_UUIDS.person)).toContain(
      SYSTEM_CLASS_UUIDS.agent,
    );
    // The property family: schemas present + bound (given/family name).
    const schemas = new Set(client.listPropertySchemas().map((s) => s.id));
    expect(schemas.has(SYSTEM_PROPERTY_UUIDS.givenName)).toBe(true);
    expect(schemas.has(SYSTEM_PROPERTY_UUIDS.familyName)).toBe(true);
    const bound = client
      .getClassBindings(SYSTEM_CLASS_UUIDS.person)
      .map((b) => b.propertySchemaId);
    expect(bound).toContain(SYSTEM_PROPERTY_UUIDS.givenName);
    expect(bound).toContain(SYSTEM_PROPERTY_UUIDS.familyName);
  });

  it("re-deploying is a complete no-op", async () => {
    const client = await seedClient();
    const { deploySystemClass } = await import("../src/ui/components/systemClassDeploy.js");
    await deploySystemClass(client, "source");
    await flushSync();
    const snapshot = {
      schemas: client.listPropertySchemas().map((s) => s.id).sort(),
      bindings: client.getClassBindings(SYSTEM_CLASS_UUIDS.source).map((b) => b.propertySchemaId).sort(),
      parents: [...client.getClassParents(SYSTEM_CLASS_UUIDS.source)].sort(),
    };
    await deploySystemClass(client, "source");
    await flushSync();
    expect(client.listPropertySchemas().map((s) => s.id).sort()).toEqual(snapshot.schemas);
    expect(client.getClassBindings(SYSTEM_CLASS_UUIDS.source).map((b) => b.propertySchemaId).sort()).toEqual(snapshot.bindings);
    expect([...client.getClassParents(SYSTEM_CLASS_UUIDS.source)].sort()).toEqual(snapshot.parents);
  });

  it("the catalog excludes classes that already exist in the workspace", async () => {
    const client = await seedClient();
    // A workspace that already has the person class (server-seeded shape).
    await client.createClass("Person", { id: SYSTEM_CLASS_UUIDS.person });
    await flushSync();
    render(
      <ClassCreateModal isOpen client={client} onClose={() => {}} />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /deploy system class/i }));
    await screen.findByRole("button", { name: /deploy source/i });
    expect(screen.queryByRole("button", { name: /deploy person/i })).toBeNull();
  });
});

describe("weblink→source extension heal (existing workspaces)", () => {
  it("materializes the edge idempotently on the pre-ruling workspace shape", async () => {
    const client = await seedClient();
    const { ensureWeblinkExtendsSource } = await import(
      "../src/ui/components/systemClassDeploy.js"
    );
    // The pre-ruling shape: the weblink class + its url family exist,
    // the source edge predates the ruling.
    await client.createClass("Web link", { id: SYSTEM_CLASS_UUIDS.weblink });
    await client.createPropertySchema({
      id: SYSTEM_PROPERTY_UUIDS.url,
      name: "URL",
      type: "url",
      scope: "class",
    });
    await client.setClassProperty(SYSTEM_CLASS_UUIDS.weblink, SYSTEM_PROPERTY_UUIDS.url, {
      sequence: 0,
    });
    await flushSync();
    expect(client.getClassParents(SYSTEM_CLASS_UUIDS.weblink)).toEqual([]);

    await ensureWeblinkExtendsSource(client);
    await flushSync();

    // The edge landed (deploySystemClass healed the source root first), and
    // the weblink's own family is untouched.
    expect(client.getClassParents(SYSTEM_CLASS_UUIDS.weblink)).toContain(
      SYSTEM_CLASS_UUIDS.source,
    );
    expect(client.getNode(SYSTEM_CLASS_UUIDS.source)).not.toBeUndefined();
    const bound = client
      .getClassBindings(SYSTEM_CLASS_UUIDS.weblink)
      .map((b) => b.propertySchemaId);
    expect(bound).toContain(SYSTEM_PROPERTY_UUIDS.url);

    // Idempotent: a second run is a complete no-op.
    const snapshot = {
      parents: [...client.getClassParents(SYSTEM_CLASS_UUIDS.weblink)].sort(),
      schemas: client.listPropertySchemas().map((s) => s.id).sort(),
    };
    await ensureWeblinkExtendsSource(client);
    await flushSync();
    expect([...client.getClassParents(SYSTEM_CLASS_UUIDS.weblink)].sort()).toEqual(
      snapshot.parents,
    );
    expect(client.listPropertySchemas().map((s) => s.id).sort()).toEqual(snapshot.schemas);
  });

  it("a converged (server-seeded) workspace skips the heal entirely", async () => {
    const client = await seedClient();
    const { deploySystemClass, ensureWeblinkExtendsSource } = await import(
      "../src/ui/components/systemClassDeploy.js"
    );
    await deploySystemClass(client, "weblink");
    await flushSync();
    const seededParents = [...client.getClassParents(SYSTEM_CLASS_UUIDS.weblink)].sort();

    await ensureWeblinkExtendsSource(client);
    await flushSync();
    expect([...client.getClassParents(SYSTEM_CLASS_UUIDS.weblink)].sort()).toEqual(seededParents);
  });
});

describe("class creation triggers (#14)", () => {
  it("the Classes hub header hosts the modal and opens the created class", async () => {
    const client = await seedClient();
    const opened: string[] = [];
    render(
      <HubView client={client} nav="classes" onOpenNode={(id) => opened.push(id)} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /new class/i }));
    // The modal is up; blank-create a class and watch it open.
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Place" } });
    fireEvent.click(screen.getByRole("button", { name: /create class/i }));
    await waitFor(() => expect(opened).toHaveLength(1));
    expect(client.getNode(opened[0]!)?.isClass).toBe(true);
  });

  it("the command palette offers New class… where the host provides it", async () => {
    const client = await seedClient();
    const openCreate = vi.fn();
    render(
      <CommandPalette
        client={client}
        open
        onRequestOpen={() => {}}
        onClose={() => {}}
        onOpenNode={() => {}}
        onNewPage={() => {}}
        onOpenClassCreate={openCreate}
        onSignOut={() => {}}
        undoState={EMPTY_UNDO_STATE}
        onUndo={() => {}}
        onRedo={() => {}}
        cacheVersion={0}
      />,
    );
    const row = await screen.findByText("New class…");
    fireEvent.click(row);
    expect(openCreate).toHaveBeenCalledTimes(1);
  });
});

describe("asset creation trigger", () => {
  it("the Assets hub header hosts the upload modal; uploading creates + opens the asset", async () => {
    const client = await seedClient();
    const opened: string[] = [];
    render(<HubView client={client} nav="assets" onOpenNode={(id) => opened.push(id)} />);
    fireEvent.click(await screen.findByRole("button", { name: /new asset/i }));
    const dialog = await screen.findByRole("dialog", { name: /upload file/i });

    vi.spyOn(client, "uploadAsset").mockResolvedValue({
      assetId: "asset-hub-1",
      hash: "hash-hub",
      originalName: "paper.pdf",
      mimeType: "application/pdf",
      size: 5,
    });
    vi.spyOn(client, "attachAsset").mockResolvedValue(undefined);
    fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, {
      target: { files: [new File(["%PDF-"], "paper.pdf", { type: "application/pdf" })] },
    });
    await within(dialog).findAllByText("paper.pdf");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: /upload/i }));
    });

    await waitFor(() => expect(opened).toHaveLength(1));
    const asset = client.getNode(opened[0]!);
    expect(asset?.classIds).toContain(SYSTEM_CLASS_UUIDS.asset);
    // The new asset is a hub member (cards listing reflects it).
    expect(client.getClassMembers(SYSTEM_CLASS_UUIDS.asset).map((m) => m.id)).toContain(opened[0]);
  });
});
