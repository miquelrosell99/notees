/**
 * Workflow rule routes (issue #13), prefix /api — CRUD for the server-side
 * "when X on nodes matching Y, do Z" rules + the append-only run audit.
 *
 * AuthZ (the shares idiom): reading is any authenticated principal — the
 * object API is default-workspace scoped, so every workspace member reads
 * rules. Writing is owner/admin only: the operator key, an administrator
 * account, or the owner membership role on the default workspace. Scoped API
 * keys authenticate as their user; the user must still clear the gate.
 *
 * Routes:
 *
 *  - GET    /workflows            list rules of the default workspace;
 *  - POST   /workflows            create a rule (criteria + actions validated
 *                                 fail-loud; 409 at the per-workspace cap);
 *  - GET    /workflows/:id        one rule (404 outside the workspace);
 *  - PATCH  /workflows/:id        merge-patch name/enabled/trigger/criteria/
 *                                 actions (re-validated whole where present);
 *  - DELETE /workflows/:id        delete a rule;
 *  - GET    /workflows/:id/runs   the run audit, newest first (capped page).
 *
 * Rule state is server coordination state, NOT log state — no envelope is
 * stamped by any route here (the prefs/shares/plugins ruling; see
 * workflows.ts for the engine and the loop policy).
 */

import type { FastifyInstance, FastifyRequest } from "fastify";

import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import { resolvePrincipal, type ResolvedRequest } from "./routes-auth.js";
import {
  MAX_WORKFLOW_RULES_PER_WORKSPACE,
  WORKFLOW_RUNS_PAGE,
  validateWorkflowActions,
  validateWorkflowCriteria,
  workflowRuleCreateSchema,
  workflowRulePatchSchema,
  type WorkflowRule,
  type WorkflowRun,
} from "./workflows.js";

/**
 * Read gate: any authenticated principal (operator key, session, user API
 * key) — the object-authz scope is the default workspace.
 */
function requireWorkflowReader(ctx: ServerContext, request: FastifyRequest): void {
  if (resolvePrincipal(ctx, request) === null) {
    throw new AppError(401, "unauthenticated", "invalid or missing credentials");
  }
}

/**
 * Write gate (the shares idiom): the operator key is the machine owner path;
 * user principals need the admin flag or the owner membership role on the
 * default workspace.
 */
function requireWorkflowAdmin(ctx: ServerContext, request: FastifyRequest): ResolvedRequest {
  const resolved = resolvePrincipal(ctx, request);
  if (resolved === null) {
    throw new AppError(401, "unauthenticated", "invalid or missing credentials");
  }
  if (resolved.principal.kind === "apikey") return resolved;
  if (resolved.principal.isAdmin) return resolved;
  if (ctx.auth.membership(ctx.defaultWorkspace, resolved.principal.userId) === "owner") {
    return resolved;
  }
  throw new AppError(403, "forbidden", "managing workflow rules is owner/admin only");
}

