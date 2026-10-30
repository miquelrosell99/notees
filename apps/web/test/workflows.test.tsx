/**
 * Workflows tests (research-tier2 slice 2b): the web materializer, the
 * undo-journal batching, the rename-survival + disable-keeps-instances
 * review foci, and the Settings → Workflows tab's three anchor-probe
 * states. Real WorkspaceClient over MemoryRelay + sql.js (the
 * system-class-deploy / sources-settings convention); the modal renders
 * through jsdom with the ResizeObserver stub.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import type { ContentAst } from "@notees/protocol";
import {
  SYSTEM_CLASS_DISPLAY_NAMES,
  SYSTEM_CLASS_ICONS,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
  planWorkflowToggle,
  workflowAnchorId,
  workflowEntityId,
} from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { WorkspaceSettingsModal } from "../src/features/workspaces/WorkspaceSettingsModal.js";
import {
  materializeWorkflow,
  workflowInstanceCount,
  workflowState,
} from "../src/features/workflows/materialize.js";
import { titleOf } from "../src/ui/dateDisplay.js";

const WS = "0192a000-0000-7000-8000-0000000000d1";
const ACTOR = "0192a000-0000-7000-8000-0000000000d2";

/** The materialized class ids (the Task-2 derived-uuid literals). */
const SYNTHESIS_ID = "4b7613a7-c050-5dd7-9f49-586d26797b08";
const COMPARISON_ID = "a1bfbf36-b734-5345-97aa-3c638b09b094";
const SOURCE_INSTANCE_ID = "38816bed-fc56-5168-b1e6-14eebbfb12a6";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
  // jsdom lacks ResizeObserver; Tabs.List uses it for the active indicator.
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
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

/** The substrate the plan binds/scopes against: the reused system classes + has-template. */
async function seedSubstrate(client: WorkspaceClient): Promise<void> {
  for (const name of ["question", "plan", "project", "source", "template"] as const) {
    if (client.getNodeRaw(SYSTEM_CLASS_UUIDS[name]) !== undefined) continue;
    await client.createClass(SYSTEM_CLASS_DISPLAY_NAMES[name], {
      id: SYSTEM_CLASS_UUIDS[name],
      icon: SYSTEM_CLASS_ICONS[name],
    });
  }
  if (!client.listPropertySchemas().some((schema) => schema.id === SYSTEM_PROPERTY_UUIDS.hasTemplate)) {
    await client.createPropertySchema({
      id: SYSTEM_PROPERTY_UUIDS.hasTemplate,
      name: "Has template",
      type: "object",
      multi: true,
      targetClassFilter: [SYSTEM_CLASS_UUIDS.template],
    });
  }
}

const text = (s: string): ContentAst => [{ type: "text", text: s }];

function renderWorkflowsTab(client: WorkspaceClient) {
  return render(
    <WorkspaceSettingsModal
      isOpen
      onClose={() => {}}
      serverUrl="https://notees.example.com"
      credential="session-token"
      workspaceId={WS}
      workspaceName="Garden"
      workspaceRole="owner"
      initialTab="workflows"
      client={client}
    />,
  );
}

// --- materializer ---------------------------------------------------------------

