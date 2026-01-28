/**
 * AssetBlock Component
 * 
 * Atomic asset block that:
 * - Resolves file path from node.uuid
 * - Infers MIME type from extension
 * - Delegates to appropriate renderer (Image, Audio, Generic, Error)
 * - Cursor cannot enter (atomic block)
 * - Supports per-asset folders with thumbnail support
 * - NEVER throws - returns error states on failures
 * 
 * Storage: assets/{uuid}/{uuid}.{ext}
 * Thumbnail: assets/{uuid}/thumbnail.webp
 */
import { useMemo } from 'react';
import { getAssetUrl } from '@/api/assets';
import { resolveAsset } from '@/utils/assetResolver';
import { ImageRenderer } from './renderers/ImageRenderer';
import { AudioRenderer } from './renderers/AudioRenderer';
import { GenericRenderer } from './renderers/GenericRenderer';
import { ErrorRenderer } from './renderers/ErrorRenderer';
import type { Node } from '@/types';
import './AssetBlock.css';

interface AssetBlockProps {
  /** The asset node */
  node: Node;
  /** Whether the block is selected (for audio Space key handling) */
  isSelected?: boolean;
  /** Whether the block content can be edited */
  canEdit?: boolean;
  /** Callback when title (node name) changes */
  onTitleChange?: (nodeId: number, newTitle: string) => void;
}

/**
 * AssetBlock - Single component for all asset types
 * 
 * Rendering is determined ONLY by MIME type inferred from file extension.
 * No asset_kind or subtype is stored.
 * 
 * NEVER throws during render - uses ErrorRenderer for failures.
 */
export function AssetBlock({
  node,
  isSelected = false,
  canEdit = true,
  onTitleChange,
}: AssetBlockProps) {
  // Resolve asset (NEVER throws)
  const resolution = useMemo(() => resolveAsset(node), [node]);
  
  // Title is the node name
  const title = node.name || '';
  
  // Handle title change
  const handleTitleChange = (newTitle: string) => {
    if (onTitleChange) {
      onTitleChange(node.id, newTitle);
    }
  };
  
  // Render error state if resolution failed
  if (resolution.status !== 'valid') {
    return (
      <div className="asset-block" data-asset-uuid={node.uuid} data-status={resolution.status}>
        <ErrorRenderer
          status={resolution.status}
          error={resolution.error || 'Unknown error'}
          warning={resolution.warning}
          uuid={resolution.uuid}
          title={title}
        />
      </div>
    );
  }
  
  // Get URLs (with null checks for TypeScript)
  const assetUrl = resolution.url || getAssetUrl(node.uuid);
  const thumbnailUrl = resolution.thumbnailUrl;
  
  // Delegate to appropriate renderer based on capability
  return (
    <div className="asset-block" data-asset-uuid={node.uuid} data-capability={resolution.capability}>
      {resolution.capability === 'image' && (
        <ImageRenderer
          nodeId={node.id}
          assetUrl={assetUrl}
          thumbnailUrl={thumbnailUrl}
          title={title}
          editable={canEdit}
          onTitleChange={handleTitleChange}
        />
      )}
      
      {resolution.capability === 'audio' && (
        <AudioRenderer
          assetUrl={assetUrl}
          mimeType={resolution.mimeType || 'audio/mpeg'}
          title={title}
          editable={canEdit}
          onTitleChange={handleTitleChange}
          isSelected={isSelected}
        />
      )}
      
      {(resolution.capability === 'video' || 
        resolution.capability === 'document' || 
        resolution.capability === 'generic') && (
        <GenericRenderer
          assetUrl={assetUrl}
          mimeType={resolution.mimeType || 'application/octet-stream'}
          extension={resolution.extension || ''}
          title={title}
          editable={canEdit}
          onTitleChange={handleTitleChange}
        />
      )}
    </div>
  );
}

export default AssetBlock;
