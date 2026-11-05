/**
 * Workflow-rules API (issue #13) — the REST surface the settings editor
 * rides. Shapes mirror the server's rule schema exactly (vendored
 * `apps/server/src/workflows.ts` — the create body is strict: name 1–120,
 * trigger {opType}, criteria (a v2 QueryAST, no aggregation), 1–10 actions
 * of property.set {propertySchemaId, value, idx} | class.assign {classId}).
 * The server's own validation errors (422 bodies) ride the rejection
 * message verbatim so the editor can surface them.
 */

export const WORKFLOW_TRIGGER_OP_TYPES = ["object.create", "property.set", "class.assign"] as const;
export type WorkflowTriggerOpType = (typeof WORKFLOW_TRIGGER_OP_TYPES)[number];

export const MAX_WORKFLOW_ACTIONS = 10;

export type WorkflowActionWire =
  | { type: "property.set"; propertySchemaId: string; value: unknown; idx: number }
  | { type: "class.assign"; classId: string };

export interface WorkflowRuleWire {
  id: string;
  workspaceId: string;
  name: string;
  enabled: boolean;
  trigger: { opType: WorkflowTriggerOpType };
  criteria: unknown;
  actions: WorkflowActionWire[];
  createdAt: number;
  updatedAt: number;
}

export type WorkflowRunOutcome =
  | "actions_written"
  | "actions_failed"
  | "skipped_loop"
  | "skipped_depth_cap";

export interface WorkflowRunWire {
  id: string;
  ruleId: string;
  triggerEnvelopeId: string;
  nodeId: string;
  actionsWritten: Array<{ opType: string; envelopeId: string }>;
  outcome: WorkflowRunOutcome;
  detail: string | null;
  createdAt: number;
}

/** The create body — exactly the server's workflowRuleCreateSchema. */
export interface WorkflowRuleCreateBody {
  name: string;
  enabled?: boolean;
  trigger: { opType: WorkflowTriggerOpType };
  criteria: unknown;
  actions: WorkflowActionWire[];
}

async function request<T>(
  serverUrl: string,
  credential: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api${path}`, {
    ...init,
    headers: {
      "X-API-Key": credential,
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body.error?.message !== undefined) message = body.error.message;
    } catch {
      // Non-JSON error — the status line stands.
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export function listWorkflowRules(serverUrl: string, credential: string): Promise<{ rules: WorkflowRuleWire[] }> {
  return request(serverUrl, credential, "/workflows");
}

export function createWorkflowRule(
  serverUrl: string,
  credential: string,
  body: WorkflowRuleCreateBody,
): Promise<{ rule: WorkflowRuleWire }> {
  return request(serverUrl, credential, "/workflows", { method: "POST", body: JSON.stringify(body) });
}

export function patchWorkflowRule(
  serverUrl: string,
  credential: string,
  id: string,
  patch: Partial<WorkflowRuleCreateBody>,
): Promise<{ rule: WorkflowRuleWire }> {
  return request(serverUrl, credential, `/workflows/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function deleteWorkflowRule(serverUrl: string, credential: string, id: string): Promise<{ ok: boolean }> {
  return request(serverUrl, credential, `/workflows/${id}`, { method: "DELETE" });
}

/** The run audit (newest first) — the last-run status the list renders. */
export function listWorkflowRuns(
  serverUrl: string,
  credential: string,
  ruleId: string,
): Promise<{ runs: WorkflowRunWire[] }> {
  return request(serverUrl, credential, `/workflows/${ruleId}/runs`);
}
