/**
 * logseq-db flow — the NEW source (spec §4): a Logseq DB-version .sqlite
 * export decoded by @notees/export's transit-kvs decoder, reconciled
 * against the CURRENT workspace by uuid with 
 * NOTEES-WINS FILL-MISSING-ONLY.
 *
 * - Class mapping is by title (case-insensitive) against the workspace's
 *   classes; unmapped classes are reported and their member nodes import
 *   unclassed — never guessed.
 * - Property mapping is the explicit owner-validated table below, keyed by
 *   the Logseq property title; unmapped properties are reported and their
 *   values are NOT written.
 * - Node exists → title/content never touched; a property value is written
 *   only when the node has no authored value for that schema.
 * - Node missing → created with the PRESERVED Logseq uuid; the parent
 *   resolves from parentUuid (a parent missing everywhere → the node is
 *   created at root and listed in the report).
 * - References are two-pass: content nodes first, then property values
 *   pointing at them; a ref target missing everywhere is reported, not
 *   faked.
 * - Assets in the sqlite export are metadata only (no blobs) — skipped and
 *   counted, never faked.
 *
 * planLogseqDbImport is the dry-run the modal previews (counts + samples);
 * runLogseqDbImport performs the writes on an explicit confirm.
 */

import type {
  LqNode,
  LqPropValue,
  LogseqDbModel,
  LogseqDbSkipped,
} from "@notees/export";

import type { AnyClient } from "../../collection/types.js";
import type {
  ClientNode,
  ClientPropertySchema,
  EffectiveProperty,
} from "@/core/workspace-client/index.js";
import {
  coerceImportValue,
  createNodeWithId,
  matchOptionByLabel,
  writePropertyValue,
  type CoerceResult,
} from "../import-writes.js";

/** The minimal read surface the reconcile plans from (AnyClient satisfies it). */
export interface LogseqDbReads {
  getNodeRaw(id: string): ClientNode | undefined;
  listClasses(): ClientNode[];
  listPropertySchemas(): ClientPropertySchema[];
  getEffectiveProperties(nodeId: string): EffectiveProperty[];
}

/**
 * The owner-validated property table (2026-10-26): Logseq property title →
 * Notees property schema name. Values for properties outside this table
 * are reported, not written.
 */
export const LOGSEQ_DB_PROPERTY_MAP: Readonly<Record<string, string>> = {
  Autor: "Linked authors",
  Sexo: "Sexo",
  "Título original": "Título original",
  Link: "Link",
  Consumido: "Consumido",
  Consumiendo: "Consumiendo",
  "Última consulta": "Última consulta",
  Fecha: "Fecha",
  Cliente: "Cliente",
  Email: "Email",
  Valoración: "Valoración",
  Teléfono: "Teléfono",
  "Tipo de estudio": "Tipo de estudio",
};

const norm = (value: string): string => value.trim().toLowerCase();

function titleTextOf(node: ClientNode | undefined): string {
  if (node === undefined) return "";
  return node.contentAst.map((token) => ("text" in token ? token.text : "")).join("");
}

// --- resolution ----------------------------------------------------------------

interface ResolvedMapping {
  classIdByTitle: Map<string, string>;
  schemaByMappedName: Map<string, ClientPropertySchema>;
  unmappedClasses: string[];
  unmappedProperties: string[];
  /** Logseq property title → schema (only mapped AND existing entries). */
  schemaByPropTitle: Map<string, ClientPropertySchema>;
}

export function resolveLogseqDbMappings(
  model: LogseqDbModel,
  reads: Pick<LogseqDbReads, "listClasses" | "listPropertySchemas">,
): ResolvedMapping {
  const classIdByTitle = new Map<string, string>();
  for (const cls of reads.listClasses()) {
    const key = norm(titleTextOf(cls));
    if (!classIdByTitle.has(key)) classIdByTitle.set(key, cls.id);
  }
  const schemaByName = new Map<string, ClientPropertySchema>();
  for (const schema of reads.listPropertySchemas()) {
    const key = norm(schema.name);
    if (!schemaByName.has(key)) schemaByName.set(key, schema);
  }

  const unmappedClasses: string[] = [];
  for (const cls of model.classes) {
    if (!classIdByTitle.has(norm(cls.title))) unmappedClasses.push(cls.title);
  }

  const unmappedProperties: string[] = [];
  const schemaByPropTitle = new Map<string, ClientPropertySchema>();
  for (const prop of model.properties) {
    const mappedName = LOGSEQ_DB_PROPERTY_MAP[prop.title];
    if (mappedName === undefined) {
      unmappedProperties.push(prop.title);
      continue;
    }
    const schema = schemaByName.get(norm(mappedName));
    if (schema === undefined) {
      unmappedProperties.push(`${prop.title} → "${mappedName}" (no such schema)`);
      continue;
    }
    schemaByPropTitle.set(prop.title, schema);
  }

  return {
    classIdByTitle,
    schemaByMappedName: schemaByName,
    unmappedClasses,
    unmappedProperties,
    schemaByPropTitle,
  };
}

