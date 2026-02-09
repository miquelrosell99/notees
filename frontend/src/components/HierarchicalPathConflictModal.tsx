/**
 * HierarchicalPathConflictModal - Resolves conflicts when multiple pages exist with same name
 * 
 * When creating hierarchical paths like "Pokemon/Charizard", if multiple "Pokemon" pages exist
 * at the same level (e.g., different classes), this modal lets users choose which one to use.
 */
import { useState, useCallback } from 'react';
import type { Node } from '@/types';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { Modal } from './core/Modal';
import { Button } from './core/Button';
import { NodeIcon } from './icons';
import { useClasses } from '@/hooks';
import './HierarchicalPathConflictModal.css';

interface HierarchicalPathConflictModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** The name of the segment that has conflicts */
  segmentName: string;
  /** The conflicting nodes to choose from */
  conflictingNodes: Node[];
  /** Callback when user selects a node */
  onSelect: (node: Node) => void;
  /** Callback when user cancels */
  onCancel: () => void;
}

export function HierarchicalPathConflictModal({
  isOpen,
  segmentName,
  conflictingNodes,
  onSelect,
  onCancel,
}: HierarchicalPathConflictModalProps) {
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null);
  const { data: allClasses } = useClasses();

  const handleConfirm = useCallback(() => {
    const selectedNode = conflictingNodes.find(n => n.id === selectedNodeId);
    if (selectedNode) {
      onSelect(selectedNode);
    }
  }, [selectedNodeId, conflictingNodes, onSelect]);

  // Get class names for a node
  const getClassNames = useCallback((node: Node): string[] => {
    if (!allClasses || !node.classes?.length) return [];
    return node.classes
      .map(classId => allClasses.find(c => c.id === classId)?.name)
      .filter((name): name is string => !!name);
  }, [allClasses]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title={`Multiple "${segmentName}" pages found`}
      size="md"
    >
      <div className="hierarchical-conflict-modal">
        <p className="hierarchical-conflict-modal__description">
          Multiple pages named "{segmentName}" exist at this level. 
          Please select which one you want to use:
        </p>

        <div className="hierarchical-conflict-modal__options">
          {conflictingNodes.map(node => {
            const classNames = getClassNames(node);
            const isSelected = selectedNodeId === node.id;

            return (
              <button
                key={node.id}
                className={`hierarchical-conflict-modal__option ${isSelected ? 'hierarchical-conflict-modal__option--selected' : ''}`}
                onClick={() => setSelectedNodeId(node.id)}
              >
                <div className="hierarchical-conflict-modal__option-icon">
                  <NodeIcon icon={node.icon} isPage={true} size="md" />
                </div>
                <div className="hierarchical-conflict-modal__option-content">
                  <div className="hierarchical-conflict-modal__option-name">
                    {nodeNameToText(node.name) || 'Untitled'}
                  </div>
                  {classNames.length > 0 && (
                    <div className="hierarchical-conflict-modal__option-classes">
                      {classNames.map((className, idx) => (
                        <span key={idx} className="hierarchical-conflict-modal__option-class">
                          {className}
                        </span>
                      ))}
                    </div>
                  )}
                  {node.id && (
                    <div className="hierarchical-conflict-modal__option-id">
                      ID: {node.id}
                    </div>
                  )}
                </div>
                {isSelected && (
                  <div className="hierarchical-conflict-modal__option-check">✓</div>
                )}
              </button>
            );
          })}
        </div>

        <div className="hierarchical-conflict-modal__actions">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button 
            variant="primary" 
            onClick={handleConfirm}
            disabled={selectedNodeId === null}
          >
            Use Selected Page
          </Button>
        </div>
      </div>
    </Modal>
  );
}
