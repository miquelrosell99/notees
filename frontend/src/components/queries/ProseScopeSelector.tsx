/**
 * ProseScopeSelector Component
 * 
 * Simplified scope selector that hides default scope and shows a collapsed control.
 */

import { useCallback } from 'react';
import { Dropdown } from '../core/Dropdown';
import type { ScopeNode, ScopeType } from '@/types/queryAST';
import './ProseScopeSelector.css';

// ==================== Types ====================

interface ProseScopeSelectorProps {
  scope: ScopeNode;
  onChange: (scope: ScopeNode) => void;
  readOnly?: boolean;
}

// ==================== Main Component ====================

export function ProseScopeSelector({
  scope,
  onChange,
  readOnly = false,
}: ProseScopeSelectorProps) {
  
  // Handle scope type change
  const handleScopeTypeChange = useCallback((newType: string | null) => {
    if (!newType) return;
    const scopeType = newType as ScopeType;
    
    onChange({
      type: 'scope',
      scope_type: scopeType,
      ...(scopeType === 'current_page' && { include_descendants: false }),
    });
  }, [onChange]);
  
  return (
    <div className="prose-scope-selector">
      <span className="prose-scope-selector__label">Search in:</span>
      <Dropdown
        value={scope.scope_type}
        onChange={handleScopeTypeChange}
        disabled={readOnly}
        options={[
          { value: 'entire_graph', label: 'Entire graph' },
          { value: 'current_page', label: 'This page' },
          { value: 'specific_pages', label: 'Selected pages' },
          { value: 'linked_refs', label: 'Nodes that reference this' },
        ]}
        size="sm"
      />
    </div>
  );
}

export default ProseScopeSelector;
