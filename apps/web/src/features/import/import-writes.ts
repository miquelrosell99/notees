/**
 * import-writes — the shared write helpers every import flow composes
 * through (the ImportTableModal write side, generalized): node creation
 * with client-chosen ids + sibling placement, node-backed text-property
 * carriers (PB2 one-shape-per-type), typed value coercion per schema, and
 * a bounded-concurrency scheduler (per-parent sequential so `afterId`
 * chains stay ordered, parallelism across parents, progress callbacks).
 *
 * Everything writes through the ordinary client op path — no new op
 * types, no wire changes; fail loud per value with a structured error the
 * flows land in their reports.
 */

import type { ContentAst } from "@notees/protocol";
import { uuidv7 } from "uuidv7";

import type { AnyClient } from "../collection/types.js";
import type { ClientPropertySchema, ClientWriteOp } from "@/core/workspace-client/index.js";

/** Bare-uuid test for values that already are node ids (the types.ts constant,
 *  mirrored — the barrel keeps UUID_LIKE internal). */
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CreateNodeInput {
  /** Defaults to a fresh UUIDv7 (the client mints one). */
  id?: string;
  parentId?: string | null;
  /** Sibling placement: append after this current sibling. */
  afterId?: string;
  /** The node's initial title text (title-is-content). */
  name?: string;
  contentAst?: ContentAst;
  classIds?: string[];
  tagIds?: string[];
  isEmbedded?: boolean;
}

/** createObject with a client-supplied id + the placement fields imports need. */
export async function createNodeWithId(client: AnyClient, input: CreateNodeInput): Promise<string> {
  return client.createObject({
    ...(input.id !== undefined ? { id: input.id } : {}),
    ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
    ...(input.afterId !== undefined ? { afterId: input.afterId } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.contentAst !== undefined ? { contentAst: input.contentAst } : {}),
    ...(input.classIds !== undefined ? { classIds: input.classIds } : {}),
    ...(input.tagIds !== undefined ? { tagIds: input.tagIds } : {}),
    ...(input.isEmbedded !== undefined ? { isEmbedded: input.isEmbedded } : {}),
  });
}

export type CoerceResult = { ok: true; value: unknown } | { ok: false; error: string };

const norm = (value: string): string => value.trim().toLowerCase();

/** Option labels → stored ids: exact case first, then case-insensitive. */
export function matchOptionByLabel(schema: ClientPropertySchema, label: string): string | null {
  const options = schema.options ?? [];
  const exact = options.find((option) => option.label === label);
  if (exact !== undefined) return exact.id;
  return options.find((option) => norm(option.label) === norm(label))?.id ?? null;
}

function optionNames(schema: ClientPropertySchema): string {
  return (schema.options ?? []).map((option) => option.label).join(", ");
}

/** One already-typed scalar → the schema's wire value (datetime resolves later). */
function coerceScalar(client: AnyClient, schema: ClientPropertySchema, raw: unknown): CoerceResult {
  switch (schema.type) {
    case "boolean": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      const key = norm(String(raw));
      if (key === "true" || key === "yes" || key === "1") return { ok: true, value: true };
      if (key === "false" || key === "no" || key === "0") return { ok: true, value: false };
      return { ok: false, error: `not a boolean (${JSON.stringify(raw)})` };
    }
    case "number": {
      if (typeof raw === "number" && Number.isFinite(raw)) return { ok: true, value: raw };
      const value = Number(String(raw).trim());
      if (String(raw).trim() !== "" && Number.isFinite(value)) return { ok: true, value };
      return { ok: false, error: `not a number (${JSON.stringify(raw)})` };
    }
    case "integer": {
      if (typeof raw === "number" && Number.isInteger(raw)) return { ok: true, value: raw };
      const value = Number(String(raw).trim());
      if (String(raw).trim() !== "" && Number.isInteger(value)) return { ok: true, value };
      return { ok: false, error: `not an integer (${JSON.stringify(raw)})` };
    }
    case "select":
    case "multi_select": {
      if (schema.options === null || schema.options.length === 0) {
        return { ok: false, error: "the schema has no options" };
      }
      const id = matchOptionByLabel(schema, String(raw));
      return id !== null
        ? { ok: true, value: id }
        : { ok: false, error: `no option named "${String(raw)}" (${optionNames(schema)})` };
    }
    case "datetime": {
      // Returns the ISO day string; the caller turns it into a day-node ref
      // via ensureDateChain (async — see coerceImportValue).
      if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) {
        return { ok: true, value: raw.trim() };
      }
      return { ok: false, error: `not an ISO date (YYYY-MM-DD): ${JSON.stringify(raw)}` };
    }
    case "object":
    case "asset":
    case "image": {
      if (typeof raw === "object" && raw !== null && "nodeId" in raw) {
        return { ok: true, value: raw };
      }
      const text = String(raw).trim();
      if (UUID_LIKE.test(text) && client.getNodeRaw(text) !== undefined) {
        return { ok: true, value: { nodeId: text } };
      }
      const byName = client.resolveNodeByName(text);
      return byName !== null
        ? { ok: true, value: { nodeId: byName } }
        : { ok: false, error: `no node named or identified by "${text}"` };
    }
    case "text":
    case "email": {
      if (typeof raw === "string") return { ok: true, value: raw };
      if (typeof raw === "number" || typeof raw === "boolean") {
        return { ok: true, value: String(raw) };
      }
      return { ok: false, error: `not a string (${JSON.stringify(raw)})` };
    }
    default:
      return { ok: false, error: `import for "${schema.type}" properties is not supported` };
  }
}

