/**
 * Workflow definitions + the pure op-plan builder (research-tier2 slice 2,
 * the D1/D2 ruling: packages/protocol/SCHEMA.md "Starter vocabulary" and
 * docs/workflows/research-workflow.md — the doc is the normative vocabulary;
 * this registry mirrors it EXACTLY).
 *
 * A workflow is declarative user-space vocabulary a workspace opts into:
 * an anchor tag page, materialized classes, property schemas (+ select
 * options), binding rows, and template nodes (+ their has-template values
 * and the writing plan's graft property values). Every materializable
 * entity carries a DETERMINISTIC id — `deriveUuid(
 * "notees:workflow:<workflowId>:<kind>:<entityKey>")` — so installed state
 * is derived never stored (the anchor probe), re-runs converge by
 * construction, and the web + CLI executors materialize byte-identical ids
 * from this one pure plan (D2: one definition, two executors).
 *
 * `planWorkflowToggle` is PURE: no I/O, no existence checks — the executor
 * (web materializer / CLI) existence-checks each step (the deploySystemClass
 * idiom) and skips what already exists. Enable never reconciles drift: a
 * re-enable re-plans the same creates, which no-op on existing rows, so user
 * renames and option edits are never overwritten (D1).
 *
 * Carrying ZERO protocol vocabulary: the plan composes only existing op
 * types; the seeded system classes (`question`, `plan`, `project`, `source`,
 * `template`) already exist in every workspace, so the plan never creates
 * them — it binds/scopes against their fixed seed UUIDs.
 */

import type { ContentAst } from "@notees/protocol";

import { deriveUuid } from "./ids.js";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "./seeds.js";

export type WorkflowId = "research";

/** One planned op — the executor maps opType+payload onto its write surface. */
export interface WorkflowOpStep {
  opType: string;
  payload: Record<string, unknown>;
}

export type WorkflowEntityKind = "tag" | "class" | "schema" | "template";

/**
 * The D1 deterministic-id ruling (SCHEMA.md "Starter vocabulary"): every
 * materializable entity's id derives from this exact format string. Pinned
 * by test (web and CLI must agree forever — the format string is the
 * contract, the derived literals the snapshot).
 */
export function workflowEntityId(
  wfId: WorkflowId,
  kind: WorkflowEntityKind,
  key: string,
): string {
  return deriveUuid(`notees:workflow:${wfId}:${kind}:${key}`);
}

/** The workflow's anchor — the materialized tag page's deterministic id. */
export function workflowAnchorId(wfId: WorkflowId): string {
  return workflowEntityId(wfId, "tag", WORKFLOWS[wfId].anchor.key);
}

// --- the definition model ----------------------------------------------------

/** Class keys scoped/bound by schemas and templates: system + workflow. */
type WorkflowClassRef = "question" | "plan" | "project" | "source" | WorkflowMaterializedClassKey;
type WorkflowMaterializedClassKey = "synthesis" | "comparison" | "source_instance";

export interface WorkflowClassSpec {
  key: WorkflowMaterializedClassKey;
  title: string;
  icon: string;
  description: string;
}

export interface WorkflowSchemaOptionSpec {
  key: string;
  label: string;
}

export interface WorkflowSchemaSpec {
  key: string;
  /** The property schema's display name (propertySchema.create `name`). */
  name: string;
  type: "text" | "select";
  multi?: boolean;
  /** The class this schema is scoped to (scopeClassIds — the sole locality
   *  authority; the disable story hides scoped schemas with their class). */
  scope: WorkflowClassRef;
  /** A binding row target (class.property.set) — absent = unbound: scoped
   *  only (the plan/synthesis properties ride the template graft / the bound
   *  synthesis row respectively; the source-instance set stays scoped-only
   *  per the D1 residual-honesty note). */
  bindTo?: WorkflowClassRef;
  hideWhenEmpty?: boolean;
  options?: WorkflowSchemaOptionSpec[];
}

/** One template body block — object.create under the template node. */
export interface WorkflowTemplateBlockSpec {
  /** Entity-key suffix — the block's deterministic id is
   *  `<templateKey>/<blockKey>` under the template kind. */
  key: string;
  content: ContentAst;
  /** This block is a node-backed-text carrier: a property.set
   *  `{ nodeId: <this block> }` on the template for the named schema rides
   *  the plan (the clone engine grafts authored values onto instances). */
  graft?: string;
  children?: WorkflowTemplateBlockSpec[];
}

