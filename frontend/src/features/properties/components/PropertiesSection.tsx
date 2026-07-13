/**
 * PropertiesSection component for displaying and editing node properties
 *
 * Supports all property types: integer, float, text, boolean, node, selection
 * Uses SuperTags to determine which properties apply to a node.
 *
 * Text properties are now stored as node references (blocks) and displayed
 * using the TextPropertyBlock component.
 */
import { useState, useCallback, useMemo } from 'react';
import { useProperties, useSetNodeProperty, useCreateProperty, useClassProperties } from '../hooks';
import { useNode, useCreateNode, usePageClass, useSystemClasses } from '@/features/content';
import { FlashcardEditor } from '@/plugins/builtin/flashcards';
import { useNavigationStore } from '@/stores';
import { useNotifications } from '@/stores/notificationStore';
import type { Property, Node, ClassProperty, PropertyCreate } from '@/types/api';
import { SYSTEM_PROPERTY_UUIDS } from '@/constants';
import { PropertiesIcon, FlashcardIcon } from '@/components/ui/icons';
import { Button } from '@/components/ui/Button';
import { getPropertyValueRenderer } from '../utils/propertyValueRegistry';
import '../utils/registerPropertyRenderers';
import { addSelectionOption } from '@/api/properties';
import { PropertySuggestionPopup } from './PropertySuggestionPopup';
import { PropertyList, type PropertyEntry } from './PropertyList';
import type { ContextMenuItem } from '@/components/ui/ContextMenu';
import { NodeViewSection } from '@/features/content';
import { PropertyValue } from './PropertyValue';
import './PropertiesSection.css';

/**
 * Mirrors backend is_empty_value (app/features/properties/attributes.py):
 * a property counts as empty when its stored value is null/undefined, an
 * empty string, or an empty array. The backend materializes these for
 * assigned-but-emptied properties (e.g. via the "Empty property" action), so
 * key presence in properties_uuid alone does not mean "has a value".
 */
function isEmptyValue(value: unknown): boolean {
  return value == null || value === '' || (Array.isArray(value) && value.length === 0);
}

interface PropertiesSectionProps {
  nodeUuid: string;
  className?: string;
  readOnly?: boolean;
  showHiddenSection?: boolean;
  showAddProperty?: boolean;
  onNavigateToNode?: (nodeUuid: string) => void;
  onOpenInSidebar?: (nodeUuid: string) => void;
  /** Whether the section is collapsed by default */
  defaultCollapsed?: boolean;
  /** Optional filter: only show properties with these UUIDs (for linked references) */
  filterPropertyIds?: string[];
  /** Render inline without section header (for use in blocks) */
  inline?: boolean;
  /**
   * When true, only show properties that actually have a value set on this
   * node (present in node.properties_uuid) — class-declared but unset
   * properties are omitted. Intended for compact inline displays.
   */
  onlyWithValues?: boolean;
  /**
   * Whether this node is the "main" node being viewed (page in page view,
   * or the focused/zoom-root block in focused block view).
   * When false, properties whose icon_visibility is not 'hidden' are moved
   * to the hidden section — their value is already shown via block icons.
   */
  isMainNode?: boolean;
}

/**
 * Properties panel for a node
 */
