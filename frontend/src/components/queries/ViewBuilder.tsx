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
 * - Shows validation feedback inline for actionable errors
 */

import { useCallback, useMemo } from 'react';
import { assertValidAST } from '@/lib/astValidator';
import { validateQueryAST } from '@/lib/queryValidation';
import { QueryBlockList } from './QueryBlockList';
import { ProseScopeSelector } from './ProseScopeSelector';
import { ValidationFeedback } from './ValidationFeedback';
import type { QueryAST, GroupNode, ConditionNode, NotNode } from '@/types/queryAST';
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
  hideFooter = false,
}: ViewBuilderProps) {
  
  // Validate AST and get validation results
  const validationResult = useMemo(() => validateQueryAST(ast), [ast]);
  
  // Pass through changes without normalization - normalization happens on save
  const handleChange = useCallback((updatedAST: QueryAST) => {
    assertValidAST(updatedAST); // Developer-only: log validation issues
    onChange(updatedAST);
  }, [onChange]);
  
  // Handle scope changes
  const handleScopeChange = useCallback((scope: typeof ast.scope) => {
    handleChange({
      ...ast,
      scope,
    });
  }, [ast, handleChange]);
  
  // Handle root group children changes
  const handleChildrenChange = useCallback((children: Array<ConditionNode | GroupNode | NotNode>) => {
    handleChange({
      ...ast,
      root_group: {
        ...ast.root_group,
        children,
      },
    });
  }, [ast, handleChange]);
  
  return (
    <div className={`view-builder ${className}`}>
      
      {/* Filters Section */}
      <div className="view-builder__filters-section">
        <QueryBlockList
          blocks={ast.root_group.children}
          onChange={handleChildrenChange}
          readOnly={readOnly}
        />
      </div>
    </div>
  );
}

export default ViewBuilder;
