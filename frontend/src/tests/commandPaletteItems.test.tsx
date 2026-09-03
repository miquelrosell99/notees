import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Node } from '@/types';
import { useCommandPaletteItems } from '@/features/layout/components/CommandPalette/useCommandPaletteItems';

function makeNode(uuid: string, name: string, overrides: Partial<Node> = {}): Node {
  return {
    uuid,
    name,
    is_page: false,
    ...overrides,
  } as unknown as Node;
}

function makeParams(overrides: Record<string, unknown> = {}) {
  return {
    rawPages: [] as Array<{ node: Node; breadcrumb?: string }>,
    rawClasses: [] as Node[],
    rawBlocks: [] as Array<{ node: Node; breadcrumb?: string }>,
    rawProperties: [],
    searchTerm: 'task',
    pageNameForCreation: 'task',
    selectedClasses: [] as Node[],
    parsedDate: null,
    existingDateNode: null,
    commands: [],
    pageMap: new Map<string, Node>(),
    recentAccessedPages: [] as Node[],
    recentCreatedPages: [] as Node[],
    randomPages: [] as Node[],
    maxPages: 8,
    maxClasses: 5,
    maxBlocks: 8,
    maxProperties: 5,
    uuidSearch: null,
    appliedFilters: [],
    isTypingBoolean: false,
    booleanOptions: [] as string[],
    suggestedPrefixes: [],
    activeFilter: null,
    formatParsedDateLabel: () => '',
    currentNodeUuid: null,
    showDevOptions: false,
    isTypingColon: false,
    isLoading: false,
    dateFormat: 'YYYY-MM-DD' as const,
    ...overrides,
  };
}

describe('useCommandPaletteItems', () => {
  it('places class results after pages (incl. add-page) and before blocks', () => {
    const page = makeNode('p1', 'Task page', { is_page: true });
    const cls = makeNode('c1', 'Task', { is_class: true });
    const block = makeNode('b1', 'a task block');

    const { result } = renderHook(() =>
      useCommandPaletteItems(
        makeParams({
          rawPages: [{ node: page }],
          rawClasses: [cls],
          rawBlocks: [{ node: block, breadcrumb: 'Task page' }],
        }) as Parameters<typeof useCommandPaletteItems>[0],
      ),
    );

    const types = result.current.map((item) => item.type);
    expect(types).toEqual(['page', 'add-page', 'class', 'block', 'quick-add']);
  });

  it('caps class results at maxClasses and adds a show-more entry', () => {
    const classes = Array.from({ length: 7 }, (_, i) =>
      makeNode(`c${i}`, `Task ${i}`, { is_class: true }),
    );

    const { result } = renderHook(() =>
      useCommandPaletteItems(
        makeParams({ rawClasses: classes }) as Parameters<typeof useCommandPaletteItems>[0],
      ),
    );

    const classItems = result.current.filter((item) => item.type === 'class');
    expect(classItems).toHaveLength(5);

    const showMore = result.current.find(
      (item) => item.type === 'show-more' && item.showMoreSection === 'classes',
    );
    expect(showMore?.showMoreCount).toBe(2);
  });

  it('matches commands by palette keywords, not only by label', () => {
    const cmd = {
      id: 'sync.pullFromServer',
      label: 'Pull from server (replace local copy)',
      context: 'global' as const,
      execute: () => {},
      palette: { category: 'tools' as const, keywords: ['sync', 'reset', 'local'] },
    };

    const { result } = renderHook(() =>
      useCommandPaletteItems(
        makeParams({ searchTerm: 'reset', commands: [cmd] }) as Parameters<
          typeof useCommandPaletteItems
        >[0],
      ),
    );

    expect(result.current.some((item) => item.type === 'command' && item.commandId === cmd.id)).toBe(true);
  });

  it('still matches commands by label', () => {
    const cmd = {
      id: 'sync.pushToServer',
      label: 'Push local changes to server',
      context: 'global' as const,
      execute: () => {},
      palette: { category: 'tools' as const, keywords: ['sync', 'upload'] },
    };

    const { result } = renderHook(() =>
      useCommandPaletteItems(
        makeParams({ searchTerm: 'push', commands: [cmd] }) as Parameters<
          typeof useCommandPaletteItems
        >[0],
      ),
    );

    expect(result.current.some((item) => item.type === 'command' && item.commandId === cmd.id)).toBe(true);
  });

  it('shows no class items when there are no class matches', () => {
    const { result } = renderHook(() =>
      useCommandPaletteItems(makeParams() as Parameters<typeof useCommandPaletteItems>[0]),
    );
    expect(result.current.some((item) => item.type === 'class')).toBe(false);
  });
});
