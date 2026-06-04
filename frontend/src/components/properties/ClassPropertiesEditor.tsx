/**
 * ClassPropertiesEditor - Component for editing which properties a Class has
 *
 * This allows defining which properties nodes with this class will have.
 * Properties defined here are separate from inherited properties.
 *
 * Uses ListSortable for drag-and-drop reordering.
 */
import { useState, useCallback, useMemo } from 'react';

import './ClassPropertiesEditor.css';
import {
  useClassProperties,
  useAddPropertyToClass,
  useRemovePropertyFromClass,
  useReorderClassProperties,
  useCreateProperty,
  useProperties,
  useUpdateClassProperty,
} from '@/hooks';
import { Button } from '@/components/core/Button';
import { PropertySuggestionPopup } from './PropertySuggestionPopup';
import { NodeViewSection } from '@/components/nodes/NodeViewSection';
import { Spinner } from '@/components/core/Spinner';
import { Icon, PropertiesIcon } from '@/components/core/icons';
import { ListSortable } from '@/components/core/ListSortable';
import { ContextMenu, type ContextMenuItem } from '@/components/core/ContextMenu';
import { useNavigationStore } from '@/stores';
import type { Property, PropertyCreate } from '@/types/api';
import { getMdiClass } from '@/utils/iconDom';
import './PropertiesSection.css';

/** Default MDI icon names for each property type */
import { PROPERTY_TYPE_ICONS } from './constants';

function getPropertyIconPath(property: Property): string | null {
  const name = property.icon || PROPERTY_TYPE_ICONS[property.type] || 'mdiFileDocumentOutline';
  return getMdiClass(name);
}

interface SortablePropertyItem {
  id: number;
  property: Property;
  required: boolean;
}

interface ClassPropertiesEditorProps {
  /** The class node ID being edited */
  classNodeId: number;
  /** Optional className for styling */
  className?: string;
  /** Whether the editor is read-only */
  readOnly?: boolean;
  /** Whether the section is expanded by default */
  defaultExpanded?: boolean;
}

/**
 * Editor for managing properties on a class
 */
