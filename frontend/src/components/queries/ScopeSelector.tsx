/**
 * ScopeSelector Component
 * 
 * Native UI component for selecting query scope.
 * Replaces the conversion-layer approach with direct AST manipulation.
 * 
 * Scope Types:
 * - entire_graph: All nodes in the graph
 * - current_page: Nodes on the current page
 * - specific_pages: Explicitly selected pages
 * - linked_refs: Nodes that reference the current page
 */
import { useCallback, useMemo } from 'react';
import { mdiFileDocumentMultiple, mdiFile, mdiFileTree, mdiLink } from '@mdi/js';
import { Button } from '../core/Button';
import { SelectionButton } from '../core/SelectionButton';
import type { ScopeNode, ScopeType } from '@/types/queryAST';
import './ScopeSelector.css';

// ==================== Types ====================

interface ScopeSelectorProps {
  /** Current scope configuration */
  scope: ScopeNode;
  /** Callback when scope changes */
  onChange: (scope: ScopeNode) => void;
  /** Whether the selector is read-only */
  readOnly?: boolean;
  /** Additional CSS class */
  className?: string;
}

// ==================== Constants ====================

const SCOPE_OPTIONS = [
  { label: 'All Nodes', value: 'entire_graph' as ScopeType, icon: mdiFileDocumentMultiple },
  { label: 'Current Page', value: 'current_page' as ScopeType, icon: mdiFile },
  { label: 'Specific Pages', value: 'specific_pages' as ScopeType, icon: mdiFileTree },
  { label: 'Linked References', value: 'linked_refs' as ScopeType, icon: mdiLink },
];

// ==================== Main Component ====================

export function ScopeSelector({
  scope,
  onChange,
  readOnly = false,
  className = '',
}: ScopeSelectorProps) {

  // Handle scope type change
  const handleScopeTypeChange = useCallback((newType: string) => {
    const scopeType = newType as ScopeType;
    
    // Create new scope node with appropriate defaults
    const newScope: ScopeNode = {
      type: 'scope',
      scope_type: scopeType,
    };

    // Preserve page_uuids if switching to/from specific_pages
    if (scopeType === 'specific_pages' && scope.page_uuids) {
      newScope.page_uuids = scope.page_uuids;
    }

    // Preserve include_descendants if relevant
    if ((scopeType === 'specific_pages' || scopeType === 'current_page') && scope.include_descendants !== undefined) {
      newScope.include_descendants = scope.include_descendants;
    }

    onChange(newScope);
  }, [scope, onChange]);

  // Handle page removal
  const handlePageRemove = useCallback((uuid: string) => {
    if (!scope.page_uuids) return;
    
    const newUuids = scope.page_uuids.filter(id => id !== uuid);
    onChange({
      ...scope,
      page_uuids: newUuids.length > 0 ? newUuids : undefined,
    });
  }, [scope, onChange]);

  // Handle descendants toggle
  const handleDescendantsToggle = useCallback(() => {
    onChange({
      ...scope,
      include_descendants: !scope.include_descendants,
    });
  }, [scope, onChange]);

  // Whether descendants option is relevant
  const showDescendantsOption = useMemo(() => {
    return scope.scope_type === 'specific_pages' || scope.scope_type === 'current_page';
  }, [scope.scope_type]);

  // Whether to show page picker UI
  const showPageSelection = useMemo(() => {
    return scope.scope_type === 'specific_pages';
  }, [scope.scope_type]);

  return (
    <div className={`scope-selector ${className}`}>
      {/* Scope Type Selection */}
      <div className="scope-selector__type">
        <label className="scope-selector__label">Query Scope</label>
        <SelectionButton
          options={SCOPE_OPTIONS}
          value={scope.scope_type}
          onChange={handleScopeTypeChange}
          disabled={readOnly}
        />
      </div>

      {/* Page Selection (for specific_pages scope) */}
      {showPageSelection && (
        <div className="scope-selector__pages">
          <label className="scope-selector__label">Selected Pages</label>
          
          {/* Selected pages list */}
          {scope.page_uuids && scope.page_uuids.length > 0 && (
            <div className="scope-selector__pages-list">
              {scope.page_uuids.map(uuid => (
                <div key={uuid} className="scope-selector__page-item">
                  <span>{uuid}</span>
                  {!readOnly && (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => handlePageRemove(uuid)}
                    >
                      ×
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Simplified: No page picker for now */}
          {(!scope.page_uuids || scope.page_uuids.length === 0) && (
            <div className="scope-selector__empty">
              No pages selected.
            </div>
          )}
        </div>
      )}

      {/* Include Descendants Option */}
      {showDescendantsOption && (
        <div className="scope-selector__descendants">
          <label className="scope-selector__checkbox">
            <input
              type="checkbox"
              checked={scope.include_descendants || false}
              onChange={handleDescendantsToggle}
              disabled={readOnly}
            />
            <span>Include child blocks</span>
          </label>
          <div className="scope-selector__help-text">
            Search within block content, not just page titles
          </div>
        </div>
      )}

      {/* Scope Description */}
      <div className="scope-selector__description">
        {getScopeDescription(scope)}
      </div>
    </div>
  );
}

// ==================== Helper Functions ====================

function getScopeDescription(scope: ScopeNode): string {
  switch (scope.scope_type) {
    case 'entire_graph':
      return 'All nodes in the graph';
    
    case 'current_page':
      if (scope.include_descendants) {
        return 'Current page + all child blocks';
      }
      return 'Current page only';
    
    case 'specific_pages':
      const pageCount = scope.page_uuids?.length || 0;
      if (pageCount === 0) {
        return 'No pages selected';
      }
      const suffix = scope.include_descendants ? ' + child blocks' : ' only';
      return `${pageCount} page${pageCount > 1 ? 's' : ''}${suffix}`;
    
    case 'linked_refs':
      return 'Nodes that link to current page';
    
    default:
      return 'Unknown scope type.';
  }
}
