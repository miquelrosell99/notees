/**
 * ScopeSelector Component
 * 
 * Native UI component for selecting query scope.
 * Replaces the conversion-layer approach with direct AST manipulation.
 * 
 * Scope Types:
 * - entire_graph: All nodes in the graph
 * - current_page: Nodes on the current page (with optional child blocks)
 */
import { useCallback, useMemo } from 'react';
import { mdiFileDocumentMultiple, mdiFile } from '@mdi/js';
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

    // Preserve include_descendants for current_page
    if (scopeType === 'current_page' && scope.include_descendants !== undefined) {
      newScope.include_descendants = scope.include_descendants;
    }

    onChange(newScope);
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
    return scope.scope_type === 'current_page';
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
            Search within the page's block content, not just the page itself
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
    
    default:
      return 'Unknown scope type';
  }
}
