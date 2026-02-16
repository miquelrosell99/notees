/**
 * Notees URI Scheme
 * 
 * Provides stable, UUID-based internal links for navigating to nodes.
 * 
 * URI format: notees:{uuid}
 * Example:    notees:550e8400-e29b-41d4-a716-446655440000
 * 
 * Used in activity log details to create navigable markdown-style links:
 *   [Node Name](notees:uuid)
 * 
 * They can also be used for deep linking to specific nodes from outside the app, or for any
 * other context where a stable reference to a node is needed that won't break if the node's
 * auto-increment ID changes (e.g. due to deletions). Since they use UUIDs, they are stable across
 * different environments and sessions.
 * 
 * For example, useful for sharing links to specific nodes, or for referencing nodes 
 * in user-generated content that may be stored long-term.
 * 
 * These URIs are stable across sessions since they use UUIDs rather than
 * auto-increment IDs, making them safe for persistent storage.
 */

const NOTEES_SCHEME = 'notees:';

/**
 * Build a notees: URI from a node UUID.
 * 
 * @param uuid - The node's UUID
 * @returns URI string like "notees:550e8400-..."
 */
export function buildNoteesUri(uuid: string): string {
  return `${NOTEES_SCHEME}${uuid}`;
}

/**
 * Check if a string is a notees: URI.
 */
export function isNoteesUri(uri: string): boolean {
  return uri.startsWith(NOTEES_SCHEME);
}

/**
 * Extract the node UUID from a notees: URI.
 * 
 * @param uri - A notees: URI string
 * @returns The UUID, or null if not a valid notees: URI
 */
export function parseNoteesUri(uri: string): string | null {
  if (!isNoteesUri(uri)) return null;
  const uuid = uri.slice(NOTEES_SCHEME.length);
  return uuid || null;
}

/**
 * Build a markdown-style link using the notees: URI scheme.
 * 
 * @param label - Display text for the link
 * @param uuid - The node's UUID
 * @returns Markdown link like "[Node Name](notees:uuid)"
 */
export function buildNoteesLink(label: string, uuid: string): string {
  return `[${label}](${buildNoteesUri(uuid)})`;
}

/** Regex to match markdown links with notees: URIs: [label](notees:uuid) */
export const NOTEES_LINK_REGEX = /\[([^\]]+)\]\(notees:([a-f0-9-]+)\)/gi;

export interface NoteesLink {
  /** Full match string */
  fullMatch: string;
  /** Display label */
  label: string;
  /** Node UUID */
  uuid: string;
  /** Start index in the source string */
  index: number;
}

/**
 * Parse all notees: markdown links from a string.
 * 
 * @param text - String potentially containing [label](notees:uuid) links
 * @returns Array of parsed links
 */
export function parseNoteesLinks(text: string): NoteesLink[] {
  const links: NoteesLink[] = [];
  const regex = new RegExp(NOTEES_LINK_REGEX.source, NOTEES_LINK_REGEX.flags);
  let match: RegExpExecArray | null;
  
  while ((match = regex.exec(text)) !== null) {
    links.push({
      fullMatch: match[0],
      label: match[1],
      uuid: match[2],
      index: match.index,
    });
  }
  
  return links;
}

/**
 * Split a string into segments of plain text and notees links.
 * Useful for rendering mixed text with clickable links.
 */
export type TextSegment = 
  | { type: 'text'; text: string }
  | { type: 'link'; label: string; uuid: string };

export function splitTextWithLinks(text: string): TextSegment[] {
  const links = parseNoteesLinks(text);
  if (links.length === 0) {
    return [{ type: 'text', text }];
  }

  const segments: TextSegment[] = [];
  let lastIndex = 0;

  for (const link of links) {
    // Add text before this link
    if (link.index > lastIndex) {
      segments.push({ type: 'text', text: text.slice(lastIndex, link.index) });
    }
    // Add the link segment
    segments.push({ type: 'link', label: link.label, uuid: link.uuid });
    lastIndex = link.index + link.fullMatch.length;
  }

  // Add remaining text after last link
  if (lastIndex < text.length) {
    segments.push({ type: 'text', text: text.slice(lastIndex) });
  }

  return segments;
}