export function PropertiesSection({
      nodeUuid,
      className = '',
      readOnly = false,
      showHiddenSection = true,
      showAddProperty = true,
      onNavigateToNode,
      onOpenInSidebar,
      defaultCollapsed = false,
      filterPropertyIds,
      inline = false,
      onlyWithValues = false,
      isMainNode = false }: PropertiesSectionProps) {
  const [isExpanded, setIsExpanded] = useState(!defaultCollapsed);
  const [showHidden, _setShowHidden] = useState(false);
  const [showPropertyPopup, setShowPropertyPopup] = useState(false);

  const { data: node, isLoading: nodeLoading } = useNode(nodeUuid, { include_properties: true });
  const { data: allProperties } = useProperties();
  const setPropertyMutation = useSetNodeProperty();
  const createNodeMutation = useCreateNode();
  const createPropertyMutation = useCreateProperty();
  const { pageClassUuid } = usePageClass();
  const { systemClassUuids } = useSystemClasses();

  // Get class properties for all classes the node has (with inheritance)
  // We need to fetch properties for each class
  const firstClassId = node?.classes_uuid?.[0] ?? null;
  const { data: classProperties1 } = useClassProperties(firstClassId, true);
  const secondClassId = node?.classes_uuid?.[1] ?? null;
  const { data: classProperties2 } = useClassProperties(secondClassId, true);
  const thirdClassId = node?.classes_uuid?.[2] ?? null;
  const { data: classProperties3 } = useClassProperties(thirdClassId, true);

  // Combine properties from all types and existing node properties
  const nodeProperties = useMemo(() => {
    if (!allProperties) return [];

    const entries: Array<{
      property: Property;
      value: unknown;
      source?: string;
      hidden?: boolean;
      readOnly?: boolean;
      required?: boolean;
      hasDefault?: boolean;
    }> = [];
    const addedPropertyIds = new Set<string>();

    // First, add properties from types (with inheritance)
    const allClassProperties: ClassProperty[] = [
      ...(classProperties1 ?? []),
      ...(classProperties2 ?? []),
      ...(classProperties3 ?? []),
    ];

    for (const classProp of allClassProperties) {
      const propertyUuid = classProp.property_uuid;
      if (addedPropertyIds.has(propertyUuid)) continue;
      addedPropertyIds.add(propertyUuid);

      // Find the full property definition
      const prop = allProperties.find(p => p.uuid === propertyUuid);
      if (!prop) continue;

      // Skip the system 'cover' property - it has its own UI element (CoverImage)
      if (prop.uuid === SYSTEM_PROPERTY_UUIDS.cover) continue;

      // Skip the system 'banner' property - it has its own UI element (BannerImage)
      if (prop.uuid === SYSTEM_PROPERTY_UUIDS.banner) continue;

      // Skip hidden system properties (e.g. _query_ast, _whiteboard_data)
      if (prop.name.startsWith('_')) continue;

      // Get value from node properties if it exists and is non-empty;
      // emptied values (null/''/[]) fall back to the effective default.
      const rawValue = node?.properties_uuid != null
        ? (node.properties_uuid as Record<string, unknown>)[prop.uuid]
        : undefined;
      const hasValue = !isEmptyValue(rawValue);
      const value = hasValue
        ? rawValue
        : classProp.default_value ?? prop.default_value ?? null;

      // Effective attributes: class-edge tri-state override ?? property base
      const effectiveHideWhenEmpty = classProp.hide_when_empty ?? prop.hide_when_empty;
      const effectiveReadonly = classProp.readonly ?? prop.readonly;
      const effectiveRequired = classProp.required ?? prop.required;

      entries.push({
        property: prop,
        value,
        source: classProp.class_node_name || `Class #${classProp.class_node_uuid}`,
        hidden: (classProp.hidden ?? false) || (effectiveHideWhenEmpty && !hasValue),
        readOnly: effectiveReadonly,
        required: effectiveRequired,
        hasDefault: (classProp.default_value ?? prop.default_value) != null,
      });
    }

    // Then add any additional properties that have values on this node
    // but aren't from classes
    if (node?.properties_uuid) {
      for (const prop of allProperties) {
        if (addedPropertyIds.has(prop.uuid)) continue;

        // Skip the system 'Cover' property - it has its own UI element (CoverImage)
        if (prop.uuid === SYSTEM_PROPERTY_UUIDS.cover) continue;

        // Skip the system 'Banner' property - it has its own UI element (BannerImage)
        if (prop.uuid === SYSTEM_PROPERTY_UUIDS.banner) continue;

        // Skip hidden system properties (e.g. _query_ast, _whiteboard_data)
        if (prop.name.startsWith('_')) continue;

        const hasProperty = prop.uuid in (node.properties_uuid as Record<string, unknown>);
        if (hasProperty) {
          const rawValue = (node.properties_uuid as Record<string, unknown>)[prop.uuid];
          const hasValue = !isEmptyValue(rawValue);
          entries.push({
            property: prop,
            value: rawValue,
            hidden: prop.hide_when_empty && !hasValue,
            readOnly: prop.readonly,
            required: prop.required,
            hasDefault: prop.default_value != null,
          });
          addedPropertyIds.add(prop.uuid);
        }
      }

      // Log properties that are in node.properties but NOT in allProperties
      const nodePropertyIds = Object.keys(node.properties_uuid as Record<string, unknown>);
      const missingFromAllProps = nodePropertyIds.filter(uuid => !allProperties.some(p => p.uuid === uuid));
      if (missingFromAllProps.length > 0) {
        console.warn('[PropertiesSection] Properties in node.properties but NOT in allProperties:', missingFromAllProps);
      }
    }

    return entries;
  }, [node, allProperties, classProperties1, classProperties2, classProperties3]);

  // Track which property IDs come from classes (cannot be removed, only emptied)
  const classPropertyIds = useMemo(() => {
    const ids = new Set<string>();
    const allClassProperties: ClassProperty[] = [
      ...(classProperties1 ?? []),
      ...(classProperties2 ?? []),
      ...(classProperties3 ?? []),
    ];
    for (const cp of allClassProperties) {
      ids.add(cp.property_uuid);
    }
    return ids;
  }, [classProperties1, classProperties2, classProperties3]);

  const { error: notifyError } = useNotifications();

  const handlePropertyChange = useCallback((propertyId: string, value: unknown) => {
    setPropertyMutation.mutate({ nodeUuid, propertyId, value }, {
      onError: () => notifyError('Failed to save property', 'Please try again.'),
    });
  }, [nodeUuid, setPropertyMutation, notifyError]);

  const handleCreatePage = useCallback(async (name: string, additionalClasses?: string[]): Promise<Node> => {
    return new Promise((resolve, reject) => {
      if (!pageClassUuid) {
        reject(new Error('Page class not found'));
        return;
      }
      // Include page class + any additional classes (e.g., from class_filter_uuids)
      const classUuids = [pageClassUuid, ...(additionalClasses ?? [])];
      createNodeMutation.mutate({ name, class_uuids: classUuids }, {
        onSuccess: (newPage) => resolve(newPage),
        onError: (error) => reject(error),
      });
    });
  }, [createNodeMutation, pageClassUuid]);

  // Handler for selecting an existing property to add
  const handleSelectProperty = useCallback((property: Property) => {
    // Set a default value for the property based on its type
    // Note: null values cause the property to be removed, so we use empty strings
    // for text-like types to ensure the property is actually added
    const renderer = getPropertyValueRenderer(property.type);
    let defaultValue: unknown = renderer?.getDefaultValue() ?? '';
    // For node and date types, we still need a non-null placeholder
    // Using empty string as a signal to create the property without a value
    if (defaultValue === null || defaultValue === undefined) {
      defaultValue = '';
    }
    setPropertyMutation.mutate({ nodeUuid, propertyId: property.uuid, value: defaultValue });
    setShowPropertyPopup(false);
  }, [nodeUuid, setPropertyMutation]);

  // Handler for creating a new property with full configuration
  const handleCreateNewProperty = useCallback((data: PropertyCreate & { selection_options?: { name: string; icon?: string }[] }) => {
    setShowPropertyPopup(false);
    const scope = data.scope ?? 'global';
    const node_uuid = scope === 'node' && !data.node_uuid ? nodeUuid : data.node_uuid;
    createPropertyMutation.mutate({ ...data, scope, node_uuid } as PropertyCreate, {
      onSuccess: async (newProperty) => {
        // Create any selection options that were specified at property-creation time
        if (data.selection_options && data.selection_options.length > 0) {
          await Promise.all(
            data.selection_options.map((opt, idx) =>
              addSelectionOption(newProperty.uuid, opt.name, opt.icon ?? null, idx)
            )
          );
        }

        // Add the property to this node with appropriate default value
        const defaultValue = newProperty.type === 'boolean' ? 'false' : '';
        setPropertyMutation.mutate({ nodeUuid, propertyId: newProperty.uuid, value: defaultValue });
      },
    });
  }, [createPropertyMutation, setPropertyMutation, nodeUuid]);

  // Handler for right-clicking on a property name - PropertyList will call getPropertyContextMenuItems
  const handlePropertyContextMenu = useCallback((_property: Property, event: React.MouseEvent) => {
    // PropertyList handles showing the context menu
    event.preventDefault();
  }, []);

  // Get openPropertyView and openNode from store
  const openPropertyView = useNavigationStore(state => state.openPropertyView);
  const openNode = useNavigationStore(state => state.openNode);

  // Handler for text property bullet click - opens block in focused view with property context
  const handleTextPropertyBulletClick = useCallback((blockId: string, property: Property) => {
    openNode(blockId, { propertyUuid: property.uuid, propertyName: property.name });
  }, [openNode]);

  // Get IDs of properties already applied to this node
  const appliedPropertyIds = useMemo(() => {
    return nodeProperties.map(p => p.property.uuid);
  }, [nodeProperties]);

  // Split properties into visible and hidden (based on hidden attribute, not value)
  const { visibleProperties, hiddenProperties } = useMemo(() => {
    // Apply filter if filterPropertyIds is provided
    let propertiesToSplit = filterPropertyIds && filterPropertyIds.length > 0
      ? nodeProperties.filter(({ property }) => filterPropertyIds.includes(property.uuid))
      : nodeProperties;

    if (onlyWithValues) {
      // Keep only properties that actually have a value set on this node.
      const setPropertyIds = new Set(
        Object.keys((node?.properties_uuid ?? {}) as Record<string, unknown>),
      );
      propertiesToSplit = propertiesToSplit.filter(({ property }) => setPropertyIds.has(property.uuid));
    }

    const visible: typeof nodeProperties = [];
    const hidden: typeof nodeProperties = [];

    for (const entry of propertiesToSplit) {
      // Properties are hidden if they have the hidden attribute set to true
      // NOT based on whether they have a value
      if (entry.hidden) {
        hidden.push(entry);
      } else if (
        !isMainNode &&
        entry.property.icon_visibility != null &&
        entry.property.icon_visibility !== 'hidden'
      ) {
        // When not the main node, properties whose value icon is displayed
        // inline in the block (before_content / after_bullet) are moved to
        // the hidden section — the icon already surfaces the value in context.
        hidden.push(entry);
      } else {
        visible.push(entry);
      }
    }

    return { visibleProperties: visible, hiddenProperties: hidden };
  }, [nodeProperties, filterPropertyIds, onlyWithValues, node?.properties_uuid, isMainNode]);

  // Render property value function for PropertyList
  const renderPropertyValue = useCallback((entry: PropertyEntry, isReadOnly: boolean) => {
    const { property, value } = entry;

    return (
      <PropertyValue
        property={property}
        nodeUuid={nodeUuid}
        value={value}
        readOnly={isReadOnly || entry.readOnly || setPropertyMutation.isPending}
        onChange={(newValue) => handlePropertyChange(property.uuid, newValue)}
        onNavigateToNode={onNavigateToNode}
        onCreatePage={handleCreatePage}
        onOpenInSidebar={onOpenInSidebar}
        onPropertyChange={handlePropertyChange}
        onBulletClick={(blockId) => handleTextPropertyBulletClick(blockId, property)}
      />
    );
  }, [nodeUuid, setPropertyMutation.isPending, handlePropertyChange, onNavigateToNode, handleCreatePage, onOpenInSidebar, handleTextPropertyBulletClick]);

  // Entry lookup by property UUID for context-menu attribute checks
  const nodePropertiesByUuid = useMemo(() => {
    return new Map(nodeProperties.map(entry => [entry.property.uuid, entry]));
  }, [nodeProperties]);

  // Get context menu items for a property
  const getPropertyContextMenuItems = useCallback((property: Property): ContextMenuItem[] => {
    const isClassProperty = classPropertyIds.has(property.uuid);
    const entry = nodePropertiesByUuid.get(property.uuid);
    const isReadOnlyEntry = entry?.readOnly ?? false;
    // Required entries can only be emptied when a default exists — the write
    // then resets to the default instead of being rejected by the backend.
    const canEmpty = !(entry?.required && !entry?.hasDefault);
    const items: ContextMenuItem[] = [
      {
        id: 'open-property',
        label: 'Open property',
        onClick: () => {
          openPropertyView(property.uuid);
        },
      },
    ];
    if (canEmpty) {
      items.push({
        id: 'empty-property',
        label: 'Empty property',
        disabled: isReadOnlyEntry,
        onClick: () => {
          setPropertyMutation.mutate({ nodeUuid, propertyId: property.uuid, value: '' });
        },
      });
    }
    items.push({
      id: 'remove-property',
      label: 'Remove from node',
      danger: true,
      disabled: isClassProperty || isReadOnlyEntry,
      onClick: () => {
        setPropertyMutation.mutate({ nodeUuid, propertyId: property.uuid, value: null });
      },
    });
    return items;
  }, [openPropertyView, setPropertyMutation, nodeUuid, classPropertyIds, nodePropertiesByUuid]);

  if (nodeLoading) {
    return (
      <div className={`properties-view loading ${className}`}>
        <div className="properties-skeleton">
          <div className="properties-skeleton__row" />
          <div className="properties-skeleton__row" />
        </div>
      </div>
    );
  }

  if (!node) {
    return null;
  }

  const cardClassUuid = systemClassUuids?.card;
  const isCard = cardClassUuid != null && node.classes_uuid?.includes(cardClassUuid);

  const flashcardSection = !inline && isCard ? (
    <NodeViewSection
      title="Flashcard"
      icon={<FlashcardIcon size="sm" />}
      className={`flashcard-section ${className}`}
      defaultExpanded={true}
    >
      <FlashcardEditor nodeUuid={nodeUuid} readOnly={readOnly} />
    </NodeViewSection>
  ) : null;

  // If no properties at all, show empty message (but still render flashcard editor for cards)
  if (nodeProperties.length === 0) {
    // In inline mode (block preview), nothing to show — keep the container hidden
    if (inline) return null;
    return (
      <>
        {flashcardSection}
        <section className={`properties-view ${className}`}>
          {showAddProperty && !readOnly && (
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
                onSelect={handleSelectProperty}
                onCreate={handleCreateNewProperty}
                excludeIds={appliedPropertyIds}
                contextNodeId={nodeUuid}
              />
            </div>
          )}
        </section>
      </>
    );
  }

  // Inline mode: render just the property rows without section wrapper
  if (inline) {
    // Return null if no visible properties
    if (visibleProperties.length === 0) {
      return null;
    }

    return (
      <PropertyList
        properties={visibleProperties}
        readOnly={readOnly}
        showHiddenSection={false}
        renderValue={renderPropertyValue}
        onPropertyContextMenu={handlePropertyContextMenu}
        getContextMenuItems={getPropertyContextMenuItems}
        className={`properties-inline ${className}`}
      />
    );
  }

  return (
    <>
      {flashcardSection}
      <NodeViewSection
        title="Properties"
        icon={<PropertiesIcon size="sm" />}
        count={nodeProperties.length}
        className={`properties-section ${className}`}
        expanded={isExpanded}
        onExpandedChange={setIsExpanded}
        hideWhenEmpty={true}
      >
      <section className={`properties-view`}>
        {/* Properties List using standard PropertyList component */}
        <PropertyList
          properties={[...visibleProperties, ...hiddenProperties]}
          readOnly={readOnly}
          showHiddenSection={showHiddenSection}
          defaultShowHidden={showHidden}
          renderValue={renderPropertyValue}
          onPropertyContextMenu={handlePropertyContextMenu}
          getContextMenuItems={getPropertyContextMenuItems}
        />

        {/* Add property button */}
        {showAddProperty && !readOnly && (
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
              onSelect={handleSelectProperty}
              onCreate={handleCreateNewProperty}
              excludeIds={appliedPropertyIds}
              contextNodeId={nodeUuid}
            />
          </div>
        )}
      </section>
    </NodeViewSection>
  </>
  );
}

/**
 * Compact inline properties display
 */
export function InlineProperties({
      nodeUuid,
      className = '' }: {
  nodeUuid: string;
  className?: string;
}) {
  const { data: node } = useNode(nodeUuid, { include_properties: true });

  if (!node?.properties_uuid || Object.keys(node.properties_uuid).length === 0) {
    return null;
  }

  const entries = Object.entries(node.properties_uuid as Record<string, unknown>);

  return (
    <div className={`inline-properties ${className}`}>
      {entries.slice(0, 3).map(([key, value]) => (
        <span key={key} className="inline-property">
          <span className="inline-property-name">{key}:</span>
          <span className="inline-property-value">{String(value)}</span>
        </span>
      ))}
      {entries.length > 3 && (
        <span className="inline-properties-more">+{entries.length - 3} more</span>
      )}
    </div>
  );
}
