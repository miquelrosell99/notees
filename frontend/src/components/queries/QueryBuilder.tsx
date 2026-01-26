/**
 * QueryBuilder Component (AST-Native)
 * 
 * Direct manipulation of QueryAST without conversion layer.
 * Replaces QueryBlockBuilder + converter approach.
 * 
 * Features:
 * - Direct AST editing
 * - Nested groups with ConditionGroupBlock
 * - Native scope selection
 * - Real-time validation
 */

import { useCallback } from 'react';
import { ScopeSelector } from './ScopeSelector';
import { ConditionGroupBlock } from './ConditionGroupBlock';
import { isSystemQuery } from '@/lib/queryASTHelpers';
import type { QueryAST, GroupNode, ScopeNode } from '@/types/queryAST';
import './QueryBuilder.css';

// ==================== Types ====================

interface QueryBuilderProps {
  /** The query AST to edit */
  ast: QueryAST;
  /** Callback when AST changes */
  onChange: (ast: QueryAST) => void;
  /** Whether the builder is read-only */
  readOnly?: boolean;
  /** Additional CSS class */
  className?: string;
}

// ==================== Main Component ====================

export function QueryBuilder({
  ast,
  onChange,
  readOnly = false,
  className = '',
}: QueryBuilderProps) {
  
  // Handle scope changes
  const handleScopeChange = useCallback((scope: ScopeNode) => {
    onChange({
      ...ast,
      scope,
    });
  }, [ast, onChange]);
  
  // Handle root group changes
  const handleRootGroupChange = useCallback((rootGroup: GroupNode) => {
    onChange({
      ...ast,
      root_group: rootGroup,
    });
  }, [ast, onChange]);
  
  // Check if this is a system query
  const isReadOnly = readOnly || isSystemQuery(ast);
  
  return (
    <div className={`query-builder ${className}`}>
      {/* System Query Banner */}
      {isSystemQuery(ast) && (
        <div className="query-builder__banner query-builder__banner--system">
          <span className="query-builder__banner-icon">🔒</span>
          <div className="query-builder__banner-content">
            <strong>System Query</strong>
            <p>This query is generated automatically (e.g., linked references, child pages) and cannot be modified.</p>
          </div>
        </div>
      )}
      
      {/* Scope Section */}
      <div className="query-builder__section">
        <h3 className="query-builder__section-title">Scope</h3>
        <p className="query-builder__section-subtitle">Which nodes to search</p>
        <ScopeSelector
          scope={ast.scope}
          onChange={handleScopeChange}
          readOnly={isReadOnly}
        />
      </div>
      
      {/* Conditions Section */}
      <div className="query-builder__section">
        <h3 className="query-builder__section-title">Conditions</h3>
        <p className="query-builder__section-subtitle">What qualifies</p>
        <ConditionGroupBlock
          group={ast.root_group}
          onUpdate={handleRootGroupChange}
          depth={0}
          readOnly={isReadOnly}
          showLogicToggle={true}
        />
      </div>
    </div>
  );
}

export default QueryBuilder;
