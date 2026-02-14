/**
 * PropertiesSection component for displaying and editing node properties
 * 
 * Supports all property types: integer, float, text, boolean, node, selection
 * Uses SuperTags to determine which properties apply to a node.
 * 
 * Text properties are now stored as node references (blocks) and displayed
 * using the TextPropertyBlock component.
 * 
 * Variants:
 * - page: Full property display with icons, bullets before values (default)
 * - block: Compact property display for blocks
 */
import { useState, useCallback, useMemo, useRef } from 'react';
import { 
  useNode, 
  useProperties,
  useSetNodeProperty,
  useCreateNode,
  useCreateProperty,
  useClassProperties,
  useInheritedProperties,
  usePageClass,
} from '@/hooks';
import { useAppStore } from '@/stores';
import { getOrCreateDaily } from '@/api/nodes';
import type { Property, Node, ClassProperty, PropertyCreate } from '@/types/api';
import { SYSTEM_PROPERTY_UUIDS } from '@/constants';
import { mdiPlus } from '@mdi/js';
import { ChevronRightIcon, PropertiesIcon } from '../core/icons';
import type { PropertyType } from '@/types/api';

/** Default icons for each property type */
const PROPERTY_TYPE_ICONS: Record<PropertyType, string> = {
  text: '📝',
  integer: '#️⃣',
  float: '🔢',
  boolean: '☑️',
  date: '📅',
  selection: '📋',
  node: '🔗',
};

/** Get icon for a property - uses custom icon if set, otherwise default for type */
function getPropertyIcon(property: Property): string {
  return property.icon || PROPERTY_TYPE_ICONS[property.type] || '📄';
}
import { Button } from '../core/Button';
import { Dropdown } from '../core/Dropdown';
import { NodeSelector } from '../nodes/NodeSelector';
import { TextPropertyBlock } from '../blocks/TextPropertyBlock';
import { PropertySuggestionPopup } from './PropertySuggestionPopup';
import { PropertyList, type PropertyEntry } from './PropertyList';
import { ContextMenu, type ContextMenuItem } from '../core/ContextMenu';
import { Bullet } from '../blocks/Bullet';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { NodeViewSection } from '../nodes/NodeViewSection';
import './PropertiesSection.css';

export type PropertiesSectionVariant = 'page' | 'block';

interface PropertiesSectionProps {
  nodeId: number;
  className?: string;
  readOnly?: boolean;
  variant?: PropertiesSectionVariant;
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
}

interface PropertyValueProps {
  property: Property;
  nodeId: number;
  value: unknown;
  readOnly?: boolean;
  onChange: (value: unknown) => void;
  onNavigateToNode?: (nodeId: number) => void;
  onCreatePage?: (name: string, additionalClasses?: number[]) => Promise<Node>;
  onOpenInSidebar?: (nodeId: number) => void;
  onPropertyChange: (propertyId: number, value: unknown) => void;
  /** Callback when text property bullet is clicked (opens focused block view) */
  onBulletClick?: (blockId: number) => void;
}

/**
 * Date property value component.
 * Shows the day page name; click opens a hidden date picker to select a new date.
 * The selected date creates/gets the day page and stores its ID as the relation value.
 */
function DatePropertyValue({
  value,
  readOnly,
  onChange,
  onDelete,
}: {
  value: number | null;
  readOnly: boolean;
  onChange: (value: unknown) => void;
  onDelete?: () => void;
}) {
  const { data: dayNode } = useNode(value);
  const dateInputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);

  // Convert day page UUID (YYYYMMDD) to YYYY-MM-DD for the date input
  const inputDateValue = useMemo(() => {
    if (!dayNode?.uuid) return '';
    const u = dayNode.uuid;
    if (u.length === 8 && /^\d{8}$/.test(u)) {
      return `${u.slice(0, 4)}-${u.slice(4, 6)}-${u.slice(6, 8)}`;
    }
    return '';
  }, [dayNode?.uuid]);

  const handleDateChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const isoDate = e.target.value; // YYYY-MM-DD
    if (!isoDate) {
      onDelete?.();
      return;
    }
    setLoading(true);
    try {
      const newDayNode = await getOrCreateDaily(isoDate);
      onChange(newDayNode.id);
    } catch (err) {
      console.error('Failed to create/get day page:', err);
    } finally {
      setLoading(false);
    }
  }, [onChange, onDelete]);

  const handleClick = useCallback(() => {
    if (readOnly || loading) return;
    dateInputRef.current?.showPicker();
  }, [readOnly, loading]);

  const displayName = dayNode ? nodeNameToText(dayNode.name) : null;

  return (
    <div className="property-value-date-container">
      {/* Hidden date input for the native calendar picker */}
      <input
        ref={dateInputRef}
        type="date"
        value={inputDateValue}
        onChange={handleDateChange}
        className="property-value-date-hidden-input"
        tabIndex={-1}
        aria-hidden
      />
      <button
        type="button"
        className="property-value-date-display"
        onClick={handleClick}
        disabled={readOnly || loading}
        title={readOnly ? undefined : 'Click to change date'}
      >
        {loading ? (
          <span className="property-placeholder">Setting…</span>
        ) : displayName ? (
          <span className="property-value-date-name">{displayName}</span>
        ) : (
          <span className="property-placeholder">Pick a date…</span>
        )}
      </button>
      {!readOnly && value != null && (
        <Button
          variant="ghost"
          size="xs"
          className="property-value-date-clear"
          onClick={(e) => { e.stopPropagation(); onDelete?.(); }}
          title="Clear date"
        >
          ×
        </Button>
      )}
    </div>
  );
}

