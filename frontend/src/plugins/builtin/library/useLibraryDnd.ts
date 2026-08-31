/**
 * useLibraryDnd — store-client side of Library drag-and-drop (Task 12).
 *
 * `attachFileToSource` uploads a dropped file as an asset node (reusing the
 * Task 6 upload path) and appends it to the source's `attachments` property.
 * `addSourceToCollection` resolves the membership plan (see `libraryDnd.ts`)
 * and nests the source under the collection via a normal `node.move` op.
 * Both flow through ordinary ops, so sync comes free.
 */
import { useCallback } from 'react';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';
import { useNotifications } from '@/stores/notificationStore';
import { projectNodeFromClient } from '@/core/adapters/nodeProjection';
import type { IWorkspaceStoreClient } from '@/core/worker/workerProtocol';
import { uuidv7 } from '@/core/uuid';
import { SYSTEM_PROPERTY_UUIDS } from '@/constants/systemProperties';
import { uploadAssetAsNode } from '@/features/content/utils/classAwareCreate';
import { nodeNameToText } from '@/features/queries';
import {
  contentLinksTo,
  mergeAttachmentValue,
  resolveCollectionDrop,
  type CollectionDropAction,
} from './libraryDnd';

const MAX_ANCESTOR_DEPTH = 100;

/** Walk a node's parent chain (nearest first), cycle-safe. */
async function collectAncestorUuids(
  client: IWorkspaceStoreClient,
  nodeUuid: string,
): Promise<string[]> {
  const chain: string[] = [];
  let current = (await projectNodeFromClient(client, nodeUuid))?.parent_uuid ?? null;
  while (current && chain.length < MAX_ANCESTOR_DEPTH && !chain.includes(current)) {
    chain.push(current);
    current = (await projectNodeFromClient(client, current))?.parent_uuid ?? null;
  }
  return chain;
}

export function useLibraryDnd() {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { client } = useWorkspaceStoreClient(workspaceUuid ?? '');
  const { success: notifySuccess, error: notifyError } = useNotifications();

  const attachFileToSource = useCallback(
    async (sourceUuid: string, file: File): Promise<void> => {
      if (!client) {
        notifyError('Workspace not ready', 'Please try again in a moment.');
        return;
      }
      try {
        const assetNode = await uploadAssetAsNode(client, file);
        const source = await projectNodeFromClient(client, sourceUuid);
        if (!source) throw new Error('Source node not found');
        const merged = mergeAttachmentValue(
          source.properties_uuid?.[SYSTEM_PROPERTY_UUIDS.attachments],
          assetNode.uuid,
        );
        if (merged === null) return; // already attached
        await client.mutate<void>('setProperty', [
          {
            propertyValueId: uuidv7(),
            nodeId: sourceUuid,
            schemaId: SYSTEM_PROPERTY_UUIDS.attachments,
            value: merged,
          },
        ]);
        notifySuccess('File attached', file.name);
      } catch (error) {
        notifyError('Failed to attach file', error instanceof Error ? error.message : undefined);
      }
    },
    [client, notifySuccess, notifyError],
  );

  const addSourceToCollection = useCallback(
    async (sourceUuid: string, collectionUuid: string): Promise<CollectionDropAction | null> => {
      if (!client) {
        notifyError('Workspace not ready', 'Please try again in a moment.');
        return null;
      }
      try {
        const source = await projectNodeFromClient(client, sourceUuid);
        if (!source) throw new Error('Source node not found');
        const [sourceAncestors, collectionAncestors] = await Promise.all([
          collectAncestorUuids(client, sourceUuid),
          collectAncestorUuids(client, collectionUuid),
        ]);
        const plan = resolveCollectionDrop({
          sourceUuid,
          collectionUuid,
          sourceAncestors,
          collectionAncestors,
          sourceAlreadyLinks: contentLinksTo(source.content, collectionUuid),
        });
        if (plan.action === 'nest') {
          await client.mutate<void>('moveNode', [sourceUuid, collectionUuid]);
          notifySuccess('Added to collection', nodeNameToText(source.name) || undefined);
        }
        return plan;
      } catch (error) {
        notifyError(
          'Failed to add to collection',
          error instanceof Error ? error.message : undefined,
        );
        return null;
      }
    },
    [client, notifySuccess, notifyError],
  );

  return { attachFileToSource, addSourceToCollection };
}
