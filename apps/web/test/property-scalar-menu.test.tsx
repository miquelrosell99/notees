/**
 * The scalar value row's node context menu (the 2026-11-02 wiring): a
 * plain-string text value renders as the scalar block row; the RIGHT-CLICK
 * mints the carrier WITHOUT the editor hand-off and opens the node context
 * menu ON the minted carrier (the scalar isn't a node yet — the menu
 * gesture materializes it first, the ghost-realize precedent). Carrier
 * rows already render BlockRow, whose own grip menu covers them.
 */

import { render, fireEvent, act } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { MemoryRelay, MemoryTransport } from "@notees/sync";
import type { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { TextPropertyRow } from "../src/features/metadata/TextPropertyRow.js";

const clients: WorkspaceClient[] = [];
afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
});

async function seedClient(): Promise<WorkspaceClient> {
  const { WorkspaceClient } = await import("../src/core/workspace-client/index.js");
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(new MemoryRelay()),
  });
  clients.push(client);
  await client.bootstrapWorkspace("4b7d1a00-2222-4000-8000-000000000099");
  return client;
}

describe("the scalar value row's context menu", () => {
  it("right-click mints the carrier and opens the node context menu on it", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "PMID", type: "text" });
    const pageId = await client.createObject({ isEmbedded: false, name: "P" });
    await client.setProperty(pageId, schemaId, "39559938", 0);

    const { container } = render(
      <TextPropertyRow
        client={client}
        nodeId={pageId}
        propertySchemaId={schemaId}
        label="PMID"
        multi={false}
        rows={client.getEffectiveProperties(pageId)}
        icon="mdi-text"
      />,
    );
    const content = container.querySelector(".nt-property-scalar-content") as HTMLElement;
    expect(content).not.toBeNull();
    fireEvent.contextMenu(content, { clientX: 12, clientY: 20 });
    // The mint is async (create + property.set) — let the microtasks land.
    await act(async () => {});
    await act(async () => {});

    // The carrier was minted carrying the scalar string…
    const effective = client.getEffectiveProperties(pageId);
    expect(effective).toHaveLength(1);
    const carrierId = (effective[0]!.value as { nodeId: string }).nodeId;
    expect(client.getNode(carrierId)?.contentAst).toEqual([{ type: "text", text: "39559938" }]);
    // …and the node context menu opened on it.
    expect(document.querySelector(".context-menu")).not.toBeNull();
  });
});