export interface WorkflowTemplateSpec {
  key: "writingPlan" | "comparison";
  /** The template node's title text (may carry {{name}} — titles are text). */
  title: string;
  /** The class node receiving the has-template value (system `plan`, the
   *  workflow's `comparison`). The template root ALSO carries this class:
   *  the graft values are scoped to it and scope eligibility is write-time
   *  fail-loud — an unclassed template could never carry them. */
  bindTo: "plan" | "comparison";
  /** Author the Research tag on the template (instances land tagged per the
   *  clone engine's tag re-issue). */
  tagAnchor?: boolean;
  body: WorkflowTemplateBlockSpec[];
}

export interface WorkflowSpec {
  label: string;
  /** What enabling installs — the Settings → Workflows row's powers line. */
  powers: string[];
  anchor: { kind: "tag"; key: string; title: string };
  classes: WorkflowClassSpec[];
  schemas: WorkflowSchemaSpec[];
  templates: WorkflowTemplateSpec[];
}

// --- the registry (v1: research — mirrors docs/workflows/research-workflow.md
// exactly; names/scopes/bindings/options are the doc's vocabulary verbatim) ---

export const WORKFLOWS: Record<WorkflowId, WorkflowSpec> = {
  research: {
    label: "Research",
    powers: [
      "Synthesis, comparison, and per-project source-instance classes",
      "Question status + source definition fields",
      "The writing-plan and comparison templates",
    ],
    anchor: { kind: "tag", key: "research", title: "Research" },
    classes: [
      {
        key: "synthesis",
        title: "Synthesis",
        icon: "mdiGraphOutline",
        description: "A synthesis — a named analytical move over live embedded evidence.",
      },
      {
        key: "comparison",
        title: "Comparison",
        icon: "mdiCompareHorizontal",
        description: "A deliberate comparison of disagreeing sources.",
      },
      {
        key: "source_instance",
        title: "Source instance",
        icon: "mdiFileTreeOutline",
        description: "A source in the context of one project — the rationale belongs to the use, not the source.",
      },
    ],
    schemas: [
      {
        key: "status",
        name: "Status",
        type: "select",
        scope: "question",
        bindTo: "question",
        options: [
          { key: "stillOpen", label: "still open" },
          { key: "partlyAddressed", label: "partly addressed" },
          { key: "inPreparation", label: "in preparation" },
          { key: "setAside", label: "set aside" },
        ],
      },
      {
        key: "move",
        name: "Move",
        type: "select",
        scope: "synthesis",
        bindTo: "synthesis",
        options: [
          { key: "pattern", label: "pattern" },
          { key: "tension", label: "tension" },
          { key: "gap", label: "gap" },
          { key: "emergingClaim", label: "emerging claim" },
        ],
      },
      {
        key: "guidingInquiries",
        name: "Guiding inquiries",
        type: "text",
        multi: true,
        scope: "project",
      },
      {
        key: "whyItBelongs",
        name: "Why it belongs",
        type: "text",
        scope: "source_instance",
      },
      {
        key: "readingPurpose",
        name: "Reading purpose",
        type: "text",
        scope: "source_instance",
      },
      {
        key: "whatItContributed",
        name: "What it contributed",
        type: "text",
        scope: "source_instance",
      },
      {
        key: "engagement",
        name: "Engagement",
        type: "select",
        scope: "source_instance",
        options: [
          { key: "encountered", label: "encountered" },
          { key: "engaged", label: "engaged" },
          { key: "extracted", label: "extracted" },
          { key: "integrated", label: "integrated" },
        ],
      },
      {
        key: "workingPosition",
        name: "Working position",
        type: "text",
        scope: "plan",
      },
      {
        key: "complication",
        name: "Complication",
        type: "text",
        scope: "plan",
      },
      {
        key: "unresolved",
        name: "Unresolved",
        type: "text",
        scope: "plan",
      },
      {
        key: "objective",
        name: "Objective",
        type: "text",
        scope: "source",
        bindTo: "source",
        hideWhenEmpty: true,
      },
      {
        key: "method",
        name: "Method",
        type: "text",
        scope: "source",
        bindTo: "source",
        hideWhenEmpty: true,
      },
      {
        key: "results",
        name: "Results",
        type: "text",
        scope: "source",
        bindTo: "source",
        hideWhenEmpty: true,
      },
      {
        key: "conclusions",
        name: "Conclusions",
        type: "text",
        scope: "source",
        bindTo: "source",
        hideWhenEmpty: true,
      },
      {
        key: "limitations",
        name: "Limitations",
        type: "text",
        scope: "source",
        bindTo: "source",
        hideWhenEmpty: true,
      },
    ],
    templates: [
      {
        key: "writingPlan",
        title: "Writing plan — {{name}}",
        bindTo: "plan",
        tagAnchor: true,
        body: [
          {
            key: "chosenMaterial",
            content: [{ type: "heading", children: [{ type: "text", text: "Chosen material" }] }],
            children: [
              {
                key: "chosenMaterialPlaceholder",
                content: [
                  {
                    type: "text",
                    text: "Embed the syntheses, notes, and concepts this plan draws on — live, so the plan never drifts from the research.",
                  },
                ],
              },
            ],
          },
          {
            key: "workingPositionCarrier",
            graft: "workingPosition",
            content: [{ type: "text", text: "The argument as it stands." }],
          },
          {
            key: "complicationCarrier",
            graft: "complication",
            content: [{ type: "text", text: "The strongest counterpressure or gap." }],
          },
          {
            key: "unresolvedCarrier",
            graft: "unresolved",
            content: [{ type: "text", text: "What you still owe the reader." }],
          },
          {
            key: "detailedOutline",
            content: [{ type: "heading", children: [{ type: "text", text: "Detailed outline" }] }],
            children: [
              {
                key: "outlineStarter",
                content: [{ type: "text", text: "1." }],
              },
            ],
          },
        ],
      },
      {
        key: "comparison",
        title: "Comparison",
        bindTo: "comparison",
        body: [
          {
            key: "question",
            content: [{ type: "heading", children: [{ type: "text", text: "Question" }] }],
            children: [
              {
                key: "questionStarter",
                content: [{ type: "text", text: "What are these sources disagreeing about?" }],
              },
            ],
          },
          {
            key: "sources",
            content: [{ type: "heading", children: [{ type: "text", text: "Sources" }] }],
            children: [
              {
                key: "sourcesPlaceholder",
                content: [
                  {
                    type: "text",
                    text: "Embed the compared sources or their key notes — the evidence lives beside the claim.",
                  },
                ],
              },
            ],
          },
          {
            key: "consequentialDifference",
            content: [
              { type: "heading", children: [{ type: "text", text: "Consequential difference" }] },
            ],
            children: [
              {
                key: "differenceStarter",
                content: [
                  {
                    type: "text",
                    text: "Explain the disagreement through methods, definitions, or populations.",
                  },
                ],
              },
            ],
          },
          {
            key: "blankVsNotAddressed",
            content: [
              { type: "heading", children: [{ type: "text", text: "Blank vs. not-addressed" }] },
            ],
            children: [
              {
                key: "blankReminder",
                content: [
                  {
                    type: "text",
                    text: "A blank field is unread or not-addressed — only the second is a literature gap. Say which one you mean.",
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
};

// --- the plan builder --------------------------------------------------------

function textAst(text: string): ContentAst {
  return [{ type: "text", text }];
}

/** Resolve a class key to its id — workflow classes derive, system classes seed. */
function classIdOf(wfId: WorkflowId, key: WorkflowClassRef): string {
  switch (key) {
    case "synthesis":
    case "comparison":
    case "source_instance":
      return workflowEntityId(wfId, "class", key);
    default:
      return SYSTEM_CLASS_UUIDS[key];
  }
}

function schemaIdOf(wfId: WorkflowId, key: string): string {
  return workflowEntityId(wfId, "schema", key);
}

function templateIdOf(wfId: WorkflowId, key: string): string {
  return workflowEntityId(wfId, "template", key);
}

function planEnable(wfId: WorkflowId, spec: WorkflowSpec): WorkflowOpStep[] {
  const steps: WorkflowOpStep[] = [];
  const anchorId = workflowAnchorId(wfId);

  // 1. The anchor tag page — an ordinary parentless page at the derived id.
  steps.push({
    opType: "object.create",
    payload: {
      objectId: anchorId,
      parentId: null,
      contentAst: textAst(spec.anchor.title),
    },
  });

  // 2. The workflow classes (no extends — none of them IS anything else).
  for (const cls of spec.classes) {
    steps.push({
      opType: "class.create",
      payload: {
        classId: workflowEntityId(wfId, "class", cls.key),
        contentAst: textAst(cls.title),
        icon: cls.icon,
        description: cls.description,
      },
    });
  }

  // 3. The property schemas (+ select options). Option ids are deterministic
  //    too — `<schemaKey>:<optionKey>` under the schema kind.
  for (const schema of spec.schemas) {
    const payload: Record<string, unknown> = {
      propertySchemaId: schemaIdOf(wfId, schema.key),
      name: schema.name,
      type: schema.type,
      multi: schema.multi ?? false,
      scopeClassIds: [classIdOf(wfId, schema.scope)],
    };
    if (schema.options !== undefined) {
      payload.options = schema.options.map((option) => ({
        id: workflowEntityId(wfId, "schema", `${schema.key}:${option.key}`),
        label: option.label,
      }));
    }
    if (schema.hideWhenEmpty === true) payload.hideWhenEmpty = true;
    steps.push({ opType: "propertySchema.create", payload });
  }

  // 4. The binding rows (bindings are per-class config — visibility only).
  for (const schema of spec.schemas) {
    if (schema.bindTo === undefined) continue;
    steps.push({
      opType: "class.property.set",
      payload: {
        classId: classIdOf(wfId, schema.bindTo),
        propertySchemaId: schemaIdOf(wfId, schema.key),
      },
    });
  }

  // 5. The templates: node (+ Research tag), body blocks (depth-first), the
  //    graft property values (node-backed text — carrier refs), and the
  //    has-template value on the bound class node.
  for (const template of spec.templates) {
    const templateId = templateIdOf(wfId, template.key);
    steps.push({
      opType: "object.create",
      payload: {
        objectId: templateId,
        parentId: null,
        // The template ALSO carries its bound class: the graft values below
        // are scoped to that class, and scope eligibility is write-time
        // fail-loud (property.set rejects a node whose class closure misses
        // the schema's scopeClassIds) — an unclassed template could never
        // carry them. The writing-plan template IS a plan.
        classIds: [SYSTEM_CLASS_UUIDS.template, classIdOf(wfId, template.bindTo)],
        ...(template.tagAnchor === true ? { tagIds: [anchorId] } : {}),
        contentAst: textAst(template.title),
      },
    });
    const grafts: Array<{ schemaKey: string; carrierId: string }> = [];
    const emitBlocks = (
      blocks: WorkflowTemplateBlockSpec[],
      parentId: string,
      pathPrefix: string,
    ): void => {
      for (const block of blocks) {
        // The block key is its PATH under the template root — two siblings
        // in different sections may reuse a key without colliding.
        const path = pathPrefix === "" ? block.key : `${pathPrefix}/${block.key}`;
        const blockId = workflowEntityId(wfId, "template", `${template.key}/${path}`);
        steps.push({
          opType: "object.create",
          payload: { objectId: blockId, parentId, contentAst: block.content },
        });
        if (block.graft !== undefined) {
          grafts.push({ schemaKey: block.graft, carrierId: blockId });
        }
        if (block.children !== undefined) emitBlocks(block.children, blockId, path);
      }
    };
    emitBlocks(template.body, templateId, "");
    for (const graft of grafts) {
      steps.push({
        opType: "property.set",
        payload: {
          objectId: templateId,
          propertySchemaId: schemaIdOf(wfId, graft.schemaKey),
          value: { nodeId: graft.carrierId },
          idx: 0,
        },
      });
    }
    // The has-template value — a multi node-typed slot, so the OR-Set add
    // carries a deterministic element id (a re-issued add with a
    // not-strictly-older HLC revives/converges the same element).
    steps.push({
      opType: "property.set",
      payload: {
        objectId: classIdOf(wfId, template.bindTo),
        propertySchemaId: SYSTEM_PROPERTY_UUIDS.hasTemplate,
        value: { nodeId: templateId },
        elementId: workflowEntityId(wfId, "template", `${template.key}:hasTemplate`),
        idx: 0,
      },
    });
  }

  return steps;
}

function planDisable(wfId: WorkflowId, spec: WorkflowSpec): WorkflowOpStep[] {
  // Disable = archive (the owner ruling): one object.update {active:false}
  // per workflow-materialized entity — the ANCHOR TAG PAGE first (the
  // installed-state probe reads it: present + archived = disabled), then the
  // classes + template nodes. Tag assignments on projects ride untouched (F3
  // hide-surfaces-keep-data); instances keep their class_ids. The schemas
  // stay (no archival story — scoped to classes the disable archives).
  // No uninstall/delete.
  const steps: WorkflowOpStep[] = [];
  steps.push({
    opType: "object.update",
    payload: { objectId: workflowAnchorId(wfId), active: false },
  });
  for (const cls of spec.classes) {
    steps.push({
      opType: "object.update",
      payload: { objectId: workflowEntityId(wfId, "class", cls.key), active: false },
    });
  }
  for (const template of spec.templates) {
    steps.push({
      opType: "object.update",
      payload: { objectId: templateIdOf(wfId, template.key), active: false },
    });
  }
  return steps;
}

/**
 * The pure toggle planner (D2): the ordered op list an executor walks,
 * existence-checking each step. Enable: anchor → classes → schemas (+options)
 * → bindings → templates (+graft values + has-template values). Disable:
 * one `object.update {active:false}` per materialized entity — the anchor
 * tag page (the installed-state probe), then the classes + template ids.
 */
export function planWorkflowToggle(
  wfId: WorkflowId,
  target: "enabled" | "disabled",
): WorkflowOpStep[] {
  const spec = WORKFLOWS[wfId];
  if (spec === undefined) {
    throw new Error(`planWorkflowToggle: unknown workflow "${String(wfId)}"`);
  }
  return target === "enabled" ? planEnable(wfId, spec) : planDisable(wfId, spec);
}
