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

import { useCallback } from 'react';
import { assertValidAST } from '@/lib/astValidator';
import { QueryBlockList } from './QueryBlockList';
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
  /** Hide the footer section */
  hideFooter?: boolean;
}

// ==================== Main Component ====================

export function ViewBuilder({
  ast,
  onChange,
  readOnly = false,
  className = '',
}: ViewBuilderProps) {
  
  // Pass through changes without normalization - normalization happens on save
  const handleChange = useCallback((updatedAST: QueryAST) => {
    assertValidAST(updatedAST); // Developer-only: log validation issues
    onChange(updatedAST);
  }, [onChange]);
  
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
