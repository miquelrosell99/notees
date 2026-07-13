import { describe, it, expect } from 'vitest';
import { composeMenuItems, type ComposableMenuItem } from './composeMenuItems';

function item(
  id: string,
  group?: ComposableMenuItem['group'],
  order?: number,
): ComposableMenuItem {
  return { id, label: id, group, order };
}

describe('composeMenuItems', () => {
  it('returns a single section without separators', () => {
    const result = composeMenuItems([item('a', 'main', 0), item('b', 'main', 1)]);
    expect(result.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('renders sections in canonical order with separators between non-empty sections', () => {
    const result = composeMenuItems([
      item('delete', 'danger', 0),
      item('copy-link', 'copy', 0),
      item('open', 'main', 0),
      item('export', 'export', 0),
    ]);
    expect(result.map((i) => i.id)).toEqual([
      'open',
      'sep-copy',
      'copy-link',
      'sep-export',
      'export',
      'sep-danger',
      'delete',
    ]);
  });

  it('sorts within a section by order, keeping insertion order on ties', () => {
    const result = composeMenuItems([
      item('c', 'main', 5),
      item('a', 'main', 1),
      item('b', 'main', 1),
    ]);
    expect(result.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('skips empty sections instead of emitting dangling separators', () => {
    const result = composeMenuItems([item('open', 'main', 0), item('delete', 'danger', 1)]);
    expect(result.map((i) => i.id)).toEqual(['open', 'sep-danger', 'delete']);
  });

  it('falls back to main for missing or unknown groups', () => {
    const result = composeMenuItems([
      item('x', undefined, 1),
      item('y', 'bogus' as unknown as ComposableMenuItem['group'], 0),
      item('z', 'danger', 0),
    ]);
    expect(result.map((i) => i.id)).toEqual(['y', 'x', 'sep-danger', 'z']);
  });

  it('defaults a missing order to 0', () => {
    const result = composeMenuItems([item('b', 'main', 3), item('a', 'main')]);
    expect(result.map((i) => i.id)).toEqual(['a', 'b']);
  });
});
