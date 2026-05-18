/**
 * DuplicatePageModal - Shown when creating a page with a name that already exists
 * 
 * Lets the user pick a class to differentiate the new page from existing ones.
 * Example: "Apple" already exists as a Fruit → create "Apple" as a Company.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { Modal } from '@/components/core/Modal';
import { Button } from '@/components/core/Button';
import { useClasses, useCreateNode, useClassClass, usePageClass } from '@/hooks';
import type { Node } from '@/types';
import { NodeIcon } from '@/components/core/icons';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import './DuplicatePageModal.css';

export interface DuplicatePageModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback to close the modal */
  onClose: () => void;
  /** The page name that had a conflict */
  pageName: string;
  /** Classes that are already taken for this name */
  conflictingClasses: string[];
  /** The classes the user originally tried to create with */
  originalClasses: number[];
  /** Parent ID for the page (for hierarchical pages) */
  parentId: number | null;
  /** Callback when the page is successfully created */
  onSuccess: (node: Node) => void;
}

/**
 * DuplicatePageModal Component
 * 
 * Shows when a page name already exists. Lets user pick a different class
 * to create a unique name+class combination.
 */
export function DuplicatePageModal({
  isOpen,
  onClose,
  pageName,
  conflictingClasses,
  originalClasses: _originalClasses,
  parentId,
  onSuccess,
}: DuplicatePageModalProps) {
  const [classQuery, setClassQuery] = useState('');
  const [selectedClass, setSelectedClass] = useState<Node | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { data: allClasses = [] } = useClasses();
  const createNodeMutation = useCreateNode();
  const { pageClassId } = usePageClass();
  const { classClassId } = useClassClass();

  // Filter classes based on search query, excluding system classes and conflicting ones
  const filteredClasses = allClasses.filter(c => {
    const name = nodeNameToText(c.name)?.toLowerCase() || '';
    const matchesQuery = !classQuery || name.includes(classQuery.toLowerCase());
    // Exclude classes that are already used with this page name
    const isConflicting = conflictingClasses.some(
      cc => cc.toLowerCase() === name
    );
    return matchesQuery && !isConflicting;
  });

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setClassQuery('');
      setSelectedClass(null);
      setError(null);
      setIsCreating(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  const handleCreate = useCallback(async () => {
    if (!selectedClass || !pageClassId) return;
    
    setIsCreating(true);
    setError(null);
    
    try {
      // Build classes: page class + selected class (excluding any conflicting ones from original)
      const classes = [pageClassId, selectedClass.id];
      
      const newNode = await createNodeMutation.mutateAsync({
        name: pageName,
        parent_id: parentId,
        classes,
      });
      
      onSuccess(newNode);
      onClose();
    } catch (err: unknown) {
      const axiosError = err as { response?: { status?: number; data?: { detail?: { message?: string } | string } } };
      if (axiosError.response?.status === 409) {
        const detail = axiosError.response.data?.detail;
        const message = typeof detail === 'object' && detail !== null ? detail.message : String(detail);
        setError(message || 'This name+class combination already exists. Pick a different class.');
      } else {
        setError('Failed to create page. Please try again.');
      }
    } finally {
      setIsCreating(false);
    }
  }, [selectedClass, pageClassId, pageName, parentId, createNodeMutation, onSuccess, onClose]);

  const handleCreateNewClass = useCallback(async () => {
    if (!classQuery.trim() || !classClassId || !pageClassId) return;
    
    setIsCreating(true);
    setError(null);
    
    try {
      // Create the new class first
      const newClass = await createNodeMutation.mutateAsync({
        name: classQuery.trim(),
        classes: [classClassId, pageClassId],
      });
      
      // Then create the page with the new class
      const newNode = await createNodeMutation.mutateAsync({
        name: pageName,
        parent_id: parentId,
        classes: [pageClassId, newClass.id],
      });
      
      onSuccess(newNode);
      onClose();
    } catch (err: unknown) {
      setError('Failed to create page. Please try again.');
    } finally {
      setIsCreating(false);
    }
  }, [classQuery, classClassId, pageClassId, pageName, parentId, createNodeMutation, onSuccess, onClose]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`"${pageName}" already exists`}
      size="sm"
      footer={
        <div className="duplicate-page-modal__footer">
          <Button variant="ghost" onClick={onClose} size="sm">
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleCreate}
            size="sm"
            disabled={!selectedClass || isCreating}
          >
            {isCreating ? 'Creating...' : 'Create'}
          </Button>
        </div>
      }
    >
      <div className="duplicate-page-modal">
        <p className="duplicate-page-modal__description">
          A page named "<strong>{pageName}</strong>" already exists
          {conflictingClasses.length > 0 && (
            <> with class{conflictingClasses.length > 1 ? 'es' : ''}: {conflictingClasses.map((c, i) => (
              <span key={c}>
                {i > 0 && ', '}
                <strong>{c}</strong>
              </span>
            ))}</>
          )}.
          Pick a different class to create a new page with the same name.
        </p>

        <div className="duplicate-page-modal__search">
          <input
            ref={inputRef}
            type="text"
            className="duplicate-page-modal__input"
            value={classQuery}
            onChange={(e) => {
              setClassQuery(e.target.value);
              setSelectedClass(null);
            }}
            placeholder="Search or create a class..."
            onKeyDown={(e) => {
              if (e.key === 'Enter' && selectedClass) {
                e.preventDefault();
                handleCreate();
              }
            }}
          />
        </div>

        <div className="duplicate-page-modal__class-list">
          {filteredClasses.map(classNode => {
            const isSelected = selectedClass?.id === classNode.id;
            return (
              <button
                key={classNode.id}
                className={`duplicate-page-modal__class-item ${isSelected ? 'duplicate-page-modal__class-item--selected' : ''}`}
                onClick={() => setSelectedClass(isSelected ? null : classNode)}
              >
                <NodeIcon icon={classNode.icon} isPage={true} size="sm" />
                <span className="duplicate-page-modal__class-name">
                  {nodeNameToText(classNode.name) || 'Untitled'}
                </span>
              </button>
            );
          })}
          
          {classQuery.trim() && !filteredClasses.some(
            c => nodeNameToText(c.name)?.toLowerCase() === classQuery.trim().toLowerCase()
          ) && (
            <button
              className="duplicate-page-modal__class-item duplicate-page-modal__class-item--create"
              onClick={handleCreateNewClass}
              disabled={isCreating}
            >
              <span className="duplicate-page-modal__create-icon">+</span>
              <span className="duplicate-page-modal__class-name">
                Create class "{classQuery.trim()}"
              </span>
            </button>
          )}
          
          {filteredClasses.length === 0 && !classQuery.trim() && (
            <p className="duplicate-page-modal__empty">
              No classes available. Type to create a new one.
            </p>
          )}
        </div>

        {error && (
          <p className="duplicate-page-modal__error">{error}</p>
        )}
      </div>
    </Modal>
  );
}

