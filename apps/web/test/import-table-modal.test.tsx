/**
 * ImportTableModal specs (issue #9): the mapping step's create/update
 * counts, update-by-uuid writing cell values (and empty cells unsetting
 * them), the create flow (title + class assignment + properties), select
 * label → option-id matching, per-cell failures landing in the final report
 * without aborting the import, .xlsx files importing through the same flow,
 * and unsupported file types failing loud at the pick step.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { renderXlsx } from "@notees/export";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { ImportTableModal } from "../src/ui/components/modals/ImportTableModal.js";

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

interface TableFixture {
  pages: string;
  status: string;
  taskClass: string;
  alpha: string;
}

async function seedTableWorkspace(client: WorkspaceClient): Promise<TableFixture> {
  const pages = await client.createPropertySchema({ name: "pages", type: "number" });
  const status = await client.createPropertySchema({
    name: "status",
    type: "select",
    options: [
      { id: "opt-backlog", label: "Backlog" },
      { id: "opt-done", label: "Done" },
    ],
  });
  const taskClass = await client.createClass("Task");
  const alpha = await client.createObject({ presentAsMain: true, name: "Alpha" });
  await client.setProperty(alpha, pages, 10, 0);
  return { pages, status, taskClass, alpha };
}

/** Pick a file through the FileDropZone's hidden input (the modal portals
 *  to document.body, so the query is document-scoped). */
function pickFile(file: File): void {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error("file input missing");
  fireEvent.change(input, { target: { files: [file] } });
}

function csvFile(content: string, name = "rows.csv"): File {
  return new File([content], name, { type: "text/csv" });
}

async function importCsv(client: WorkspaceClient, content: string): Promise<void> {
  render(<ImportTableModal isOpen client={client} onClose={() => {}} />);
  pickFile(csvFile(content));
  const counts = await screen.findByTestId("import-preview-counts");
  expect(counts).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  await screen.findByText(/Imported:/);
}

function valueOf(client: WorkspaceClient, nodeId: string, schemaId: string): unknown {
  return client.getEffectiveProperties(nodeId).find((prop) => prop.propertySchemaId === schemaId)?.value;
}

