/**
 * Client-side workspace seed (local-first split, Task 3).
 *
 * Mirrors the server seed in `app/core/seed.py` (`seed_workspace_relay`):
 * `class.create` + `node.updateContent` (class name content) for every system
 * class, then `node.create` for the Inbox page and the user's personal page.
 * Emitting the same operation sequence into the local store produces the same
 * derived state a server-seeded workspace would, so attaching a server later
 * (Task 6 adoption) merges cleanly.
 */

import { Clock } from './clock';
import { createOperation, type Operation } from './types/operation';
import type { IWorkspaceStoreClient } from './worker/workerProtocol';
import type { ClassRow } from './query/classes';
import type { NodeRow } from './store';
import { SYSTEM_CLASS_UUIDS, SYSTEM_PAGE_UUIDS } from '@/constants/systemProperties';

interface TextAst {
  type: string;
  children: Array<{ type: string; text: string }>;
}

/** Minimal paragraph AST for a plain-text node name (mirrors `_name_ast`). */
function nameAst(text: string): TextAst[] {
  return [{ type: 'paragraph', children: [{ type: 'text', text }] }];
}

/** Class/page ids to (re)seed; defaults to everything when omitted. */
export interface SeedFilter {
  classIds?: ReadonlySet<string>;
  pageIds?: ReadonlySet<string>;
}

/**
 * Build the exact operation sequence the server seed produces for a new
 * workspace. Pass `filter` to emit ops only for a subset of classes/pages
 * (used by `ensureLocalWorkspace` to skip already-seeded entries).
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
    operations.push(build('class.create', { classId, name }, [classId]));
    operations.push(
      build('node.updateContent', { nodeId: classId, content: nameAst(name) }, [classId])
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
 * Seed the local workspace with the system classes and default pages,
 * idempotently.
 *
 * Runs at local-workspace open. Entries that already exist in the store
 * (e.g. a persisted or previously server-seeded workspace) are skipped, so
 * re-running emits nothing. Ops are applied through the store client's
 * canonical `applyMany` path, which also dedupes by op id.
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
  for (const classId of Object.values(SYSTEM_CLASS_UUIDS)) {
    const existing = await client.query<ClassRow | undefined>('getClass', [classId]);
    if (!existing) missingClassIds.add(classId);
  }

  const missingPageIds = new Set<string>();
  for (const pageId of Object.values(SYSTEM_PAGE_UUIDS)) {
    const existing = await client.query<NodeRow | undefined>('getNode', [pageId]);
    if (!existing) missingPageIds.add(pageId);
  }

  const operations = buildWorkspaceSeedOperations(workspaceId, actorId, userDisplayName, {
    classIds: missingClassIds,
    pageIds: missingPageIds,
  });
  if (operations.length === 0) return 0;

  await client.mutate<number>('applyMany', [operations]);
  return operations.length;
}
