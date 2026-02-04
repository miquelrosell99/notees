/**
 * Link processing utilities for the frontend.
 * 
 * Provides functions for link validation, sanitization, and format checking
 * that complement the backend link parsing service.
 */

import { sanitizeContent, hasEditorArtifacts } from './linkSanitization';

// Link pattern constants
export const LINK_PATTERN = /\[\[([^\]:\s]+)(?::([a-f0-9-]+))?\]\]/g;
export const TYPE_PATTERN = /\{\{([^}]+)\}\}/g;

/**
 * Validate that a string contains a valid node ID.
 */
export function isValidNodeId(nodeId: string): boolean {
  return /^\d+$/.test(nodeId.trim());
}

/**
 * Validate that a string is a valid link UUID.
 */
export function isValidLinkUuid(uuid: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(uuid);
}

/**
 * Parse a link string to extract node ID and optional link UUID.
 * Returns null if the link format is invalid.
 */
export function parseLinkString(linkString: string): { nodeId: string; linkUuid?: string } | null {
  const match = linkString.match(/^\[\[([^\]:\s]+)(?::([a-f0-9-]+))?\]\]$/);
  if (!match) return null;
  
  const [, nodeId, linkUuid] = match;
  if (!isValidNodeId(nodeId)) return null;
  if (linkUuid && !isValidLinkUuid(linkUuid)) return null;
  
  return {
    nodeId,
    linkUuid: linkUuid || undefined,
  };
}

/**
 * Format a node ID and optional link UUID into canonical link syntax.
 */
export function formatLinkString(nodeId: string | number, linkUuid?: string): string {
  const id = String(nodeId);
  if (linkUuid) {
    return `[[${id}:${linkUuid}]]`;
  }
  return `[[${id}]]`;
}

/**
 * Extract all link references from content without sanitization.
 * Used when you want to see the original corrupted links for debugging.
 */
export function extractRawLinks(content: string): Array<{
  raw: string;
  nodeId?: string;
  linkUuid?: string;
  start: number;
  end: number;
}> {
  const links: Array<{
    raw: string;
    nodeId?: string;
    linkUuid?: string;
    start: number;
    end: number;
  }> = [];
  
  let match;
  const regex = new RegExp(LINK_PATTERN.source, 'g');
  while ((match = regex.exec(content)) !== null) {
    links.push({
      raw: match[0],
      nodeId: match[1],
      linkUuid: match[2] || undefined,
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  
  return links;
}

/**
 * Check if content has any link patterns (including potentially malformed ones).
 */
export function hasLinks(content: string): boolean {
  return LINK_PATTERN.test(content) || hasEditorArtifacts(content);
}

/**
 * Check if content has any inline type references.
 */
export function hasInlineTypes(content: string): boolean {
  return TYPE_PATTERN.test(content);
}

/**
 * Comprehensive content processing: sanitize and validate all links.
 * Returns sanitized content and any validation warnings.
 */
export function processContent(rawContent: string): {
  content: string;
  warnings: string[];
  hadArtifacts: boolean;
} {
  const warnings: string[] = [];
  const hadArtifacts = hasEditorArtifacts(rawContent);
  
  if (hadArtifacts) {
    warnings.push('Editor artifacts detected and removed');
  }
  
  const content = sanitizeContent(rawContent);
  const links = extractRawLinks(content);
  
  // Validate all links
  for (const link of links) {
    if (link.nodeId && !isValidNodeId(link.nodeId)) {
      warnings.push(`Invalid node ID in link: ${link.raw}`);
    }
    if (link.linkUuid && !isValidLinkUuid(link.linkUuid)) {
      warnings.push(`Invalid link UUID in link: ${link.raw}`);
    }
  }
  
  return {
    content,
    warnings,
    hadArtifacts,
  };
}

// Re-export sanitization functions
export { sanitizeContent, hasEditorArtifacts };