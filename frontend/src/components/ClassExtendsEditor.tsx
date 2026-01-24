/**
 * ClassExtendsEditor - Component for editing which classes a class extends
 * 
 * This allows setting up inheritance relationships between classes.
 * When a class extends another, nodes with that class will have
 * all properties from the extended class (plus its own properties).
 */
import { useState, useCallback } from 'react';
import './ClassExtendsEditor.css';
import { 
  useClassExtends, 
  useAddClassExtends, 
  useRemoveClassExtends,
  useNodes 
} from '@/hooks';
import { mdiPlus } from '@mdi/js';
import { LinkIcon, NodeIcon } from './icons';
import { Button } from './core/Button';

interface ClassExtendsEditorProps {
  /** The class node ID being edited */
  classNodeId: number;
  /** Optional class name */
  className?: string;
  /** Whether the editor is read-only */
  readOnly?: boolean;
  /** Callback when navigating to a class */
  onNavigateToClass?: (classId: number) => void;
}

/**
 * Editor for managing class inheritance (extends) relationships
 */
export function ClassExtendsEditor({
  classNodeId,
  className = '',
  readOnly = false,
  onNavigateToClass,
}: ClassExtendsEditorProps) {
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  
  // Fetch current extends relationships
  const { data: extendsRelations, isLoading } = useClassExtends(classNodeId);
  
  // Fetch all pages (potential classes to extend)
  const { data: allNodes } = useNodes({ pages_only: true });
  
  // Mutations
  const addExtendsMutation = useAddClassExtends();
  const removeExtendsMutation = useRemoveClassExtends();
  
  // Filter available classes (exclude self and already extended classes)
  const availableClasses = allNodes?.filter(node => {
    if (node.id === classNodeId) return false;
    if (extendsRelations?.some(ext => ext.extends_type_node_id === node.id)) return false;
    if (searchQuery && !node.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  }) ?? [];
  
  const handleAddExtends = useCallback((extendsClassId: number) => {
    addExtendsMutation.mutate(
      { classId: classNodeId, extendsClassId },
      {
        onSuccess: () => {
          setIsAddingNew(false);
          setSearchQuery('');
        },
      }
    );
  }, [classNodeId, addExtendsMutation]);
  
  const handleRemoveExtends = useCallback((extendsClassId: number) => {
    removeExtendsMutation.mutate({ classId: classNodeId, extendsClassId });
  }, [classNodeId, removeExtendsMutation]);
  
  if (isLoading) {
    return <div className={`class-extends-editor loading ${className}`}>Loading...</div>;
  }
  
  return (
    <div className={`class-extends-editor ${className}`}>
      <h4 className="class-extends-title">
        <LinkIcon size="sm" />
        Extends (Inherits From)
      </h4>
      
      {/* Current extends list */}
      <div className="class-extends-list">
        {extendsRelations && extendsRelations.length > 0 ? (
          extendsRelations.map((ext) => (
            <div key={ext.id} className="class-extends-item">
              <Button
                className="class-extends-name"
                variant="ghost"
                size="sm"
                onClick={() => onNavigateToClass?.(ext.extends_type_node_id)}
                title="Click to view class"
              >
                <NodeIcon isPage={true} size="xs" />
                {ext.extends_type_node_name || `Class #${ext.extends_type_node_id}`}
              </Button>
              {!readOnly && (
                <Button
                  className="class-extends-remove"
                  variant="ghost"
                  size="xs"
                  onClick={() => handleRemoveExtends(ext.extends_type_node_id)}
                  disabled={removeExtendsMutation.isPending}
                  title="Remove inheritance"
                >
                  ×
                </Button>
              )}
            </div>
          ))
        ) : (
          <p className="class-extends-empty">
            No parent classes. Add classes to inherit their properties.
          </p>
        )}
      </div>
      
      {/* Add new extends */}
      {!readOnly && (
        <div className="class-extends-add">
          {isAddingNew ? (
            <div className="class-extends-picker">
              <input
                type="text"
                className="class-extends-search"
                placeholder="Search classes..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                autoFocus
              />
              <div className="class-extends-options">
                {availableClasses.slice(0, 10).map((node) => (
                  <Button
                    key={node.id}
                    className="class-extends-option"
                    variant="ghost"
                    size="sm"
                    onClick={() => handleAddExtends(node.id)}
                    disabled={addExtendsMutation.isPending}
                  >
                    <NodeIcon isPage={true} size="xs" />
                    {node.name}
                  </Button>
                ))}
                {availableClasses.length === 0 && (
                  <p className="class-extends-no-results">No classes found</p>
                )}
              </div>
              <Button
                className="class-extends-cancel"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setIsAddingNew(false);
                  setSearchQuery('');
                }}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              icon={mdiPlus}
              className="class-extends-add-btn"
              onClick={() => setIsAddingNew(true)}
              title="Add parent class"
              size="sm"
              variant="ghost"
            >
              Add parent class
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export default ClassExtendsEditor;
