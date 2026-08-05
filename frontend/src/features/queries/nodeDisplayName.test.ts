import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { nodeNameToDisplayText, useNodeDisplayName } from './nodeDisplayName';
import type { Node } from '@/types';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';

const mockDateFormat = vi.hoisted(() => vi.fn().mockReturnValue('YYYY/MM/DD'));

vi.mock('@/stores', () => ({
  useSettingsStore: Object.assign(
    (selector: (s: { dateFormat: string }) => unknown) => selector({ dateFormat: mockDateFormat() }),
    { getState: () => ({ dateFormat: mockDateFormat() }) },
  ),
  formatDate: (date: Date, format: string) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return format === 'YYYY/MM/DD'
      ? `${y}/${m}/${d}`
      : format === 'YYYY-MM-DD'
        ? `${y}-${m}-${d}`
        : `${d}/${m}/${y}`;
  },
  formatMonth: (year: number, month: number, format: string) => {
    const m = String(month).padStart(2, '0');
    const sep = format.includes('/') ? '/' : '-';
    return format.startsWith('YYYY')
      ? `${year}${sep}${m}`
      : `${m}${sep}${year}`;
  },
  formatYear: (year: number) => String(year),
}));

function makeNode(overrides: Partial<Node> & { classes_uuid?: string[] } = {}): Node {
  return {
    uuid: 'node-uuid',
    name: '',
    is_page: true,
    classes_uuid: [],
    ...overrides,
  } as Node;
}

beforeEach(() => {
  mockDateFormat.mockReturnValue('YYYY/MM/DD');
});

describe('nodeNameToDisplayText', () => {
  it('formats a day-class node as YYYY/MM/DD', () => {
    const node = makeNode({
      name: '20260805',
      classes_uuid: [SYSTEM_CLASS_UUIDS.day],
    });
    expect(nodeNameToDisplayText(node)).toBe('2026/08/05');
  });

  it('formats a month-class node as YYYY/MM', () => {
    const node = makeNode({
      name: '20260800',
      classes_uuid: [SYSTEM_CLASS_UUIDS.month],
    });
    expect(nodeNameToDisplayText(node)).toBe('2026/08');
  });

  it('formats a year-class node as YYYY', () => {
    const node = makeNode({
      name: '20260000',
      classes_uuid: [SYSTEM_CLASS_UUIDS.year],
    });
    expect(nodeNameToDisplayText(node)).toBe('2026');
  });

  it('respects the dateFormat preference for day-class nodes', () => {
    mockDateFormat.mockReturnValue('DD/MM/YYYY');
    const node = makeNode({
      name: '20260805',
      classes_uuid: [SYSTEM_CLASS_UUIDS.day],
    });
    expect(nodeNameToDisplayText(node)).toBe('05/08/2026');
  });

  it('respects the dateFormat preference for month-class nodes', () => {
    mockDateFormat.mockReturnValue('MM-YYYY');
    const node = makeNode({
      name: '20260800',
      classes_uuid: [SYSTEM_CLASS_UUIDS.month],
    });
    expect(nodeNameToDisplayText(node)).toBe('08-2026');
  });

  it('does not format a non-date page with a numeric-looking name', () => {
    const node = makeNode({
      name: '20260805',
      classes_uuid: [SYSTEM_CLASS_UUIDS.page],
    });
    expect(nodeNameToDisplayText(node)).toBe('20260805');
  });

  it('returns empty string for a missing node', () => {
    expect(nodeNameToDisplayText(undefined)).toBe('');
    expect(nodeNameToDisplayText(null)).toBe('');
  });

  it('returns empty string for an empty name', () => {
    const node = makeNode({ name: '', classes_uuid: [SYSTEM_CLASS_UUIDS.day] });
    expect(nodeNameToDisplayText(node)).toBe('');
  });

  it('respects maxLength', () => {
    const node = makeNode({
      name: '20260805',
      classes_uuid: [SYSTEM_CLASS_UUIDS.day],
    });
    expect(nodeNameToDisplayText(node, { maxLength: 4 })).toBe('2026');
  });
});

describe('useNodeDisplayName', () => {
  it('returns the formatted display name for a date node', () => {
    const node = makeNode({
      name: '20260805',
      classes_uuid: [SYSTEM_CLASS_UUIDS.day],
    });
    const { result } = renderHook(() => useNodeDisplayName(node));
    expect(result.current).toBe('2026/08/05');
  });

  it('reacts to dateFormat changes', () => {
    const node = makeNode({
      name: '20260805',
      classes_uuid: [SYSTEM_CLASS_UUIDS.day],
    });
    const { result, rerender } = renderHook(() => useNodeDisplayName(node));
    expect(result.current).toBe('2026/08/05');

    mockDateFormat.mockReturnValue('DD/MM/YYYY');
    rerender();
    expect(result.current).toBe('05/08/2026');
  });

  it('returns the fallback for a missing node', () => {
    const { result } = renderHook(() => useNodeDisplayName(null));
    expect(result.current).toBe('Untitled');
  });

  it('returns a custom fallback when provided', () => {
    const { result } = renderHook(() => useNodeDisplayName(null, 'None'));
    expect(result.current).toBe('None');
  });
});
