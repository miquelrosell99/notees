import { Button } from '@/components/ui/Button';
import { nodeNameToText } from '@/features/queries/hooks/useStringifyAST';
import type { AppliedFilter } from '@/utils/searchFilters';

interface FilterPillsProps {
  filters: AppliedFilter[];
  onRemove: (index: number) => void;
}

export function FilterPills({ filters, onRemove }: FilterPillsProps) {
  if (filters.length === 0) return null;

  return (
    <div className="node-selector__filter-pills">
      {filters.map((filter, fi) => (
        <span key={`${filter.type}-${fi}`} className="node-selector__filter-pill">
          {filter.type === 'class' ? (
            <>
              <span className="node-selector__filter-pill-label">class:</span>
              <span>{nodeNameToText(filter.classNode.name)}</span>
            </>
          ) : (
            <>
              <span className="node-selector__filter-pill-label">{filter.prefix}:</span>
              <span>{filter.value ? 'true' : 'false'}</span>
            </>
          )}
          <Button
            variant="ghost"
            size="xs"
            icon="mdi mdi-close"
            className="node-selector__filter-pill-remove"
            onClick={() => onRemove(fi)}
            aria-label="Remove filter"
          />
        </span>
      ))}
    </div>
  );
}