/**
 * Render a property value based on its type
 */
function PropertyValue({ 
  property, 
  nodeId,
  value, 
  readOnly = false, 
  onChange,
  onNavigateToNode,
  onCreatePage,
  onOpenInSidebar,
  onPropertyChange,
  onBulletClick 
}: PropertyValueProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState<string>('');

  const startEditing = useCallback(() => {
    if (readOnly) return;
    setEditValue(String(value ?? ''));
    setIsEditing(true);
  }, [readOnly, value]);

  const commitEdit = useCallback(() => {
    setIsEditing(false);
    
    // Convert value based on property type
    let finalValue: unknown;
    switch (property.type) {
      case 'integer':
        finalValue = parseInt(editValue, 10);
        if (isNaN(finalValue as number)) return;
        break;
      case 'float':
        finalValue = parseFloat(editValue);
        if (isNaN(finalValue as number)) return;
        break;
      case 'boolean':
        finalValue = editValue === 'true' || editValue === '1';
        break;
      case 'node':
        finalValue = parseInt(editValue, 10);
        if (isNaN(finalValue as number)) return;
        break;
      default:
        finalValue = editValue;
    }
    
    onChange(finalValue);
  }, [editValue, property.type, onChange]);

  switch (property.type) {
    case 'boolean':
      return (
        <input
          type="checkbox"
          checked={Boolean(value)}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.checked)}
          className="property-value-checkbox"
        />
      );

    case 'integer':
    case 'float':
      if (isEditing) {
        return (
          <input
            type="number"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitEdit();
              if (e.key === 'Escape') setIsEditing(false);
            }}
            step={property.type === 'float' ? 'any' : 1}
            autoFocus
            className="property-value-input property-value-number"
          />
        );
      }
      return (
        <Button
          variant="ghost"
          className="property-value-display"
          onClick={startEditing}
          disabled={readOnly}
        >
          {value != null ? String(value) : <span className="property-placeholder">—</span>}
        </Button>
      );

    case 'text':
      // Text properties are stored as block node references
      // Value is the block node ID (number) or null
      return (
        <TextPropertyBlock
          property={property}
          nodeId={nodeId}
          blockNodeId={typeof value === 'number' ? value : null}
          readOnly={readOnly}
          onOpenInSidebar={onOpenInSidebar}
          onPropertyChange={onPropertyChange}
          onBulletClick={onBulletClick}
        />
      );

    case 'node':
      // For node references - use NodeSelector with trigger='select'
      // eslint-disable-next-line react-hooks/rules-of-hooks
      const handleCreateNodeForProperty = useCallback(async (name: string): Promise<Node> => {
        const newPage = await onCreatePage?.(name, property.class_filters);
        if (!newPage) throw new Error('Failed to create page');
        return newPage;
      }, [onCreatePage, property.class_filters]);
      
      return (
        <NodeSelector
          trigger="select"
          value={value as number | number[] | null}
          multi={property.multi}
          searchMode="pages"
          classFilters={property.class_filters}
          placeholder="Select node..."
          searchPlaceholder="Search pages..."
          readOnly={readOnly}
          onNodeClick={onNavigateToNode}
          onChange={(newValue) => onChange(newValue)}
          onCreateNew={readOnly ? undefined : handleCreateNodeForProperty}
        />
      );

    case 'selection':
      // Selection with options
      const options = property.options ?? [];
      
      if (property.multi) {
        // Multi-value selection: use Dropdown with multiple
        // eslint-disable-next-line react-hooks/rules-of-hooks
        const selectionOptions = useMemo(() => 
          options.map(opt => ({
            value: opt.id,
            label: opt.name,
            icon: opt.icon || undefined,
          })),
          [options]
        );
        
        return (
          <Dropdown
            options={selectionOptions}
            values={Array.isArray(value) ? value.map(v => typeof v === 'object' && v !== null && 'id' in v ? (v as { id: number }).id : v) : []}
            onChangeMultiple={(newValues) => onChange(newValues)}
            placeholder="Select options..."
            multiple
            searchable
            disabled={readOnly}
            size="sm"
          />
        );
      } else {
        // Single-value selection: use Dropdown
        // eslint-disable-next-line react-hooks/rules-of-hooks
        const selectionOptions = useMemo(() => 
          options.map(opt => ({
            value: opt.id,
            label: opt.name,
            icon: opt.icon || undefined,
          })),
          [options]
        );
        
        const currentValue = typeof value === 'object' && value !== null && 'id' in value ? (value as { id: number }).id : value;
        
        return (
          <Dropdown
            options={selectionOptions}
            value={typeof currentValue === 'number' ? currentValue : null}
            onChange={(newValue) => onChange(newValue)}
            placeholder="Select an option..."
            searchable
            disabled={readOnly}
            size="sm"
            onDelete={!readOnly && currentValue != null ? () => onChange(null) : undefined}
          />
        );
      }

    case 'date':
      // Date property: value is a day page node ID (relation)
      // Display: show day page node name
      // Edit: calendar picker → creates/gets day page → sets node ID
      return (
        <DatePropertyValue
          value={typeof value === 'number' ? value : null}
          readOnly={readOnly}
          onChange={onChange}
          onDelete={!readOnly && value != null ? () => onChange(null) : undefined}
        />
      );

    default:
      return <span className="property-value-unknown">{String(value ?? '')}</span>;
  }
}

