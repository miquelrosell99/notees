/**
 * ViewBuilder Component (Redesigned)
 * 
 * Clean, modern, intent-first UI for defining views.
 * Single-column layout with generous whitespace and typographic hierarchy.
 * 
 * Design principles:
 * - Calm, obvious, trustworthy
 * - Whitespace and hierarchy over boxes and borders
 * - Intent-first with live-updating prose
 * - Progressive disclosure (basic → advanced)
 * - No validation noise or warnings
 */

import { useCallback, useState, useMemo } from 'react';
import { mdiChevronDown, mdiChevronUp } from '@mdi/js';
import { normalizeAST } from '@/lib/astNormalizer';
import { assertValidAST } from '@/lib/astValidator';
import { getQueryIntent } from '@/lib/astProseRenderer';
import { ProseConditionBuilder } from './ProseConditionBuilder';
import { ProseScopeSelector } from './ProseScopeSelector';
import { EngineView } from './EngineView';
import { Button } from '../core/Button';
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
  const [showScope, setShowScope] = useState(false);
  
  // Auto-normalize and validate AST on every change
  const handleChange = useCallback((updatedAST: QueryAST) => {
    const normalized = normalizeAST(updatedAST);
    assertValidAST(normalized); // Log validation errors in development
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
  
  // Check if scope is default
  const isDefaultScope = ast.scope.scope_type === 'entire_graph';
  
  // Check if query has conditions
  const hasConditions = ast.root_group.children.length > 0;
  
  return (
    <div className={`view-builder ${className}`}>
      {/* Intent Header - Visual Anchor */}
      <div className="view-builder__intent-header">
        <h2 className="view-builder__intent-label">This view shows</h2>
        <p className="view-builder__intent-text">{intentLabel}</p>
      </div>
      
      {/* Scope Selector - Hidden by default, inline when shown */}
      {!isDefaultScope || showScope ? (
        <div className="view-builder__scope-section">
          <span className="view-builder__scope-prefix">Search in:</span>
          <ProseScopeSelector
            scope={ast.scope}
            onChange={handleScopeChange}
            readOnly={readOnly}
          />
        </div>
      ) : (
        !readOnly && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowScope(true)}
            className="view-builder__show-scope"
          >
            Change search scope
          </Button>
        )
      )}
      
      {/* Conditions Section */}
      <div className="view-builder__conditions-section">
        {hasConditions ? (
          <>
            <h3 className="view-builder__conditions-label">Filters</h3>
            <ProseConditionBuilder
              group={ast.root_group}
              onUpdate={handleRootGroupChange}
              readOnly={readOnly}
            />
          </>
        ) : (
          <div className="view-builder__empty-state">
            {!readOnly && <p>No additional filters — all nodes in scope will be shown</p>}
          </div>
        )}
      </div>
      
      {/* Result Preview - Bottom right */}
      {resultCount !== undefined && (
        <div className="view-builder__result-preview">
          {isLoading ? (
            <span className="view-builder__result-loading">Calculating...</span>
          ) : (
            <span className="view-builder__result-count">
              ● {resultCount} node{resultCount === 1 ? '' : 's'} will appear in this view
            </span>
          )}
        </div>
      )}
      
      {/* Engine View - Collapsed by default */}
      {!readOnly && (
        <div className="view-builder__engine-section">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowEngine(!showEngine)}
            icon={showEngine ? mdiChevronUp : mdiChevronDown}
            className="view-builder__engine-toggle"
          >
            {showEngine ? 'Hide' : 'Show'} engine view
          </Button>
          
          {showEngine && (
            <EngineView ast={ast} />
          )}
        </div>
      )}
    </div>
  );
}

export default ViewBuilder;