export function ClassPropertiesEditor({
  classNodeId,
  className = '',
  readOnly = false,
  defaultExpanded = true,
}: ClassPropertiesEditorProps) {
  const [showPropertyPopup, setShowPropertyPopup] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ property: Property; x: number; y: number } | null>(null);

  // Fetch current class properties (direct only, not inherited)
  const { data: classProperties, isLoading } = useClassProperties(classNodeId, false);
  const { data: allProperties } = useProperties();

  // Mutations
  const addPropertyMutation = useAddPropertyToClass();
  const createPropertyMutation = useCreateProperty();
  const removePropertyMutation = useRemovePropertyFromClass();
  const reorderMutation = useReorderClassProperties();
  const updateClassPropertyMutation = useUpdateClassProperty();

  // Handle creating a new property and immediately linking it to the class
  const handleCreateProperty = useCallback(
    (data: PropertyCreate & { selection_options?: { name: string; icon?: string }[] }) => {
      const scope = data.scope ?? (data.is_local ? 'node' : 'global');
      const node_id = scope === 'class' ? classNodeId : data.node_id;
      createPropertyMutation.mutate(
        { ...data, scope, node_id } as PropertyCreate,
        {
          onSuccess: (created) => {
            addPropertyMutation.mutate(
              { classId: classNodeId, propertyId: created.id },
              { onSuccess: () => setShowPropertyPopup(false) }
            );
          },
        }
      );
    },
    [classNodeId, createPropertyMutation, addPropertyMutation]
  );

  // Get IDs of properties already applied to this class
  const appliedPropertyIds = useMemo(() => {
    return classProperties?.map(cp => cp.property_id) ?? [];
  }, [classProperties]);

  // Build sortable items from class properties
  const sortableItems = useMemo<SortablePropertyItem[]>(() => {
    if (!classProperties || !allProperties) return [];
    return classProperties
      .map(cp => {
        const property = allProperties.find(p => p.id === cp.property_id);
        return property ? { id: cp.property_id, property, required: cp.required ?? false } : null;
      })
      .filter((item): item is SortablePropertyItem => item !== null);
  }, [classProperties, allProperties]);

  const handleAddProperty = useCallback((property: { id: number }) => {
    addPropertyMutation.mutate(
      { classId: classNodeId, propertyId: property.id },
      { onSuccess: () => setShowPropertyPopup(false) }
    );
  }, [classNodeId, addPropertyMutation]);

  const handleRemoveProperty = useCallback((propertyId: number) => {
    removePropertyMutation.mutate({ classId: classNodeId, propertyId });
  }, [classNodeId, removePropertyMutation]);

  const handleReorder = useCallback((fromIndex: number, toIndex: number) => {
    if (!classProperties) return;
    const newOrder = [...classProperties];
    const [moved] = newOrder.splice(fromIndex, 1);
    newOrder.splice(toIndex, 0, moved);
    reorderMutation.mutate({
      classId: classNodeId,
      propertyIds: newOrder.map(cp => cp.property_id),
    });
  }, [classProperties, classNodeId, reorderMutation]);

  // Get openPropertyView from store
  const openPropertyView = useNavigationStore(state => state.openPropertyView);

  // Context menu items for the open context menu
  const contextMenuItems = useMemo((): ContextMenuItem[] => {
    if (!contextMenu) return [];
    return [
      {
        id: 'open-property',
        label: 'Open property',
        onClick: () => openPropertyView(contextMenu.property.id),
      },
      {
        id: 'remove-property',
        label: 'Remove from class',
        danger: true,
        disabled: contextMenu.property.is_system,
        onClick: () => handleRemoveProperty(contextMenu.property.id),
      },
    ];
  }, [contextMenu, openPropertyView, handleRemoveProperty]);

  if (isLoading) {
    return <div className={`properties-view class-definition-variant loading ${className}`}><Spinner size="sm" /></div>;
  }

  return (
    <NodeViewSection
      title="Class Properties"
      icon={<PropertiesIcon size="sm" />}
      count={sortableItems.length}
      className={`class-properties-section ${className}`}
      defaultExpanded={defaultExpanded}
      hideWhenEmpty={false}
    >
      <div className="class-properties-content">
        {/* Sortable properties list */}
        {sortableItems.length > 0 ? (
          <ListSortable
            items={sortableItems}
            onReorder={handleReorder}
            showDragHandle={!readOnly}
            renderIcon={(item) => {
              const path = getPropertyIconPath(item.property);
              return path ? <Icon path={path} size={0.7} /> : null;
            }}
            renderText={(item) => item.property.name}
            renderAction={(item) =>
              !readOnly ? (
                <div className="class-property-actions">
                  <button
                    className={`class-property-required-btn ${item.required ? 'class-property-required-btn--active' : ''} hover-reveal`}
                    title={item.required ? 'Required (click to make optional)' : 'Optional (click to make required)'}
                    onClick={(e) => {
                      e.stopPropagation();
                      updateClassPropertyMutation.mutate({
                        classId: classNodeId,
                        propertyId: item.property.id,
                        data: { required: !item.required },
                      });
                    }}
                  >
                    <Icon path={"mdi mdi-asterisk"} size={0.55} />
                  </button>
                  <button
                    className="class-property-menu-btn hover-reveal"
                    title="Property options"
                    onClick={(e) => {
                      e.stopPropagation();
                      setContextMenu({ property: item.property, x: e.clientX, y: e.clientY });
                    }}
                  >
                    <Icon path={"mdi mdi-dots-vertical"} size={0.65} />
                  </button>
                </div>
              ) : null
            }
            onItemContextMenu={(item, event) => {
              event.preventDefault();
              setContextMenu({ property: item.property, x: event.clientX, y: event.clientY });
            }}
          />
        ) : (
          <p className="class-properties-empty">No properties defined yet.</p>
        )}

        {/* Add new property */}
        {!readOnly && (
          <div className="properties-add-wrapper">
            <Button
              icon={"mdi mdi-plus"}
              className="properties-add-btn"
              onClick={() => setShowPropertyPopup(!showPropertyPopup)}
              title="Add property"
              size="xs"
              variant="ghost"
            >
              Add property
            </Button>
            <PropertySuggestionPopup
              isOpen={showPropertyPopup}
              onClose={() => setShowPropertyPopup(false)}
              onSelect={handleAddProperty}
              onCreate={handleCreateProperty}
              excludeIds={appliedPropertyIds}
              contextClassIds={[classNodeId]}
              defaultScope="class"
            />
          </div>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          items={contextMenuItems}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          onClose={() => setContextMenu(null)}
        />
      )}
    </NodeViewSection>
  );
}

