/**
 * AdvancedLogicPanel Component
 * 
 * Collapsed by default panel that shows:
 * - Read-only QueryAST viewer
 * - Optional SQL display (behind additional toggle)
 * 
 * No warnings or redundancy messages.
 */

import { useState, useCallback } from 'react';
import { mdiCodeJson, mdiCodeTags } from '@mdi/js';
import { Button } from '../core/Button';
import { QuerySQLPreview } from './QuerySQLPreview';
import type { QueryAST } from '@/types/queryAST';
import './AdvancedLogicPanel.css';

// ==================== Types ====================

interface AdvancedLogicPanelProps {
  ast: QueryAST;
}

// ==================== Main Component ====================

export function AdvancedLogicPanel({ ast }: AdvancedLogicPanelProps) {
  const [showSQL, setShowSQL] = useState(false);
  
  // Handle copying AST to clipboard
  const handleCopyAST = useCallback(() => {
    const astJson = JSON.stringify(ast, null, 2);
    navigator.clipboard.writeText(astJson);
  }, [ast]);
  
  return (
    <div className="advanced-logic-panel">
      {/* AST Viewer */}
      <div className="advanced-logic-panel__section">
        <div className="advanced-logic-panel__header">
          <h4 className="advanced-logic-panel__title">Query Structure (AST)</h4>
          <Button
            icon={mdiCodeJson}
            onClick={handleCopyAST}
            variant="ghost"
            size="xs"
          >
            Copy
          </Button>
        </div>
        <pre className="advanced-logic-panel__ast">
          {JSON.stringify(ast, null, 2)}
        </pre>
      </div>
      
      {/* SQL Preview - Behind toggle */}
      <div className="advanced-logic-panel__section">
        {!showSQL ? (
          <Button
            icon={mdiCodeTags}
            onClick={() => setShowSQL(true)}
            variant="ghost"
            size="sm"
          >
            Show generated SQL
          </Button>
        ) : (
          <>
            <div className="advanced-logic-panel__header">
              <h4 className="advanced-logic-panel__title">Generated SQL</h4>
            </div>
            <QuerySQLPreview ast={ast} />
            <p className="advanced-logic-panel__note">
              Read-only. SQL is generated from the query structure above.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

export default AdvancedLogicPanel;