/**
 * Properties panel for a node
 */
export function PropertiesSection({
  nodeId,
  className = '',
  readOnly = false,
  variant = 'page',
  showHiddenSection = true,
  showAddProperty = true,
  onNavigateToNode,
  onOpenInSidebar,
  defaultCollapsed = false,
  filterPropertyIds,
  inline = false,
}: PropertiesSectionProps) {
  const [isExpanded, setIsExpanded] = useState(!defaultCollapsed);
  const [showHidden, setShowHidden] = useState(false);
  const [showPropertyPopup, setShowPropertyPopup] = useState(false);
  
  const { data: node, isLoading: nodeLoading } = useNode(nodeId, { include_properties: true });
  const { data: allProperties } = useProperties();
  const setPropertyMutation = useSetNodeProperty();
  const createNodeMutation = useCreateNode();
  const createPropertyMutation = useCreateProperty();
  const { pageClassId } = usePageClass();
  
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

  const handlePropertyChange = useCallback((propertyId: number, value: unknown) => {
    setPropertyMutation.mutate({ nodeId, propertyId, value });
  }, [nodeId, setPropertyMutation]);

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
    let defaultValue: unknown;
    switch (property.type) {
      case 'boolean':
        defaultValue = false;
        break;
      case 'integer':
      case 'float':
        defaultValue = 0;
        break;
      case 'text':
      case 'selection':
        defaultValue = '';
        break;
      case 'node':
      case 'date':
      default:
        // For node and date types, we still need a non-null placeholder
        // Using empty string as a signal to create the property without a value
        defaultValue = '';
        break;
    }
    setPropertyMutation.mutate({ nodeId, propertyId: property.id, value: defaultValue });
    setShowPropertyPopup(false);
  }, [nodeId, setPropertyMutation]);

  // Handler for creating a new property with full configuration
  const handleCreateNewProperty = useCallback((data: PropertyCreate & { selection_options?: { name: string; icon?: string }[] }) => {
    setShowPropertyPopup(false);
    createPropertyMutation.mutate(data, {
      onSuccess: async (newProperty) => {
        // Add selection options if provided
        if (data.selection_options && data.selection_options.length > 0) {
          // TODO: Add API call to create selection options
          // For now, they should be created by the backend if supported
        }
        
        // Add the property to this node with appropriate default value
        const defaultValue = newProperty.type === 'boolean' ? 'false' : '';
        setPropertyMutation.mutate({ nodeId, propertyId: newProperty.id, value: defaultValue });
      },
    });
  }, [createPropertyMutation, setPropertyMutation, nodeId]);

  // Handler for right-clicking on a property name - PropertyList will call getPropertyContextMenuItems
  const handlePropertyContextMenu = useCallback((property: Property, event: React.MouseEvent) => {
    // PropertyList handles showing the context menu
    event.preventDefault();
  }, []);

  // Get openPropertyView and openNode from store
  const openPropertyView = useAppStore(state => state.openPropertyView);
  const openNode = useAppStore(state => state.openNode);

  // Handler for text property bullet click - opens block in focused view with property context
  const handleTextPropertyBulletClick = useCallback((blockId: number, property: Property) => {
    openNode(blockId, { propertyId: property.id, propertyName: property.name });
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
      } else {
        visible.push(entry);
      }
    }
    
    return { visibleProperties: visible, hiddenProperties: hidden };
  }, [nodeProperties, filterPropertyIds]);

  const variantClass = variant === 'block' ? 'block-variant' : '';
  
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
    return [
      {
        id: 'open-property',
        label: 'Open property',
        onClick: () => {
          openPropertyView(property.id);
        },
      },
      {
        id: 'remove-property',
        label: 'Remove from node',
        danger: true,
        disabled: property.is_system,
        onClick: () => {
          setPropertyMutation.mutate({ nodeId, propertyId: property.id, value: null });
        },
      },
    ];
  }, [openPropertyView, setPropertyMutation, nodeId]);

  if (nodeLoading) {
    return (
      <div className={`properties-view loading ${variantClass} ${className}`}>
        <div className="properties-skeleton">Loading properties...</div>
      </div>
    );
  }

  if (!node) {
    return null;
  }

  // If no properties at all, show empty message
  if (nodeProperties.length === 0) {
    return (
      <section className={`properties-view ${variantClass} ${className}`}>
        {showAddProperty && !readOnly && (
          <div className="properties-add-wrapper">
            <Button 
              icon={mdiPlus}
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
            />
          </div>
        )}
      </section>
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
        variant={variant}
      />
    );
  }

  return (
    <NodeViewSection
      title="Properties"
      icon={<PropertiesIcon size="sm" />}
      count={nodeProperties.length}
      className={`properties-section ${variantClass} ${className}`}
      expanded={isExpanded}
      onExpandedChange={setIsExpanded}
      hideWhenEmpty={true}
    >
      <section className={`properties-view ${variantClass}`}>
        {/* Properties List using standard PropertyList component */}
        <PropertyList
          properties={[...visibleProperties, ...hiddenProperties]}
          readOnly={readOnly}
          showHiddenSection={showHiddenSection}
          defaultShowHidden={showHidden}
          renderValue={renderPropertyValue}
          onPropertyContextMenu={handlePropertyContextMenu}
          getContextMenuItems={getPropertyContextMenuItems}
          variant={variant}
        />

        {/* Inherited Properties Section - only for class nodes */}
        {firstClassId && (
          <InheritedPropertiesSection
            classNodeId={firstClassId}
          />
        )}

        {/* Add property button */}
        {showAddProperty && !readOnly && (
          <div className="properties-add-wrapper">
            <Button 
              icon={mdiPlus}
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
            />
          </div>
        )}
      </section>
    </NodeViewSection>
  );
}

