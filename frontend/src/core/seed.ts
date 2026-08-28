/**
 * Client-side workspace seed (local-first split, Task 3).
 *
 * Mirrors the server seed in `app/core/seed.py` (`seed_workspace_relay`):
 * `class.create` (with icon and `extends` where applicable) +
 * `node.updateContent` (class name content) for every system class, then
 * `propertySchema.create` + `classPropertyEdge.create` for every class-scoped
 * system property schema, then `node.create` for the Inbox page and the
 * user's personal page. Emitting the same operation sequence into the local
 * store produces the same derived state a server-seeded workspace would, so
 * attaching a server later (Task 6 adoption) merges cleanly.
 */

import { Clock } from './clock';
import { createOperation, type Operation } from './types/operation';
import type { IWorkspaceStoreClient } from './worker/workerProtocol';
import type { ClassRow } from './query/classes';
import type { NodeRow } from './store';
import {
  SYSTEM_CLASS_EXTENDS,
  SYSTEM_CLASS_ICONS,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_EXTRA_CLASS_BINDINGS,
  SYSTEM_PAGE_UUIDS,
  SYSTEM_PROPERTY_SCHEMA_SPECS,
  SYSTEM_PROPERTY_UUIDS,
} from '@/constants/systemProperties';

type ClassName = keyof typeof SYSTEM_CLASS_UUIDS;
type PropertyName = keyof typeof SYSTEM_PROPERTY_UUIDS;

interface TextAst {
  type: string;
  children: Array<{ type: string; text: string }>;
}

/** Minimal paragraph AST for a plain-text node name (mirrors `_name_ast`). */
function nameAst(text: string): TextAst[] {
  return [{ type: 'paragraph', children: [{ type: 'text', text }] }];
}

/** Resolve the canonical extends parent UUIDs for a system class. */
function extendsUuids(className: string): string[] {
  return (SYSTEM_CLASS_EXTENDS[className] ?? []).map(
    (parent) => SYSTEM_CLASS_UUIDS[parent as ClassName]
  );
}

/**
 * Per-class `sequence` of each schema's binding, in canonical spec order
 * (mirrors `_edge_sequences` in `app/core/seed.py`).
 */
function edgeSequences(): Map<string, number> {
  const sequences = new Map<string, number>();
  const perClass = new Map<string, number>();
  for (const [schemaName, spec] of Object.entries(SYSTEM_PROPERTY_SCHEMA_SPECS)) {
    const index = perClass.get(spec.bindTo) ?? 0;
    sequences.set(schemaName, index);
    perClass.set(spec.bindTo, index + 1);
  }
  return sequences;
}

/** Build the `propertySchema.create` payload for a system schema. */
function schemaPayload(schemaName: string, schemaId: string): Record<string, unknown> {
  const spec = SYSTEM_PROPERTY_SCHEMA_SPECS[schemaName];
  const payload: Record<string, unknown> = {
    schemaId,
    name: schemaName,
    type: spec.type,
    isSystem: true,
    scope: 'class',
  };
  if (spec.multi) payload.multi = true;
  if (spec.classFilter) {
    payload.classFilterUuids = spec.classFilter.map((c) => SYSTEM_CLASS_UUIDS[c as ClassName]);
  }
  if (spec.options) payload.options = spec.options;
  if (spec.defaultValue !== undefined) payload.defaultValue = spec.defaultValue;
  return payload;
}

/** Entity ids to (re)seed; defaults to everything when a field is omitted. */
export interface SeedFilter {
  classIds?: ReadonlySet<string>;
  pageIds?: ReadonlySet<string>;
  schemaIds?: ReadonlySet<string>;
  /** Binding keys (`${classId}:${schemaId}`) to emit classPropertyEdge.create for. */
  edgeKeys?: ReadonlySet<string>;
  /** Classes that exist but lack canonical ancestors: classId -> merged extends. */
  extendsFixes?: ReadonlyMap<string, string[]>;
}

/**
 * Build the exact operation sequence the server seed produces for a new
 * workspace. Pass `filter` to emit ops only for a subset of entities (used by
 * `ensureLocalWorkspace` to skip already-seeded entries).
 */
