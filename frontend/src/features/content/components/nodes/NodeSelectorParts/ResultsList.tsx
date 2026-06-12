import { Spinner } from '@/components/ui/Spinner';
import { Checkbox } from '@/components/ui/Checkbox';
import { AddIcon } from '@/components/ui/icons';
import { NodeResultItem } from '../NodeResultItem';
import type { Node } from '@/types';
import type { FilterPrefixConfig } from '@/utils/searchFilters';

export type FilterSuggestionItem =
  | { type: 'class'; node: Node }
  | { type: 'boolean'; prefix: string; label: string; value: boolean }
  | { type: 'prefix'; config: FilterPrefixConfig };

export type ResultsListMode = 'single' | 'multi' | 'search';

interface ResultsListProps {
  mode: ResultsListMode;
  items: Node[];
  filterSuggestions: FilterSuggestionItem[];
  assignedIds: Set<number>;
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
  isLoading: boolean;
  searchQuery: string;
  showCreateOption?: boolean;
  showMoreOption?: boolean;
  convertCandidates?: Node[];
  buildParentPath: (node: Node) => string;
  buildBlockParentPath: (node: Node) => string;
  getDisplayClasses: (node: Node) => Array<{ id: number; name: string }>;
  allClasses: Node[];
  onAdd: (node: Node) => void;
  onToggle?: (node: Node) => void;
  onAddClassFilter: (node: Node) => void;
  onAddBooleanFilter: (prefix: string, label: string, value: boolean) => void;
  onPrefixSelect: (prefix: string) => void;
  onCreateNew: () => void;
  onShowMore: () => void;
  onConvertToClass?: (node: Node) => void;
  onClosePicker?: () => void;
  createIconSize?: 'sm' | 'xs';
  emptyClassName?: string;
}

export function ResultsList({
  mode,
  items,
  filterSuggestions,
  assignedIds,
  selectedIndex,
  setSelectedIndex,
  isLoading,
  searchQuery,
  showCreateOption,
  showMoreOption,
  convertCandidates = [],
  buildParentPath,
  buildBlockParentPath,
  getDisplayClasses,
  allClasses,
  onAdd,
  onToggle,
  onAddClassFilter,
  onAddBooleanFilter,
  onPrefixSelect,
  onCreateNew,
  onShowMore,
  onConvertToClass,
  onClosePicker,
  createIconSize = 'sm',
  emptyClassName = 'node-selector__empty',
}: ResultsListProps) {
  const showCreate = showCreateOption ?? false;
  const showMore = showMoreOption ?? false;

  const hasContent =
    filterSuggestions.length > 0 ||
    items.length > 0 ||
    convertCandidates.length > 0 ||
    showCreate;

  if (isLoading && searchQuery.length > 0) {
    return (
      <div className="node-selector__loading">
        <Spinner size="sm" label="Searching..." />
      </div>
    );
  }

  if (!hasContent) {
    return (
      <div className={emptyClassName}>
        {searchQuery ? 'No matches found' : 'Start typing to search'}
      </div>
    );
  }

  const createIndex = filterSuggestions.length + items.length + convertCandidates.length;
  const showMoreIndex = createIndex + (showCreate ? 1 : 0);

  return (
    <>
      {filterSuggestions.map((item, index) => {
        const isHighlighted = index === selectedIndex;
        if (item.type === 'class') {
          return (
            <NodeResultItem
              key={`filter-class-${item.node.id}`}
              node={item.node}
              isHighlighted={isHighlighted}
              onClick={() => onAddClassFilter(item.node)}
              onMouseEnter={() => setSelectedIndex(index)}
              className="node-result-item--filter-suggestion"
              iconOverride={<span className="node-selector__filter-prefix">class:</span>}
            />
          );
        }
        return (
          <button
            key={`filter-${item.type}-${item.type === 'boolean' ? item.prefix : item.config.prefix}`}
            className={`node-selector__filter-suggestion ${isHighlighted ? 'node-selector__filter-suggestion--highlighted' : ''}`}
            onClick={() =>
              item.type === 'boolean'
                ? onAddBooleanFilter(item.prefix, item.label, item.value)
                : onPrefixSelect(item.config.prefix)
            }
            onMouseEnter={() => setSelectedIndex(index)}
          >
            <span className="node-selector__filter-prefix">
              {item.type === 'boolean' ? `${item.prefix}:` : item.config.label}
            </span>
            <span className="node-selector__filter-value">
              {item.type === 'boolean' ? (item.value ? 'true' : 'false') : item.config.description}
            </span>
          </button>
        );
      })}

      {items.map((node, index) => {
        const globalIndex = filterSuggestions.length + index;
        const isAssigned = assignedIds.has(node.id);
        return (
          <NodeResultItem
            key={node.id}
            node={node}
            parentPath={node.is_page ? buildParentPath(node) : buildBlockParentPath(node)}
            displayClasses={getDisplayClasses(node)}
            isHighlighted={globalIndex === selectedIndex}
            isSelected={mode === 'single' ? isAssigned : undefined}
            onClick={() => (mode === 'multi' && onToggle ? onToggle(node) : onAdd(node))}
            onMouseEnter={() => setSelectedIndex(globalIndex)}
            allClasses={allClasses}
            after={
              mode === 'multi' && onToggle ? (
                <Checkbox
                  size="sm"
                  checked={isAssigned}
                  onChange={() => onToggle(node)}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : undefined
            }
          />
        );
      })}

      {convertCandidates.length > 0 && (
        <>
          <div className="node-selector__section-label">Convert to class</div>
          {convertCandidates.map((node, index) => {
            const idx = filterSuggestions.length + items.length + index;
            return (
              <NodeResultItem
                key={`convert-${node.id}`}
                node={node}
                parentPath={buildParentPath(node)}
                displayClasses={getDisplayClasses(node)}
                isHighlighted={idx === selectedIndex}
                onClick={() => {
                  onConvertToClass?.(node);
                  onClosePicker?.();
                }}
                onMouseEnter={() => setSelectedIndex(idx)}
                allClasses={allClasses}
                className="node-result-item--convert"
              />
            );
          })}
        </>
      )}

      {showCreate && (
        <NodeResultItem
          key="__create"
          node={{ name: `Create "${searchQuery.trim()}"` } as Node}
          isHighlighted={selectedIndex === createIndex}
          onClick={onCreateNew}
          onMouseEnter={() => setSelectedIndex(createIndex)}
          className="node-result-item--create"
          iconOverride={<AddIcon size={createIconSize} />}
        />
      )}

      {showMore && (
        <button
          className={`node-selector__show-more ${selectedIndex === showMoreIndex ? 'node-selector__show-more--highlighted' : ''}`}
          onClick={onShowMore}
          onMouseEnter={() => setSelectedIndex(showMoreIndex)}
        >
          Show more results
        </button>
      )}
    </>
  );
}
