/**
 * Hook resolving an asset node's MIME type.
 *
 * Returns null for non-asset nodes and while the lookup is in flight; the
 * result is cached per asset uuid. Used by context menus to gate per-format
 * node actions (e.g. EPUB extract/inject) on the attachment's MIME type.
 *
 * Asset detection uses the system `asset` class: the `Node.is_asset` flag is
 * declared in the API types but never populated client-side.
 */
import { useQuery } from '@tanstack/react-query';
import type { Node } from '@/types/api';
import { assetKeys } from '@/hooks/queryKeys';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import { getAssetInfo } from '../api/assets';

export function useAssetMimeType(node: Node | null | undefined): string | null {
  const isAsset = node?.classes_uuid?.includes(SYSTEM_CLASS_UUIDS.asset) ?? false;
  const assetUuid = isAsset ? node?.uuid : null;
  const { data } = useQuery({
    queryKey: assetKeys.info(assetUuid ?? ''),
    queryFn: () => getAssetInfo(assetUuid as string),
    enabled: assetUuid != null,
    meta: { skipGlobalError: true },
  });
  return data?.content_type ?? null;
}
