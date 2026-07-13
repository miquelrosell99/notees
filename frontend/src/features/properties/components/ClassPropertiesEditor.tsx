/**
 * ClassPropertiesEditor - Component for editing which properties a Class has
 *
 * This allows defining which properties nodes with this class will have.
 * Properties defined here are separate from inherited properties.
 *
 * Uses ListSortable for drag-and-drop reordering.
 */
import { useState, useEffect, useCallback, useMemo } from 'react';

import './ClassPropertiesEditor.css';
import { useClassProperties, useAddPropertyToClass, useRemovePropertyFromClass, useReorderClassProperties, useCreateProperty, useProperties, useUpdateClassProperty } from '../hooks';
import { Button } from '@/components/ui/Button';
import { PropertySuggestionPopup } from './PropertySuggestionPopup';
import { NodeViewSection } from '@/features/content';
import { Spinner } from '@/components/ui/Spinner';
import { Icon, PropertiesIcon } from '@/components/ui/icons';
import { ListSortable } from '@/components/ui/ListSortable';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu';
import { useNavigationStore } from '@/stores';
import type { Property, PropertyCreate } from '@/types/api';
import { getMdiClass } from '@/utils/iconDom';
import './PropertiesSection.css';
import { DefaultValueEditor } from './DefaultValueEditor';

/** Default MDI icon names for each property type */
import { PROPERTY_TYPE_ICONS } from '../utils/constants';

function getPropertyIconPath(property: Property): string | null {
  const name = property.icon || PROPERTY_TYPE_ICONS[property.type] || 'mdiFileDocumentOutline';
  return getMdiClass(name);
}

/**
 * Property types whose default value can be edited in the UI. Mirrors the
 * editable set inside DefaultValueEditor (other types render a static note
 * there, which would just be noise in a class row).
 */
const DEFAULT_EDITABLE_TYPES = new Set(['text', 'url', 'email', 'integer', 'float', 'boolean', 'selection']);

interface SortablePropertyItem {
  id: string;
  nodeUuid: string;
  property: Property;
  /** Tri-state edge overrides; null = inherit from the property base */
  required: boolean | null;
  readOnly: boolean | null;
  hideWhenEmpty: boolean | null;
  /** Edge default override; null/undefined = inherit the property base default */
  defaultValue: unknown;
}

type TriState = 'on' | 'off' | 'inherit';

interface TriStateToggleProps {
  /** Current edge value; null = inherit */
  value: boolean | null;
  /** Resolved property base, shown in the inherit-state label */
  baseValue: boolean;
  onChange: (value: boolean | null) => void;
  /** MDI icon names per state */
  icons: Record<TriState, string>;
  /** Accessible label per state; inherit resolves the base (e.g. "Inherit (required)") */
  labels: { on: string; off: string; inherit: (base: boolean) => string };
}

/**
 * Tri-state override toggle: click cycles inherit -> on -> off -> inherit.
 * The title/aria-label shows the current state; in inherit state it shows
 * the resolved property base.
 *
 * Keeps optimistic local state: without it, a second click before the
 * mutation's query invalidation refetches would recompute from the stale
 * prop and re-send the same value. Props re-sync whenever they change.
 */
function TriStateToggle({ value, baseValue, onChange, icons, labels }: TriStateToggleProps) {
  const [localValue, setLocalValue] = useState<boolean | null>(value);
  useEffect(() => {
    setLocalValue(value);
  }, [value]);

  const state: TriState = localValue === null ? 'inherit' : localValue ? 'on' : 'off';
  const label = state === 'inherit' ? labels.inherit(baseValue) : labels[state];
  const next: boolean | null = state === 'inherit' ? true : state === 'on' ? false : null;
  return (
    <Button
      aria-label={label}
      variant="ghost"
      size="xs"
      icon={`mdi ${icons[state]}`}
      className={`class-property-tristate-btn class-property-tristate-btn--${state} hover-reveal`}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        setLocalValue(next);
        onChange(next);
      }}
    />
  );
}

