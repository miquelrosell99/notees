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
import { useState, useCallback, useMemo } from 'react';
import { 
  useNode, 
  useProperties,
  useSetNodeProperty,
  useCreatePage,
  useCreateProperty,
  useTypeProperties,
} from '@/hooks';
import { useNodesStore } from '@/stores';
import type { Property, Node, TypeProperty, PropertyType } from '@/types/api';
import { SYSTEM_PROPERTY_UUIDS } from '@/constants';
import { mdiPlus } from '@mdi/js';
import { CalendarIcon, ChevronRightIcon, PropertiesIcon } from './icons';
import { Button } from './core/Button';
import { NodePicker } from './nodes/NodePicker';
import { TextPropertyBlock } from './blocks/TextPropertyBlock';
import { PropertyPickerModal } from './properties/PropertyPickerModal';
import { PropertyConfigPanel } from './properties/PropertyConfigPanel';
import { Bullet } from './blocks/Bullet';
import { NodeViewSection } from './nodes/NodeViewSection';
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
}

interface PropertyValueProps {
  property: Property;
  nodeId: number;
  value: unknown;
  readOnly?: boolean;
  onChange: (value: unknown) => void;
  onNavigateToNode?: (nodeId: number) => void;
  onCreatePage?: (name: string) => Promise<Node>;
  onOpenInSidebar?: (nodeId: number) => void;
  onPropertyChange: (propertyId: number, value: unknown) => void;
  /** Callback when text property bullet is clicked (opens focused block view) */
  onBulletClick?: (blockId: number) => void;
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
      // For node references, use NodePicker which filters to pages + tag_filters
      return (
        <NodePicker
          property={property}
          value={value as number | number[] | null}
          multi={property.multi}
          readOnly={readOnly}
          onChange={(newValue) => onChange(newValue)}
          onNavigate={onNavigateToNode}
          onCreate={onCreatePage}
        />
      );

