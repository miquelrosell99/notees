/**
 * ProseScopeSelector Component
 * 
 * Inline sentence-style scope selector.
 * Renders as prose: "[Entire graph ▼]" with optional checkbox.
 * Hidden entirely when scope = default ("Entire graph").
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
  const handleScopeTypeChange = useCallback((scopeType: string | null) => {
    if (!scopeType) return;
    onChange({
      ...scope,
      scope_type: scopeType as ScopeType,
      // Reset scope-specific fields when changing type
      page_uuids: undefined,
      include_descendants: undefined,
      excluded_page_uuids: undefined,
    });
  }, [scope, onChange]);
  
  return (
    <span className="prose-scope-selector">
      <Dropdown
        value={scope.scope_type}
        onChange={handleScopeTypeChange}
        disabled={readOnly}
        options={[
          { value: 'entire_graph', label: 'Entire graph' },
          { value: 'current_page', label: 'This page' },
          { value: 'specific_pages', label: 'Selected pages' },
          { value: 'linked_refs', label: 'Linked references' },
        ]}
        size="sm"
        className="prose-scope-selector__dropdown"
      />
      
      {/* Include descendants checkbox for current_page */}
      {scope.scope_type === 'current_page' && (
        <label className="prose-scope-selector__checkbox">
          <input
            type="checkbox"
            checked={scope.include_descendants || false}
            onChange={(e) => onChange({ ...scope, include_descendants: e.target.checked })}
            disabled={readOnly}
          />
          <span>Include child blocks</span>
        </label>
      )}
      
      {/* Page count indicator for specific_pages */}
      {scope.scope_type === 'specific_pages' && (
        <span className="prose-scope-selector__count">
          ({scope.page_uuids?.length || 0} page{(scope.page_uuids?.length || 0) === 1 ? '' : 's'} selected)
        </span>
      )}
    </span>
  );
}

export default ProseScopeSelector;
