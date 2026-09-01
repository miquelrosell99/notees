import { describe, it, expect } from 'vitest';
import { createTestDatabase } from '../../__tests__/helpers';
import { extractTextContent } from '../textContent';
import { queryOne } from '../../db/sqlite';

/**
 * Ground truth: evaluate the legacy json_tree expression directly in SQLite
 * and compare against the TypeScript extractor.
 */
async function expectJsonTreeParity(contents: string[]): Promise<void> {
  const db = await createTestDatabase();
  for (const contentJson of contents) {
    const row = queryOne<{ v: string | null }>(
      db,
      "SELECT (SELECT group_concat(value, '') FROM json_tree(?) WHERE key = 'text') AS v",
      [contentJson]
    );
    expect(extractTextContent(contentJson), `content: ${contentJson}`).toBe(row?.v ?? null);
  }
}

describe('extractTextContent', () => {
  it('concatenates text leaves in document order without a separator', () => {
    const content = JSON.stringify([
      { type: 'paragraph', children: [{ type: 'text', text: 'Hello ' }] },
      {
        type: 'paragraph',
        children: [
          { type: 'text', text: 'wor' },
          { type: 'text', text: 'ld', marks: [{ type: 'strong' }] },
        ],
      },
    ]);
    expect(extractTextContent(content)).toBe('Hello world');
  });

  it('treats the CRDT wrapper text leaf verbatim (no unwrapping)', () => {
    const inner = JSON.stringify([
      { type: 'paragraph', children: [{ type: 'text', text: 'real text' }] },
    ]);
    const content = JSON.stringify([{ type: 'text', text: inner }]);
    expect(extractTextContent(content)).toBe(inner);
  });

  it('collects text leaves nested under marks and children', () => {
    const content = JSON.stringify([
      {
        type: 'heading',
        attrs: { level: 2 },
        children: [
          { type: 'text', text: 'A' },
          {
            type: 'text',
            text: 'B',
            marks: [{ type: 'em' }, { type: 'link', attrs: { href: 'https://x.test' } }],
          },
        ],
      },
    ]);
    expect(extractTextContent(content)).toBe('AB');
  });

  it('returns null when there are no text leaves', () => {
    expect(extractTextContent('[]')).toBeNull();
    expect(extractTextContent(JSON.stringify([{ type: 'image', attrs: { src: 'x' } }]))).toBeNull();
  });

  it('returns an empty string (not null) when the only text leaf is empty', () => {
    expect(extractTextContent(JSON.stringify([{ type: 'text', text: '' }]))).toBe('');
  });

  it('returns null for malformed JSON', () => {
    expect(extractTextContent('Raw title text')).toBeNull();
    expect(extractTextContent('{')).toBeNull();
  });

  it('recurses into non-string text values to find nested text leaves', () => {
    // json_tree would also include the container's JSON serialization for such
    // a value; that shape never occurs in real content, so the extractor only
    // collects the string leaves.
    const content = JSON.stringify([{ type: 'x', text: { text: 'nested' } }]);
    expect(extractTextContent(content)).toBe('nested');
  });

  it('skips non-string scalar text values', () => {
    expect(extractTextContent(JSON.stringify([{ text: 5 }, { text: true }, { text: null }]))).toBeNull();
  });

  it('matches the legacy json_tree expression exactly for representative payloads', async () => {
    await expectJsonTreeParity([
      '[]',
      JSON.stringify([{ type: 'paragraph', children: [{ type: 'text', text: 'Hello world' }] }]),
      JSON.stringify([
        { type: 'paragraph', children: [{ type: 'text', text: 'a' }] },
        { type: 'paragraph', children: [{ type: 'text', text: 'b', marks: [{ type: 'strong' }] }] },
      ]),
      JSON.stringify([
        {
          type: 'text',
          text: JSON.stringify([{ type: 'paragraph', children: [{ type: 'text', text: 'real' }] }]),
        },
      ]),
      JSON.stringify([{ type: 'text', text: '' }]),
      JSON.stringify([{ type: 'image', attrs: { src: 'x' } }]),
      JSON.stringify({ text: 'top-level object' }),
      JSON.stringify(['plain string in array', { deep: [{ deeper: { text: 'leaf' } }] }]),
    ]);
  });
});
