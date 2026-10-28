/**
 * NodePills "+N" overflow popup — the pill-contract spec: the popup is the
 * FULL management surface, listing every assigned class in order (the first
 * pill included, and any class whose pill the derived view hides because a
 * class_link token in the content already marks it inline). Each row is the
 * SAME pill element the inline cluster renders — effective color, left
 * icon, click to open, hover-reveal × — and the pill itself is the drag
 * source: no grip handle.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { NodePills } from "../src/features/metadata/NodePills.js";

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
  localStorage.clear();
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

async function seedClassedPage(classNames: string[]) {
  const client = await seedClient();
  const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
  const classIds: string[] = [];
  for (const name of classNames) classIds.push(await client.createClass(name));
  for (const classId of classIds) await client.assignClass(pageId, classId);
  return { client, pageId, classIds };
}

function openPopup() {
  fireEvent.click(screen.getByRole("button", { name: /Show \d+ more class/ }));
  return screen.getByRole("dialog", { name: "All classes" });
}

describe("NodePills overflow popup — pill contract", () => {
  it("lists every assigned class as a pill, the first one included", async () => {
    const { client, pageId, classIds } = await seedClassedPage(["alpha", "beta", "gamma"]);
    render(<NodePills client={client} nodeId={pageId} classIds={classIds} overflow />);

    const popup = openPopup();
    // The pill label buttons (the dnd wrapper also exposes role=button —
    // the .pill__text buttons are the pill labels proper).
    const labels = [...popup.querySelectorAll(".pill__text")].map((el) => el.textContent ?? "");
    // All three, in assignment order — the first pill (visible inline) rides
    // the popup too, so the popup is the full list, not just the extras.
    expect(labels).toEqual(["alpha", "beta", "gamma"]);
    // The pill look, not a menu row: the colored pill element.
    for (const pill of popup.querySelectorAll(".pill")) {
      expect(pill.classList.contains("pill--hover-reveal-right")).toBe(true);
    }
  });

  it("the × removes with the hover-reveal chrome; there is no grip handle", async () => {
    const { client, pageId, classIds } = await seedClassedPage(["alpha", "beta", "gamma"]);
    render(<NodePills client={client} nodeId={pageId} classIds={classIds} overflow />);

    const popup = openPopup();
    // No drag-handle buttons anywhere in the popup — the pill is the drag source.
    expect(within(popup).queryByRole("button", { name: /^Reorder / })).toBeNull();
    expect(popup.querySelector(".node-pills-popup__grip")).toBeNull();

    const remove = within(popup).getByRole("button", { name: "Remove class beta" });
    fireEvent.click(remove);
    await vi.waitFor(() => {
      expect(client.getNode(pageId)?.classIds).toEqual([classIds[0], classIds[2]]);
    });
  });

  it("a class whose pill hides inline (a class_link in the content) still rides the popup", async () => {
    const { client, pageId, classIds } = await seedClassedPage(["inline-marked", "beta", "gamma"]);
    // The content references the first class inline — the derived view hides
    // its pill from the inline cluster (the link IS the marker)…
    await client.updateObject(pageId, {
      contentAst: [{ type: "class_link", classId: classIds[0]! }],
    });

    const { container } = render(
      <NodePills client={client} nodeId={pageId} classIds={client.getNode(pageId)!.classIds} overflow />,
    );
    // …so the inline cluster shows "beta" and the "+N" button, no
    // "inline-marked" pill…
    expect(within(container).queryByRole("button", { name: "inline-marked" })).toBeNull();

    // …but the popup lists ALL THREE — the full assigned list, hidden pill
    // included.
    const popup = openPopup();
    const labels = [...popup.querySelectorAll(".pill__text")].map((el) => el.textContent ?? "");
    expect(labels).toEqual(["inline-marked", "beta", "gamma"]);
  });
});
