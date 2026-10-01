/**
 * TitleEditor tests (jsdom): title-is-content — the page's title IS its text
 * content. The header displays the content excerpt, focus+blur without
 * typing must NOT materialize a content write, and typing a title commits a
 * text-only contentAst via updateObject.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

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
  localStorage.clear();
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

  it("does not persist anything when focus enters and leaves untouched", async () => {
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
    // The content is untouched — the title keeps tracking it.
    expect(client.getNode(pageId)!.contentAst).toEqual([
      { type: "text", text: "Derived from prose" },
    ]);
  });

  it("commits a typed title as the page's text content", async () => {
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
    expect(updateSpy).toHaveBeenCalledWith(pageId, {
      contentAst: [{ type: "text", text: "Authored Title" }],
    });
  });

  it("content is authoritative: the name convenience yields to explicit contentAst", async () => {
    const client = await makeClient();
    const pageId = await client.createObject({
      nodeType: "page",
      name: "Stored Name",
      contentAst: [{ type: "text", text: "unrelated prose" }],
    });
    const { container } = renderTitle(client, pageId);
    expect(container.querySelector("h1")!.textContent).toBe("unrelated prose");
  });

  it("renders date pages as a static title in the user's dateFormat", async () => {
    localStorage.setItem("notees.settings.dateFormat", JSON.stringify("YYYY/MM/DD"));
    const client = await makeClient();
    const pageId = await client.createObject({
      nodeType: "page",
      name: "20260627",
      classIds: [SYSTEM_CLASS_UUIDS.day],
    });
    const updateSpy = vi.spyOn(client, "updateObject");
    const { container } = renderTitle(client, pageId);
    const heading = container.querySelector("h1")!;
    expect(heading.textContent).toBe("2026/06/27");
    expect(heading.getAttribute("contenteditable")).toBeNull();
    // Interacting with the static title never renames the date page.
    fireEvent.focus(heading);
    fireEvent.blur(heading);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("applies the dateFormat setting to date page titles", async () => {
    localStorage.setItem("notees.settings.dateFormat", JSON.stringify("DD-MM-YYYY"));
    const client = await makeClient();
    const pageId = await client.createObject({
      id: "00000000-0000-0000-00dd-202906270000",
      nodeType: "page",
      classIds: [SYSTEM_CLASS_UUIDS.day],
      contentAst: [{ type: "text", text: "20290627" }],
    });
    const { container } = renderTitle(client, pageId);
    expect(container.querySelector("h1")!.textContent).toBe("27-06-2029");
  });
});
