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

interface PropertiesSectionProps {
  nodeId: number;
  className?: string;
  readOnly?: boolean;
  showHiddenSection?: boolean;
  showAddProperty?: boolean;
  onNavigateToNode?: (nodeId: number) => void;
  onOpenInSidebar?: (nodeId: number) => void;
  /** Whether the section is collapsed by default */
  defaultCollapsed?: boolean;
  /** Optional filter: only show properties with these IDs (for linked references) */
  filterPropertyIds?: number[];
  /** Render inline without section header (for use in blocks) */
  inline?: boolean;
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
  nodeId,
  className = '',
  readOnly = false,
  showHiddenSection = true,
  showAddProperty = true,
  onNavigateToNode,
  onOpenInSidebar,
  defaultCollapsed = false,
  filterPropertyIds,
  inline = false,
  isMainNode = false,
}: PropertiesSectionProps) {
  const [isExpanded, setIsExpanded] = useState(!defaultCollapsed);
  const [showHidden, _setShowHidden] = useState(false);
  const [showPropertyPopup, setShowPropertyPopup] = useState(false);

  const { data: node, isLoading: nodeLoading } = useNode(nodeId, { include_properties: true });
  const { data: allProperties } = useProperties();
  const setPropertyMutation = useSetNodeProperty();
  const createNodeMutation = useCreateNode();
  const createPropertyMutation = useCreateProperty();
  const { pageClassId } = usePageClass();
  const { systemClassIds } = useSystemClasses();

  // Get class properties for all classes the node has (with inheritance)
  // We need to fetch properties for each class
  const firstClassId = node?.classes?.[0] ?? null;
  const { data: classProperties1 } = useClassProperties(firstClassId, true);
  const secondClassId = node?.classes?.[1] ?? null;
  const { data: classProperties2 } = useClassProperties(secondClassId, true);
  const thirdClassId = node?.classes?.[2] ?? null;
  const { data: classProperties3 } = useClassProperties(thirdClassId, true);

  // Combine properties from all types and existing node properties
  const nodeProperties = useMemo(() => {
    if (!allProperties) return [];

    const entries: Array<{ property: Property; value: unknown; source?: string; hidden?: boolean }> = [];
    const addedPropertyIds = new Set<number>();

    // First, add properties from types (with inheritance)
    const allClassProperties: ClassProperty[] = [
      ...(classProperties1 ?? []),
      ...(classProperties2 ?? []),
      ...(classProperties3 ?? []),
    ];

    for (const classProp of allClassProperties) {
      if (addedPropertyIds.has(classProp.property_id)) continue;
      addedPropertyIds.add(classProp.property_id);

      // Find the full property definition
      const prop = allProperties.find(p => p.id === classProp.property_id);
      if (!prop) continue;

      // Skip the system 'cover' property - it has its own UI element (CoverImage)
      if (prop.uuid === SYSTEM_PROPERTY_UUIDS.cover) continue;

      // Skip the system 'banner' property - it has its own UI element (BannerImage)
      if (prop.uuid === SYSTEM_PROPERTY_UUIDS.banner) continue;

      // Skip hidden system properties (e.g. _query_ast, _whiteboard_data)
      if (prop.name.startsWith('_')) continue;

      // Get value from node properties if it exists
      const value = node?.properties && String(prop.id) in (node.properties as Record<string, unknown>)
        ? (node.properties as Record<string, unknown>)[String(prop.id)]
        : classProp.default_value ?? null;

      entries.push({
        property: prop,
        value,
        source: classProp.class_node_name || `Class #${classProp.class_node_id}`,
        hidden: classProp.hidden ?? false,
      });
    }

    // Then add any additional properties that have values on this node
    // but aren't from classes
    if (node?.properties) {
      for (const prop of allProperties) {
        if (addedPropertyIds.has(prop.id)) continue;

        // Skip the system 'Cover' property - it has its own UI element (CoverImage)
        if (prop.uuid === SYSTEM_PROPERTY_UUIDS.cover) continue;

        // Skip the system 'Banner' property - it has its own UI element (BannerImage)
        if (prop.uuid === SYSTEM_PROPERTY_UUIDS.banner) continue;

        // Skip hidden system properties (e.g. _query_ast, _whiteboard_data)
        if (prop.name.startsWith('_')) continue;

        const hasProperty = String(prop.id) in (node.properties as Record<string, unknown>);
        if (hasProperty) {
          entries.push({
            property: prop,
            value: (node.properties as Record<string, unknown>)[String(prop.id)],
            hidden: false,
          });
          addedPropertyIds.add(prop.id);
        }
      }

      // Log properties that are in node.properties but NOT in allProperties
      const nodePropertyIds = Object.keys(node.properties as Record<string, unknown>).map(k => parseInt(k, 10));
      const missingFromAllProps = nodePropertyIds.filter(id => !allProperties.some(p => p.id === id));
      if (missingFromAllProps.length > 0) {
        console.warn('[PropertiesSection] Properties in node.properties but NOT in allProperties:', missingFromAllProps);
      }
    }

    return entries;
  }, [node, allProperties, classProperties1, classProperties2, classProperties3]);

  // Track which property IDs come from classes (cannot be removed, only emptied)
  const classPropertyIds = useMemo(() => {
    const ids = new Set<number>();
    const allClassProperties: ClassProperty[] = [
      ...(classProperties1 ?? []),
      ...(classProperties2 ?? []),
      ...(classProperties3 ?? []),
    ];
    for (const cp of allClassProperties) {
      ids.add(cp.property_id);
    }
    return ids;
  }, [classProperties1, classProperties2, classProperties3]);

  const { error: notifyError } = useNotifications();

  const handlePropertyChange = useCallback((propertyId: number, value: unknown) => {
    setPropertyMutation.mutate({ nodeId, propertyId, value }, {
      onError: () => notifyError('Failed to save property', 'Please try again.'),
    });
  }, [nodeId, setPropertyMutation, notifyError]);

  const handleCreatePage = useCallback(async (name: string, additionalClasses?: number[]): Promise<Node> => {
    return new Promise((resolve, reject) => {
      if (!pageClassId) {
        reject(new Error('Page class not found'));
        return;
      }
      // Include page class + any additional classes (e.g., from class_filters)
      const classes = [pageClassId, ...(additionalClasses ?? [])];
      createNodeMutation.mutate({ name, classes }, {
        onSuccess: (newPage) => resolve(newPage),
        onError: (error) => reject(error),
      });
    });
  }, [createNodeMutation, pageClassId]);

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
    setPropertyMutation.mutate({ nodeId, propertyId: property.id, value: defaultValue });
    setShowPropertyPopup(false);
  }, [nodeId, setPropertyMutation]);

  // Handler for creating a new property with full configuration
  const handleCreateNewProperty = useCallback((data: PropertyCreate & { selection_options?: { name: string; icon?: string }[] }) => {
    setShowPropertyPopup(false);
    const scope = data.scope ?? 'global';
    const node_id = scope === 'node' && !data.node_id ? nodeId : data.node_id;
    createPropertyMutation.mutate({ ...data, scope, node_id } as PropertyCreate, {
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
        setPropertyMutation.mutate({ nodeId, propertyId: newProperty.id, value: defaultValue });
      },
    });
  }, [createPropertyMutation, setPropertyMutation, nodeId]);

  // Handler for right-clicking on a property name - PropertyList will call getPropertyContextMenuItems
  const handlePropertyContextMenu = useCallback((_property: Property, event: React.MouseEvent) => {
    // PropertyList handles showing the context menu
    event.preventDefault();
  }, []);

  // Get openPropertyView and openNode from store
  const openPropertyView = useNavigationStore(state => state.openPropertyView);
  const openNode = useNavigationStore(state => state.openNode);

  // Handler for text property bullet click - opens block in focused view with property context
  const handleTextPropertyBulletClick = useCallback((blockId: number, property: Property) => {
    openNode(blockId, { propertyUuid: property.uuid, propertyName: property.name });
  }, [openNode]);

  // Get IDs of properties already applied to this node
  const appliedPropertyIds = useMemo(() => {
    return nodeProperties.map(p => p.property.id);
  }, [nodeProperties]);

  // Split properties into visible and hidden (based on hidden attribute, not value)
  const { visibleProperties, hiddenProperties } = useMemo(() => {
    // Apply filter if filterPropertyIds is provided
    const propertiesToSplit = filterPropertyIds && filterPropertyIds.length > 0
      ? nodeProperties.filter(({ property }) => filterPropertyIds.includes(property.id))
      : nodeProperties;

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
  }, [nodeProperties, filterPropertyIds, isMainNode]);

  // Render property value function for PropertyList
  const renderPropertyValue = useCallback((entry: PropertyEntry, isReadOnly: boolean) => {
    const { property, value } = entry;

    return (
      <PropertyValue
        property={property}
        nodeId={nodeId}
        value={value}
        readOnly={isReadOnly || setPropertyMutation.isPending}
        onChange={(newValue) => handlePropertyChange(property.id, newValue)}
        onNavigateToNode={onNavigateToNode}
        onCreatePage={handleCreatePage}
        onOpenInSidebar={onOpenInSidebar}
        onPropertyChange={handlePropertyChange}
        onBulletClick={(blockId) => handleTextPropertyBulletClick(blockId, property)}
      />
    );
  }, [nodeId, setPropertyMutation.isPending, handlePropertyChange, onNavigateToNode, handleCreatePage, onOpenInSidebar, handleTextPropertyBulletClick]);

  // Get context menu items for a property
  const getPropertyContextMenuItems = useCallback((property: Property): ContextMenuItem[] => {
    const isClassProperty = classPropertyIds.has(property.id);
    return [
      {
        id: 'open-property',
        label: 'Open property',
        onClick: () => {
          openPropertyView(property.id);
        },
      },
      {
        id: 'empty-property',
        label: 'Empty property',
        onClick: () => {
          setPropertyMutation.mutate({ nodeId, propertyId: property.id, value: '' });
        },
      },
      {
        id: 'remove-property',
        label: 'Remove from node',
        danger: true,
        disabled: isClassProperty,
        onClick: () => {
          setPropertyMutation.mutate({ nodeId, propertyId: property.id, value: null });
        },
      },
    ];
  }, [openPropertyView, setPropertyMutation, nodeId, classPropertyIds]);

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

  const cardClassId = systemClassIds?.card;
  const isCard = cardClassId != null && node.classes?.includes(cardClassId);

  const flashcardSection = !inline && isCard ? (
    <NodeViewSection
      title="Flashcard"
      icon={<FlashcardIcon size="sm" />}
      className={`flashcard-section ${className}`}
      defaultExpanded={true}
    >
      <FlashcardEditor nodeId={nodeId} readOnly={readOnly} />
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
                contextNodeId={nodeId}
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
              contextNodeId={nodeId}
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
  nodeId,
  className = '',
}: {
  nodeId: number;
  className?: string;
}) {
  const { data: node } = useNode(nodeId, { include_properties: true });

  if (!node?.properties || Object.keys(node.properties).length === 0) {
    return null;
  }

  const entries = Object.entries(node.properties as Record<string, unknown>);

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
