/**
 * Link content sanitization utilities.
 * 
 * Removes editor artifacts and normalizes link formats to canonical [[nodeId]] syntax.
 * Handles common corruptions from VS Code/Monaco Editor and other Markdown processors.
 */

/**
 * Strip editor artifacts and normalize to canonical format.
 * 
 * Removes:
 * - vscodecontentref artifacts: [[[nodeId]]](http://vscodecontentref/N)
 * - Malformed internal URLs: [text](internal://nodeId) 
 * - Other editor-generated link corruptions
 * 
 * Returns canonical [[nodeId]] or [[nodeId:linkUuid]] format.
 */
export function sanitizeContent(rawContent: string): string {
  if (!rawContent) {
    return rawContent;
  }
  
  let content = rawContent;
  
  // Remove vscodecontentref artifacts: [[[nodeId]]](http://vscodecontentref/N) -> [[nodeId]]
  content = content.replace(
    /\[\[\[([^\]]+)\]\]\]\(http:\/\/vscodecontentref\/\d+\)/g,
    '[[$1]]'
  );
  
  // Normalize internal URLs: [text](internal://nodeId) -> [[nodeId]]
  content = content.replace(
    /\[([^\]]*)\]\(internal:\/\/(\d+)\)/g,
    '[[$2]]'
  );
  
  // Handle broken markdown links with node IDs: [[[nodeId]]] -> [[nodeId]]
  content = content.replace(
    /\[\[\[([^\]]+)\]\]\]/g,
    '[[$1]]'
  );
  
  // Normalize any remaining malformed bracket patterns
  content = content.replace(
    /\[\[\[([^\]]+)\]\]/g,
    '[[$1]]'
  );
  
  return content;
}

/**
 * Check if content contains editor artifacts that need sanitization.
 */
export function hasEditorArtifacts(content: string): boolean {
  if (!content) return false;
  
  return (
    content.includes('vscodecontentref') ||
    content.includes('internal://') ||
    /\[\[\[.*\]\]\]/.test(content) ||
    /\[\[\[.*\]\]/.test(content)
  );
}