/**
 * Frontmatter/Logseq value → typed property value for one schema. Lists
 * coerce per item and return the canonical multi array (one value at idx 0,
 * the ImportTableModal precedent); datetime strings resolve to day-node refs
 * through the date chain; node-typed values resolve by uuid or display name.
 */
export async function coerceImportValue(
  client: AnyClient,
  schema: ClientPropertySchema,
  raw: unknown,
): Promise<CoerceResult> {
  if (Array.isArray(raw)) {
    const values: unknown[] = [];
    for (const part of raw) {
      const one = await coerceImportValue(client, schema, part);
      if (!one.ok) return one;
      values.push(one.value);
    }
    return { ok: true, value: values };
  }
  const coerced = coerceScalar(client, schema, raw);
  if (!coerced.ok) return coerced;
  if (schema.type === "datetime") {
    const { day } = await client.ensureDateChain(coerced.value as string);
    return { ok: true, value: { nodeId: day } };
  }
  return coerced;
}

/**
 * One ALREADY-COERCED value → batch ops (the `applyOps` primitive): the
 * caller composes these into its gesture batch and applies them in ONE undo
 * entry / ONE RPC. Text values ride the node-backed carrier shape (a fresh
 * carrier child per string — the table cell's commit path); carrier ids are
 * caller-assigned so the setProperty op can anchor to a carrier created
 * earlier in the same batch. Multi arrays of non-text values write the
 * canonical idx-0 array shape; flows that need per-idx multi writes (Logseq
 * DB cardinality-many) call this once per value with their own idx.
 */
export function composePropertyValueOps(
  nodeId: string,
  schema: ClientPropertySchema,
  value: unknown,
  idx: number,
  newId: () => string = uuidv7,
): ClientWriteOp[] {
  if (schema.type === "text" && !Array.isArray(value)) {
    const carrierId = newId();
    return [
      {
        kind: "create",
        input: { id: carrierId, parentId: nodeId, contentAst: [{ type: "text", text: String(value) }] },
      },
      { kind: "setProperty", objectId: nodeId, propertySchemaId: schema.id, value: { nodeId: carrierId }, idx },
    ];
  }
  if (schema.type === "text" && Array.isArray(value)) {
    const ops: ClientWriteOp[] = [];
    const refs: Array<{ nodeId: string }> = [];
    for (const part of value as unknown[]) {
      const carrierId = newId();
      ops.push({
        kind: "create",
        input: { id: carrierId, parentId: nodeId, contentAst: [{ type: "text", text: String(part) }] },
      });
      refs.push({ nodeId: carrierId });
    }
    ops.push({ kind: "setProperty", objectId: nodeId, propertySchemaId: schema.id, value: refs, idx });
    return ops;
  }
  return [{ kind: "setProperty", objectId: nodeId, propertySchemaId: schema.id, value, idx }];
}

export interface ImportTask {
  /**
   * Sibling-order key: tasks sharing a parentKey run SEQUENTIALLY in
   * enqueue order (the afterId chain must be authored in order); distinct
   * parentKeys run in parallel.
   */
  parentKey: string;
  run: () => Promise<void>;
}

/**
 * Bounded-concurrency import scheduler. Tasks group by parentKey; each
 * group is an ordered sequential chain; chains run across a worker pool
 * (default 4 parents at a time). Progress reports completed/total after
 * every finished task. Failures do not abort the run — the task's own
 * try/catch owns per-item reporting (fail loud per item, never guess).
 */
export async function runImportTasks(
  tasks: readonly ImportTask[],
  options: { parallelism?: number; onProgress?: (completed: number, total: number) => void } = {},
): Promise<void> {
  const parallelism = Math.max(1, options.parallelism ?? 4);
  const chains = new Map<string, Array<() => Promise<void>>>();
  for (const task of tasks) {
    const chain = chains.get(task.parentKey);
    if (chain !== undefined) chain.push(task.run);
    else chains.set(task.parentKey, [task.run]);
  }
  const queue = [...chains.values()];
  const total = tasks.length;
  let completed = 0;
  const notify = (): void => options.onProgress?.(completed, total);
  const worker = async (): Promise<void> => {
    for (;;) {
      const chain = queue.shift();
      if (chain === undefined) return;
      for (const run of chain) {
        await run();
        completed += 1;
        notify();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallelism, queue.length) }, () => worker()));
}
