/**
 * Selection export beyond tables: flat
 * cards and kanban collections gain the table's selection machinery (a
 * per-card checkbox, session state) and the same "Export selected…"
 * affordance (the ExportPageModal batch path over the checked ids). The
 * table's CSV export gains the optional selected-rows scope. Harness:
 * jsdom over the in-process WorkspaceClient, direct NodeCollection renders.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient, type ClientNode } from "../src/core/workspace-client.js";
// The barrel import registers every built-in view (registration side effects).
import { NodeCollection } from "../src/ui/views/index.js";
import type { NodeCollectionItem } from "../src/ui/views/types.js";

const WS = "0192a000-0000-7000-8000-0000000000b1";
const ACTOR = "0192a000-0000-7000-8000-0000000000b2";

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

async function flushWrites(): Promise<void> {
  await act(async () => {});
}

/** Capture downloadBlob's anchor + blob (jsdom has no URL.createObjectURL). */
function stubDownload() {
  const captured: { blob: Blob | null; anchor: HTMLAnchorElement | null; restore: () => void } = {
    blob: null,
    anchor: null,
    restore: () => {},
  };
  Object.defineProperty(URL, "createObjectURL", {
    value: vi.fn((blob: Blob) => {
      captured.blob = blob;
      return "blob:mock";
    }),
    configurable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      captured.anchor = this;
    });
  captured.restore = () => click.mockRestore();
  return captured;
}

function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

/** Spec-local RFC-4180 reader (the export package's own test idiom). */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += char;
    } else if (char === '"') inQuotes = true;
    else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else if (char === "\r") {
      if (text[i + 1] !== "\n") field += char;
    } else field += char;
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

async function makeItems(client: WorkspaceClient, names: string[]): Promise<NodeCollectionItem[]> {
  const items: NodeCollectionItem[] = [];
  for (const name of names) {
    const id = await client.createObject({ presentAsMain: true, name });
    items.push({ node: client.getNode(id) as ClientNode });
  }
  return items;
}

describe("table CSV — the optional selected-rows scope", () => {
  it("Export selected CSV downloads just the checked rows; Export CSV stays whole-view", async () => {
    const client = await seedClient();
    const items = await makeItems(client, ["Alpha", "Beta", "Gamma"]);
    const download = stubDownload();
    render(
      <NodeCollection viewMode="table" client={client} items={items} exportFileName="projects" />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Alpha" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Beta" }));

    fireEvent.click(screen.getByRole("button", { name: "Export selected as CSV" }));
    expect(download.anchor?.download).toBe("projects-selected.csv");
    const scoped = parseCsv(await readBlobText(download.blob!));
    expect(scoped[0]).toEqual(["Name", "Classes", "Created"]);
    expect(scoped.map((row) => row[0])).toEqual(["Name", "Alpha", "Beta"]);

    // The whole-view export is untouched: all three rows.
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    const whole = parseCsv(await readBlobText(download.blob!));
    expect(whole.map((row) => row[0])).toEqual(["Name", "Alpha", "Beta", "Gamma"]);
    download.restore();
  });
});

describe("cards selection export", () => {
  it("card checkboxes accumulate a session selection and Export selected… opens the batch modal over the checked ids", async () => {
    const client = await seedClient();
    const items = await makeItems(client, ["Alpha", "Beta", "Gamma"]);
    render(<NodeCollection viewMode="cards" client={client} items={items} />);

    // The checkbox rides each card; the card highlights while checked.
    const checkbox = screen.getByRole("checkbox", { name: "Select Alpha" });
    fireEvent.click(checkbox);
    const card = document.querySelector(".node-card--selected");
    expect(card?.getAttribute("data-node-id")).toBe(items[0]!.node.id);

    // The toolbar chrome mirrors the table's: count + the modal affordance.
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Gamma" }));
    expect(screen.getByText("2 selected")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Export selected…" }));
    expect(await screen.findByText("Export 2 nodes")).toBeTruthy();

    // Toggle off clears the chrome.
    const closeButtons = screen.getAllByRole("button", { name: /Close modal|Close/ });
    fireEvent.click(closeButtons[closeButtons.length - 1]!);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Alpha" }));
    expect(screen.queryByText("2 selected")).toBeNull();
    expect(screen.getByText("1 selected")).toBeDefined();
    expect(document.querySelectorAll(".node-card--selected")).toHaveLength(1);
  });

  it("selectable={false} renders no checkboxes (the tables' opt-out contract)", async () => {
    const client = await seedClient();
    const items = await makeItems(client, ["Solo"]);
    const { container } = render(
      <NodeCollection viewMode="cards" client={client} items={items} selectable={false} />,
    );
    expect(container.querySelector(".node-card__select")).toBeNull();
  });
});

describe("kanban selection export", () => {
  it("board cards check + export through the same affordance", async () => {
    const client = await seedClient();
    const statusId = await client.createPropertySchema({
      name: "Status",
      type: "select",
      options: [
        { id: "00000000-0000-0000-00c5-000000000011", label: "Backlog" },
        { id: "00000000-0000-0000-00c5-000000000012", label: "Doing" },
      ],
    });
    const alpha = await client.createObject({ presentAsMain: true, name: "Alpha" });
    const beta = await client.createObject({ presentAsMain: true, name: "Beta" });
    await client.setProperty(alpha, statusId, "00000000-0000-0000-00c5-000000000011", 0);
    await client.setProperty(beta, statusId, "00000000-0000-0000-00c5-000000000012", 0);
    const items: NodeCollectionItem[] = [alpha, beta].map(
      (id) => ({ node: client.getNode(id) as ClientNode }),
    );
    render(
      <NodeCollection
        viewMode="kanban"
        client={client}
        items={items}
        kanbanProperty={statusId}
        propertiesOf={(nodeId) => client.getEffectiveProperties(nodeId)}
      />,
    );

    // Both cards render inside their columns with the selection checkbox
    // (Alpha's value places it in Backlog; the board groups by the values).
    const backlog = document.querySelector(
      '[data-column-id="00000000-0000-0000-00c5-000000000011"]',
    ) as HTMLElement;
    expect(backlog).not.toBeNull();
    fireEvent.click(within(backlog).getByRole("checkbox", { name: "Select Alpha" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Beta" }));
    expect(screen.getByText("2 selected")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Export selected…" }));
    expect(await screen.findByText("Export 2 nodes")).toBeTruthy();
  });
});
