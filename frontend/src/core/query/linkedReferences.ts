/**
 * Build LinkedReference-shaped results from the core SQLite derived store.
 *
 * This is the local-first replacement for
 * `frontend/src/features/sync/local/buildOfflineLinkedReferences.ts`.
 */

import type { LinkedReferencesResponse } from '@/types/api';
import { createEmptyQueryAST } from '@/types/queryAST';
import { autoFixSystemQuery } from '@/lib/systemQueryAutoFix';
import type { WorkspaceStore } from '../store';
import type { IWorkspaceStoreClient } from '../worker/workerProtocol';
import { buildSyntheticRef } from '../projections/LinkedReferenceProjection';
import { queryNodes } from './queryNodes';

/**
 * Evaluate linked references locally and return the same shape as the server endpoint.
 */
export function buildLinkedReferences(
  store: WorkspaceStore,
  nodeUuid: string,
  params?: { limit?: number; offset?: number }
): LinkedReferencesResponse {
  const baseAst = createEmptyQueryAST();
  const ast = autoFixSystemQuery(baseAst, 'linked_references', { nodeUuid });
  const matches = queryNodes(store, {
    ast,
    runtimeParams: { current_node_uuid: nodeUuid, current_node_id: nodeUuid },
    projectionDepth: 0,
  });

  const refs = matches
    .map((sourceNode) => buildSyntheticRef(store, sourceNode.uuid))
    .filter((ref): ref is NonNullable<typeof ref> => ref !== undefined);

  const offset = params?.offset ?? 0;
  const limit = params?.limit ?? refs.length;
  const paginated = refs.slice(offset, offset + limit);

  return { linked_references: paginated, total_count: refs.length };
}

export async function buildLinkedReferencesFromClient(
  client: IWorkspaceStoreClient,
  nodeUuid: string,
  params?: { limit?: number; offset?: number }
): Promise<LinkedReferencesResponse> {
  return client.query<LinkedReferencesResponse>('buildLinkedReferences', [nodeUuid, params]);
}
