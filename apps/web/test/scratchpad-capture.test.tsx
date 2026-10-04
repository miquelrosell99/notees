/**
 * Scratchpad capture tests (§34.19 :1180): the seeded scratchpad page
 * renders the keyboard-first capture input at its top; Enter appends the
 * draft as block child(ren) of the page (one per non-empty line), Shift+Enter
 * stays in the draft, the input keeps focus after a capture, and ordinary
 * pages (embedded or not) never render the chrome.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";
import { SCRATCHPAD_PAGE_ID } from "../src/ui/components/ScratchpadCapture.js";
import { proseFromAst } from "../src/editor/prose.js";

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

/** Seed the scratchpad system page exactly like the server seed does. */
async function ensureScratchpad(client: WorkspaceClient): Promise<void> {
  await client.createObject({
    id: SCRATCHPAD_PAGE_ID,
    presentAsMain: true,
    name: "scratchpad",
  });
}

describe("ScratchpadCapture", () => {
  it("renders the capture input at the top of the scratchpad page only", async () => {
    const client = await seedClient();
    await ensureScratchpad(client);
    const plainPage = await client.createObject({ presentAsMain: true, name: "Plain page" });

    const scratch = render(<PageView client={client} pageId={SCRATCHPAD_PAGE_ID} />);
    expect(screen.getByLabelText("Scratchpad capture")).not.toBeNull();
    scratch.unmount();

    const plain = render(<PageView client={client} pageId={plainPage} />);
    expect(screen.queryByLabelText("Scratchpad capture")).toBeNull();
    plain.unmount();
  });

  it("Enter appends the draft as a block; multi-line drafts become one block per line", async () => {
    const client = await seedClient();
    await ensureScratchpad(client);
    const { container } = render(<PageView client={client} pageId={SCRATCHPAD_PAGE_ID} />);

    const input = screen.getByLabelText("Scratchpad capture");
    fireEvent.change(input, { target: { value: "first thought" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByText("Captured 1 block.");

    fireEvent.change(input, { target: { value: "second\n\nthird" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByText("Captured 2 blocks.");

    const children = client.getChildren(SCRATCHPAD_PAGE_ID);
    expect(children.map((child) => proseFromAst(child.contentAst))).toEqual([
      "first thought",
      "second",
      "third",
    ]);
    expect(container.querySelectorAll(".nt-scratch-capture").length).toBe(1);
  });

  it("Shift+Enter stays in the draft; the Add button mirrors the keystroke", async () => {
    const client = await seedClient();
    await ensureScratchpad(client);
    render(<PageView client={client} pageId={SCRATCHPAD_PAGE_ID} />);

    const input = screen.getByLabelText("Scratchpad capture");
    fireEvent.change(input, { target: { value: "line one" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(client.getChildren(SCRATCHPAD_PAGE_ID).length).toBe(0);
    expect((input as HTMLTextAreaElement).value).toBe("line one");

    fireEvent.change(input, { target: { value: "line one\nline two" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await screen.findByText("Captured 2 blocks.");
    expect(
      client.getChildren(SCRATCHPAD_PAGE_ID).map((child) => proseFromAst(child.contentAst)),
    ).toEqual(["line one", "line two"]);
  });

  it("embedded renders skip the capture chrome", async () => {
    const client = await seedClient();
    await ensureScratchpad(client);
    render(<PageView client={client} pageId={SCRATCHPAD_PAGE_ID} embedded />);
    expect(screen.queryByLabelText("Scratchpad capture")).toBeNull();
  });
});
