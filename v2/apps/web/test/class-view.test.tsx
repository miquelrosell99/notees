/**
 * Class View tests: view resolution f(node_type), class chrome (name/icon/
 * color), extends editing (class.setExtends m2m), read-only property bindings
 * (seed-derived), the description shelf, and the lazy classed-nodes section.
 * jsdom environment over the in-process WorkspaceClient + MemoryRelay.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { NodeView } from "../src/ui/App.js";
import { ClassView } from "../src/ui/ClassView.js";

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

/** Flush the microtasks a fireEvent-triggered async write runs on. */
async function flushWrites(): Promise<void> {
  await act(async () => {});
}

describe("Class View", () => {
  it("resolves views by node type: class → Class View, page → Page View", async () => {
    const client = await seedClient();
    const classId = await client.createClass("source");
    const pageId = await client.createObject({ nodeType: "page", name: "A Page" });

    const classRender = render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    // Class chrome, not the block tree.
    expect(screen.getByRole("heading", { name: "Extends" })).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Property bindings" })).not.toBeNull();
    expect(classRender.container.querySelector(".nt-block-tree")).toBeNull();
    classRender.unmount();

    render(<NodeView client={client} nodeId={pageId} onOpenNode={() => {}} />);
    expect(screen.getByRole("heading", { name: "A Page" })).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Extends" })).toBeNull();
  });

  it("commits the edited class name via the shared TitleEditor pattern", async () => {
    const client = await seedClient();
    const classId = await client.createClass("agent");
    const { container } = render(<ClassView client={client} classId={classId} />);

    const title = container.querySelector<HTMLElement>(".nt-page-title");
    if (title === null) throw new Error("title heading missing");
    expect(title.textContent).toBe("agent");

    title.textContent = "Contributor";
    fireEvent.keyDown(title, { key: "Enter" });
    await flushWrites();
    expect(client.getNode(classId)?.name).toBe("Contributor");
  });

  it("adds an extends parent via the picker: store update + chip", async () => {
    const client = await seedClient();
    const childId = await client.createClass("person");
    const parentId = await client.createClass("agent");
    render(<ClassView client={client} classId={childId} />);

    expect(screen.getByText("No parent classes.")).not.toBeNull();

    fireEvent.change(screen.getByLabelText("Add parent class"), { target: { value: parentId } });
    await flushWrites();

    expect(client.getClassParents(childId)).toEqual([parentId]);
    // The parent renders as a chip linking to its Class View.
    const chip = screen.getByRole("button", { name: "agent" });
    expect(chip.className).toContain("nt-class-chip-link");
  });

  it("removes an extends parent via the chip's remove button", async () => {
    const client = await seedClient();
    const childId = await client.createClass("person");
    const parentId = await client.createClass("agent");
    await client.setClassExtends(childId, [parentId]);
    render(<ClassView client={client} classId={childId} />);

    expect(screen.getByRole("button", { name: "agent" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove parent agent" }));
    await flushWrites();

    expect(client.getClassParents(childId)).toEqual([]);
    expect(screen.getByText("No parent classes.")).not.toBeNull();
  });

  it("keeps the classed-nodes section lazy: no member query until expanded", async () => {
    const client = await seedClient();
    const classId = await client.createClass("agent");
    const membersSpy = vi.spyOn(client, "getClassMembers");
    render(<ClassView client={client} classId={classId} />);

    expect(membersSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /classed nodes/i }));
    await flushWrites();

    expect(membersSpy).toHaveBeenCalledWith(classId);
    expect(screen.getByText("No classed nodes.")).not.toBeNull();
  });

  it("lists a classed node after expand and navigates to its page", async () => {
    const client = await seedClient();
    const classId = await client.createClass("agent");
    const pageId = await client.createObject({ nodeType: "page", name: "Ada Lovelace" });
    await client.assignClass(pageId, classId);
    const onOpenNode = vi.fn();
    render(<ClassView client={client} classId={classId} onOpenPage={onOpenNode} />);

    fireEvent.click(screen.getByRole("button", { name: /classed nodes/i }));
    await flushWrites();

    const memberRow = screen.getByRole("button", { name: /ada lovelace/i });
    fireEvent.click(memberRow);
    expect(onOpenNode).toHaveBeenCalledWith(pageId);
  });

  it("renders the seeded property bindings in sequence order", async () => {
    const client = await seedClient();
    const classId = await client.createClass("source");
    const { container } = render(<ClassView client={client} classId={classId} />);

    const names = [...container.querySelectorAll(".nt-class-binding-name")].map(
      (el) => el.textContent,
    );
    expect(names).toEqual([
      "attachments",
      "authors",
      "linkedAuthors",
      "isbn",
      "doi",
      "publicationDate",
      "publisher",
      "citekey",
    ]);
    // Sequence order is explicit: authors (seq 2) before isbn (seq 3).
    expect(names.indexOf("authors")).toBeLessThan(names.indexOf("isbn"));

    const rows = [...container.querySelectorAll(".nt-class-binding")];
    // Citations revision (2026-09-27): authors is a plain text-multi property…
    const authorsRow = rows[1]!;
    expect(authorsRow.textContent).toContain("text");
    expect(authorsRow.textContent).toContain("multi");
    expect(authorsRow.textContent).not.toContain("agent");
    // …and linkedAuthors is the node-typed, agent-filtered sibling.
    const linkedRow = rows[2]!;
    expect(linkedRow.textContent).toContain("object");
    expect(linkedRow.textContent).toContain("multi");
    expect(linkedRow.textContent).toContain("agent");
  });

  it("renders the class content in the description shelf", async () => {
    const client = await seedClient();
    const classId = await client.createClass("agent");
    render(<ClassView client={client} classId={classId} />);
    expect(screen.getByText("No description.")).not.toBeNull();

    await act(async () => {
      await client.updateObject(classId, {
        contentAst: [{ type: "text", text: "People and organizations." }],
      });
    });

    expect(screen.getByText("People and organizations.")).not.toBeNull();
    expect(screen.queryByText("No description.")).toBeNull();
  });
});
