/**
 * The web executor for the workflow op plan (research-tier2 slice 2b — D2:
 * one definition, two executors; the CLI mirrors this against its own write
 * surface and both derive byte-identical ids from the same pure plan).
 *
 * `planWorkflowToggle` is PURE — no I/O, no existence checks. This module
 * is the web half of the executor: it walks the plan, existence-checks each
 * step against the client's reads (the `deploySystemClass` idiom:
 * convergence is decided per step, never reconciled), and applies the
 * pending steps through the client's write surface. Consequences, all
 * pinned by test:
 *
 *  - Re-declares/re-uses are SKIPPED, never clobbered — a re-enable replays
 *    the creates, which no-op on existing rows, so user renames and option
 *    edits survive (D1). An ARCHIVED existing row is not "converged" for an
 *    enable: the step un-archives it (object.update {active: true}) without
 *    touching its content (the gallery's enableArchivedSystemClass seam).
 *  - ONE undo-journal entry per toggle: the batch rides INSIDE the client
 *    (the beginClassedCreate/reviewCard precedent) — WorkspaceClient wraps
 *    the steps in `undoJournal.batchAsync` in-process; the WorkerClient
 *    ships them as ONE RPC journaled worker-side (a closure cannot cross
 *    the boundary).
 *  - Disable archives; instances keep their class_ids (F3) — the plan
 *    never touches membership.
 *
 * The installed-state probe is ONE anchor read (workflowState): absent =
 * Available, present + active = Installed, present + archived = Disabled
 * (the D1 ruling — installed state is derived, never stored).
 */

import {
  WORKFLOWS,
  planWorkflowToggle,
  plainTextExcerpt,
  workflowAnchorId,
  workflowEntityId,
  type WorkflowId,
  type WorkflowOpStep,
} from "@notees/domain";
import type { ContentAst } from "@notees/protocol";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client/index.js";

type AnyClient = WorkspaceClient | WorkerClient;

/** One toggle's outcome: how many plan steps wrote vs converged already. */
export interface WorkflowMaterializeResult {
  applied: number;
  skipped: number;
}

/** The anchor-probe states — the Settings row's Available/Installed/Disabled. */
export type WorkflowState = "available" | "installed" | "disabled";

/**
 * The installed-state probe (D1): ONE read of the anchor node row. Absent =
 * "available" (never installed); present + active = "installed"; present +
 * archived = "disabled" (the disable plan archives the anchor first so this
 * probe stays honest).
 */
export function workflowState(
  client: Pick<AnyClient, "getNodeRaw">,
  wfId: WorkflowId,
): WorkflowState {
  const anchor = client.getNodeRaw(workflowAnchorId(wfId));
  if (anchor === undefined) return "available";
  return anchor.isActive ? "installed" : "disabled";
}

/**
 * The disable confirmation's instance count: distinct ACTIVE non-class
 * nodes carrying any of the workflow's materialized classes — minus the
 * workflow's OWN template nodes (they carry a class by the plan's design,
 * not as user data; counting them would confirm on every disable).
 * Membership rides a disable (F3), so this is the honest "N of YOUR nodes
 * keep this vocabulary" number.
 */
export function workflowInstanceCount(client: AnyClient, wfId: WorkflowId): number {
  const spec = WORKFLOWS[wfId];
  const ownTemplateIds = new Set(
    spec.templates.map((template) => workflowEntityId(wfId, "template", template.key)),
  );
  const members = new Set<string>();
  for (const cls of spec.classes) {
    const classId = workflowEntityId(wfId, "class", cls.key);
    for (const node of client.getClassMembers(classId)) {
      if (node.isActive && !node.isClass && !ownTemplateIds.has(node.id)) members.add(node.id);
    }
  }
  return members.size;
}

// --- convergence (the deploySystemClass existence-check idiom) ---------------

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/**
 * True when a plan step needs NO write. Enable creates converge when the row
 * exists AND is active (an archived row still needs the un-archive); the
 * property values converge when the authored row is already there
 * (elementId-addressed rows by element id, positional graft rows by value).
 * Disable archive steps converge when the node is absent or already
 * archived. Nothing here reconciles drift — a user-renamed class is
 * "converged" and its name is never touched.
 */
