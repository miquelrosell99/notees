/**
 * The one-top-bar ruling tests (owner 2026-10-24): every surface carries
 * EXACTLY ONE top bar and that bar is the SurfaceTopBar register. The day
 * page was the violation — AppBody stacked its own SurfaceTopBar (the
 * DayStepper) above NodeView, whose panelled chrome renders the nodeview
 * top bar (the info toggle, the classes pills, the blocks view switcher,
 * the "…" menu) underneath. Now the stepper is INJECTED into NodeView's
 * own bar through `topBarActionsExtra` (NodeView → PageView → NodeTopbar;
 * the compact corner rides it too), the wrapper's bar is gone, and the
 * embedded/preview suppression of the whole chrome row carries the
 * injection with it.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { newEnvelope, type Envelope } from "@notees/protocol";
import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { NodeView } from "../src/ui/NodeView.js";
import { DayStepper } from "../src/features/calendar/DayPageHeader.js";

const WS = "0192a000-0000-7000-8000-0000000000e1";
const ACTOR = "0192a000-0000-7000-8000-0000000000e2";
const DEVICE = "test-device";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
});

/** Flush the microtasks an async client write runs on. */
async function flushWrites(): Promise<void> {
  await act(async () => {});
}

/** Server-style seed op the relay holds before the client bootstraps. */
function seedEnvelope(opType: string, payload: Record<string, unknown>, affected: string[]): Envelope {
  return newEnvelope({
    workspaceId: WS,
    actorId: ACTOR,
    deviceId: DEVICE,
    client: "seed",
    hlc: { physical: 1, logical: 0 },
    affectedNodeIds: affected,
    opType,
    payload,
  });
}

function seedClass(classId: string, name: string): Envelope {
  return seedEnvelope(
    "class.create",
    { classId, contentAst: [{ type: "text", text: name }] },
    [classId],
  );
}

/** A real workspace is server-seeded: the date-chain system classes. */
function seededRelay(): MemoryRelay {
  const relay = new MemoryRelay();
  relay.ingest([
    seedClass(SYSTEM_CLASS_UUIDS.day, "day"),
    seedClass(SYSTEM_CLASS_UUIDS.month, "month"),
    seedClass(SYSTEM_CLASS_UUIDS.year, "year"),
  ]);
  return relay;
}

async function seedDayPage(iso: string): Promise<{ client: WorkspaceClient; day: string }> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(seededRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  const { day } = await client.ensureDateChain(iso);
  await flushWrites();
  return { client, day };
}

describe("the one-top-bar ruling on the day page", () => {
  it("the day page rides ONE bar: the injected stepper, the view switcher, and the node menu share the nodeview top bar", async () => {
    const { client, day } = await seedDayPage("2026-06-15");
    const onNavigateDay = vi.fn();

    const { container } = render(
      <NodeView
        client={client}
        nodeId={day}
        onOpenNode={vi.fn()}
        cornerMenu
        topBarActionsExtra={<DayStepper iso="2026-06-15" onNavigateDay={onNavigateDay} />}
      />,
    );

    // Exactly ONE bar — the nodeview's own; the host stacks no second bar.
    const bars = container.querySelectorAll(".surface-topbar");
    expect(bars.length).toBe(1);
    const bar = container.querySelector(".nt-node-topbar")!;
    expect(bar).not.toBeNull();

    // The stepper rides the bar's actions cluster, beside (not above) the
    // page's own chrome: the blocks view switcher and the "…" node menu
    // are in the SAME bar.
    expect(bar.querySelector(".day-stepper")).not.toBeNull();
    const inBar = within(bar as HTMLElement);
    const next = inBar.getByRole("button", { name: "Next day" });
    expect(inBar.getByRole("button", { name: "Previous day" })).not.toBeNull();
    expect(inBar.getByRole("group", { name: "Blocks view" })).not.toBeNull();
    expect(inBar.getByRole("button", { name: "Node actions" })).not.toBeNull();

    // The injection stays live: stepping reports through the host's seam.
    fireEvent.click(next);
    expect(onNavigateDay).toHaveBeenLastCalledWith("2026-06-16");
  });

  it("NodeView without the injection renders no stepper — the bar is the page's own chrome", async () => {
    const { client, day } = await seedDayPage("2026-06-15");

    const { container } = render(
      <NodeView client={client} nodeId={day} onOpenNode={vi.fn()} cornerMenu />,
    );

    expect(container.querySelectorAll(".surface-topbar").length).toBe(1);
    expect(screen.queryByRole("button", { name: "Previous day" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Next day" })).toBeNull();
  });

  it("the compact layout (sections session toggle) rides the stepper in the corner cluster, not a second bar", async () => {
    const { client, day } = await seedDayPage("2026-06-15");

    const { container } = render(
      <NodeView
        client={client}
        nodeId={day}
        onOpenNode={vi.fn()}
        cornerMenu
        sectionsLayout
        topBarActionsExtra={<DayStepper iso="2026-06-15" onNavigateDay={vi.fn()} />}
      />,
    );

    // Compact: no panelled bar at all; the corner carries the pieces.
    expect(container.querySelector(".nt-node-topbar")).toBeNull();
    const corner = container.querySelector(".nt-node-view__corner")!;
    expect(corner).not.toBeNull();
    const inCorner = within(corner as HTMLElement);
    expect(inCorner.getByRole("button", { name: "Previous day" })).not.toBeNull();
    expect(inCorner.getByRole("button", { name: "Next day" })).not.toBeNull();
  });

  it("embedded and preview surfaces grow no bar and no stepper — the suppression carries the injection", async () => {
    const { client, day } = await seedDayPage("2026-06-15");
    const stepper = <DayStepper iso="2026-06-15" onNavigateDay={vi.fn()} />;

    const embedded = render(
      <NodeView client={client} nodeId={day} onOpenNode={vi.fn()} embedded topBarActionsExtra={stepper} />,
    );
    expect(embedded.container.querySelector(".surface-topbar")).toBeNull();
    expect(embedded.queryByRole("button", { name: "Previous day" })).toBeNull();
    embedded.unmount();

    const preview = render(
      <NodeView client={client} nodeId={day} onOpenNode={vi.fn()} preview topBarActionsExtra={stepper} />,
    );
    expect(preview.container.querySelector(".surface-topbar")).toBeNull();
    expect(preview.queryByRole("button", { name: "Previous day" })).toBeNull();
  });
});
