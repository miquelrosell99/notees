/**
 * TypeExtendsEditor - Component for editing which types a Type/Class extends
 * 
 * This allows setting up inheritance relationships between types.
 * When a type extends another, nodes with that type will have
 * all properties from the extended type (plus its own properties).
 */
import { useState, useCallback } from 'react';
import './TypeExtendsEditor.css';
import { 
  useTypeExtends, 
  useAddTypeExtends, 
  useRemoveTypeExtends,
  useNodes 
} from '@/hooks';
import { mdiPlus } from '@mdi/js';
import { LinkIcon, NodeIcon } from './icons';
import { Button } from './core/Button';

interface TypeExtendsEditorProps {
  /** The type node ID being edited */
  typeNodeId: number;
  /** Optional class name */
  className?: string;
  /** Whether the editor is read-only */
  readOnly?: boolean;
  /** Callback when navigating to a type */
  onNavigateToType?: (typeId: number) => void;
}

/**
 * Editor for managing type inheritance (extends) relationships
 */
export function TypeExtendsEditor({
  typeNodeId,
  className = '',
  readOnly = false,
  onNavigateToType,
}: TypeExtendsEditorProps) {
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  
  // Fetch current extends relationships
  const { data: extendsRelations, isLoading } = useTypeExtends(typeNodeId);
  
  // Fetch all pages (potential types to extend)
  const { data: allNodes } = useNodes({ pages_only: true });
  
  // Mutations
  const addExtendsMutation = useAddTypeExtends();
  const removeExtendsMutation = useRemoveTypeExtends();
  
  // Filter available types (exclude self and already extended types)
  const availableTypes = allNodes?.filter(node => {
    if (node.id === typeNodeId) return false;
    if (extendsRelations?.some(ext => ext.extends_type_node_id === node.id)) return false;
    if (searchQuery && !node.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  }) ?? [];
  
  const handleAddExtends = useCallback((extendsTypeId: number) => {
    addExtendsMutation.mutate(
      { typeId: typeNodeId, extendsTypeId },
      {
        onSuccess: () => {
          setIsAddingNew(false);
          setSearchQuery('');
        },
      }
    );
  }, [typeNodeId, addExtendsMutation]);
  
  const handleRemoveExtends = useCallback((extendsTypeId: number) => {
    removeExtendsMutation.mutate({ typeId: typeNodeId, extendsTypeId });
  }, [typeNodeId, removeExtendsMutation]);
  
  if (isLoading) {
    return <div className={`type-extends-editor loading ${className}`}>Loading...</div>;
  }
  
  return (
    <div className={`type-extends-editor ${className}`}>
      <h4 className="type-extends-title">
        <LinkIcon size="sm" />
        Extends (Inherits From)
      </h4>
      
      {/* Current extends list */}
      <div className="type-extends-list">
        {extendsRelations && extendsRelations.length > 0 ? (
          extendsRelations.map((ext) => (
            <div key={ext.id} className="type-extends-item">
              <Button
                className="type-extends-name"
                variant="ghost"
                size="sm"
                onClick={() => onNavigateToType?.(ext.extends_type_node_id)}
                title="Click to view type"
              >
                <NodeIcon isPage={true} size="xs" />
                {ext.extends_type_node_name || `Type #${ext.extends_type_node_id}`}
              </Button>
              {!readOnly && (
                <Button
                  className="type-extends-remove"
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
          <p className="type-extends-empty">
            No parent types. Add types to inherit their properties.
          </p>
        )}
      </div>
      
      {/* Add new extends */}
      {!readOnly && (
        <div className="type-extends-add">
          {isAddingNew ? (
            <div className="type-extends-picker">
              <input
                type="text"
                className="type-extends-search"
                placeholder="Search types..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                autoFocus
              />
              <div className="type-extends-options">
                {availableTypes.slice(0, 10).map((node) => (
                  <Button
                    key={node.id}
                    className="type-extends-option"
                    variant="ghost"
                    size="sm"
                    onClick={() => handleAddExtends(node.id)}
                    disabled={addExtendsMutation.isPending}
                  >
                    <NodeIcon isPage={true} size="xs" />
                    {node.name}
                  </Button>
                ))}
                {availableTypes.length === 0 && (
                  <p className="type-extends-no-results">No types found</p>
                )}
              </div>
              <Button
                className="type-extends-cancel"
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
              className="type-extends-add-btn"
              onClick={() => setIsAddingNew(true)}
              title="Add parent type"
              size="sm"
              variant="ghost"
            >
              Add parent type
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export default TypeExtendsEditor;