describe("materializeWorkflow", () => {
  it("enables the whole plan; a second run applies 0 (idempotency)", async () => {
    const client = await seedClient();
    await seedSubstrate(client);

    const planLength = planWorkflowToggle("research", "enabled").length;
    const first = await materializeWorkflow(client, "research", "enabled");
    expect(first).toEqual({ applied: planLength, skipped: 0 });

    // The anchor probe reads installed.
    expect(workflowState(client, "research")).toBe("installed");
    expect(client.getNodeRaw(workflowAnchorId("research"))?.isActive).toBe(true);

    // A materialized taste: the synthesis class with its icon + description.
    const synthesis = client.getNodeRaw(SYNTHESIS_ID);
    expect(synthesis).toMatchObject({ isClass: true, isActive: true, icon: "mdiGraphOutline" });
    expect(titleOf(client, SYNTHESIS_ID)).toBe("Synthesis");
    // The writing-plan template carries the plan classing (the graft
    // eligibility carrier) and the Research tag.
    const writingPlan = client.getNodeRaw("e91c8f08-54b6-52db-b59d-48ef2829b4a3");
    expect(writingPlan?.classIds).toContain(SYSTEM_CLASS_UUIDS.plan);
    expect(writingPlan?.classIds).toContain(SYSTEM_CLASS_UUIDS.template);
    expect(writingPlan?.tagIds).toContain(workflowAnchorId("research"));

    // Idempotency: every step now converges — zero writes.
    const second = await materializeWorkflow(client, "research", "enabled");
    expect(second).toEqual({ applied: 0, skipped: planLength });
  });

  it("journals exactly ONE undo entry per enable and per disable", async () => {
    const client = await seedClient();
    await seedSubstrate(client);

    const depth0 = client.undoDepth().undo;
    await materializeWorkflow(client, "research", "enabled");
    expect(client.undoDepth().undo).toBe(depth0 + 1);

    await materializeWorkflow(client, "research", "disabled");
    expect(client.undoDepth().undo).toBe(depth0 + 2);

    // A converged re-run journals NOTHING (no writes, no entry).
    await materializeWorkflow(client, "research", "disabled");
    expect(client.undoDepth().undo).toBe(depth0 + 2);
  });

  it("rename survival: a re-enable never clobbers a renamed class", async () => {
    const client = await seedClient();
    await seedSubstrate(client);
    await materializeWorkflow(client, "research", "enabled");

    // The user renames the materialized synthesis class…
    await client.updateObject(SYNTHESIS_ID, { contentAst: text("Síntesis") });
    expect(titleOf(client, SYNTHESIS_ID)).toBe("Síntesis");

    // …and re-enabling converges without touching the name (D1).
    const again = await materializeWorkflow(client, "research", "enabled");
    expect(again.applied).toBe(0);
    expect(titleOf(client, SYNTHESIS_ID)).toBe("Síntesis");
  });

  it("disable keeps instances: a synthesis node keeps its class_ids (F3), re-enable revives", async () => {
    const client = await seedClient();
    await seedSubstrate(client);
    await materializeWorkflow(client, "research", "enabled");

    const instance = await client.createObject({ name: "The field, synthesized" });
    await client.assignClass(instance, SYNTHESIS_ID);
    expect(client.getNodeRaw(instance)?.classIds).toContain(SYNTHESIS_ID);
    expect(workflowInstanceCount(client, "research")).toBe(1);

    const disablePlanLength = planWorkflowToggle("research", "disabled").length;
    const disabled = await materializeWorkflow(client, "research", "disabled");
    expect(disabled).toEqual({ applied: disablePlanLength, skipped: 0 });

    // The vocabulary hides: anchor + classes archived; the probe reads disabled.
    expect(workflowState(client, "research")).toBe("disabled");
    expect(client.getNodeRaw(workflowAnchorId("research"))?.isActive).toBe(false);
    for (const classId of [SYNTHESIS_ID, COMPARISON_ID, SOURCE_INSTANCE_ID]) {
      expect(client.getNodeRaw(classId)?.isActive).toBe(false);
    }
    // The instance rides: still active, still classed.
    expect(client.getNodeRaw(instance)?.isActive).toBe(true);
    expect(client.getNodeRaw(instance)?.classIds).toContain(SYNTHESIS_ID);

    // Re-enable un-archives (existence-checked) without touching instances.
    const reEnabled = await materializeWorkflow(client, "research", "enabled");
    expect(reEnabled.applied).toBe(disablePlanLength);
    expect(workflowState(client, "research")).toBe("installed");
    expect(client.getNodeRaw(instance)?.classIds).toContain(SYNTHESIS_ID);
  });
});

// --- Settings → Workflows tab ------------------------------------------------------

describe("WorkflowsSettingsSection", () => {
  it("renders Available, then Installed after Enable, then Disabled after Disable (the anchor probe)", async () => {
    const client = await seedClient();
    await seedSubstrate(client);
    renderWorkflowsTab(client);

    expect(screen.getByText("Research")).toBeInTheDocument();
    expect(screen.getByText("Available")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    });
    expect(await screen.findByText("Installed")).toBeInTheDocument();
    expect(workflowState(client, "research")).toBe("installed");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    });
    expect(await screen.findByText("Disabled")).toBeInTheDocument();
    expect(workflowState(client, "research")).toBe("disabled");
  });

  it("a disable with instances confirms first, stating the keep-data count", async () => {
    const client = await seedClient();
    await seedSubstrate(client);
    await materializeWorkflow(client, "research", "enabled");
    const instance = await client.createObject({ name: "A synthesis" });
    await client.assignClass(instance, SYNTHESIS_ID);
    await materializeWorkflow(client, "research", "disabled"); // archive…
    renderWorkflowsTab(client); // …so the row opens Disabled

    // Re-enable from the row, then disable WITH an instance live.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Re-enable" }));
    });
    expect(await screen.findByText("Installed")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    });
    const dialog = await screen.findByRole("dialog", { name: "Disable Research?" });
    expect(within(dialog).getByText(/1 node carries this vocabulary/)).toBeInTheDocument();
    expect(
      within(dialog).getByText(/they keep it — the vocabulary hides from pickers/),
    ).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Disable" }));
    });
    expect(await screen.findByText("Disabled")).toBeInTheDocument();
    expect(client.getNodeRaw(instance)?.classIds).toContain(SYNTHESIS_ID);
  });
});
