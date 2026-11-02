/**
 * Collapsed descendant-count pill tests: a collapsed block with children
 * renders the hover-revealed count pill (`.nt-block-collapsed-count`) whose
 * badge carries the TOTAL RECURSIVE descendant count (every block hidden
 * under the collapse) and whose tooltip names it. Expanded blocks and the
 * rows of the hidden subtree render no pill. The hover reveal itself is
 * CSS (`.nt-block-row:hover`) — jsdom asserts presence and content only.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
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

const text = (t: string) => [{ type: "text", text: t }];

describe("collapsed descendant count", () => {
  it("counts the total recursive blocks hidden under a collapsed block", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Collapse Count" });
    const a = await client.createObject({ parentId: pageId, contentAst: text("A") });
    const b = await client.createObject({ parentId: a, contentAst: text("B") });
    await client.createObject({ parentId: b, contentAst: text("C") });
    await client.createObject({ parentId: a, contentAst: text("D") });

    const { container } = render(<PageView client={client} pageId={pageId} />);

    // Expanded: no pill anywhere.
    expect(container.querySelector(".nt-block-collapsed-count")).toBeNull();

    // Two collapsible blocks in this seed (A and B) — two chevrons. A is
    // the first row in document order.
    fireEvent.click(screen.getAllByLabelText("Collapse block")[0]);

    // A hides B, C and D — three recursive blocks, not two direct children.
    const pill = container.querySelector(".nt-block-collapsed-count");
    expect(pill).not.toBeNull();
    expect(pill!.textContent).toBe("3");
    expect(pill!.getAttribute("title")).toBe("3 blocks inside");
    expect(container.querySelectorAll(".nt-block-collapsed-count")).toHaveLength(1);
    // The hidden subtree's rows (and their own chevrons) unmounted with the
    // collapse — expanding again brings the pill state back to none.
    expect(screen.queryByText("B")).toBeNull();
    expect(screen.queryByText("D")).toBeNull();
    fireEvent.click(screen.getByLabelText("Expand block"));
    expect(container.querySelector(".nt-block-collapsed-count")).toBeNull();
    expect(screen.getByText("C")).toBeDefined();
  });

  it("singular tooltip for a single hidden block", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Singular" });
    const a = await client.createObject({ parentId: pageId, contentAst: text("A") });
    await client.createObject({ parentId: a, contentAst: text("B") });

    const { container } = render(<PageView client={client} pageId={pageId} />);
    fireEvent.click(screen.getByLabelText("Collapse block"));

    const pill = container.querySelector(".nt-block-collapsed-count");
    expect(pill).not.toBeNull();
    expect(pill!.textContent).toBe("1");
    expect(pill!.getAttribute("title")).toBe("1 block inside");
  });
});
