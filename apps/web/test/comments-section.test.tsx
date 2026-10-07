/**
 * CommentsSection tests (the original
 * comments model restored onto the context column): comments are DIRECT
 * CHILDREN classed `comment` (the seeded system class); the section is
 * NodeViewSection chrome ("Comments" + the direct-child count), hidden when
 * empty; the quick-add composer creates a child block classed comment with
 * the text as its content (title-is-content); a reply is a comment whose
 * parent is the comment; children nest in the thread (any child blocks);
 * a row click opens the comment node; each row carries the original Reply/Delete
 * pair. Lazy per the section contract: threads resolve on the first expand
 * (useSectionData), re-deriving per notification while expanded.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { CommentsSection } from "../src/ui/components/CommentsSection.js";

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

/** Flush the microtasks an async client write runs on. */
async function flushWrites(): Promise<void> {
  await act(async () => {});
}

/** Create a comment child (the original model: classed `comment`, parented). */
async function createComment(
  client: WorkspaceClient,
  parentId: string,
  text: string,
): Promise<string> {
  const id = await client.createObject({
    parentId,
    classIds: [SYSTEM_CLASS_UUIDS.comment],
    name: text,
  });
  return id;
}

function commentChildrenOf(client: WorkspaceClient, nodeId: string) {
  return client
    .getChildren(nodeId)
    .filter((node) => node.classIds.includes(SYSTEM_CLASS_UUIDS.comment));
}

describe("CommentsSection", () => {
  it("hidden at zero comments; renders with the direct-child count once one exists", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Doc" });

    const { container, unmount } = render(
      <CommentsSection client={client} nodeId={pageId} onOpenNode={() => {}} />,
    );
    expect(container.firstElementChild).toBeNull();
    unmount();

    await createComment(client, pageId, "First!");
    render(<CommentsSection client={client} nodeId={pageId} onOpenNode={() => {}} />);
    const header = screen.getByRole("button", { name: /Comments/ });
    expect(within(header).getByText("1")).not.toBeNull();
  });

  it("threads resolve lazily on the first expand; a notification re-derives while expanded", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Doc" });
    await createComment(client, pageId, "Hello there");

    render(<CommentsSection client={client} nodeId={pageId} onOpenNode={() => {}} />);
    // Collapsed: the chrome + count render, the rows do not.
    expect(screen.queryByRole("button", { name: "Hello there" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Comments/ }));
    expect(screen.getByRole("button", { name: "Hello there" })).not.toBeNull();

    // A second comment lands while expanded: the section re-derives.
    await act(async () => {
      await createComment(client, pageId, "Second");
    });
    expect(screen.getByRole("button", { name: "Second" })).not.toBeNull();
    expect(within(screen.getByRole("button", { name: /Comments/ })).getByText("2")).not.toBeNull();
  });

  it("the quick-add composer creates a child block classed comment with the text as its content", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Doc" });
    await createComment(client, pageId, "Earlier");

    render(<CommentsSection client={client} nodeId={pageId} onOpenNode={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Comments/ }));
    fireEvent.click(screen.getByRole("button", { name: /Add comment/ }));
    fireEvent.change(screen.getByLabelText("Add a comment…"), {
      target: { value: "Fresh take" },
    });
    fireEvent.keyDown(screen.getByLabelText("Add a comment…"), { key: "Enter" });
    await flushWrites();

    const comments = commentChildrenOf(client, pageId);
    // Title-is-content: the text rides the content AST, the class is set.
    expect(
      comments.some(
        (node) =>
          node.contentAst.length === 1 &&
          (node.contentAst[0] as { type: string; text: string }).text === "Fresh take",
      ),
    ).toBe(true);
    expect(comments).toHaveLength(2);
    // The section re-derived: both rows render, the badge reads 2.
    expect(screen.getByRole("button", { name: "Fresh take" })).not.toBeNull();
  });

  it("a reply is a comment whose parent is the comment; children nest in the thread", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Doc" });
    const parent = await createComment(client, pageId, "Parent comment");
    await createComment(client, parent, "Nested reply");
    // Any child block nests (the original recursion over comment.children) — even a
    // non-comment child rides the thread.
    await client.createObject({ parentId: parent, name: "Ordinary child" });

    render(<CommentsSection client={client} nodeId={pageId} onOpenNode={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Comments/ }));

    const row = screen.getByRole("button", { name: "Parent comment" }).closest("li")!;
    const nested = within(row).getByRole("button", { name: "Nested reply" });
    expect(nested.closest("ul")!.className).toContain("nt-comments__list--nested");
    // The ordinary child nests too — the thread is children-recursive.
    expect(within(row).getByRole("button", { name: "Ordinary child" })).not.toBeNull();
    expect(commentChildrenOf(client, parent)).toHaveLength(1);
    expect(commentChildrenOf(client, parent)[0]!.contentAst).toEqual([
      { type: "text", text: "Nested reply" },
    ]);
  });

  it("the Reply composer parents the new comment under the row's comment", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Doc" });
    const parent = await createComment(client, pageId, "Discussed");

    render(<CommentsSection client={client} nodeId={pageId} onOpenNode={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Comments/ }));
    fireEvent.click(screen.getByRole("button", { name: "Reply to Discussed" }));
    fireEvent.change(screen.getByLabelText("Reply…"), { target: { value: "My reply" } });
    fireEvent.keyDown(screen.getByLabelText("Reply…"), { key: "Enter" });
    await flushWrites();

    const replies = commentChildrenOf(client, parent);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.contentAst).toEqual([{ type: "text", text: "My reply" }]);
    // The reply nests under its parent row in the re-derived thread.
    const row = screen.getByRole("button", { name: "Discussed" }).closest("li")!;
    expect(within(row).getByRole("button", { name: "My reply" })).not.toBeNull();
  });

  it("a row click opens the comment node; Delete trashes it (the original pair)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Doc" });
    const commentId = await createComment(client, pageId, "Open me");

    const onOpenNode = vi.fn();
    render(<CommentsSection client={client} nodeId={pageId} onOpenNode={onOpenNode} />);
    fireEvent.click(screen.getByRole("button", { name: /Comments/ }));

    fireEvent.click(screen.getByRole("button", { name: "Open me" }));
    expect(onOpenNode).toHaveBeenCalledWith(commentId);

    fireEvent.click(screen.getByRole("button", { name: "Delete comment Open me" }));
    await flushWrites();
    expect(client.getNodeRaw(commentId)!.isActive).toBe(false);
    // The section re-derived: the row is gone, the count reads 0 and the
    // whole section hides.
    expect(screen.queryByRole("button", { name: /Comments/ })).toBeNull();
  });
});
