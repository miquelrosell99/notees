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

import { useCallback, useState } from 'react';
import { assertValidAST } from '@/lib/astValidator';
import { QueryBlockList } from './QueryBlockList';
import { parseQueryLanguage } from '@/lib/parseQueryLanguage';
import { Button } from '@/components/ui/Button';
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
  const [showTextInput, setShowTextInput] = useState(false);
  const [textQuery, setTextQuery] = useState('');
  const [textError, setTextError] = useState<string | null>(null);
  const [isParsing, setIsParsing] = useState(false);

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

  const handleParseTextQuery = useCallback(async () => {
    if (!textQuery.trim()) return;
    setIsParsing(true);
    setTextError(null);
    try {
      const parsedAst = await parseQueryLanguage(textQuery.trim());
      handleChange(parsedAst);
      setShowTextInput(false);
      setTextQuery('');
    } catch (error) {
      setTextError(error instanceof Error ? error.message : 'Failed to parse query');
    } finally {
      setIsParsing(false);
    }
  }, [textQuery, handleChange]);

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

      {/* Compact text query language toggle */}
      {!readOnly && (
        <div className="view-builder__text-query-section">
          {!showTextInput ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowTextInput(true)}
              icon="mdi mdi-text-box-search-outline"
            >
              Edit as text query
            </Button>
          ) : (
            <div className="view-builder__text-query-input">
              <textarea
                value={textQuery}
                onChange={(e) => setTextQuery(e.target.value)}
                placeholder='e.g. content:"meeting" AND create_date >= {this_week}'
                aria-label="Text query"
                rows={3}
                className="view-builder__text-query-textarea"
              />
              {textError && (
                <div className="view-builder__text-query-error">{textError}</div>
              )}
              <div className="view-builder__text-query-actions">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleParseTextQuery}
                  disabled={isParsing || !textQuery.trim()}
                >
                  {isParsing ? 'Parsing…' : 'Parse to filters'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowTextInput(false);
                    setTextError(null);
                    setTextQuery('');
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