interface ClassPropertiesEditorProps {
  /** The class node UUID being edited */
  classNodeUuid: string;
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
  classNodeUuid,
  className = '',
  readOnly = false,
  defaultExpanded = true,
}: ClassPropertiesEditorProps) {
  const [showPropertyPopup, setShowPropertyPopup] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ property: Property; x: number; y: number } | null>(null);

  // Fetch current class properties (direct only, not inherited)
  const { data: classProperties, isLoading } = useClassProperties(classNodeUuid, false);
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
      const scope = data.scope ?? 'global';
      const node_uuid = scope === 'class' ? classNodeUuid : data.node_uuid;
      createPropertyMutation.mutate(
        { ...data, scope, node_uuid } as PropertyCreate,
        {
          onSuccess: (created) => {
            addPropertyMutation.mutate(
              { classId: classNodeUuid, propertyId: created.uuid },
              { onSuccess: () => setShowPropertyPopup(false) }
            );
          },
        }
      );
    },
    [classNodeUuid, createPropertyMutation, addPropertyMutation]
  );

  // Get UUIDs of properties already applied to this class
  const appliedPropertyIds = useMemo(() => {
    return classProperties?.map(cp => cp.property_uuid).filter((uuid): uuid is string => !!uuid) ?? [];
  }, [classProperties]);

  // Build sortable items from class properties
  const sortableItems = useMemo<SortablePropertyItem[]>(() => {
    if (!classProperties || !allProperties) return [];
    return classProperties
      .map(cp => {
        const propertyUuid = cp.property_uuid;
        const property = propertyUuid ? allProperties.find(p => p.uuid === propertyUuid) : undefined;
        return property
          ? {
              id: property.uuid,
              nodeUuid: property.uuid,
              property,
              required: cp.required,
              readOnly: cp.readonly,
              hideWhenEmpty: cp.hide_when_empty,
              defaultValue: cp.default_value,
            }
          : null;
      })
      .filter((item): item is SortablePropertyItem => item !== null);
  }, [classProperties, allProperties]);

  const handleAddProperty = useCallback((property: Property) => {
    addPropertyMutation.mutate(
      { classId: classNodeUuid, propertyId: property.uuid },
      { onSuccess: () => setShowPropertyPopup(false) }
    );
  }, [classNodeUuid, addPropertyMutation]);

  const handleRemoveProperty = useCallback((property: Property) => {
    removePropertyMutation.mutate({ classId: classNodeUuid, propertyId: property.uuid });
  }, [classNodeUuid, removePropertyMutation]);

  const handleReorder = useCallback((fromIndex: number, toIndex: number) => {
    if (!classProperties) return;
    const newOrder = [...classProperties];
    const [moved] = newOrder.splice(fromIndex, 1);
    newOrder.splice(toIndex, 0, moved);
    reorderMutation.mutate({
      classId: classNodeUuid,
      propertyIds: newOrder.map(cp => cp.property_uuid).filter((uuid): uuid is string => !!uuid),
    });
  }, [classProperties, classNodeUuid, reorderMutation]);

  // Get openPropertyView from store
  const openPropertyView = useNavigationStore(state => state.openPropertyView);

  // Context menu items for the open context menu
  const contextMenuItems = useMemo((): ContextMenuItem[] => {
    if (!contextMenu) return [];
    return [
      {
        id: 'open-property',
        label: 'Open property',
        onClick: () => openPropertyView(contextMenu.property.uuid),
      },
      {
        id: 'remove-property',
        label: 'Remove from class',
        danger: true,
        disabled: contextMenu.property.is_system,
        onClick: () => handleRemoveProperty(contextMenu.property),
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
                  {DEFAULT_EDITABLE_TYPES.has(item.property.type) && (
                    <DefaultValueEditor
                      property={item.property}
                      value={item.defaultValue}
                      className="class-property-default-editor"
                      onChange={(value) => {
                        updateClassPropertyMutation.mutate({
                          classId: classNodeUuid,
                          propertyId: item.property.uuid,
                          data: { default_value: value },
                        });
                      }}
                    />
                  )}
                  <TriStateToggle
                    value={item.required}
                    baseValue={item.property.required}
                    icons={{ on: 'mdi-asterisk', off: 'mdi-asterisk', inherit: 'mdi-asterisk' }}
                    labels={{
                      on: 'Required (click to make optional)',
                      off: 'Optional (click to inherit)',
                      inherit: (base) => `Inherit (${base ? 'required' : 'optional'})`,
                    }}
                    onChange={(v) => {
                      updateClassPropertyMutation.mutate({
                        classId: classNodeUuid,
                        propertyId: item.property.uuid,
                        data: { required: v },
                      });
                    }}
                  />
                  <TriStateToggle
                    value={item.readOnly}
                    baseValue={item.property.readonly}
                    icons={{ on: 'mdi-lock', off: 'mdi-lock-open-variant', inherit: 'mdi-lock-outline' }}
                    labels={{
                      on: 'Read-only (click to make editable)',
                      off: 'Editable (click to inherit)',
                      inherit: (base) => `Inherit (${base ? 'read-only' : 'editable'})`,
                    }}
                    onChange={(v) => {
                      updateClassPropertyMutation.mutate({
                        classId: classNodeUuid,
                        propertyId: item.property.uuid,
                        data: { readonly: v },
                      });
                    }}
                  />
                  <TriStateToggle
                    value={item.hideWhenEmpty}
                    baseValue={item.property.hide_when_empty}
                    icons={{ on: 'mdi-eye-off', off: 'mdi-eye', inherit: 'mdi-eye-outline' }}
                    labels={{
                      on: 'Hidden when empty (click to always show)',
                      off: 'Always shown (click to inherit)',
                      inherit: (base) => `Inherit (${base ? 'hidden when empty' : 'always shown'})`,
                    }}
                    onChange={(v) => {
                      updateClassPropertyMutation.mutate({
                        classId: classNodeUuid,
                        propertyId: item.property.uuid,
                        data: { hide_when_empty: v },
                      });
                    }}
                  />
                  <Button aria-label="Property options"
                    variant="ghost"
                    size="xs"
                    icon="mdi mdi-dots-vertical"
                    className="class-property-menu-btn hover-reveal"
                    title="Property options"
                    onClick={(e) => {
                      e.stopPropagation();
                      setContextMenu({ property: item.property, x: e.clientX, y: e.clientY });
                    }}
                  />
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
              contextClassIds={[classNodeUuid]}
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
