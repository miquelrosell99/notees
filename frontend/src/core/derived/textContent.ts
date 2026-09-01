/**
 * Extract the concatenated text leaves of a node's content JSON into the
 * derived `node.text_content` column.
 *
 * This is the write-time equivalent of the SQLite expression the query
 * compiler used to evaluate per row:
 *
 *   (SELECT group_concat(value, '') FROM json_tree(content) WHERE key = 'text')
 *
 * Semantics must match json_tree exactly for real content payloads:
 * depth-first document-order traversal of the parsed JSON; whenever an object
 * property key is exactly 'text' and its value is a string, append the value;
 * concatenate with no separator; return null when no such values exist
 * (group_concat over an empty set is NULL). Malformed JSON yields null.
 */
export function extractTextContent(contentJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    return null;
  }
  const parts: string[] = [];
  collectTextValues(parsed, parts);
  return parts.length > 0 ? parts.join('') : null;
}

function collectTextValues(value: unknown, parts: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTextValues(item, parts);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'text') {
        if (typeof child === 'string') {
          parts.push(child);
        } else {
          collectTextValues(child, parts);
        }
      } else {
        collectTextValues(child, parts);
      }
    }
  }
}
