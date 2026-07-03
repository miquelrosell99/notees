import { describe, it, expect } from 'vitest';
import { compareDateFirstAlpha, sortDateFirstAlpha } from './nodeSort';
import type { Node } from '@/types';

function makeNode(overrides: Partial<Node> & { uuid: string; name: string }): Node {
  return {
    icon: null,
    color: null,
    parent_uuid: null,
    page_uuid: null,
    sequence: 0,
    active: true,
    is_page: true,
    create_date: '2024-01-01T00:00:00Z',
    write_date: '2024-01-01T00:00:00Z',
    ...overrides,
  } as Node;
}

describe('compareDateFirstAlpha', () => {
  it('sorts date pages before non-date pages', () => {
    const daily = makeNode({
      uuid: '00000000-0000-0000-00dd-202401150000',
      name: '2024-01-15',
      is_daily: true,
    });
    const alpha = makeNode({ uuid: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', name: 'Apple' });

    expect(compareDateFirstAlpha(daily, alpha)).toBeLessThan(0);
    expect(compareDateFirstAlpha(alpha, daily)).toBeGreaterThan(0);
  });

  it('sorts date pages with the most recent date first', () => {
    const jan15 = makeNode({
      uuid: '00000000-0000-0000-00dd-202401150000',
      name: '2024-01-15',
      is_daily: true,
    });
    const jan20 = makeNode({
      uuid: '00000000-0000-0000-00dd-202401200000',
      name: '2024-01-20',
      is_daily: true,
    });
    const feb1 = makeNode({
      uuid: '00000000-0000-0000-00dd-202402010000',
      name: '2024-02-01',
      is_daily: true,
    });

    const sorted = [jan15, feb1, jan20].sort(compareDateFirstAlpha);
    expect(sorted.map((n) => n.name)).toEqual(['2024-02-01', '2024-01-20', '2024-01-15']);
  });

  it('sorts month and year date pages alongside day pages', () => {
    const year2024 = makeNode({
      uuid: '00000000-0000-0000-00bb-202400000000',
      name: '2024',
      is_yearly: true,
    });
    const jan2024 = makeNode({
      uuid: '00000000-0000-0000-00aa-202401000000',
      name: '2024-01',
      is_monthly: true,
    });
    const jan15 = makeNode({
      uuid: '00000000-0000-0000-00dd-202401150000',
      name: '2024-01-15',
      is_daily: true,
    });

    const sorted = [jan15, year2024, jan2024].sort(compareDateFirstAlpha);
    expect(sorted.map((n) => n.name)).toEqual(['2024-01-15', '2024-01', '2024']);
  });

  it('sorts non-date pages alphabetically (case-insensitive)', () => {
    const apple = makeNode({ uuid: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', name: 'Apple' });
    const banana = makeNode({ uuid: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', name: 'banana' });
    const carrot = makeNode({ uuid: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', name: 'Carrot' });

    const sorted = [carrot, apple, banana].sort(compareDateFirstAlpha);
    expect(sorted.map((n) => n.name)).toEqual(['Apple', 'banana', 'Carrot']);
  });

  it('matches the Logseq ordering: newest date first, then alphabetically', () => {
    const apple = makeNode({ uuid: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', name: 'Apple' });
    const jan10 = makeNode({
      uuid: '00000000-0000-0000-00dd-202401100000',
      name: '2024-01-10',
      is_daily: true,
    });
    const jan20 = makeNode({
      uuid: '00000000-0000-0000-00dd-202401200000',
      name: '2024-01-20',
      is_daily: true,
    });
    const zebra = makeNode({ uuid: 'z0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', name: 'Zebra' });

    const sorted = [zebra, jan10, apple, jan20].sort(compareDateFirstAlpha);
    expect(sorted.map((n) => n.name)).toEqual(['2024-01-20', '2024-01-10', 'Apple', 'Zebra']);
  });
});

describe('sortDateFirstAlpha', () => {
  it('returns a new array sorted without mutating the input', () => {
    const a = makeNode({ uuid: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', name: 'A' });
    const b = makeNode({
      uuid: '00000000-0000-0000-00dd-202401010000',
      name: '2024-01-01',
      is_daily: true,
    });
    const input = [a, b];
    const sorted = sortDateFirstAlpha(input);

    expect(sorted).not.toBe(input);
    expect(sorted.map((n) => n.name)).toEqual(['2024-01-01', 'A']);
    expect(input.map((n) => n.name)).toEqual(['A', '2024-01-01']);
  });
});
