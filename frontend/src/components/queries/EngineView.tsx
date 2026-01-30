/**
 * EngineView Component
 * 
 * Low-contrast, secondary section showing:
 * - AST viewer (prominent, first)
 * - SQL preview (subordinate, behind explicit toggle)
 * 
 * Design:
 * - Collapsed by default (triggered from ViewBuilder)
 * - Clean typography
 * - Neutral, muted colors
 * - "Execution preview (informational only)" labeling for SQL
 */

import { useState, useCallback } from 'react';
import { mdiContentCopy } from '@mdi/js';
import { Button } from '../core/Button';
import { QuerySQLPreview } from './QuerySQLPreview';
import type { QueryAST } from '@/types/queryAST';
import './EngineView.css';

// ==================== Types ====================

interface EngineViewProps {
  ast: QueryAST;
}

// ==================== Main Component ====================

export function EngineView({ ast }: EngineViewProps) {
  const [showSQL, setShowSQL] = useState(false);
  
  // Handle copying AST to clipboard
  const handleCopyAST = useCallback(() => {
    const astJson = JSON.stringify(ast, null, 2);
    navigator.clipboard.writeText(astJson);
  }, [ast]);
  
  return (
    <div className="engine-view">
      {/* AST Section - Primary */}
      <div className="engine-view__section">
        <div className="engine-view__header">
          <h4 className="engine-view__title">Query structure</h4>
          <Button
            icon={mdiContentCopy}
            onClick={handleCopyAST}
            variant="ghost"
            size="xs"
            className="engine-view__copy"
          >
            Copy
          </Button>
        </div>
        <pre className="engine-view__ast">
          {JSON.stringify(ast, null, 2)}
        </pre>
      </div>
      
      {/* SQL Section - Behind toggle */}
      <div className="engine-view__section">
        {!showSQL ? (
          <button
            type="button"
            onClick={() => setShowSQL(true)}
            className="engine-view__show-sql"
          >
            Show execution preview…
          </button>
        ) : (
          <>
            <div className="engine-view__header">
              <h4 className="engine-view__title">Execution preview</h4>
              <span className="engine-view__note">(informational only)</span>
            </div>
            <QuerySQLPreview ast={ast} />
            <button
              type="button"
              onClick={() => setShowSQL(false)}
              className="engine-view__hide-sql"
            >
              Hide
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default EngineView;
