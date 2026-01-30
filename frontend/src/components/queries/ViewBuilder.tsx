/**
 * ViewBuilder Component
 * 
 * Calm, intent-first, prose-based query editor.
 * Single-column layout with generous whitespace and typographic hierarchy.
 * 
 * Design principles:
 * - Calm, obvious, trustworthy
 * - Whitespace and hierarchy over boxes and borders
 * - Intent-first with live-updating prose
 * - Progressive disclosure (basic → advanced)
 * - No validation noise or warnings (empty queries are valid)
 */

import { useCallback, useState, useMemo } from 'react';
import { normalizeAST } from '@/lib/astNormalizer';
import { assertValidAST } from '@/lib/astValidator';
import { getQueryIntent } from '@/lib/astProseRenderer';
import { ProseConditionBuilder } from './ProseConditionBuilder';
import { ProseScopeSelector } from './ProseScopeSelector';
import { EngineView } from './EngineView';
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
  
  const [showEngine, setShowEngine] = useState(false);
  
  // Auto-normalize and validate AST on every change (validation is console-only)
  const handleChange = useCallback((updatedAST: QueryAST) => {
    const normalized = normalizeAST(updatedAST);
    assertValidAST(normalized); // Developer-only: log validation issues
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
  
  // Generate intent label (live-updating)
  const intentLabel = useMemo(() => getQueryIntent(ast), [ast]);
  
  return (
    <div className={`view-builder ${className}`}>
      {/* Intent Header - Primary Visual Anchor */}
      <div className="view-builder__intent-header">
        <span className="view-builder__intent-label">This view shows</span>
        <p className="view-builder__intent-text">{intentLabel}</p>
      </div>
      
      {/* Scope Selector - Always visible */}
      <div className="view-builder__scope-section">
        <span className="view-builder__scope-prefix">Search in:</span>
        <ProseScopeSelector
          scope={ast.scope}
          onChange={handleScopeChange}
          readOnly={readOnly}
        />
      </div>
      
      {/* Filters Section */}
      <div className="view-builder__filters-section">
        <ProseConditionBuilder
          group={ast.root_group}
          onUpdate={handleRootGroupChange}
          readOnly={readOnly}
        />
      </div>
      
      {/* Result Preview - Bottom right, de-emphasized */}
      {resultCount !== undefined && (
        <div className="view-builder__result-preview">
          {isLoading ? (
            <span className="view-builder__result-loading">Calculating…</span>
          ) : (
            <span className="view-builder__result-count">
              <span className="view-builder__result-dot">●</span>
              {resultCount} node{resultCount === 1 ? '' : 's'} will appear in this view
            </span>
          )}
        </div>
      )}
      
      {/* Advanced Logic - Collapsed by default, demoted */}
      {!readOnly && (
        <div className="view-builder__advanced-section">
          <button
            type="button"
            onClick={() => setShowEngine(!showEngine)}
            className="view-builder__advanced-toggle"
          >
            {showEngine ? '▲' : '▼'} Advanced logic
          </button>
          
          {showEngine && (
            <EngineView ast={ast} />
          )}
        </div>
      )}
    </div>
  );
}

export default ViewBuilder;
