/**
 * WorkflowRulesSection — the workspace-settings Automation tab (issue #13):
 * the workflow-RULES editor over the coordination API (the vocabularies
 * live on the existing "Workflows" tab; these are the "when X on nodes
 * matching Y, do Z" rules the client-side evaluator runs).
 *
 * - List: name, trigger summary, active toggle, last-run status from the run
 *   audit (GET /workflows/:id/runs), edit + delete (confirm).
 * - Create/edit in a kit Modal: fields exactly matching the server's rule
 *   schema (trigger opType, the v2 QueryAST criteria as JSON, 1–10 actions).
 *   Client validation mirrors the server's shapes (parseQueryAst + no
 *   aggregation + a trial compile, uuid/length/count checks) for fast
 *   feedback; the server's own 422 message surfaces verbatim on submit.
 * - Offline degradation: the last successful list stays rendered with a
 *   "rules sync when the server answers" note; a never-loaded failure shows
 *   the note with nothing else.
 */

import { useCallback, useEffect, useState } from "react";

import { parseQueryAst, type QueryAst } from "@notees/protocol";
import { compile } from "@notees/query";

import { Badge } from "../../components/ui/kit/Badge.js";
import { Button } from "../../components/ui/kit/Button.js";
import { CodeTextarea } from "../../components/ui/kit/CodeTextarea.js";
import { ConfirmationModal } from "../../components/ui/kit/ConfirmationModal.js";
import { Dropdown } from "../../components/ui/kit/Dropdown.js";
import { Modal } from "../../components/ui/kit/Modal.js";
import { TextField } from "../../components/ui/kit/TextField.js";
import { ToggleSwitch } from "../../components/ui/kit/ToggleSwitch.js";
import {
  MAX_WORKFLOW_ACTIONS,
  WORKFLOW_TRIGGER_OP_TYPES,
  createWorkflowRule,
  deleteWorkflowRule,
  listWorkflowRules,
  listWorkflowRuns,
  patchWorkflowRule,
  type WorkflowActionWire,
  type WorkflowRuleWire,
  type WorkflowRunWire,
  type WorkflowTriggerOpType,
} from "../../core/workflow-rules-api.js";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const TRIGGER_LABELS: Record<WorkflowTriggerOpType, string> = {
  "object.create": "Node created",
  "property.set": "Property set",
  "class.assign": "Class assigned",
};

const RUN_OUTCOME_LABELS: Record<WorkflowRunWire["outcome"], string> = {
  actions_written: "actions written",
  actions_failed: "failed",
  skipped_loop: "skipped (loop)",
  skipped_depth_cap: "skipped (depth)",
};

function shortId(id: string): string {
  return id.slice(0, 8);
}

function actionSummary(action: WorkflowActionWire): string {
  return action.type === "property.set"
    ? `Set property ${shortId(action.propertySchemaId)}`
    : `Assign class ${shortId(action.classId)}`;
}

/** The criteria JSON a fresh rule starts from (matches v2, no conditions). */
const EMPTY_CRITERIA_JSON = JSON.stringify(
  {
    version: 2,
    scope: { type: "entire_workspace" },
    root: { type: "group", logic: "and", children: [] },
  },
  null,
  2,
);

/**
 * The client mirror of the server's validateWorkflowCriteria: strict v2
 * parse, no aggregation (criteria probe node membership), trial compile.
 * Returns null when valid, the message otherwise.
 */