/**
 * Inherited Properties Section - shows properties inherited from extended classes
 */
function InheritedPropertiesSection({
  classNodeId,
}: {
  classNodeId: number;
}) {
  const [showInherited, setShowInherited] = useState(false);
  const { data: inheritedProps, isLoading } = useInheritedProperties(classNodeId);

  if (isLoading) return null;
  if (!inheritedProps || inheritedProps.length === 0) return null;

  return (
    <div className="properties-inherited-section">
      <Button 
        variant="ghost"
        className={`properties-inherited-toggle ${showInherited ? 'expanded' : ''}`}
        onClick={() => setShowInherited(!showInherited)}
      >
        <ChevronRightIcon size="xs" />
        <span>Inherited Properties ({inheritedProps.length})</span>
      </Button>
      
      {showInherited && (
        <div className="properties-inherited-list">
          {inheritedProps.map((prop) => (
            <div 
              key={prop.property_id} 
              className={`property-row property-inherited ${prop.is_overridden ? 'property-overridden' : ''}`}
              title={prop.is_overridden ? `Overridden by dedicated class property` : undefined}
            >
              <div className="property-label">
                <span className="property-name">
                  {prop.is_overridden && <span className="property-overridden-indicator">⊘ </span>}
                  {prop.property_name}
                </span>
                <span className="property-inherited-source" title={`Inherited from ${prop.from_class_name}`}>
                  from {prop.from_class_name}
                </span>
              </div>
              <div className="property-value-container">
                <div className="property-value-wrapper">
                  <Bullet interactive={false} size="xs" />
                  <span className="property-inherited-value">
                    {prop.default_value != null ? String(prop.default_value) : <span className="property-placeholder">—</span>}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
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

export default PropertiesSection;

