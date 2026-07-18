/**
 * Resolve a node UUID to its projected legacy Node shape from the core store.
 */

import type { Node } from '@/types/api';
import { projectNode } from '../adapters/nodeProjection';
import type { WorkspaceStore } from '../store';

export function getNodeByUuid(store: WorkspaceStore, nodeUuid: string): Node | null {
  return projectNode(store, nodeUuid) ?? null;
}
