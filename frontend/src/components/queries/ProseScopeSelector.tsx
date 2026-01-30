/**
 * ProseScopeSelector Component
 * 
 * SelectionButton for choosing between entire graph (global) or this page (local).
 * Uses mdi icons to signal scope.
 */

import { useCallback } from 'react';
import { SelectionButton } from '../core/SelectionButton';
import { mdiWeb, mdiFileDocumentOutline } from '@mdi/js';
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
  const handleScopeTypeChange = useCallback((scopeType: string) => {
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
      <SelectionButton
        value={scope.scope_type}
        onChange={handleScopeTypeChange}
        disabled={readOnly}
        options={[
          { value: 'entire_graph', icon: mdiWeb, label: 'Entire graph' },
          { value: 'current_page', icon: mdiFileDocumentOutline, label: 'This page' },
        ]}
        size="sm"
      />
    </span>
  );
}

export default ProseScopeSelector;
