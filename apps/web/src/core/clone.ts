/**
 * Clone engine — §34.25 T1: the shared subtree-clone / template-instantiation
 * primitive (modelling decision 2, generalized from the createAnnotation
 * composition pattern in workspace-client.ts).
 *
 * The engine COMPOSES ops as plain data (assertable without a live sync) and
 * SUBMITS them through the existing client op path — one `object.create` per
 * cloned node (fresh UUIDv7 identity, `contentAst` copied, classIds/tagIds
 * seeded on the create) followed by the cloned node's authored `property.set`
 * carriers. Sibling order is reproduced on every backend by anchor chaining:
 * the first cloned child appends, each following sibling carries
 * `afterId` = the previously cloned sibling's fresh id (the m2 beforeId/
 * afterId carriers — identical replay on every replica from the single
 * global log).
 *
 * Reference semantics are SCHEMA.md "Templates" (A3 + D3): content tokens
 * keep their targets (mention/class_chip/typed_link), tags are re-issued on
 * the fresh id, class assignments are copied minus the caller's strip set
 * (template instantiation strips the `template` marker class — the v1 rule),
 * node-typed property values copy the reference, asset_ref re-points at the
 * same CAS asset, embed_ref carries the same live embed (never deep-cloned),
 * and whiteboard card geometry is re-keyed to the cloned cards' fresh ids.
 * Only AUTHORED property values are copied — derived class-binding defaults
 * are never materialized (the effective read recomputes them per the
 * instance's own classes; SCHEMA.md D2).
 *
 * The engine is generic on purpose: cloneSubtree powers a real duplicate
 * gesture later (§34.25 T4) and never writes provenance; instantiateTemplate
 * powers create-with-template (T2) and the T3 surfaces and records the D1-
 * amendment generatedFrom reference on the produced root.
 */

import { uuidv7 } from "uuidv7";

import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";
import type { ContentAst } from "@notees/protocol";

import type {
  ClientNode,
  CreateObjectInput,
  EffectiveProperty,
  UpdateObjectInput,
} from "./workspace-client.js";

/** Read surface the engine composes from (both client classes satisfy it). */
export interface CloneReadSurface {
  getNode(id: string): ClientNode | undefined;
  /** Position-ordered, active-only children (the store's child order). */
  getChildren(id: string): ClientNode[];
  /** Authored + derived property rows; the engine copies AUTHORED rows only. */
  getEffectiveProperties(id: string): EffectiveProperty[];
}

