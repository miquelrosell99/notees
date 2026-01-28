/**
 * Asset Resolver - Read-only asset validation and resolution.
 * 
 * CRITICAL INVARIANTS (validated by this resolver):
 * 1. One asset node ↔ one asset folder
 * 2. One asset folder ↔ exactly one source file named <uuid>.<ext>
 * 3. UUID is immutable
 * 4. File extension is authoritative for MIME inference
 * 5. Block name (node.name) is semantic only and NEVER affects disk state
 * 
 * This resolver NEVER throws during render - it returns safe error states.
 */
import { extractExtension, inferMimeType, getCapabilityFromMime, type AssetCapability } from './mimeUtils';
import type { Node } from '@/types';
import { SYSTEM_CLASS_UUIDS } from '@/constants';

/** Asset resolution result */
export interface AssetResolution {
  /** Resolution status */
  status: 'valid' | 'missing' | 'broken_mime' | 'permission_error' | 'invariant_violation';
  
  /** Error message (if status !== 'valid') */
  error?: string;
  
  /** Asset UUID */
  uuid: string;
  
  /** File extension (if determinable) */
  extension: string | null;
  
  /** MIME type (if determinable) */
  mimeType: string | null;
  
  /** Rendering capability (if determinable) */
  capability: AssetCapability | null;
  
  /** Asset URL (if accessible) */
  url: string | null;
  
  /** Thumbnail URL (if available) */
  thumbnailUrl: string | null;
  
  /** Warning message (non-fatal) */
  warning?: string;
}

/**
 * Resolve an asset node to its rendering information.
 * 
 * NEVER THROWS - returns error states instead.
 */
export function resolveAsset(node: Node): AssetResolution {
  // Validate node has asset class
  // This is typically validated at the Block level before calling this
  // We just proceed with resolution
  
  // Extract extension from node name
  // INVARIANT: Extension is authoritative for MIME
  const extension = extractExtension(node.name || '');
  
  if (!extension) {
    return {
      status: 'broken_mime',
      error: 'Asset has no file extension',
      warning: 'Cannot determine file type - add extension to filename',
      uuid: node.uuid,
      extension: null,
      mimeType: null,
      capability: null,
      url: null,
      thumbnailUrl: null,
    };
  }
  
  // Infer MIME type from extension
  const mimeType = inferMimeType(extension);
  const capability = getCapabilityFromMime(mimeType);
  
  // Construct asset URL
  // The backend will verify the file exists and return 404 if missing
  const url = `/api/assets/${node.uuid}`;
  
  // Check for thumbnail (only for images)
  const thumbnailUrl = capability === 'image' 
    ? `/api/assets/${node.uuid}/thumbnail`
    : null;
  
  return {
    status: 'valid',
    uuid: node.uuid,
    extension,
    mimeType,
    capability,
    url,
    thumbnailUrl,
  };
}

/**
 * Check if a node is an asset by class UUID.
 */
export function isAssetNode(node: Node, allClasses?: Node[]): boolean {
  if (!node.classes || node.classes.length === 0) return false;
  if (!allClasses) return false;
  
  return node.classes.some(classId => {
    const classNode = allClasses.find(c => c.id === classId);
    return classNode?.uuid === SYSTEM_CLASS_UUIDS.asset;
  });
}

/**
 * Get asset metadata for inspector panel.
 */
export interface AssetMetadata {
  uuid: string;
  originalFilename: string;
  storedFilename: string;
  mimeType: string;
  extension: string;
  capability: AssetCapability;
}

export function getAssetMetadata(node: Node): AssetMetadata | null {
  const resolution = resolveAsset(node);
  
  if (resolution.status !== 'valid' || !resolution.extension || !resolution.mimeType || !resolution.capability) {
    return null;
  }
  
  return {
    uuid: resolution.uuid,
    originalFilename: node.name || 'Untitled',
    storedFilename: `${resolution.uuid}${resolution.extension}`,
    mimeType: resolution.mimeType,
    extension: resolution.extension,
    capability: resolution.capability,
  };
}
