/**
 * TitleEditor tests (jsdom): migrated v1 pages carry their title inside the
 * content AST with a null stored `name`; the header must display the derived
 * content excerpt instead of an empty title, focus+blur without typing must
 * NOT materialize the derivation as a stored name, and typing a title
 * commits it.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { OutlinerContext, type OutlinerContextValue } from "../src/ui/outliner-context.js";
import { TitleEditor } from "../src/ui/TitleEditor.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
});

async function makeClient(): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(new MemoryRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

function renderTitle(client: WorkspaceClient, pageId: string) {
  const page = client.getNode(pageId);
  if (page === undefined) throw new Error("page not found");
  const ctx = { client } as unknown as OutlinerContextValue;
  return render(
    <OutlinerContext.Provider value={ctx}>
      <TitleEditor page={page} />
    </OutlinerContext.Provider>,
  );
}

describe("TitleEditor", () => {
  it("shows the derived content excerpt when the stored name is null", async () => {
    const client = await makeClient();
    const pageId = await client.createObject({
      nodeType: "page",
      contentAst: [{ type: "text", text: "The Structure of Scientific Revolutions" }],
    });
    const { container } = renderTitle(client, pageId);
    expect(container.querySelector("h1")!.textContent).toBe(
      "The Structure of Scientific Revolutions",
    );
  });

  it("does not persist the derived title when focus enters and leaves untouched", async () => {
    const client = await makeClient();
    const pageId = await client.createObject({
      nodeType: "page",
      contentAst: [{ type: "text", text: "Derived from prose" }],
    });
    const updateSpy = vi.spyOn(client, "updateObject");
    const { container } = renderTitle(client, pageId);
    const heading = container.querySelector("h1")!;
    fireEvent.focus(heading);
    fireEvent.blur(heading);
    expect(updateSpy).not.toHaveBeenCalled();
    // The stored name is still null — the title keeps tracking content.
    expect(client.getNode(pageId)!.name).toBeNull();
  });

  it("commits a typed title as the stored name", async () => {
    const client = await makeClient();
    const pageId = await client.createObject({
      nodeType: "page",
      contentAst: [{ type: "text", text: "Derived from prose" }],
    });
    const updateSpy = vi.spyOn(client, "updateObject");
    const { container } = renderTitle(client, pageId);
    const heading = container.querySelector("h1")!;
    fireEvent.focus(heading);
    heading.textContent = "Authored Title";
    fireEvent.blur(heading);
    expect(updateSpy).toHaveBeenCalledWith(pageId, { name: "Authored Title" });
  });

  it("keeps a stored name authoritative over content", async () => {
    const client = await makeClient();
    const pageId = await client.createObject({
      nodeType: "page",
      name: "Stored Name",
      contentAst: [{ type: "text", text: "unrelated prose" }],
    });
    const { container } = renderTitle(client, pageId);
    expect(container.querySelector("h1")!.textContent).toBe("Stored Name");
  });
});
