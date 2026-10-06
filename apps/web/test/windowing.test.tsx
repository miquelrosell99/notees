/**
 * Windowing tests (§34.70): the shared useWindowed engine + the
 * ShowMoreButton affordance integrated per surface — the table (window
 * growth, reset-on-sort, the honest select-all label, and the CSV full-set
 * invariant), cards, kanban columns, the flat outline, the grouped outline
 * sections (the references grouping), and the read-only outline tree (with
 * the editable outliner tree deliberately staying whole). jsdom over the
 * in-process WorkspaceClient + MemoryRelay (the view-modes precedent).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { renderHook } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { ClassView } from "../src/ui/ClassView.js";
import { CollectionHub } from "../src/ui/components/CollectionHub.js";
import { PageView } from "../src/ui/PageView.js";
import { NodeCollection } from "../src/ui/views/index.js";
import { useWindowed } from "../src/ui/views/useWindowed.js";
import type { NodeCollectionItem } from "../src/ui/views/index.js";

/** The `.nt-backlinks` strip (the selected tab's rows load on mount). */
function backlinksStrip(): HTMLElement {
  const strip = document.querySelector(".nt-backlinks");
  if (strip === null) throw new Error("no .nt-backlinks strip rendered");
  return strip as HTMLElement;
}

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

/** Members seeded past the default window (100) in every surface test. */
const BIG = 120;

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

/** Flush the microtasks a fireEvent-triggered async write runs on. */
async function flushWrites(): Promise<void> {
  await act(async () => {});
}

const expandClassedNodes = async (): Promise<void> => {
  const header = screen.getByRole("button", { name: /classed nodes/i });
  if (header.getAttribute("aria-expanded") === "false") {
    fireEvent.click(header);
    await flushWrites();
  }
};

describe("useWindowed — the §34.70 engine", () => {
  it("starts at the window size, grows by size, and names the remaining count", () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    const { result } = renderHook(() => useWindowed(items, { size: 100 }));
    expect(result.current.visible).toHaveLength(100);
    expect(result.current.remaining).toBe(150);
    expect(result.current.hasMore).toBe(true);

    act(() => result.current.showMore());
    expect(result.current.visible).toHaveLength(200);
    expect(result.current.remaining).toBe(50);

    act(() => result.current.showMore());
    expect(result.current.visible).toHaveLength(250);
    expect(result.current.remaining).toBe(0);
    expect(result.current.hasMore).toBe(false);
  });

  it("resets to the first window when the resetKey changes (sort/filter)", () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useWindowed(items, { size: 100, resetKey: key }),
      { initialProps: { key: "a" } },
    );
    act(() => result.current.showMore());
    expect(result.current.visible).toHaveLength(200);

    rerender({ key: "b" });
    expect(result.current.visible).toHaveLength(100);
    expect(result.current.remaining).toBe(150);
  });

  it("a shrunken list stays fully visible with nothing remaining", () => {
    const { result, rerender } = renderHook(
      ({ items }: { items: number[] }) => useWindowed(items, { size: 100 }),
      { initialProps: { items: Array.from({ length: 250 }, (_, i) => i) } },
    );
    act(() => result.current.showMore());
    expect(result.current.visible).toHaveLength(200);

    rerender({ items: [1, 2, 3] });
    expect(result.current.visible).toEqual([1, 2, 3]);
    expect(result.current.remaining).toBe(0);
    expect(result.current.hasMore).toBe(false);
  });

  it("defaults to the shared 100-row window", () => {
    const items = Array.from({ length: 101 }, (_, i) => i);
    const { result } = renderHook(() => useWindowed(items));
    expect(result.current.visible).toHaveLength(100);
    expect(result.current.remaining).toBe(1);
  });
});

