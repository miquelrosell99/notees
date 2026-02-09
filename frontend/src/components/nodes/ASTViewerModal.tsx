/**
 * AST Viewer Modal
 * 
 * A debug modal that displays the raw AST (Abstract Syntax Tree) of a node's name
 * and all its child blocks. Useful for debugging and understanding the internal structure.
 */
import { Modal } from '../core/Modal';
import { useNode } from '@/hooks';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import type { Node } from '@/types';
import './ASTViewerModal.css';

interface ASTViewerModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback when modal should close */
  onClose: () => void;
  /** The node whose AST to display */
  node: Node | null;
}

/**
 * Format AST JSON with syntax highlighting
 */
function formatAST(name: string | null | undefined): { formatted: string; isValid: boolean } {
  if (!name) {
    return { formatted: '(empty)', isValid: false };
  }
  
  try {
    const parsed = JSON.parse(name);
    return { 
      formatted: JSON.stringify(parsed, null, 2), 
      isValid: true 
    };
  } catch {
    // Not valid JSON - show as raw string
    return { 
      formatted: `(plain text, not AST)\n\n"${name}"`, 
      isValid: false 
    };
  }
}

/**
 * Single AST block display
 */
function ASTBlock({ node, depth = 0 }: { node: Node; depth?: number }) {
  const { formatted, isValid } = formatAST(node.name);
  const displayText = nodeNameToText(node.name) || '(empty)';
  
  return (
    <div className="ast-viewer-block" style={{ marginLeft: depth * 16 }}>
      <div className="ast-viewer-block-header">
        <span className="ast-viewer-block-depth">{depth > 0 ? '└─' : ''}</span>
        <span className="ast-viewer-block-type">{node.is_page ? 'Page' : 'Block'}</span>
        <span className="ast-viewer-block-id">#{node.id}</span>
        <span className={`ast-viewer-block-status ${isValid ? 'valid' : 'invalid'}`}>
          {isValid ? '✓' : '✗'}
        </span>
      </div>
      <div className="ast-viewer-block-preview">{displayText}</div>
      <pre className={`ast-viewer-pre compact ${isValid ? 'valid' : 'invalid'}`}>
        <code>{formatted}</code>
      </pre>
      {node.children?.map((child) => (
        <ASTBlock key={child.id} node={child} depth={depth + 1} />
      ))}
    </div>
  );
}

export function ASTViewerModal({ isOpen, onClose, node }: ASTViewerModalProps) {
  // Fetch node with children when modal is open
  const { data: nodeWithChildren } = useNode(isOpen && node ? node.id : null, {
    include_children: true
  });
  
  if (!node) return null;
  
  const displayNode = nodeWithChildren || node;
  const { formatted, isValid } = formatAST(displayNode.name);
  
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Node AST Viewer"
      size="lg"
      className="ast-viewer-modal"
    >
      <div className="ast-viewer-content">
        <div className="ast-viewer-info">
          <div className="ast-viewer-row">
            <span className="ast-viewer-label">ID:</span>
            <span className="ast-viewer-value">{displayNode.id}</span>
          </div>
          <div className="ast-viewer-row">
            <span className="ast-viewer-label">UUID:</span>
            <span className="ast-viewer-value mono">{displayNode.uuid}</span>
          </div>
          <div className="ast-viewer-row">
            <span className="ast-viewer-label">Type:</span>
            <span className="ast-viewer-value">
              {displayNode.is_page ? 'Page' : 'Block'}
              {displayNode.is_daily ? ' (Day)' : ''}
              {displayNode.is_monthly ? ' (Month)' : ''}
              {displayNode.is_yearly ? ' (Year)' : ''}
            </span>
          </div>
          <div className="ast-viewer-row">
            <span className="ast-viewer-label">Children:</span>
            <span className="ast-viewer-value">{displayNode.children?.length ?? 0}</span>
          </div>
        </div>
        
        <div className="ast-viewer-ast">
          <div className="ast-viewer-ast-header">
            <span>This Node</span>
            <button 
              className="ast-viewer-copy-btn"
              onClick={() => navigator.clipboard.writeText(displayNode.name || '')}
              title="Copy to clipboard"
            >
              Copy
            </button>
          </div>
          <div className="ast-viewer-row">
            <span className="ast-viewer-label">Format:</span>
            <span className={`ast-viewer-value ${isValid ? 'valid' : 'invalid'}`}>
              {isValid ? '✓ Valid AST JSON' : '✗ Plain text (invalid)'}
            </span>
          </div>
          <pre className={`ast-viewer-pre ${isValid ? 'valid' : 'invalid'}`}>
            <code>{formatted}</code>
          </pre>
        </div>
        
        {displayNode.children && displayNode.children.length > 0 && (
          <div className="ast-viewer-children">
            <div className="ast-viewer-ast-header">
              <span>Child Blocks ({displayNode.children.length})</span>
            </div>
            <div className="ast-viewer-children-list">
              {displayNode.children.map((child) => (
                <ASTBlock key={child.id} node={child} depth={0} />
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

export default ASTViewerModal;
