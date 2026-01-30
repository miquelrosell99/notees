/**
 * EngineView Component (Renamed from AdvancedLogicPanel)
 * 
 * Low-contrast, secondary section showing:
 * - AST viewer (prominent, monospace with generous spacing)
 * - SQL preview (subordinate, behind explicit toggle)
 * - No warnings or redundancy messages
 * 
 * Design:
 * - Collapsed by default (triggered from ViewBuilder)
 * - Clean typography
 * - Neutral, muted colors
 * - "Execution preview (informational only)" labeling for SQL
 */

import { useState, useCallback } from 'react';
import { mdiCodeBraces, mdiContentCopy } from '@mdi/js';
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
      {/* AST Section */}
      <div className="engine-view__section">
        <div className="engine-view__header">
          <h4 className="engine-view__title">Query Structure</h4>
          <Button
            icon={mdiContentCopy}
            onClick={handleCopyAST}
            variant="ghost"
            size="xs"
            className="engine-view__action"
          >
            Copy JSON
          </Button>
        </div>
        <pre className="engine-view__ast">
          {JSON.stringify(ast, null, 2)}
        </pre>
      </div>
      
      {/* SQL Section - Behind toggle */}
      <div className="engine-view__section">
        {!showSQL ? (
          <Button
            icon={mdiCodeBraces}
            onClick={() => setShowSQL(true)}
            variant="ghost"
            size="sm"
            className="engine-view__toggle"
          >
            Show execution preview
          </Button>
        ) : (
          <>
            <div className="engine-view__header">
              <h4 className="engine-view__title">Execution Preview</h4>
              <span className="engine-view__subtitle">(informational only)</span>
            </div>
            <QuerySQLPreview ast={ast} />
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setShowSQL(false)}
              className="engine-view__hide"
            >
              Hide
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

export default EngineView;
