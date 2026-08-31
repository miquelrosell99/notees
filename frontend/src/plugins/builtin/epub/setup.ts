/**
 * EPUB plugin frontend setup (notees.epub).
 *
 * Registers per-attachment node actions on EPUB asset pills: attachments of a
 * source render as node pills in the properties panel, and their right-click
 * menu composes plugin node actions (menu 'link'; the asset block's own menu
 * is 'node'). Visibility is gated on the attachment's MIME type via
 * NodeActionContext.assetMimeType, so non-EPUB attachments never show these
 * actions. The backend endpoints live under /api/plugins/notees.epub/assets/.
 */
import type { NodeActionContext, PluginContext } from '@/plugins/core';
import { queryClient } from '@/lib/queryClient';
import { assetKeys, nodeKeys } from '@/hooks/queryKeys';
import { useNotificationStore } from '@/stores/notificationStore';
import { getLogger } from '@/utils/logger';
import { getApiErrorMessage } from '@/utils/apiError';

const log = getLogger('epub-plugin');

export const EPUB_MIME_TYPE = 'application/epub+zip';

/** Only EPUB asset attachments show the metadata actions. */
export function isEpubAsset(context: NodeActionContext): boolean {
  return context.assetMimeType === EPUB_MIME_TYPE;
}

interface ExtractResponse {
  source_uuid: string;
  applied: Record<string, unknown>;
}

interface InjectResponse {
  asset_uuid: string;
  changed: boolean;
  asset_hash: string;
}

export function setup(context: PluginContext) {
  const api = context.getApiClient();
  const notifications = () => useNotificationStore.getState();

  const extractMetadata = async (assetUuid: string) => {
    try {
      const { data } = (await api.post(`/assets/${assetUuid}/extract`, {})) as {
        data: ExtractResponse;
      };
      // Title/authors/publisher/… changed on the source node.
      await queryClient.invalidateQueries({
        queryKey: nodeKeys.detailBase(data.source_uuid),
      });
      await queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      const fields = Object.keys(data.applied).join(', ');
      notifications().success(
        'Metadata extracted',
        fields ? `Applied to source: ${fields}` : 'No metadata found in the file'
      );
    } catch (error) {
      log.error('EPUB metadata extraction failed', error);
      notifications().error(
        'Metadata extraction failed',
        getApiErrorMessage(error, 'Please try again.')
      );
    }
  };

  const injectMetadata = async (assetUuid: string) => {
    try {
      const { data } = (await api.post(`/assets/${assetUuid}/inject`, {})) as {
        data: InjectResponse;
      };
      // The blob/hash changed under the same asset node; refresh asset info.
      await queryClient.invalidateQueries({ queryKey: assetKeys.info(assetUuid) });
      notifications().success(
        'Source metadata synced',
        data.changed ? 'EPUB file updated' : 'EPUB already up to date'
      );
    } catch (error) {
      log.error('EPUB metadata injection failed', error);
      notifications().error(
        'Metadata sync failed',
        getApiErrorMessage(error, 'Please try again.')
      );
    }
  };

  context.registerNodeAction({
    id: 'epub.extractMetadata',
    label: 'Extract metadata → source',
    icon: 'mdi-book-arrow-down-outline',
    menus: ['link', 'node'],
    visible: isEpubAsset,
    execute: ({ nodeUuid, close }) => {
      close();
      void extractMetadata(nodeUuid);
    },
  });

  context.registerNodeAction({
    id: 'epub.injectMetadata',
    label: 'Sync source metadata → EPUB',
    icon: 'mdi-book-sync-outline',
    menus: ['link', 'node'],
    visible: isEpubAsset,
    execute: ({ nodeUuid, close }) => {
      close();
      void injectMetadata(nodeUuid);
    },
  });
}