describe("table windowing (§34.70)", () => {
  async function seedBigTable(client: WorkspaceClient): Promise<string> {
    // WORKAROUND(store applier): class.create's contentAst never lands —
    // seed the title through object.update instead.
    const classId = await client.createClass("project");
    await client.updateObject(classId, { contentAst: [{ type: "text", text: "project" }] });
    for (let i = 0; i < BIG; i += 1) {
      const member = await client.createObject({
        presentAsMain: true,
        name: `Member ${String(i).padStart(3, "0")}`,
      });
      await client.assignClass(member, classId);
    }
    return classId;
  }

  const rowCount = (): number =>
    screen.getAllByRole("table")[0]!.querySelectorAll(".nt-table-name-label").length;

  it("renders the first window with an honest remaining count; Show more grows", async () => {
    const client = await seedClient();
    const classId = await seedBigTable(client);
    render(<ClassView client={client} classId={classId} />);
    await expandClassedNodes();

    expect(rowCount()).toBe(100);
    const more = screen.getByRole("button", { name: "Show more (20 remaining)" });

    fireEvent.click(more);
    expect(rowCount()).toBe(BIG);
    expect(screen.queryByRole("button", { name: /Show more/ })).toBeNull();
  });

  it("a sort change resets the window", async () => {
    const client = await seedClient();
    const classId = await seedBigTable(client);
    render(<ClassView client={client} classId={classId} />);
    await expandClassedNodes();

    fireEvent.click(screen.getByRole("button", { name: "Show more (20 remaining)" }));
    expect(rowCount()).toBe(BIG);

    fireEvent.click(screen.getByRole("button", { name: /^Name/ }));
    expect(rowCount()).toBe(100);
    expect(screen.getByRole("button", { name: "Show more (20 remaining)" })).not.toBeNull();
  });

  it("select-all is labeled and covers the loaded window only", async () => {
    const client = await seedClient();
    const classId = await seedBigTable(client);
    render(<ClassView client={client} classId={classId} />);
    await expandClassedNodes();

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all loaded rows" }));
    // 100 loaded rows selected — the hidden 20 stay unselected (labeled so).
    expect(document.querySelectorAll(".nt-table-row--selected").length).toBe(100);
    expect(screen.getByText("100 selected")).not.toBeNull();
  });

  it("CSV export covers the FULL set, never the window (regression)", async () => {
    const client = await seedClient();
    const classId = await seedBigTable(client);
    const download = stubDownload();
    render(<ClassView client={client} classId={classId} />);
    await expandClassedNodes();

    // The window shows 100; the export must still carry all 120 rows.
    expect(rowCount()).toBe(100);
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    const csv = await readBlobText(download.blob!);
    const lines = csv.split(/\r?\n/).filter((line) => line !== "");
    expect(lines[0]).toContain("Name");
    expect(lines).toHaveLength(BIG + 1); // header + every member
    download.restore();
  });
});

describe("cards windowing (§34.70)", () => {
  it("windows the card grid; Show more grows it", async () => {
    const client = await seedClient();
    const items: NodeCollectionItem[] = [];
    for (let i = 0; i < BIG; i += 1) {
      const id = await client.createObject({ presentAsMain: true, name: `Card ${i}` });
      items.push({ node: client.getNode(id)! });
    }
    render(
      <CollectionHub
        client={client}
        icon="mdi-view-grid-outline"
        title="Big set"
        items={items}
        modes={["cards"]}
        defaultMode="cards"
        onOpenNode={() => {}}
      />,
    );

    // The hub count badge names the FULL set while the grid renders the window.
    expect(document.querySelector(".nt-hub-count")!.textContent).toBe(String(BIG));
    expect(screen.getAllByRole("article")).toHaveLength(100);

    fireEvent.click(screen.getByRole("button", { name: "Show more (20 remaining)" }));
    expect(screen.getAllByRole("article")).toHaveLength(BIG);
  });
});

describe("kanban column windowing (§34.70)", () => {
  it("windows each column independently; the count badge stays full", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({
      name: "Status",
      type: "select",
      options: [{ id: "00000000-0000-0000-00c7-000000000001", label: "Backlog" }],
    });
    const items: NodeCollectionItem[] = [];
    for (let i = 0; i < BIG; i += 1) {
      const id = await client.createObject({ presentAsMain: true, name: `Task ${i}` });
      await client.setProperty(id, schemaId, "00000000-0000-0000-00c7-000000000001", 0);
      items.push({ node: client.getNode(id)! });
    }
    render(
      <CollectionHub
        client={client}
        icon="mdi-view-grid"
        title="Board"
        items={items}
        modes={["kanban"]}
        defaultMode="kanban"
        kanbanProperty={schemaId}
        onOpenNode={() => {}}
      />,
    );

    const column = document.querySelector(
      '.kanban-column[data-column-id="00000000-0000-0000-00c7-000000000001"]',
    ) as HTMLElement;
    // Full bucket count in the header; the loaded window on the board.
    expect(within(column).getByText(String(BIG))).not.toBeNull();
    expect(column.querySelectorAll(".kanban-card")).toHaveLength(100);

    fireEvent.click(within(column).getByRole("button", { name: "Show more (20 remaining)" }));
    expect(column.querySelectorAll(".kanban-card")).toHaveLength(BIG);
  });
});

