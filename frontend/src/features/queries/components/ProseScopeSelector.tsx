/**
 * ProseScopeSelector Component
 * 
 * SelectionButton for choosing between entire workspace (global) or this page (local).
 * Uses mdi icons to signal scope.
 */

import { useCallback } from 'react';
import { SelectionButton } from '@/components/ui/SelectionButton';
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
      type: 'scope',
      scope_type: scopeType as ScopeType,
    });
  }, [onChange]);
  
  return (
    <span className="prose-scope-selector">
      <SelectionButton
        value={scope.scope_type}
        onChange={handleScopeTypeChange}
        disabled={readOnly}
        options={[
          { value: 'entire_workspace', icon: "mdi mdi-web", label: 'All nodes' },
          { value: 'pages', icon: "mdi mdi-file-multiple", label: 'All pages' },
          { value: 'current_page', icon: "mdi mdi-file-document-outline", label: 'Current page' },
        ]}
        size="sm"
      />
    </span>
  );
}