export function stepConverged(client: AnyClient, step: WorkflowOpStep): boolean {
  const p = asRecord(step.payload);
  switch (step.opType) {
    case "object.create":
    case "class.create": {
      const id = String(p.objectId ?? p.classId);
      const node = client.getNodeRaw(id);
      return node !== undefined && node.isActive;
    }
    case "propertySchema.create":
      return client
        .listPropertySchemas()
        .some((schema) => schema.id === p.propertySchemaId);
    case "class.property.set":
      return client
        .getRegistryBindings(String(p.classId))
        .some((binding) => binding.propertySchemaId === p.propertySchemaId);
    case "property.set": {
      const objectId = String(p.objectId);
      const schemaId = String(p.propertySchemaId);
      const rows = client
        .getEffectiveProperties(objectId)
        .filter((row) => row.propertySchemaId === schemaId);
      if (typeof p.elementId === "string") {
        // OR-Set add: the deterministic element id is the convergence key.
        return rows.some((row) => row.elementId === p.elementId);
      }
      return rows.some(
        (row) => row.source === "authored" && JSON.stringify(row.value) === JSON.stringify(p.value),
      );
    }
    case "object.update": {
      // The disable shape: archive when active; absent/already-archived is
      // a no-op (nothing to hide).
      const node = client.getNodeRaw(String(p.objectId));
      return node === undefined || !node.isActive;
    }
    default:
      return false;
  }
}

/**
 * Apply ONE plan step through the client's write surface (the public write
 * methods ARE the WorkspaceClientWrites surface, RPC-mirrored on the
 * WorkerClient). A create on an ARCHIVED existing row un-archives it
 * (content untouched); every other existing row is the caller's job to have
 * existence-checked first — this function is written to be safe anyway.
 */
export async function applyWorkflowStep(client: AnyClient, step: WorkflowOpStep): Promise<void> {
  const p = asRecord(step.payload);
  switch (step.opType) {
    case "object.create": {
      const id = String(p.objectId);
      const existing = client.getNodeRaw(id);
      if (existing !== undefined) {
        if (!existing.isActive) await client.updateObject(id, { active: true });
        return;
      }
      await client.createObject({
        id,
        parentId: (p.parentId as string | null) ?? null,
        ...(Array.isArray(p.classIds) ? { classIds: p.classIds as string[] } : {}),
        ...(Array.isArray(p.tagIds) ? { tagIds: p.tagIds as string[] } : {}),
        contentAst: (p.contentAst ?? []) as ContentAst,
      });
      return;
    }
    case "class.create": {
      const id = String(p.classId);
      const existing = client.getNodeRaw(id);
      if (existing !== undefined) {
        if (!existing.isActive) await client.updateObject(id, { active: true });
        return;
      }
      await client.createClass(plainTextExcerpt((p.contentAst ?? []) as ContentAst), {
        id,
        ...(typeof p.icon === "string" ? { icon: p.icon } : {}),
        ...(typeof p.description === "string" ? { description: p.description } : {}),
      });
      return;
    }
    case "propertySchema.create": {
      await client.createPropertySchema({
        id: String(p.propertySchemaId),
        name: String(p.name),
        type: String(p.type),
        ...(typeof p.multi === "boolean" ? { multi: p.multi } : {}),
        ...(Array.isArray(p.scopeClassIds)
          ? { scopeClassIds: p.scopeClassIds as string[] }
          : {}),
        ...(Array.isArray(p.options)
          ? { options: p.options as Array<{ id: string; label: string }> }
          : {}),
        ...(typeof p.hideWhenEmpty === "boolean" ? { hideWhenEmpty: p.hideWhenEmpty } : {}),
      });
      return;
    }
    case "class.property.set": {
      await client.setClassProperty(String(p.classId), String(p.propertySchemaId), {});
      return;
    }
    case "property.set": {
      await client.setProperty(
        String(p.objectId),
        String(p.propertySchemaId),
        p.value,
        typeof p.idx === "number" ? p.idx : 0,
        undefined,
        typeof p.elementId === "string" ? p.elementId : undefined,
      );
      return;
    }
    case "object.update": {
      await client.updateObject(String(p.objectId), {
        active: p.active === false ? false : true,
      });
      return;
    }
    default:
      throw new Error(`applyWorkflowStep: unsupported opType "${step.opType}"`);
  }
}

/**
 * Materialize one workflow toggle: the plan's steps applied inside ONE
 * undo-journal batch (inside the client, so the batch survives the
 * WorkerClient RPC boundary), each step RE-CHECKED for convergence at
 * apply time — ordering matters: the enable plan un-archives a disabled
 * class before its binding step runs, so a plan-time filter would
 * mis-count the binding (its registry row mirrors the class liveness) and
 * re-issue a redundant upsert. A converged workspace writes nothing and
 * journals nothing: {applied: 0, skipped: plan.length}.
 */
export async function materializeWorkflow(
  client: AnyClient,
  wfId: WorkflowId,
  target: "enabled" | "disabled",
): Promise<WorkflowMaterializeResult> {
  return client.applyWorkflowSteps(planWorkflowToggle(wfId, target));
}
