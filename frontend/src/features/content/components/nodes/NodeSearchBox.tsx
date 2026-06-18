/**
 * NodeSearchBox — feature wrapper around the controlled SearchBox
 *
 * Wires Notees node search hooks and provides a default renderer for Node
 * results. Custom search functions/renderers are still supported for property
 * and class pickers.
 */
import { useState, useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SearchBox } from '@/components/ui';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useSearch } from '@/features/content';
import { nodeNameToText } from '@/features/queries';
import { NodeIcon } from '@/components/ui/icons';
import type { Node } from '@/types';
import { searchKeys } from '@/hooks/queryKeys';


export interface NodeSearchBoxProps<T = Node> {
  placeholder?: string;
  className?: string;
  onSelect: (item: T) => void;
  /** Custom search function. When omitted, the default node search hook is used. */
  searchFn?: (query: string) => Promise<T[]> | T[];
  /** Custom key extractor */
  getKey?: (item: T) => string | number;
  /** Custom renderer for result items */
  renderItem?: (item: T) => ReactNode;
  /** Filter applied to the fetched results */
  filterFn?: (item: T) => boolean;
  /** Initial query value */
  initialQuery?: string;
  /** Focus the input on mount */
  focusOnMount?: boolean;
  /** Show create option for new items */
  showCreate?: boolean;
  /** Called when create is selected (passes the query string) */
  onCreate?: (query: string) => void;
  /** Debounce delay for the search query in milliseconds */
  debounceMs?: number;
}

const defaultGetKey = <T,>(item: T): string | number => {
  if (typeof item === 'object' && item !== null) {
    const record = item as Record<string, unknown>;
    if ('id' in record) return record.id as string | number;
    if ('name' in record) return record.name as string | number;
    if ('uuid' in record) return record.uuid as string | number;
  }
  return String(item);
};

const defaultRenderNode = (node: Node): ReactNode => (
  <>
    <span className="result-icon">
      <NodeIcon icon={node.icon} isPage={true} />
    </span>
    <span className="result-title">
      {nodeNameToText(node.name) || 'Untitled'}
    </span>
  </>
);

export function NodeSearchBox<T = Node>({
  placeholder = 'Search...',
  className = '',
  onSelect,
  searchFn,
  getKey,
  renderItem,
  filterFn,
  initialQuery = '',
  focusOnMount = false,
  showCreate = false,
  onCreate,
  debounceMs = 300,
}: NodeSearchBoxProps<T>) {
  const [query, setQuery] = useState(initialQuery);
  const debouncedQuery = useDebouncedValue(query, debounceMs);

  const defaultSearch = useSearch(debouncedQuery);
  const customSearch = useQuery({
    queryKey: searchKeys.nodeSearchBox(debouncedQuery),
    queryFn: () => searchFn!(debouncedQuery),
    enabled: !!searchFn && debouncedQuery.length > 0,
  });

  const rawResults = searchFn ? customSearch.data : defaultSearch.data;
  const isLoading = searchFn ? customSearch.isLoading : defaultSearch.isLoading;

  const results = useMemo(() => {
    const items = (rawResults || []) as T[];
    return filterFn ? items.filter(filterFn) : items;
  }, [rawResults, filterFn]);

  const effectiveGetKey = getKey ?? defaultGetKey;

  const effectiveRenderItem = renderItem ?? ((item: T) => {
    const node = item as unknown as Node;
    if ('name' in node) {
      return defaultRenderNode(node);
    }
    return <span>{String(item)}</span>;
  });

  return (
    <SearchBox<T>
      query={query}
      onQueryChange={setQuery}
      results={results}
      isLoading={isLoading}
      renderItem={effectiveRenderItem}
      getKey={effectiveGetKey}
      onSelect={onSelect}
      placeholder={placeholder}
      className={className}
      focusOnMount={focusOnMount}
      showCreate={showCreate}
      onCreate={onCreate}
    />
  );
}