/** Write surface the engine submits through (the existing client op path). */
export interface CloneWriteSurface {
  createObject(partial: CreateObjectInput): Promise<string>;
  updateObject(id: string, fields: UpdateObjectInput): Promise<void>;
  setProperty(
    objectId: string,
    propertySchemaId: string,
    value: unknown,
    idx?: number,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
}

export interface CloneCreatePayload {
  objectId: string;
  parentId?: string | null;
  afterId?: string;
  beforeId?: string;
  presentAsMain?: boolean;
  contentAst?: ContentAst;
  classIds?: string[];
  tagIds?: string[];
}

export interface CloneUpdatePayload {
  objectId: string;
  contentAst: ContentAst;
}

export interface ClonePropertySetPayload {
  objectId: string;
  propertySchemaId: string;
  value: unknown;
  idx: number;
  metadata?: Record<string, unknown>;
}

/**
 * One composed op — plain data, assertable without a live sync. A bare
 * `object.create` on an EXISTING id (no parentId/contentAst) is the
 * documented OR-Set add carrier (class/tag re-issue — the applier's
 * exists-branch seeds membership without touching the tree).
 */
export type CloneOp =
  | { opType: "object.create"; payload: CloneCreatePayload }
  | { opType: "object.update"; payload: CloneUpdatePayload }
  | { opType: "property.set"; payload: ClonePropertySetPayload };

/** A composed clone: the op list + the source→fresh id map. */
export interface CloneComposition {
  ops: CloneOp[];
  /** Fresh id of the cloned source root (the graft's objectId for templates). */
  rootId: string;
  idMap: ReadonlyMap<string, string>;
}

export interface SubtreeCloneOptions {
  /** Root of the subtree to clone. */
  rootId: string;
  /** Parent of the cloned root; omitted/null = workspace root. */
  parentId?: string | null;
  afterId?: string | undefined;
  beforeId?: string | undefined;
  /**
   * Class ids dropped from every cloned node (template instantiation passes
   * the `template` marker class — the strip rule; a plain duplicate passes
   * none).
   */
  stripClassIds?: readonly string[];
  /** Overrides the cloned root's render bit; default = copy the source bit. */
  rootPresentAsMain?: boolean;
  /** Fresh-id generator (tests pin ids; production = uuidv7). */
  newId?: () => string;
}

export interface TemplateGraftOptions {
  /** Template root whose attributes/children instantiate onto the object. */
  templateRootId: string;
  /** The freshly created object receiving the graft (must exist). */
  objectId: string;
  /** Defaults to the `template` marker class. */
  stripClassIds?: readonly string[];
  newId?: () => string;
  /**
   * D1-amendment provenance (default true): record `generatedFrom` →
   * templateRootId on the produced root. Every instantiation path keeps the
   * default (create-with-template, gallery Use, slash, T4 apply-to-existing);
   * pass false only when a graft must stay provenance-free.
   */
  provenance?: boolean;
}

const DEFAULT_STRIP: readonly string[] = [];
/** Template instantiation's strip rule (v1 port): an instance is not a template. */
const TEMPLATE_STRIP: readonly string[] = [SYSTEM_CLASS_UUIDS.template];

/** Re-key a whiteboard token's card geometry to cloned fresh ids. */
function remapWhiteboardCards(ast: ContentAst, idMap: ReadonlyMap<string, string>): ContentAst {
  return ast.map((token) => {
    if (token.type !== "whiteboard") return token;
    const layout = token.layout;
    if (typeof layout !== "object" || layout === null || Array.isArray(layout)) return token;
    const cards = (layout as Record<string, unknown>).cards;
    if (typeof cards !== "object" || cards === null || Array.isArray(cards)) return token;
    let remapped = false;
    const nextCards: Record<string, unknown> = {};
    for (const [key, geometry] of Object.entries(cards as Record<string, unknown>)) {
      const fresh = idMap.get(key);
      if (fresh !== undefined) {
        nextCards[fresh] = geometry;
        remapped = true;
      } else {
        nextCards[key] = geometry;
      }
    }
    if (!remapped) return token;
    return { ...token, layout: { ...layout, cards: nextCards } };
  });
}

/**
 * Compose a subtree clone as plain ops. Two passes over the source tree:
 * ids are assigned to the whole subtree first (so a whiteboard node's card
 * geometry can re-key to descendant fresh ids), then ops are emitted in
 * depth-first pre-order — create + authored property sets per node, children
 * after parents, siblings anchored afterId → previous fresh sibling.
 */
export function composeSubtreeClone(
  reads: CloneReadSurface,
  opts: SubtreeCloneOptions,
): CloneComposition {
  const strip = new Set(opts.stripClassIds ?? DEFAULT_STRIP);
  const newId = opts.newId ?? uuidv7;
  const idMap = new Map<string, string>();

  interface Entry {
    source: ClientNode;
    parentFreshId: string | null;
    afterId?: string;
    beforeId?: string;
    isRoot: boolean;
  }
  const entries: Entry[] = [];

  const visit = (
    sourceId: string,
    parentFreshId: string | null,
    anchor: { afterId?: string; beforeId?: string },
    isRoot: boolean,
  ): void => {
    const source = reads.getNode(sourceId);
    if (!source) throw new Error(`composeSubtreeClone: node ${sourceId} not found`);
    const freshId = newId();
    idMap.set(source.id, freshId);
    entries.push({ source, parentFreshId, ...anchor, isRoot });
    let prevChildFresh: string | undefined;
    for (const child of reads.getChildren(source.id)) {
      // Anchor chaining: each child afterId → the previous child's fresh id,
      // so replay converges to the source's exact sibling order on every
      // backend (the first child appends).
      const childAnchor: { afterId?: string; beforeId?: string } = {};
      if (prevChildFresh !== undefined) childAnchor.afterId = prevChildFresh;
      visit(child.id, freshId, childAnchor, false);
      prevChildFresh = idMap.get(child.id);
    }
  };
  visit(
    opts.rootId,
    opts.parentId ?? null,
    {
      ...(opts.afterId !== undefined ? { afterId: opts.afterId } : {}),
      ...(opts.beforeId !== undefined ? { beforeId: opts.beforeId } : {}),
    },
    true,
  );

  const ops: CloneOp[] = [];
  for (const entry of entries) {
    const { source } = entry;
    const classIds = source.classIds.filter((classId) => !strip.has(classId));
    ops.push({
      opType: "object.create",
      payload: {
        objectId: idMap.get(source.id)!,
        ...(entry.isRoot && opts.rootPresentAsMain !== undefined
          ? { presentAsMain: opts.rootPresentAsMain }
          : { presentAsMain: source.presentAsMain }),
        contentAst: remapWhiteboardCards(source.contentAst, idMap),
        ...(classIds.length > 0 ? { classIds } : {}),
        ...(source.tagIds.length > 0 ? { tagIds: [...source.tagIds] } : {}),
        ...(entry.parentFreshId !== null ? { parentId: entry.parentFreshId } : {}),
        ...(entry.afterId !== undefined ? { afterId: entry.afterId } : {}),
        ...(entry.beforeId !== undefined ? { beforeId: entry.beforeId } : {}),
      },
    });
    // Authored property values only — derived binding defaults are never
    // materialized (SCHEMA.md D2 / "Class properties").
    for (const prop of reads.getEffectiveProperties(source.id)) {
      if (prop.source !== "authored") continue;
      ops.push({
        opType: "property.set",
        payload: {
          objectId: idMap.get(source.id)!,
          propertySchemaId: prop.propertySchemaId,
          value: prop.value,
          idx: prop.idx,
          ...(prop.metadata !== null ? { metadata: prop.metadata } : {}),
        },
      });
    }
  }

  return { ops, rootId: idMap.get(opts.rootId)!, idMap };
}

/**
 * Compose a create-with-template graft (SCHEMA.md "Templates",
 * instantiate-at-create): the template root's contentAst lands on the object
 * (object.update), its class assignments minus the strip set re-issue via
 * the OR-Set add carrier, its authored property values land as property.set,
 * and the root's children are cloned beneath the object in order. The
 * template node itself is never referenced by the instance.
 */
export function composeTemplateGraft(
  reads: CloneReadSurface,
  opts: TemplateGraftOptions,
): CloneComposition {
  const strip = new Set(opts.stripClassIds ?? TEMPLATE_STRIP);
  const root = reads.getNode(opts.templateRootId);
  if (!root) throw new Error(`composeTemplateGraft: template ${opts.templateRootId} not found`);
  const target = reads.getNode(opts.objectId);
  const existingClasses = new Set(target?.classIds ?? []);

  const ops: CloneOp[] = [
    { opType: "object.update", payload: { objectId: opts.objectId, contentAst: root.contentAst } },
  ];
  // Class assignments minus the marker class, skipping classes the object
  // already carries (the picked class is typically among the root's own).
  for (const classId of root.classIds) {
    if (strip.has(classId) || existingClasses.has(classId)) continue;
    ops.push({
      opType: "object.create",
      payload: { objectId: opts.objectId, classIds: [classId] },
    });
  }
  // Tags re-issue on the object the same way (A3), skipping ones it carries.
  const existingTags = new Set(target?.tagIds ?? []);
  for (const tagId of root.tagIds) {
    if (existingTags.has(tagId)) continue;
    ops.push({
      opType: "object.create",
      payload: { objectId: opts.objectId, tagIds: [tagId] },
    });
  }
  for (const prop of reads.getEffectiveProperties(root.id)) {
    if (prop.source !== "authored") continue;
    ops.push({
      opType: "property.set",
      payload: {
        objectId: opts.objectId,
        propertySchemaId: prop.propertySchemaId,
        value: prop.value,
        idx: prop.idx,
        ...(prop.metadata !== null ? { metadata: prop.metadata } : {}),
      },
    });
  }

  const idMap = new Map<string, string>();
  let prevChildFresh: string | undefined;
  for (const child of reads.getChildren(root.id)) {
    const sub = composeSubtreeClone(reads, {
      rootId: child.id,
      parentId: opts.objectId,
      afterId: prevChildFresh,
      stripClassIds: [...strip],
      ...(opts.newId !== undefined ? { newId: opts.newId } : {}),
    });
    ops.push(...sub.ops);
    for (const [sourceId, freshId] of sub.idMap) idMap.set(sourceId, freshId);
    prevChildFresh = sub.rootId;
  }

  return { ops, rootId: opts.objectId, idMap };
}

/** Submit composed ops through the existing client op path, in order. */
export async function submitCloneOps(
  writes: CloneWriteSurface,
  ops: readonly CloneOp[],
): Promise<void> {
  for (const op of ops) {
    if (op.opType === "object.create") {
      const p = op.payload;
      await writes.createObject({
        id: p.objectId,
        ...(p.presentAsMain !== undefined ? { presentAsMain: p.presentAsMain } : {}),
        ...(p.contentAst !== undefined ? { contentAst: p.contentAst } : {}),
        ...(p.classIds !== undefined ? { classIds: p.classIds } : {}),
        ...(p.tagIds !== undefined ? { tagIds: p.tagIds } : {}),
        ...(p.parentId !== undefined ? { parentId: p.parentId } : {}),
        ...(p.afterId !== undefined ? { afterId: p.afterId } : {}),
        ...(p.beforeId !== undefined ? { beforeId: p.beforeId } : {}),
      });
    } else if (op.opType === "object.update") {
      await writes.updateObject(op.payload.objectId, { contentAst: op.payload.contentAst });
    } else {
      await writes.setProperty(
        op.payload.objectId,
        op.payload.propertySchemaId,
        op.payload.value,
        op.payload.idx,
        op.payload.metadata,
      );
    }
  }
}

export interface CloneIO {
  reads: CloneReadSurface;
  writes: CloneWriteSurface;
}

/**
 * Clone a subtree (generic — also the T4 duplicate engine): composes then
 * submits, returning the fresh root id. The source tree is read at compose
 * time; the write surface only sees the existing carriers.
 */
export async function cloneSubtree(io: CloneIO, opts: SubtreeCloneOptions): Promise<string> {
  const composition = composeSubtreeClone(io.reads, opts);
  await submitCloneOps(io.writes, composition.ops);
  return composition.rootId;
}

/**
 * Instantiate a template onto a freshly created object (create-with-template,
 * SCHEMA.md "Templates"): grafts the root's content/classes/properties and
 * clones the root's children beneath the object in order. Instantiation
 * provenance (D1 amendment): unless `provenance: false`, the produced root
 * records `generatedFrom` → the template — the generic cloneSubtree duplicate
 * path never writes it.
 */
export async function instantiateTemplate(
  io: CloneIO,
  opts: TemplateGraftOptions,
): Promise<void> {
  const composition = composeTemplateGraft(io.reads, opts);
  await submitCloneOps(io.writes, composition.ops);
  if (opts.provenance !== false) {
    await writeGeneratedFrom(io.writes, opts.objectId, opts.templateRootId);
  }
}

/**
 * The D1-amendment provenance write: the generated node records its template
 * instance-side (single node-typed value; the template's instance list is a
 * derived backlink read — never a list write on the template). Used by the
 * instantiation wrapper and by the slash path, which clones via cloneSubtree
 * and writes provenance at the call site.
 */
export async function writeGeneratedFrom(
  writes: Pick<CloneWriteSurface, "setProperty">,
  objectId: string,
  templateRootId: string,
): Promise<void> {
  await writes.setProperty(
    objectId,
    SYSTEM_PROPERTY_UUIDS.generatedFrom,
    { nodeId: templateRootId },
    0,
  );
}
