/**
 * View-transform tests: block collapse and prose mode over PageView (jsdom).
 * Both are display-only transforms per SCHEMA.md — collapse is session-local
 * state that hides a subtree from rendering, prose mode is the `nt-prose`
 * class flattening bullets/indents. Neither writes to the store.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";

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

/** Page with a childless root block and a root block holding a two-level subtree. */
async function seedTreePage(client: WorkspaceClient): Promise<string> {
  const pageId = await client.createObject({ nodeType: "page", name: "Transforms" });
  await client.createObject({
    nodeType: "block",
    parentId: pageId,
    contentAst: [{ type: "text", text: "leaf root" }],
  });
  const parent = await client.createObject({
    nodeType: "block",
    parentId: pageId,
    contentAst: [{ type: "text", text: "parent" }],
  });
  const child = await client.createObject({
    nodeType: "block",
    parentId: parent,
    contentAst: [{ type: "text", text: "nested child" }],
  });
  await client.createObject({
    nodeType: "block",
    parentId: child,
    contentAst: [{ type: "text", text: "grandchild" }],
  });
  return pageId;
}

function blockTreeEl(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>(".nt-block-tree");
  if (el === null) throw new Error("no .nt-block-tree rendered");
  return el;
}

/**
 * Click the first "Collapse block" chevron in document order (the root-level
 * parent in the seeded tree). After it collapses, the nested chevron unmounts,
 * so the matching "Expand block" button is unique again.
 */
function collapseRootParent(): void {
  const first = screen.getAllByRole("button", { name: "Collapse block" })[0];
  if (first === undefined) throw new Error("no collapse chevron rendered");
  fireEvent.click(first);
}

describe("block collapse", () => {
  it("hides the entire subtree when collapsed and re-renders it on expand", async () => {
    const client = await seedClient();
    const pageId = await seedTreePage(client);
    const { container } = render(<PageView client={client} pageId={pageId} />);

    // Sanity: both descendant levels render inside nested children containers.
    expect(screen.getByText("nested child")).not.toBeNull();
    expect(screen.getByText("grandchild")).not.toBeNull();
    expect(container.querySelectorAll(".nt-block-children").length).toBe(2);

    collapseRootParent();

    // The whole subtree disappears from the DOM; the block itself stays.
    expect(screen.getByText("parent")).not.toBeNull();
    expect(screen.queryByText("nested child")).toBeNull();
    expect(screen.queryByText("grandchild")).toBeNull();
    expect(container.querySelector(".nt-block-children")).toBeNull();
    expect(screen.getByRole("button", { name: "Expand block" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand block" }));

    expect(screen.getByText("nested child")).not.toBeNull();
    expect(screen.getByText("grandchild")).not.toBeNull();
    expect(container.querySelectorAll(".nt-block-children").length).toBe(2);
  });

  it("renders a chevron only on blocks that have children", async () => {
    const client = await seedClient();
    const pageId = await seedTreePage(client);
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const tree = blockTreeEl(container);
    // Exactly the two parents (root parent + nested child) get a chevron.
    expect(tree.querySelectorAll(".nt-block-chevron").length).toBe(2);

    // The childless root block's row has no chevron — only the plain bullet
    // plus the drag-handle grip that every row carries.
    const leafRow = screen.getByText("leaf root").closest(".nt-block-row");
    expect(leafRow).not.toBeNull();
    expect(
      within(leafRow as HTMLElement).queryByRole("button", { name: /collapse block|expand block/i }),
    ).toBeNull();
    expect(within(leafRow as HTMLElement).getByTitle("Drag to move")).not.toBeNull();
  });

  it("does not enter edit mode when the chevron is clicked", async () => {
    const client = await seedClient();
    const pageId = await seedTreePage(client);
    const { container } = render(<PageView client={client} pageId={pageId} />);

    collapseRootParent();

    // Read-mode content stays; no contentEditable editor mounts in the row.
    expect(container.querySelector(".nt-block-text")).toBeNull();
    expect(screen.getByText("parent")).not.toBeNull();
  });

  it("writes nothing to the store and leaves the tree data intact", async () => {
    const client = await seedClient();
    const pageId = await seedTreePage(client);
    const updateSpy = vi.spyOn(client, "updateObject");
    const createSpy = vi.spyOn(client, "createObject");
    const moveSpy = vi.spyOn(client, "moveObject");
    const deleteSpy = vi.spyOn(client, "deleteObject");
    const treeBefore = JSON.stringify(client.getBlockTree(pageId));

    render(<PageView client={client} pageId={pageId} />);
    collapseRootParent();
    fireEvent.click(screen.getByRole("button", { name: "Expand block" }));

    expect(updateSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
    expect(moveSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
    // Display state only: the underlying tree is untouched.
    expect(JSON.stringify(client.getBlockTree(pageId))).toBe(treeBefore);
  });
});

describe("prose mode", () => {
  it("adds the nt-prose class to the tree container when toggled on", async () => {
    const client = await seedClient();
    const pageId = await seedTreePage(client);
    const { container } = render(<PageView client={client} pageId={pageId} />);

    expect(blockTreeEl(container).classList.contains("nt-prose")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Prose" }));

    expect(blockTreeEl(container).classList.contains("nt-prose")).toBe(true);
  });

  it("keeps the same rows and tree shape while prose mode is on", async () => {
    const client = await seedClient();
    const pageId = await seedTreePage(client);
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const textsBefore = [...container.querySelectorAll(".nt-block-content")].map(
      (el) => el.textContent,
    );
    const blocksBefore = container.querySelectorAll(".nt-block").length;

    fireEvent.click(screen.getByRole("button", { name: "Prose" }));

    const tree = blockTreeEl(container);
    // Every row is still there, same order — only the view changes.
    expect(tree.querySelectorAll(".nt-block").length).toBe(blocksBefore);
    expect([...tree.querySelectorAll(".nt-block-content")].map((el) => el.textContent)).toEqual(
      textsBefore,
    );
    // Nesting still exists in the DOM; the flattening is CSS-only (jsdom
    // cannot compute the stylesheet, so this asserts shape + the class hook
    // that hides bullets and indents).
    expect(tree.querySelectorAll(".nt-block-children").length).toBe(2);
    expect(tree.querySelectorAll(".nt-bullet").length).toBeGreaterThan(0);
    expect(tree.classList.contains("nt-prose")).toBe(true);
  });

  it("restores the outliner view when toggled off", async () => {
    const client = await seedClient();
    const pageId = await seedTreePage(client);
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const toggle = screen.getByRole("button", { name: "Prose" });
    fireEvent.click(toggle);
    expect(blockTreeEl(container).classList.contains("nt-prose")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Prose" }));

    expect(blockTreeEl(container).classList.contains("nt-prose")).toBe(false);
    // Bullets and nested indentation are back (CSS rules no longer apply).
    expect(container.querySelectorAll(".nt-bullet").length).toBeGreaterThan(0);
    expect(container.querySelectorAll(".nt-block-children").length).toBe(2);
  });
});