function mappedClassIds(node: LqNode, mapping: ResolvedMapping): string[] {
  const ids: string[] = [];
  for (const title of node.classTitles) {
    const id = mapping.classIdByTitle.get(norm(title));
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

/** Mapped props whose values exist in the model, with their Notees schema. */
function mappedProps(
  node: LqNode,
  mapping: ResolvedMapping,
): Array<{ propTitle: string; schema: ClientPropertySchema; values: LqPropValue[] }> {
  const out: Array<{ propTitle: string; schema: ClientPropertySchema; values: LqPropValue[] }> = [];
  for (const prop of node.props) {
    const schema = mapping.schemaByPropTitle.get(prop.title);
    if (schema === undefined) continue;
    if (prop.values.length === 0) continue;
    out.push({ propTitle: prop.title, schema, values: prop.values });
  }
  return out;
}

/** The slots a node currently holds AUTHORED values for (any source check
 *  above this: authored rows only — bound/derived rows never block a fill). */
function authoredSchemaIds(reads: Pick<LogseqDbReads, "getEffectiveProperties">, nodeId: string): Set<string> {
  const ids = new Set<string>();
  for (const row of reads.getEffectiveProperties(nodeId)) {
    if (row.source === "authored" && row.value !== null && row.value !== undefined) {
      ids.add(row.propertySchemaId);
    }
  }
  return ids;
}

// --- the dry-run plan ------------------------------------------------------------

export interface LogseqDbPlan {
  counts: { create: number; fill: number; skip: number; fail: number };
  /** Per-category sample titles (bounded). */
  samples: Record<"create" | "fill" | "skip" | "fail", string[]>;
  unmappedClasses: string[];
  unmappedProperties: string[];
  /** Nodes whose parent is missing everywhere → created at root. */
  missingParents: Array<{ uuid: string; title: string }>;
}

const SAMPLE_CAP = 12;

function nodeTitle(node: LqNode): string {
  return node.title ?? node.name ?? "(untitled)";
}

export function planLogseqDbImport(model: LogseqDbModel, reads: LogseqDbReads): LogseqDbPlan {
  const mapping = resolveLogseqDbMappings(model, reads);
  const modelUuids = new Set(model.nodes.map((n) => n.uuid));
  const plan: LogseqDbPlan = {
    counts: { create: 0, fill: 0, skip: 0, fail: 0 },
    samples: { create: [], fill: [], skip: [], fail: [] },
    unmappedClasses: mapping.unmappedClasses,
    unmappedProperties: mapping.unmappedProperties,
    missingParents: [],
  };
  const sample = (kind: "create" | "fill" | "skip" | "fail", title: string): void => {
    if (plan.samples[kind].length < SAMPLE_CAP) plan.samples[kind].push(title);
  };

  for (const node of model.nodes) {
    if (node.parentUuid !== null && !modelUuids.has(node.parentUuid)) {
      if (reads.getNodeRaw(node.parentUuid) === undefined) {
        plan.missingParents.push({ uuid: node.uuid, title: nodeTitle(node) });
      }
    }
    const exists = reads.getNodeRaw(node.uuid) !== undefined;
    if (!exists) {
      plan.counts.create += 1;
      sample("create", nodeTitle(node));
      continue;
    }
    const held = authoredSchemaIds(reads, node.uuid);
    const hasFill = mappedProps(node, mapping).some(({ schema }) => !held.has(schema.id));
    if (hasFill) {
      plan.counts.fill += 1;
      sample("fill", nodeTitle(node));
    } else {
      plan.counts.skip += 1;
      sample("skip", nodeTitle(node));
    }
  }
  return plan;
}

// --- value coercion ------------------------------------------------------------

function isoOfJournalDay(day: string): string {
  return `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
}

/**
 * One decoded Logseq value → the Notees schema's wire value. Node refs are
 * checked against the import's own id set plus the workspace (the caller
 * owns the two-pass ordering); unresolved targets report, never fake.
 */
async function coerceLqValue(
  client: AnyClient,
  schema: ClientPropertySchema,
  value: LqPropValue,
): Promise<CoerceResult> {
  switch (value.kind) {
    case "node":
      return coerceImportValue(client, schema, value.uuid);
    case "date":
      return coerceImportValue(client, schema, isoOfJournalDay(value.day));
    case "number":
      return coerceImportValue(client, schema, value.value);
    case "boolean":
      return coerceImportValue(client, schema, value.value);
    case "text":
      // Closed values/selects match by option label; plain text rides the
      // generic coercion (resolve-by-name for object schemas included).
      if (schema.type === "select" || schema.type === "multi_select") {
        const id = matchOptionByLabel(schema, value.text);
        return id !== null
          ? { ok: true, value: id }
          : { ok: false, error: `no option named "${value.text}"` };
      }
      return coerceImportValue(client, schema, value.text);
  }
}

// --- the write run ------------------------------------------------------------

export interface LogseqDbReport {
  created: number;
  filled: number;
  skipped: number;
  failed: number;
  skippedEntities: LogseqDbSkipped;
  unmappedClasses: string[];
  unmappedProperties: string[];
  missingParents: string[];
  /** Ref targets missing from both the model and the workspace — not written. */
  missingRefs: string[];
  failures: string[];
}

export interface RunLogseqDbOptions {
  onProgress?: (completed: number, total: number) => void;
}

export async function runLogseqDbImport(
  model: LogseqDbModel,
  client: AnyClient,
  options: RunLogseqDbOptions = {},
): Promise<LogseqDbReport> {
  const mapping = resolveLogseqDbMappings(model, client);
  const modelByUuid = new Map(model.nodes.map((n) => [n.uuid, n]));
  const createdIds = new Set<string>();
  const failedIds = new Set<string>();
  const report: LogseqDbReport = {
    created: 0,
    filled: 0,
    skipped: 0,
    failed: 0,
    skippedEntities: model.skipped,
    unmappedClasses: mapping.unmappedClasses,
    unmappedProperties: mapping.unmappedProperties,
    missingParents: [],
    missingRefs: [],
    failures: [],
  };

  // Pass 1 — create the missing nodes, parents before children (topological
  // order over the model's parent edges; parents outside the model resolve
  // to existing workspace nodes; missing-everywhere parents fall to root
  // and are listed).
  const missing = model.nodes.filter((n) => client.getNodeRaw(n.uuid) === undefined);
  const orderByDepth = (nodes: LqNode[]): LqNode[] => {
    const depthOf = (node: LqNode, guard: Set<string>): number => {
      if (node.parentUuid === null || !modelByUuid.has(node.parentUuid) || guard.has(node.uuid)) {
        return 0;
      }
      guard.add(node.uuid);
      return 1 + depthOf(modelByUuid.get(node.parentUuid)!, guard);
    };
    return [...nodes].sort((a, b) => depthOf(a, new Set()) - depthOf(b, new Set()));
  };

  for (const node of orderByDepth(missing)) {
    let parentId: string | null = null;
    if (node.parentUuid !== null) {
      if (modelByUuid.has(node.parentUuid) || client.getNodeRaw(node.parentUuid) !== undefined) {
        parentId = node.parentUuid;
      } else {
        report.missingParents.push(`${nodeTitle(node)} (${node.uuid})`);
      }
    }
    try {
      await createNodeWithId(client, {
        id: node.uuid,
        name: nodeTitle(node),
        ...(parentId !== null ? { parentId } : {}),
        classIds: mappedClassIds(node, mapping),
      });
      createdIds.add(node.uuid);
      report.created += 1;
    } catch (error) {
      failedIds.add(node.uuid);
      report.failed += 1;
      report.failures.push(
        `Failed to create "${nodeTitle(node)}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Pass 2 — fill-missing-only properties, now that every referenced content
  // node exists. NOTEES WINS: a schema with an authored value is never
  // touched; title/content are never written here at all.
  let completed = 0;
  const total = model.nodes.length;
  for (const node of model.nodes) {
    completed += 1;
    options.onProgress?.(completed, total);
    const exists = client.getNodeRaw(node.uuid);
    if (exists === undefined || failedIds.has(node.uuid)) continue;
    const held = authoredSchemaIds(client, node.uuid);
    let nodeFilled = false;
    for (const { propTitle, schema, values } of mappedProps(node, mapping)) {
      if (held.has(schema.id)) continue;
      const multi = values.length > 1;
      let wrote = false;
      for (let i = 0; i < values.length; i++) {
        const value = values[i]!;
        const coerced = await coerceLqValue(client, schema, value);
        if (!coerced.ok) {
          // A node-ref target missing everywhere is reported distinctly.
          if (value.kind === "node" && /no node named/.test(coerced.error)) {
            report.missingRefs.push(`${nodeTitle(node)} → ${value.uuid} (${propTitle})`);
          } else {
            report.failures.push(
              `"${nodeTitle(node)}", ${propTitle}: ${coerced.error} — value skipped`,
            );
          }
          continue;
        }
        // Per-value write isolation, the pass-1-create pattern: a store
        // throw (shape/guard) lands in the failure list and the run
        // continues — one bad value must never abort a reconcile that has
        // already created hundreds of nodes.
        try {
          await writePropertyValue(client, node.uuid, schema, coerced.value, multi ? i : 0);
          wrote = true;
        } catch (error) {
          report.failures.push(
            `"${nodeTitle(node)}", ${propTitle}: ${error instanceof Error ? error.message : String(error)} — value skipped`,
          );
        }
      }
      if (wrote) {
        held.add(schema.id);
        nodeFilled = true;
      }
    }
    // Fills count MATCHED (pre-existing) nodes only — a created node's
    // properties ride its create row in the preview, never double-count.
    if (nodeFilled && !createdIds.has(node.uuid)) report.filled += 1;
  }

  return report;
}
