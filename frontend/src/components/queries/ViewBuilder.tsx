/**
 * ViewBuilder Component
 * 
 * Intent-first UI for defining views as "saved questions".
 * Hides engine-level details and presents QueryAST as natural language prose.
 * 
 * Design principles:
 * - No SQL, AND/OR warnings, or redundancy messages in normal mode
 * - Single-column layout with whitespace over borders
 * - Progressive disclosure: Intent → Logic → Engine (debug only)
 * - Auto-normalize AST on every change
 */

import { useCallback, useState, useMemo } from 'react';
import { mdiChevronDown, mdiChevronUp } from '@mdi/js';
import Icon from '@mdi/react';
import { normalizeAST } from '@/lib/astNormalizer';
import { getQueryLabel } from '@/lib/astProseRenderer';
import { ProseConditionBuilder } from './ProseConditionBuilder';
import { ProseScopeSelector } from './ProseScopeSelector';
import { AdvancedLogicPanel } from './AdvancedLogicPanel';
import type { QueryAST } from '@/types/queryAST';
import './ViewBuilder.css';

// ==================== Types ====================

interface ViewBuilderProps {
  /** The query AST to edit */
  ast: QueryAST;
  /** Callback when AST changes */
  onChange: (ast: QueryAST) => void;
  /** Number of nodes that match this query (for preview) */
  resultCount?: number;
  /** Whether currently loading results */
  isLoading?: boolean;
  /** Whether the builder is read-only */
  readOnly?: boolean;
  /** Additional CSS class */
  className?: string;
}

// ==================== Main Component ====================

export function ViewBuilder({
  ast,
  onChange,
  resultCount = 0,
  isLoading = false,
  readOnly = false,
  className = '',
}: ViewBuilderProps) {
  
  const [showAdvanced, setShowAdvanced] = useState(false);
  
  // Auto-normalize AST on every change
  const handleChange = useCallback((updatedAST: QueryAST) => {
    const normalized = normalizeAST(updatedAST);
    onChange(normalized);
  }, [onChange]);
  
  // Handle scope changes
  const handleScopeChange = useCallback((scope: typeof ast.scope) => {
    handleChange({
      ...ast,
      scope,
    });
  }, [ast, handleChange]);
  
  // Handle root group changes
  const handleRootGroupChange = useCallback((rootGroup: typeof ast.root_group) => {
    handleChange({
      ...ast,
      root_group: rootGroup,
    });
  }, [ast, handleChange]);
  
  // Generate intent label
  const intentLabel = useMemo(() => getQueryLabel(ast), [ast]);
  
  // Check if scope is default (should hide UI)
  const isDefaultScope = ast.scope.scope_type === 'entire_graph';
  
  // Check if query has conditions
  const hasConditions = ast.root_group.children.length > 0;
  
  return (
    <div className={`view-builder ${className}`}>
      {/* Intent Header */}
      <div className="view-builder__intent">
        <h3 className="view-builder__intent-label">This view shows:</h3>
        <p className="view-builder__intent-text">{intentLabel}</p>
      </div>
      
      {/* Scope Section - Hidden by default */}
      {!isDefaultScope && (
        <div className="view-builder__scope">
          <ProseScopeSelector
            scope={ast.scope}
            onChange={handleScopeChange}
            readOnly={readOnly}
          />
        </div>
      )}
      
      {/* Conditions Section */}
      <div className="view-builder__conditions">
        <h3 className="view-builder__section-label">Where</h3>
        <ProseConditionBuilder
          group={ast.root_group}
          onUpdate={handleRootGroupChange}
          readOnly={readOnly}
        />
      </div>
      
      {/* Result Count Preview */}
      {!isLoading && hasConditions && (
        <div className="view-builder__preview">
          <span className="view-builder__preview-indicator">●</span>
          <span className="view-builder__preview-text">
            {resultCount} node{resultCount !== 1 ? 's' : ''} will appear in this view
          </span>
        </div>
      )}
      
      {/* Advanced Logic Panel - Collapsed by default */}
      <div className="view-builder__advanced">
        <button
          className="view-builder__advanced-toggle"
          onClick={() => setShowAdvanced(!showAdvanced)}
          type="button"
        >
          <Icon path={showAdvanced ? mdiChevronUp : mdiChevronDown} size={0.8} />
          <span className="view-builder__advanced-label">⚠ Advanced logic</span>
        </button>
        
        {showAdvanced && (
          <AdvancedLogicPanel ast={ast} />
        )}
      </div>
    </div>
  );
}

export default ViewBuilder;
