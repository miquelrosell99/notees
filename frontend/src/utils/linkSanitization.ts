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

/**
 * Find bare node UUIDs in content that are not already wrapped in [[...]] link syntax.
 * Matches standard UUID v4 and date UUIDs (00000000-0000-0000-00xx-...).
 * Returns an array of matches with their positions.
 */
export function findBareNodeUuids(content: string): Array<{ uuid: string; start: number; end: number }> {
  if (!content) return [];
  
  const results: Array<{ uuid: string; start: number; end: number }> = [];
  
  // Find all UUIDs, then exclude those inside [[ ]] or after a colon (link instance UUIDs)
  const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  let match;
  while ((match = uuidRegex.exec(content)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    
    // Check if this UUID is inside [[ ]] brackets (i.e., already a link)
    const before = content.substring(0, start);
    const after = content.substring(end);
    
    const lastOpen = before.lastIndexOf('[[');
    const lastClose = before.lastIndexOf(']]');
    
    // UUID is wrapped if [[ appears after the last ]] and ]] appears after us
    const isWrapped = lastOpen > lastClose && after.indexOf(']]') !== -1 && 
      (after.indexOf(']]') < after.indexOf('[[') || after.indexOf('[[') === -1);
    
    // Skip if it's a link instance UUID (after a colon inside brackets like [[nodeId:uuid]])
    const charBefore = start > 0 ? content[start - 1] : '';
    const isLinkUuid = charBefore === ':';
    
    if (!isWrapped && !isLinkUuid) {
      results.push({ uuid: match[0].toLowerCase(), start, end });
    }
  }
  
  return results;
}