describe("flat outline windowing (§34.70)", () => {
  it("windows the list; Show more grows it", async () => {
    const client = await seedClient();
    const items: NodeCollectionItem[] = [];
    for (let i = 0; i < BIG; i += 1) {
      const id = await client.createObject({ presentAsMain: true, name: `Item ${i}` });
      items.push({ node: client.getNode(id)! });
    }
    render(
      <CollectionHub
        client={client}
        icon="mdi-format-list-bulleted"
        title="Big list"
        items={items}
        modes={["outline"]}
        defaultMode="outline"
        onOpenNode={() => {}}
      />,
    );

    expect(document.querySelector(".nt-hub-count")!.textContent).toBe(String(BIG));
    expect(document.querySelectorAll(".outline-flat li")).toHaveLength(100);

    fireEvent.click(screen.getByRole("button", { name: "Show more (20 remaining)" }));
    expect(document.querySelectorAll(".outline-flat li")).toHaveLength(BIG);
  });
});

describe("grouped outline sections — the references grouping (§34.70)", () => {
  it("windows a huge group per group; the group count names the full set", async () => {
    const client = await seedClient();
    const targetId = await client.createObject({ presentAsMain: true, name: "Zebra" });
    const sourceId = await client.createObject({ presentAsMain: true, name: "Source One" });
    for (let i = 0; i < BIG; i += 1) {
      await client.createObject({
        parentId: sourceId,
        contentAst: [{ type: "mention", targetNodeId: targetId, text: "Zebra" }],
      });
    }
    render(<PageView client={client} pageId={targetId} onOpenPage={() => {}} />);

    // The selected Backlinks tab loaded its rows on mount.
    const linked = backlinksStrip();

    // One group, its header count honest at 120, its rows windowed at 100.
    expect(linked.querySelectorAll(".outline-group")).toHaveLength(1);
    expect(linked.querySelector(".outline-group__count")!.textContent).toBe(String(BIG));
    expect(linked.querySelectorAll(".outline-group__items > li")).toHaveLength(100);

    fireEvent.click(within(linked).getByRole("button", { name: "Show more (20 remaining)" }));
    expect(linked.querySelectorAll(".outline-group__items > li")).toHaveLength(BIG);
  });
});

describe("outline tree windowing (§34.70)", () => {
  it("windows a read-only child-page tree; Show more grows it", async () => {
    const client = await seedClient();
    const parentId = await client.createObject({ presentAsMain: true, name: "Parent" });
    for (let i = 0; i < BIG; i += 1) {
      await client.createObject({
        parentId,
        presentAsMain: true,
        name: `Sub ${String(i).padStart(3, "0")}`,
      });
    }
    render(<PageView client={client} pageId={parentId} onOpenPage={() => {}} />);

    // Child pages starts expanded; the section badge reads the materialized
    // full count while the tree renders the loaded window.
    const sections = document.querySelectorAll(".node-view-section");
    const childPages = [...sections].find((section) =>
      section.textContent?.includes("Child pages"),
    ) as HTMLElement;
    expect(childPages.querySelector(".node-view-section__count")!.textContent).toBe(String(BIG));
    expect(screen.getByText("Sub 000")).not.toBeNull();
    expect(screen.queryByText("Sub 119")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show more (20 remaining)" }));
    expect(screen.getByText("Sub 119")).not.toBeNull();
  });

  it("the editable outliner tree stays whole — no window on the editing surface", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Big doc" });
    for (let i = 0; i < BIG; i += 1) {
      await client.createObject({
        parentId: pageId,
        contentAst: [{ type: "text", text: `blk ${i}` }],
      });
    }
    render(<PageView client={client} pageId={pageId} onOpenPage={() => {}} />);

    // Every top-level block renders — a window could hide a just-created
    // block, so the editable tree is deliberately excluded from windowing.
    expect(screen.getByText("blk 0")).not.toBeNull();
    expect(screen.getByText(`blk ${BIG - 1}`)).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Show more/ })).toBeNull();
  });

  it("NodeCollection windows a flat collection directly", async () => {
    const client = await seedClient();
    const items: NodeCollectionItem[] = [];
    for (let i = 0; i < BIG; i += 1) {
      const id = await client.createObject({ presentAsMain: true, name: `Ro ${i}` });
      items.push({ node: client.getNode(id)! });
    }
    const { container } = render(
      <NodeCollection
        viewMode="outline"
        client={client}
        items={items}
        onNodeClick={() => {}}
      />,
    );
    expect(container.querySelectorAll(".outline-flat li")).toHaveLength(100);
    fireEvent.click(screen.getByRole("button", { name: "Show more (20 remaining)" }));
    expect(container.querySelectorAll(".outline-flat li")).toHaveLength(BIG);
  });
});

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

/** Read a Blob as UTF-8 text in jsdom (whose Blob has no arrayBuffer()). */
function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}