    case 'selection':
      // Selection with options
      const options = property.options ?? [];
      return (
        <select
          value={String(value ?? '')}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value)}
          className="property-value-select"
        >
          <option value="">Select...</option>
          {options.map((opt) => (
            <option key={opt.id} value={opt.name}>
              {opt.icon ? `${opt.icon} ` : ''}{opt.name}
            </option>
          ))}
        </select>
      );

    case 'date':
      // Date picker that links to day page when clicked
      const dateValue = value ? String(value) : '';
      return (
        <div className="property-value-date-container">
          <input
            type="date"
            value={dateValue}
            disabled={readOnly}
            onChange={(e) => onChange(e.target.value)}
            className="property-value-date-input"
          />
          {dateValue && (
            <Button
              variant="ghost"
              size="xs"
              className="property-value-date-link"
              onClick={() => {
                // Navigate to day page via UUID (YYYYMMDD format)
                const dateParts = dateValue.split('-');
                if (dateParts.length === 3) {
                  const uuid = `${dateParts[0]}${dateParts[1]}${dateParts[2]}`;
                  // TODO: Find node by UUID and navigate
                  void uuid; // Silence unused variable warning
                }
              }}
              title="Go to day page"
            >
              <CalendarIcon size="xs" />
            </Button>
          )}
        </div>
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
}: PropertiesSectionProps) {
  const [isExpanded, setIsExpanded] = useState(!defaultCollapsed);
  const [showHidden, setShowHidden] = useState(false);
  const [showPickerModal, setShowPickerModal] = useState(false);
  const [showConfigPanel, setShowConfigPanel] = useState(false);
  const [configPanelPosition, setConfigPanelPosition] = useState<{ x: number; y: number } | undefined>();
  const [editingProperty, setEditingProperty] = useState<Property | null>(null);
  
  const { data: node, isLoading: nodeLoading } = useNode(nodeId, { include_properties: true });
  const { data: allProperties } = useProperties();
  const setPropertyMutation = useSetNodeProperty();
  const createPageMutation = useCreatePage();
  const createPropertyMutation = useCreateProperty();
  
  // Get type properties for all types the node has (with inheritance)
  // We need to fetch properties for each type
  const firstTypeId = node?.types?.[0] ?? null;
  const { data: typeProperties1 } = useTypeProperties(firstTypeId, true);
  const secondTypeId = node?.types?.[1] ?? null;
  const { data: typeProperties2 } = useTypeProperties(secondTypeId, true);
  const thirdTypeId = node?.types?.[2] ?? null;
  const { data: typeProperties3 } = useTypeProperties(thirdTypeId, true);

  // Combine properties from all types and existing node properties
  const nodeProperties = useMemo(() => {
    if (!allProperties) return [];
    
    const entries: Array<{ property: Property; value: unknown; source?: string; hidden?: boolean }> = [];
    const addedPropertyIds = new Set<number>();
    
    // First, add properties from types (with inheritance)
    const allTypeProperties: TypeProperty[] = [
      ...(typeProperties1 ?? []),
      ...(typeProperties2 ?? []),
      ...(typeProperties3 ?? []),
    ];
    
    for (const typeProp of allTypeProperties) {
      if (addedPropertyIds.has(typeProp.property_id)) continue;
      addedPropertyIds.add(typeProp.property_id);
      
      // Find the full property definition
      const prop = allProperties.find(p => p.id === typeProp.property_id);
      if (!prop) continue;
      
      // Skip the system 'types' property - it's displayed separately in the Types row
      if (prop.uuid === SYSTEM_PROPERTY_UUIDS.types) continue;
      
      // Skip the system 'cover' property - it has its own UI element (CoverImage)
      if (prop.uuid === SYSTEM_PROPERTY_UUIDS.cover) continue;
      
      // Skip the system 'banner' property - it has its own UI element (BannerImage)
      if (prop.uuid === SYSTEM_PROPERTY_UUIDS.banner) continue;
      
      // Get value from node properties if it exists
      const key = prop.name.toLowerCase().replace(/\s+/g, '_');
      const value = node?.properties && key in (node.properties as Record<string, unknown>)
        ? (node.properties as Record<string, unknown>)[key]
        : typeProp.default_value ?? null;
      
      entries.push({
        property: prop,
        value,
        source: typeProp.type_node_name || `Type #${typeProp.type_node_id}`,
        hidden: typeProp.hidden ?? false,
      });
    }
    
    // Then add any additional properties that have values on this node
    // but aren't from types
    if (node?.properties) {
      for (const prop of allProperties) {
        if (addedPropertyIds.has(prop.id)) continue;
        
        // Skip the system 'types' property - it's displayed separately in the Types row
        if (prop.uuid === SYSTEM_PROPERTY_UUIDS.types) continue;
        
        // Skip the system 'cover' property - it has its own UI element (CoverImage)
        if (prop.uuid === SYSTEM_PROPERTY_UUIDS.cover) continue;
        
        // Skip the system 'banner' property - it has its own UI element (BannerImage)
        if (prop.uuid === SYSTEM_PROPERTY_UUIDS.banner) continue;
        
        const key = prop.name.toLowerCase().replace(/\s+/g, '_');
        if (key in (node.properties as Record<string, unknown>)) {
          entries.push({
            property: prop,
            value: (node.properties as Record<string, unknown>)[key],
            hidden: false,
          });
          addedPropertyIds.add(prop.id);
        }
      }
    }
    
    return entries;
  }, [node, allProperties, typeProperties1, typeProperties2, typeProperties3]);

  const handlePropertyChange = useCallback((propertyId: number, value: unknown) => {
    setPropertyMutation.mutate({ nodeId, propertyId, value });
  }, [nodeId, setPropertyMutation]);

  const handleCreatePage = useCallback(async (name: string): Promise<Node> => {
    return new Promise((resolve, reject) => {
      createPageMutation.mutate({ name }, {
        onSuccess: (newPage) => resolve(newPage),
        onError: (error) => reject(error),
      });
    });
  }, [createPageMutation]);

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
    setShowPickerModal(false);
  }, [nodeId, setPropertyMutation]);

  // Handler for creating a new property
  const handleCreateProperty = useCallback((name: string, type: PropertyType, isLocal: boolean) => {
    createPropertyMutation.mutate({ name, type, is_local: isLocal }, {
      onSuccess: (newProperty) => {
        // After creating the property, add it to this node with a default value
        handleSelectProperty(newProperty);
      },
    });
  }, [createPropertyMutation, handleSelectProperty]);

  // Handler for clicking on a property name to edit it
  const handlePropertyNameClick = useCallback((property: Property, event: React.MouseEvent) => {
    // Position the config panel near the click
    const rect = (event.target as HTMLElement).getBoundingClientRect();
    setConfigPanelPosition({ x: rect.left, y: rect.bottom + 4 });
    setEditingProperty(property);
    setShowConfigPanel(true);
  }, []);

  // Handler for property updates from config panel
  const handlePropertyUpdate = useCallback((updatedProperty: Property) => {
    // The config panel handles the API call, we just need to refresh
    // This will trigger a re-fetch of properties
    setEditingProperty(updatedProperty);
  }, []);

  // Handler for property deletion from config panel
  const handlePropertyDelete = useCallback((_propertyId: number) => {
    // Property was deleted, close the panel
    setShowConfigPanel(false);
    setEditingProperty(null);
    // The properties will refresh automatically via React Query
  }, []);

  // Get openPropertyView and openNode from store
  const openPropertyView = useNodesStore(state => state.openPropertyView);
  const openNode = useNodesStore(state => state.openNode);

  // Handler for opening property view
  const handleOpenPropertyView = useCallback((propertyId: number) => {
    openPropertyView(propertyId);
  }, [openPropertyView]);

  // Handler for text property bullet click - opens block in focused view with property context
  const handleTextPropertyBulletClick = useCallback((blockId: number, property: Property) => {
    openNode(blockId, 'block', { propertyId: property.id, propertyName: property.name });
  }, [openNode]);

  // Get IDs of properties already applied to this node
  const appliedPropertyIds = useMemo(() => {
    return nodeProperties.map(p => p.property.id);
  }, [nodeProperties]);

  // Split properties into visible and hidden (based on hidden attribute, not value)
  const { visibleProperties, hiddenProperties } = useMemo(() => {
    const visible: typeof nodeProperties = [];
    const hidden: typeof nodeProperties = [];
    
    for (const entry of nodeProperties) {
      // Properties are hidden if they have the hidden attribute set to true
      // NOT based on whether they have a value
      if (entry.hidden) {
        hidden.push(entry);
      } else {
        visible.push(entry);
      }
    }
    
    return { visibleProperties: visible, hiddenProperties: hidden };
  }, [nodeProperties]);

  const variantClass = variant === 'block' ? 'block-variant' : '';

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
          <>
            <Button 
              icon={mdiPlus}
              className="properties-add-btn" 
              onClick={() => setShowPickerModal(true)}
              title="Add property"
              size="sm"
              variant="ghost"
            >
              Add property
            </Button>
            <PropertyPickerModal
              isOpen={showPickerModal}
              onClose={() => setShowPickerModal(false)}
              onSelect={handleSelectProperty}
              onCreate={handleCreateProperty}
              excludeIds={appliedPropertyIds}
            />
          </>
        )}
      </section>
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
        {/* Visible properties (those with values) */}
        <div className="properties-list">
          {visibleProperties.map(({ property, value, source }) => (
            <div key={property.id} className="property-row">
              <Button 
                variant="ghost"
                className="property-label property-label-clickable"
                onClick={(e) => !readOnly && handlePropertyNameClick(property, e)}
                title="Click to edit property"
              >
                {property.icon && <span className="property-icon">{property.icon}</span>}
                <span className="property-name">{property.name}</span>
                {source && <span className="property-source" title={`From ${source}`}>({source})</span>}
              </Button>
              <div className="property-value-container">
                <div className="property-value-wrapper">
                  {/* Decorative bullet for non-text properties */}
                  {property.type !== 'text' && (
                    <Bullet interactive={false} size="xs" />
                  )}
                  {/* Interactive bullet for text properties - clicking opens block in focused view */}
                  {property.type === 'text' && (
                    <Bullet 
                      nodeId={typeof value === 'number' ? value : undefined}
                      interactive={!readOnly && typeof value === 'number'}
                      onClick={() => typeof value === 'number' && handleTextPropertyBulletClick(value, property)}
                      onShiftClick={(blockId) => onOpenInSidebar?.(blockId)}
                      size="xs"
                    />
                  )}
                  <PropertyValue
                    property={property}
                    nodeId={nodeId}
                    value={value}
                    readOnly={readOnly || setPropertyMutation.isPending}
                    onChange={(newValue) => handlePropertyChange(property.id, newValue)}
                    onNavigateToNode={onNavigateToNode}
                    onCreatePage={handleCreatePage}
                    onOpenInSidebar={onOpenInSidebar}
                    onPropertyChange={handlePropertyChange}
                    onBulletClick={(blockId) => handleTextPropertyBulletClick(blockId, property)}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Hidden properties section (properties without values) */}
        {showHiddenSection && hiddenProperties.length > 0 && (
          <div className="properties-hidden-section">
            <Button 
              variant="ghost"
              className={`properties-hidden-toggle ${showHidden ? 'expanded' : ''}`}
              onClick={() => setShowHidden(!showHidden)}
            >
              <ChevronRightIcon size="xs" />
              <span>Hidden properties</span>
            </Button>
            
            {showHidden && (
              <div className="properties-hidden-list">
                {hiddenProperties.map(({ property, value, source: _source }) => (
                  <div key={property.id} className="property-row">
                    <Button 
                      variant="ghost"
                      className="property-label property-label-clickable"
                      onClick={(e) => !readOnly && handlePropertyNameClick(property, e)}
                      title="Click to edit property"
                    >
                      {property.icon && <span className="property-icon">{property.icon}</span>}
                      <span className="property-name">{property.name}</span>
                    </Button>
                    <div className="property-value-container">
                      <div className="property-value-wrapper">
                        {/* Decorative bullet for non-text properties */}
                        {property.type !== 'text' && (
                          <Bullet interactive={false} size="xs" />
                        )}
                        {/* Interactive bullet for text properties */}
                        {property.type === 'text' && (
                          <Bullet 
                            nodeId={typeof value === 'number' ? value : undefined}
                            interactive={!readOnly && typeof value === 'number'}
                            onClick={() => typeof value === 'number' && handleTextPropertyBulletClick(value, property)}
                            onShiftClick={(blockId) => onOpenInSidebar?.(blockId)}
                            size="xs"
                          />
                        )}
                        <PropertyValue
                          property={property}
                          nodeId={nodeId}
                          value={value}
                          readOnly={readOnly || setPropertyMutation.isPending}
                          onChange={(newValue) => handlePropertyChange(property.id, newValue)}
                          onNavigateToNode={onNavigateToNode}
                          onCreatePage={handleCreatePage}
                          onOpenInSidebar={onOpenInSidebar}
                          onPropertyChange={handlePropertyChange}
                          onBulletClick={(blockId) => handleTextPropertyBulletClick(blockId, property)}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Add property button */}
        {showAddProperty && !readOnly && (
          <div className="properties-add">
            <Button 
              icon={mdiPlus}
              className="properties-add-btn" 
              onClick={() => setShowPickerModal(true)}
              title="Add property"
              size="sm"
              variant="ghost"
            >
              Add property
            </Button>
          </div>
        )}

        {/* Property Picker Modal */}
        <PropertyPickerModal
          isOpen={showPickerModal}
          onClose={() => setShowPickerModal(false)}
          onSelect={handleSelectProperty}
          onCreate={handleCreateProperty}
          excludeIds={appliedPropertyIds}
        />

        {/* Property Config Panel */}
        <PropertyConfigPanel
          isOpen={showConfigPanel}
          property={editingProperty}
          position={configPanelPosition}
          onClose={() => {
            setShowConfigPanel(false);
            setEditingProperty(null);
          }}
          onUpdate={handlePropertyUpdate}
          onDelete={handlePropertyDelete}
          onOpenPropertyView={handleOpenPropertyView}
        />
      </section>
    </NodeViewSection>
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