function ruleView(rule: WorkflowRule): Record<string, unknown> {
  return {
    id: rule.id,
    workspaceId: rule.workspaceId,
    name: rule.name,
    enabled: rule.enabled,
    trigger: { opType: rule.triggerOpType },
    criteria: rule.criteria,
    actions: rule.actions,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

function runView(run: WorkflowRun): Record<string, unknown> {
  return {
    id: run.id,
    ruleId: run.ruleId,
    triggerEnvelopeId: run.triggerEnvelopeId,
    nodeId: run.nodeId,
    actionsWritten: run.actionsWritten,
    outcome: run.outcome,
    detail: run.detail,
    createdAt: run.createdAt,
  };
}

export function registerWorkflowRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get("/workflows", async (request) => {
    requireWorkflowReader(ctx, request);
    const rules = ctx.workflows.list(ctx.defaultWorkspace);
    return { rules: rules.map(ruleView) };
  });

  app.post("/workflows", async (request, reply) => {
    requireWorkflowAdmin(ctx, request);
    const parsed = workflowRuleCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(
        422,
        "validation_failed",
        parsed.error.issues[0]?.message ?? "invalid workflow rule",
      );
    }
    const workspaceId = ctx.defaultWorkspace;
    if (ctx.workflows.count(workspaceId) >= MAX_WORKFLOW_RULES_PER_WORKSPACE) {
      throw new AppError(
        409,
        "conflict",
        `workflow rule cap reached (${MAX_WORKFLOW_RULES_PER_WORKSPACE} per workspace)`,
      );
    }
    let criteria;
    let actions;
    try {
      criteria = validateWorkflowCriteria(parsed.data.criteria);
      actions = parsed.data.actions;
      validateWorkflowActions(actions);
    } catch (error) {
      // ZodError dumps its issues as `.message`; anything else here is a
      // compile-trial failure whose message is already human-readable.
      throw new AppError(
        422,
        "validation_failed",
        error instanceof Error ? error.message : "invalid workflow rule",
      );
    }
    const rule = ctx.workflows.create({
      workspaceId,
      name: parsed.data.name,
      enabled: parsed.data.enabled ?? true,
      triggerOpType: parsed.data.trigger.opType,
      criteria,
      actions,
    });
    reply.code(201);
    return { rule: ruleView(rule) };
  });

  app.get("/workflows/:id", async (request) => {
    requireWorkflowReader(ctx, request);
    const { id } = request.params as { id: string };
    const rule = ctx.workflows.find(ctx.defaultWorkspace, id);
    if (rule === null) {
      throw new AppError(404, "not_found", `no workflow rule with id "${id}"`);
    }
    return { rule: ruleView(rule) };
  });

  app.patch("/workflows/:id", async (request) => {
    requireWorkflowAdmin(ctx, request);
    const { id } = request.params as { id: string };
    const parsed = workflowRulePatchSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(
        422,
        "validation_failed",
        parsed.error.issues[0]?.message ?? "invalid workflow rule patch",
      );
    }
    const workspaceId = ctx.defaultWorkspace;
    if (ctx.workflows.find(workspaceId, id) === null) {
      throw new AppError(404, "not_found", `no workflow rule with id "${id}"`);
    }
    const patch: {
      name?: string;
      enabled?: boolean;
      triggerOpType?: WorkflowRule["triggerOpType"];
      criteria?: WorkflowRule["criteria"];
      actions?: WorkflowRule["actions"];
    } = {};
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.enabled !== undefined) patch.enabled = parsed.data.enabled;
    if (parsed.data.trigger !== undefined) patch.triggerOpType = parsed.data.trigger.opType;
    try {
      if (parsed.data.criteria !== undefined) patch.criteria = validateWorkflowCriteria(parsed.data.criteria);
      if (parsed.data.actions !== undefined) {
        validateWorkflowActions(parsed.data.actions);
        patch.actions = parsed.data.actions;
      }
    } catch (error) {
      throw new AppError(422, "validation_failed", error instanceof Error ? error.message : "invalid workflow rule patch");
    }
    const rule = ctx.workflows.update(workspaceId, id, patch);
    if (rule === null) {
      throw new AppError(404, "not_found", `no workflow rule with id "${id}"`);
    }
    return { rule: ruleView(rule) };
  });

  app.delete("/workflows/:id", async (request) => {
    requireWorkflowAdmin(ctx, request);
    const { id } = request.params as { id: string };
    if (!ctx.workflows.remove(ctx.defaultWorkspace, id)) {
      throw new AppError(404, "not_found", `no workflow rule with id "${id}"`);
    }
    return { ok: true };
  });

  /** The append-only audit, newest first — how the loop policy and failures stay observable. */
  app.get("/workflows/:id/runs", async (request) => {
    requireWorkflowReader(ctx, request);
    const { id } = request.params as { id: string };
    const workspaceId = ctx.defaultWorkspace;
    if (ctx.workflows.find(workspaceId, id) === null) {
      throw new AppError(404, "not_found", `no workflow rule with id "${id}"`);
    }
    const runs = ctx.workflows.runs(workspaceId, id, WORKFLOW_RUNS_PAGE);
    return { runs: runs.map(runView) };
  });
}