export function buildWorkspaceSeedOperations(
  workspaceId: string,
  actorId: string,
  userDisplayName: string,
  filter: SeedFilter = {}
): Operation[] {
  const clock = new Clock(actorId);
  const build = (opType: string, payload: unknown, affectedNodeIds: string[]): Operation =>
    createOperation(
      {
        workspaceId,
        actorId,
        hlc: clock.advance(Date.now()),
        affectedNodeIds,
        opType,
      },
      payload
    );

  const operations: Operation[] = [];

  for (const [name, classId] of Object.entries(SYSTEM_CLASS_UUIDS)) {
    if (filter.classIds && !filter.classIds.has(classId)) continue;
    const payload: Record<string, unknown> = { classId, name };
    const icon = SYSTEM_CLASS_ICONS[name];
    if (icon) payload.icon = icon;
    const extendsIds = extendsUuids(name);
    if (extendsIds.length > 0) payload.extends = extendsIds;
    operations.push(build('class.create', payload, [classId]));
    operations.push(
      build('node.updateContent', { nodeId: classId, content: nameAst(name) }, [classId])
    );
  }

  if (filter.extendsFixes) {
    for (const [classId, extendsClassIds] of filter.extendsFixes) {
      operations.push(
        build('class.setExtends', { classId, extendsClassIds }, [classId, ...extendsClassIds])
      );
    }
  }

  const sequences = edgeSequences();
  for (const [schemaName, spec] of Object.entries(SYSTEM_PROPERTY_SCHEMA_SPECS)) {
    const schemaId = SYSTEM_PROPERTY_UUIDS[schemaName as PropertyName];
    const classId = SYSTEM_CLASS_UUIDS[spec.bindTo as ClassName];
    if (!filter.schemaIds || filter.schemaIds.has(schemaId)) {
      operations.push(
        build('propertySchema.create', schemaPayload(schemaName, schemaId), [schemaId])
      );
    }
    if (!filter.edgeKeys || filter.edgeKeys.has(`${classId}:${schemaId}`)) {
      operations.push(
        build(
          'classPropertyEdge.create',
          { classId, propertySchemaId: schemaId, sequence: sequences.get(schemaName) ?? 0 },
          [classId, schemaId]
        )
      );
    }
  }

  // Base system properties (e.g. cover) only get a binding edge — their
  // schemas are created outside the class-scoped spec seed (mirrors
  // `_system_schema_operations` in `app/core/seed.py`).
  for (const [propName, binding] of Object.entries(SYSTEM_EXTRA_CLASS_BINDINGS)) {
    const schemaId = SYSTEM_PROPERTY_UUIDS[propName as PropertyName];
    const classId = SYSTEM_CLASS_UUIDS[binding.bindTo as ClassName];
    if (filter.edgeKeys && !filter.edgeKeys.has(`${classId}:${schemaId}`)) continue;
    operations.push(
      build(
        'classPropertyEdge.create',
        { classId, propertySchemaId: schemaId, sequence: binding.sequence },
        [classId, schemaId]
      )
    );
  }

  const pages: Array<[string, string]> = [
    ['Inbox', SYSTEM_PAGE_UUIDS.inbox],
    [userDisplayName, SYSTEM_PAGE_UUIDS.scratchpad],
  ];
  for (const [name, pageId] of pages) {
    if (filter.pageIds && !filter.pageIds.has(pageId)) continue;
    operations.push(
      build('node.create', { nodeId: pageId, kind: 'page', initialContent: nameAst(name) }, [pageId])
    );
  }

  return operations;
}

/**
 * Seed the local workspace with the system schema and default pages,
 * idempotently.
 *
 * Runs at local-workspace open. Entries that already exist in the store
 * (e.g. a persisted or previously server-seeded workspace) are skipped, so
 * re-running emits nothing. Classes that exist but lack their canonical
 * `extends` ancestors (workspaces seeded before the source hierarchy) receive
 * a `class.setExtends` op with the union of existing and canonical parents.
 * Ops are applied through the store client's canonical `applyMany` path,
 * which also dedupes by op id.
 *
 * Returns the number of seed operations emitted (0 when already seeded).
 */
export async function ensureLocalWorkspace(
  client: IWorkspaceStoreClient,
  actorId: string,
  userDisplayName: string
): Promise<number> {
  const workspaceId = await client.query<string>('getWorkspaceId', []);

  const missingClassIds = new Set<string>();
  const extendsFixes = new Map<string, string[]>();
  for (const [name, classId] of Object.entries(SYSTEM_CLASS_UUIDS)) {
    const existing = await client.query<ClassRow | undefined>('getClass', [classId]);
    if (!existing) {
      missingClassIds.add(classId);
      continue;
    }
    const expected = extendsUuids(name);
    if (expected.length === 0) continue;
    const current = existing.extendsClassIds ?? [];
    const missing = expected.filter((parent) => !current.includes(parent));
    if (missing.length > 0) {
      extendsFixes.set(classId, [...current, ...missing]);
    }
  }

  const missingSchemaIds = new Set<string>();
  const missingEdgeKeys = new Set<string>();
  const directEdgesByClass = new Map<string, Set<string>>();
  for (const [schemaName, spec] of Object.entries(SYSTEM_PROPERTY_SCHEMA_SPECS)) {
    const schemaId = SYSTEM_PROPERTY_UUIDS[schemaName as PropertyName];
    const classId = SYSTEM_CLASS_UUIDS[spec.bindTo as ClassName];
    const schema = await client.query<unknown>('getPropertySchemaByUuid', [schemaId]);
    if (!schema) missingSchemaIds.add(schemaId);

    let edges = directEdgesByClass.get(classId);
    if (!edges) {
      const rows = await client.query<Array<{ property_uuid: string }>>('getClassProperties', [
        classId,
        false,
      ]);
      edges = new Set(rows.map((row) => row.property_uuid));
      directEdgesByClass.set(classId, edges);
    }
    if (!edges.has(schemaId)) missingEdgeKeys.add(`${classId}:${schemaId}`);
  }

  for (const [propName, binding] of Object.entries(SYSTEM_EXTRA_CLASS_BINDINGS)) {
    const schemaId = SYSTEM_PROPERTY_UUIDS[propName as PropertyName];
    const classId = SYSTEM_CLASS_UUIDS[binding.bindTo as ClassName];
    // Raw edge lookup: the bound schema may be a base system property whose
    // row is not synced locally yet, so getClassProperties (which joins
    // property_schema) would hide the edge and re-emit it on every open.
    const edgeIds = await client.query<string[]>('getClassPropertyEdgeIds', [classId]);
    if (!edgeIds.includes(schemaId)) missingEdgeKeys.add(`${classId}:${schemaId}`);
  }

  const missingPageIds = new Set<string>();
  for (const pageId of Object.values(SYSTEM_PAGE_UUIDS)) {
    const existing = await client.query<NodeRow | undefined>('getNode', [pageId]);
    if (!existing) missingPageIds.add(pageId);
  }

  const operations = buildWorkspaceSeedOperations(workspaceId, actorId, userDisplayName, {
    classIds: missingClassIds,
    pageIds: missingPageIds,
    schemaIds: missingSchemaIds,
    edgeKeys: missingEdgeKeys,
    extendsFixes,
  });
  if (operations.length === 0) return 0;

  await client.mutate<number>('applyMany', [operations]);
  return operations.length;
}
