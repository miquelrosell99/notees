import { describe, it, expect } from 'vitest';
import { nodeNameToText } from './useStringifyAST';

describe('nodeNameToText', () => {
  it('stringifies a formal AST document', () => {
    const ast = JSON.stringify([{ type: 'paragraph', children: [{ type: 'text', text: 'Hello world' }] }]);
    expect(nodeNameToText(ast)).toBe('Hello world');
  });

  it('falls back to bare inline text nodes at document level', () => {
    const ast = JSON.stringify([{ type: 'text', text: '20260805' }]);
    expect(nodeNameToText(ast)).toBe('20260805');
  });

  it('returns plain text names that look like compact numeric dates', () => {
    expect(nodeNameToText('20260805')).toBe('20260805');
    expect(nodeNameToText('20260800')).toBe('20260800');
    expect(nodeNameToText('20260000')).toBe('20260000');
  });

  it('returns plain text names such as "Inbox"', () => {
    expect(nodeNameToText('Inbox')).toBe('Inbox');
  });

  it('returns empty string for genuinely empty content', () => {
    expect(nodeNameToText('')).toBe('');
    expect(nodeNameToText('[]')).toBe('');
  });

  it('does not treat JSON arrays/objects as display text', () => {
    expect(nodeNameToText('[{"type":"query"}]')).toBe('');
    expect(nodeNameToText('{"foo":"bar"}')).toBe('');
  });

  it('respects maxLength', () => {
    expect(nodeNameToText('20260805', 4)).toBe('2026');
    expect(nodeNameToText([{ type: 'text', text: '20260805' }], 4)).toBe('2026');
  });

  it('does not render an unresolved node_link as "…"', () => {
    const targetId = '00000000-0000-0000-0000-000000000001';
    const ast = JSON.stringify([
      { type: 'paragraph', children: [{ type: 'node_link', link_id: targetId, ref_type: 'node' }] },
    ]);
    expect(nodeNameToText(ast)).not.toBe('…');
    expect(nodeNameToText(ast)).toBe(targetId);
  });

  it('unwraps CRDT-wrapped AST instead of returning raw JSON', () => {
    const targetId = '00000000-0000-0000-0000-000000000002';
    const innerAst = JSON.stringify([
      { type: 'paragraph', children: [{ type: 'node_link', link_id: targetId, ref_type: 'node' }] },
    ]);
    const wrapped = JSON.stringify([{ type: 'text', text: innerAst }]);
    expect(nodeNameToText(wrapped)).not.toContain('type');
    expect(nodeNameToText(wrapped)).toBe(targetId);
  });
});
