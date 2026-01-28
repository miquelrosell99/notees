/**
 * MIME type utilities for asset rendering
 * 
 * Infers MIME type from file extension and determines rendering capabilities.
 */

/** MIME type mappings from extensions */
const EXTENSION_TO_MIME: Record<string, string> = {
  // Images
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'png': 'image/png',
  'gif': 'image/gif',
  'webp': 'image/webp',
  'svg': 'image/svg+xml',
  'bmp': 'image/bmp',
  'ico': 'image/x-icon',
  
  // Audio
  'mp3': 'audio/mpeg',
  'wav': 'audio/wav',
  'ogg': 'audio/ogg',
  'opus': 'audio/opus',
  'weba': 'audio/webm',
  'm4a': 'audio/mp4',
  'flac': 'audio/flac',
  
  // Video
  'mp4': 'video/mp4',
  'webm': 'video/webm',
  'ogv': 'video/ogg',
  'mov': 'video/quicktime',
  
  // Documents
  'pdf': 'application/pdf',
  'doc': 'application/msword',
  'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'xls': 'application/vnd.ms-excel',
  'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'ppt': 'application/vnd.ms-powerpoint',
  'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  
  // Text
  'txt': 'text/plain',
  'md': 'text/markdown',
  'html': 'text/html',
  'css': 'text/css',
  'js': 'text/javascript',
  'json': 'application/json',
  'xml': 'application/xml',
  
  // Archives
  'zip': 'application/zip',
  'rar': 'application/x-rar-compressed',
  '7z': 'application/x-7z-compressed',
  'tar': 'application/x-tar',
  'gz': 'application/gzip',
};

/** Asset rendering capabilities */
export type AssetCapability = 'image' | 'audio' | 'video' | 'document' | 'generic';

/**
 * Infer MIME type from file extension
 */
export function inferMimeType(extension: string): string {
  const ext = extension.toLowerCase().replace(/^\./, '');
  return EXTENSION_TO_MIME[ext] || 'application/octet-stream';
}

/**
 * Extract extension from filename
 */
export function extractExtension(filename: string): string | null {
  const match = filename.match(/\.([^.]+)$/);
  return match ? match[1] : null;
}

/**
 * Get rendering capability from MIME type
 */
export function getCapabilityFromMime(mimeType: string): AssetCapability {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType === 'application/pdf' || 
      mimeType.includes('document') || 
      mimeType.includes('spreadsheet') ||
      mimeType.includes('presentation')) return 'document';
  return 'generic';
}

/**
 * Get icon emoji for MIME type
 */
export function getIconForMime(mimeType: string): string {
  const capability = getCapabilityFromMime(mimeType);
  switch (capability) {
    case 'image': return '🖼️';
    case 'audio': return '🎵';
    case 'video': return '🎬';
    case 'document': return '📄';
    default: return '📎';
  }
}

/**
 * Get human-readable type label from MIME
 */
export function getMimeLabel(mimeType: string): string {
  const parts = mimeType.split('/');
  if (parts.length === 2) {
    const [category, subtype] = parts;
    return `${subtype.toUpperCase()} ${category.charAt(0).toUpperCase() + category.slice(1)}`;
  }
  return 'File';
}