describe("ImportTableModal", () => {
  it("previews create/update counts, skipped rows, and the header mapping", async () => {
    const client = await seedClient();
    const fixture = await seedTableWorkspace(client);
    render(<ImportTableModal isOpen client={client} onClose={() => {}} />);
    pickFile(
      csvFile(
        `uuid,name,pages\n,New book,120\n${fixture.alpha},,42\n,,\n`,
      ),
    );
    const counts = await screen.findByTestId("import-preview-counts");
    expect(counts.textContent).toContain("1 row will update existing nodes");
    expect(counts.textContent).toContain("1 will create new nodes");
    expect(counts.textContent).toContain("1 empty row skipped");
    // Header mapping chips name every column's role.
    expect((await screen.findAllByText(/pages \(number\)/)).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/node id \(update\)/)).not.toBeNull();
    expect(screen.getByText(/title \(new nodes\)/)).not.toBeNull();
    // The preview table shows the data rows.
    expect(screen.getByText("New book")).not.toBeNull();
  });

  it("update-by-uuid writes the cell value; empty cells unset", async () => {
    const client = await seedClient();
    const fixture = await seedTableWorkspace(client);
    await importCsv(client, `uuid,pages\n${fixture.alpha},42\n`);
    expect(valueOf(client, fixture.alpha, fixture.pages)).toBe(42);

    await importCsv(client, `uuid,pages\n${fixture.alpha},\n`);
    expect(valueOf(client, fixture.alpha, fixture.pages)).toBeUndefined();
  });

  it("select cells match option labels to the stored option ids", async () => {
    const client = await seedClient();
    const fixture = await seedTableWorkspace(client);
    await importCsv(client, `uuid,status\n${fixture.alpha},Done\n`);
    expect(valueOf(client, fixture.alpha, fixture.status)).toBe("opt-done");

    await importCsv(client, `uuid,status\n${fixture.alpha},backlog\n`);
    expect(valueOf(client, fixture.alpha, fixture.status)).toBe("opt-backlog");
  });

  it("creates nodes with the title, class assignment, and typed properties", async () => {
    const client = await seedClient();
    const fixture = await seedTableWorkspace(client);
    await importCsv(client, `name,class,pages,status\nGamma,Task,7,Done\n`);
    const created = client.resolveNodeByName("Gamma");
    expect(created).not.toBeNull();
    const node = client.getNode(created!)!;
    expect(node.classIds).toContain(fixture.taskClass);
    expect(valueOf(client, node.id, fixture.pages)).toBe(7);
    expect(valueOf(client, node.id, fixture.status)).toBe("opt-done");
  });

  it("update rows rename the node when a title cell is present", async () => {
    const client = await seedClient();
    const fixture = await seedTableWorkspace(client);
    await importCsv(client, `uuid,name\n${fixture.alpha},Renamed\n`);
    expect(client.resolveNodeByName("Renamed")).toBe(fixture.alpha);
  });

  it("collects bad cells into the report and still imports the good rows", async () => {
    const client = await seedClient();
    const fixture = await seedTableWorkspace(client);
    await importCsv(client, `uuid,name,pages\n${fixture.alpha},,abc\n,Beta,5\n`);
    // The failure is reported with row/column/value/reason (the value rides a
    // <strong>, so assert on the list item's full text)…
    expect(await screen.findByText(/1 cell failed/)).not.toBeNull();
    const failure = document.querySelector(".import-modal__failure-list li");
    expect(failure?.textContent).toContain('Row 2, pages = "abc"');
    expect(failure?.textContent).toContain("not a number");
    // …the update row still counted as updated, and the good row created.
    const summary = screen.getByText(/Imported:/);
    expect(summary.textContent).toContain("1 created");
    expect(summary.textContent).toContain("1 updated");
    expect(client.resolveNodeByName("Beta")).not.toBeNull();
  });

  it("reports update rows whose uuid matches no node", async () => {
    const client = await seedClient();
    await seedTableWorkspace(client);
    const missing = "0192a000-0000-7000-8000-0000000000ff";
    await importCsv(client, `uuid,pages\n${missing},3\n`);
    expect(await screen.findByText(/no node with this uuid/)).not.toBeNull();
    expect(screen.getByText(/Imported:/).textContent).toContain("0 updated");
  });

  it("imports .xlsx files built by the Excel export writer", async () => {
    const client = await seedClient();
    const fixture = await seedTableWorkspace(client);
    const bytes = renderXlsx(
      ["uuid", "pages"],
      [
        [fixture.alpha, 42],
        ["", 7],
      ],
    );
    render(<ImportTableModal isOpen client={client} onClose={() => {}} />);
    pickFile(new File([new Uint8Array(bytes)], "rows.xlsx"));
    const counts = await screen.findByTestId("import-preview-counts");
    expect(counts.textContent).toContain("1 row will update existing nodes");
    expect(counts.textContent).toContain("1 will create new nodes");
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await screen.findByText(/Imported:/);
    expect(valueOf(client, fixture.alpha, fixture.pages)).toBe(42);
  });

  it("fails loud on unsupported file types at the pick step", async () => {
    const client = await seedClient();
    await seedTableWorkspace(client);
    render(<ImportTableModal isOpen client={client} onClose={() => {}} />);
    pickFile(new File(["hello"], "notes.txt"));
    expect(await screen.findByText(/unsupported file type/)).not.toBeNull();
    expect(screen.getByText(/pick a \.csv or \.xlsx file/i)).not.toBeNull();
  });

  it("fails loud when the file has no header row", async () => {
    const client = await seedClient();
    await seedTableWorkspace(client);
    render(<ImportTableModal isOpen client={client} onClose={() => {}} />);
    pickFile(csvFile(""));
    expect(await screen.findByText(/a header row is required/)).not.toBeNull();
  });
});