export function validateCriteriaJson(text: string): string | null {
  let ast: QueryAst;
  try {
    ast = parseQueryAst(JSON.parse(text));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (ast.aggregation !== undefined) {
    return "criteria must not carry an aggregation — it is a node filter, not a grouped report";
  }
  try {
    compile(ast);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return null;
}

/** A value field's text → the wire value: empty = null, JSON when it parses, raw text otherwise. */
export function parseActionValue(text: string): unknown {
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

interface ActionDraft {
  type: "property.set" | "class.assign";
  propertySchemaId: string;
  valueText: string;
  idxText: string;
  classId: string;
}

interface RuleDraft {
  name: string;
  triggerOpType: WorkflowTriggerOpType;
  criteriaText: string;
  actions: ActionDraft[];
}

function draftFromRule(rule: WorkflowRuleWire): RuleDraft {
  return {
    name: rule.name,
    triggerOpType: rule.trigger.opType,
    criteriaText: JSON.stringify(rule.criteria, null, 2),
    actions: rule.actions.map((action) =>
      action.type === "property.set"
        ? {
            type: "property.set" as const,
            propertySchemaId: action.propertySchemaId,
            valueText: action.value === null || action.value === undefined ? "" : JSON.stringify(action.value),
            idxText: String(action.idx ?? 0),
            classId: "",
          }
        : {
            type: "class.assign" as const,
            propertySchemaId: "",
            valueText: "",
            idxText: "0",
            classId: action.classId,
          },
    ),
  };
}

const EMPTY_DRAFT: RuleDraft = {
  name: "",
  triggerOpType: "object.create",
  criteriaText: EMPTY_CRITERIA_JSON,
  actions: [
    { type: "property.set", propertySchemaId: "", valueText: "", idxText: "0", classId: "" },
  ],
};

/** The client mirror of the server body's shape checks (the server's word stays final). */
function validateDraft(draft: RuleDraft): string | null {
  if (draft.name.trim().length === 0 || draft.name.trim().length > 120) {
    return "Name is required (1–120 characters).";
  }
  const criteriaError = validateCriteriaJson(draft.criteriaText);
  if (criteriaError !== null) return `Criteria: ${criteriaError}`;
  if (draft.actions.length === 0) return "At least one action is required.";
  if (draft.actions.length > MAX_WORKFLOW_ACTIONS) return `At most ${MAX_WORKFLOW_ACTIONS} actions per rule.`;
  for (const action of draft.actions) {
    if (action.type === "property.set") {
      if (!UUID_RE.test(action.propertySchemaId)) return "Property actions need a property-schema uuid.";
      const idx = Number(action.idxText);
      if (!Number.isInteger(idx) || idx < 0) return "Property actions need an integer idx ≥ 0.";
    } else if (!UUID_RE.test(action.classId)) {
      return "Class actions need a class uuid.";
    }
  }
  return null;
}

function draftToActions(draft: RuleDraft): WorkflowActionWire[] {
  return draft.actions.map((action) =>
    action.type === "property.set"
      ? {
          type: "property.set" as const,
          propertySchemaId: action.propertySchemaId,
          value: parseActionValue(action.valueText),
          idx: Number(action.idxText) || 0,
        }
      : { type: "class.assign" as const, classId: action.classId },
  );
}

export function WorkflowRulesSection({ serverUrl, credential }: { serverUrl: string; credential: string }) {
  /** null = never loaded (the server never answered). */
  const [rules, setRules] = useState<WorkflowRuleWire[] | null>(null);
  const [online, setOnline] = useState(true);
  const [lastRuns, setLastRuns] = useState<Record<string, WorkflowRunWire>>({});
  const [editor, setEditor] = useState<{ mode: "create" } | { mode: "edit"; rule: WorkflowRuleWire } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<WorkflowRuleWire | null>(null);

  const refresh = useCallback(async () => {
    try {
      const page = await listWorkflowRules(serverUrl, credential);
      setRules(page.rules);
      setOnline(true);
      const newest: Record<string, WorkflowRunWire> = {};
      await Promise.all(
        page.rules.map(async (rule) => {
          try {
            const runs = await listWorkflowRuns(serverUrl, credential, rule.id);
            if (runs.runs[0] !== undefined) newest[rule.id] = runs.runs[0];
          } catch {
            // Runs unreadable — the row shows "never run"; rules still listed.
          }
        }),
      );
      setLastRuns(newest);
    } catch {
      setOnline(false);
    }
  }, [serverUrl, credential]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = async (rule: WorkflowRuleWire) => {
    try {
      const patched = await patchWorkflowRule(serverUrl, credential, rule.id, { enabled: !rule.enabled });
      setRules((current) =>
        current === null ? current : current.map((r) => (r.id === rule.id ? patched.rule : r)),
      );
    } catch {
      setOnline(false);
    }
  };

  return (
    <section aria-label="Workflow rules">
      <p className="settings-item__description">
        Rules run on this device as envelopes apply — a matching node gets the rule's actions as ordinary
        envelopes every client converges on.
      </p>
      {online === false && (
        <p className="settings-item__description" role="status">
          Couldn't reach the server{rules === null ? "" : " — showing the last synced rules"}. Rules sync when
          the server answers.
        </p>
      )}
      {rules !== null && rules.length === 0 && (
        <p className="settings-item__description">No rules yet.</p>
      )}
      {rules?.map((rule) => {
        const last = lastRuns[rule.id];
        return (
          <div key={rule.id} className="settings-item workflows-settings__row">
            <div className="settings-item__info">
              <span className="settings-item__label">{rule.name}</span>
              <span className="settings-item__description">
                {TRIGGER_LABELS[rule.trigger.opType]} · {rule.actions.map(actionSummary).join("; ")}
              </span>
              <span className="settings-item__description">
                {last === undefined
                  ? "Never run"
                  : `Last run: ${RUN_OUTCOME_LABELS[last.outcome]} · ${new Date(last.createdAt).toLocaleString()}`}
              </span>
            </div>
            <div className="workflows-settings__actions">
              <Badge variant={rule.enabled ? "primary" : "neutral"} size="sm">
                {rule.enabled ? "Active" : "Paused"}
              </Badge>
              <ToggleSwitch
                leftLabel="Off"
                rightLabel="On"
                checked={rule.enabled}
                onChange={() => void toggle(rule)}
                aria-label={`Toggle ${rule.name}`}
                size="sm"
              />
              <Button variant="outline" size="sm" onClick={() => setEditor({ mode: "edit", rule })}>
                Edit
              </Button>
              <Button variant="danger" size="sm" onClick={() => setConfirmDelete(rule)}>
                Delete
              </Button>
            </div>
          </div>
        );
      })}
      <div className="settings-ads__row">
        <Button variant="primary" size="sm" onClick={() => setEditor({ mode: "create" })}>
          New rule
        </Button>
      </div>

      {editor !== null && (
        <WorkflowRuleEditor
          serverUrl={serverUrl}
          credential={credential}
          initial={editor.mode === "edit" ? draftFromRule(editor.rule) : EMPTY_DRAFT}
          title={editor.mode === "edit" ? `Edit rule — ${editor.rule.name}` : "New workflow rule"}
          onSubmit={async (draft) => {
            const body = {
              name: draft.name.trim(),
              enabled: true,
              trigger: { opType: draft.triggerOpType },
              criteria: JSON.parse(draft.criteriaText) as unknown,
              actions: draftToActions(draft),
            };
            if (editor.mode === "create") {
              await createWorkflowRule(serverUrl, credential, body);
            } else {
              await patchWorkflowRule(serverUrl, credential, editor.rule.id, body);
            }
            setEditor(null);
            await refresh();
          }}
          onClose={() => setEditor(null)}
        />
      )}

      <ConfirmationModal
        isOpen={confirmDelete !== null}
        title={confirmDelete !== null ? `Delete ${confirmDelete.name}?` : "Delete rule?"}
        message="The rule stops running on every device; its run audit stays on the server."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={() => {
          const rule = confirmDelete;
          setConfirmDelete(null);
          if (rule !== null) {
            void deleteWorkflowRule(serverUrl, credential, rule.id)
              .then(refresh)
              .catch(() => setOnline(false));
          }
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </section>
  );
}

function WorkflowRuleEditor({
  serverUrl: _serverUrl,
  credential: _credential,
  title,
  initial,
  onSubmit,
  onClose,
}: {
  serverUrl: string;
  credential: string;
  title: string;
  initial: RuleDraft;
  onSubmit: (draft: RuleDraft) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<RuleDraft>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const update = (patch: Partial<RuleDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
  };

  const submit = async () => {
    const validationError = validateDraft(draft);
    if (validationError !== null) {
      setError(validationError);
      return;
    }
    setBusy(true);
    try {
      await onSubmit(draft);
    } catch (err) {
      // The server's validation error (422) surfaces verbatim.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={title}
      size="lg"
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={() => void submit()} disabled={busy} loading={busy}>
            Save rule
          </Button>
        </>
      }
    >
      <div className="nt-form">
        <TextField
          label="Name"
          value={draft.name}
          onChange={(event) => update({ name: event.target.value })}
          placeholder="Flag new papers for review"
          disabled={busy}
          autoFocus
        />
        <Dropdown
          options={WORKFLOW_TRIGGER_OP_TYPES.map((opType) => ({ value: opType, label: TRIGGER_LABELS[opType] }))}
          value={draft.triggerOpType}
          onChange={(value) => update({ triggerOpType: value as WorkflowTriggerOpType })}
          disabled={busy}
          placeholder="Trigger"
          ariaLabel="Trigger"
        />
        <label className="nt-field">
          <span>Criteria (QueryAST v2 JSON — a node filter, no aggregation)</span>
        </label>
        <CodeTextarea
          value={draft.criteriaText}
          onChange={(value) => update({ criteriaText: value })}
          spellCheck={false}
          disabled={busy}
          className="workflow-rules-editor__criteria"
          label="Criteria"
        />
        <span className="settings-item__description">
          Matches nodes the rule applies to — e.g. a member/class condition on the classes above.
        </span>
        <span className="settings-item__label">Actions (1–{MAX_WORKFLOW_ACTIONS})</span>
        {draft.actions.map((action, index) => (
          <div key={index} className="settings-item workflows-settings__row">
            <Dropdown
              options={[
                { value: "property.set", label: "Set a property" },
                { value: "class.assign", label: "Assign a class" },
              ]}
              value={action.type}
              onChange={(value) =>
                update({
                  actions: draft.actions.map((a, i) =>
                    i === index ? { ...a, type: value as ActionDraft["type"] } : a,
                  ),
                })
              }
              disabled={busy}
              ariaLabel={`Action ${index + 1} type`}
            />
            {action.type === "property.set" ? (
              <>
                <TextField
                  label="Property schema uuid"
                  value={action.propertySchemaId}
                  onChange={(event) =>
                    update({
                      actions: draft.actions.map((a, i) =>
                        i === index ? { ...a, propertySchemaId: event.target.value } : a,
                      ),
                    })
                  }
                  disabled={busy}
                />
                <TextField
                  label="Value (JSON, or text)"
                  value={action.valueText}
                  onChange={(event) =>
                    update({
                      actions: draft.actions.map((a, i) =>
                        i === index ? { ...a, valueText: event.target.value } : a,
                      ),
                    })
                  }
                  disabled={busy}
                  placeholder='"review"'
                />
                <TextField
                  label="Slot idx"
                  value={action.idxText}
                  onChange={(event) =>
                    update({
                      actions: draft.actions.map((a, i) =>
                        i === index ? { ...a, idxText: event.target.value } : a,
                      ),
                    })
                  }
                  disabled={busy}
                />
              </>
            ) : (
              <TextField
                label="Class uuid"
                value={action.classId}
                onChange={(event) =>
                  update({
                    actions: draft.actions.map((a, i) => (i === index ? { ...a, classId: event.target.value } : a)),
                  })
                }
                disabled={busy}
              />
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || draft.actions.length <= 1}
              onClick={() => update({ actions: draft.actions.filter((_, i) => i !== index) })}
            >
              Remove
            </Button>
          </div>
        ))}
        <div className="settings-ads__row">
          <Button
            variant="outline"
            size="sm"
            disabled={busy || draft.actions.length >= MAX_WORKFLOW_ACTIONS}
            onClick={() =>
              update({
                actions: [
                  ...draft.actions,
                  { type: "property.set", propertySchemaId: "", valueText: "", idxText: "0", classId: "" },
                ],
              })
            }
          >
            Add action
          </Button>
        </div>
        {error !== null && (
          <p className="nt-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
