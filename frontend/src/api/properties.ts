/**
 * Properties API functions
 */
import api from '@/api/client';
import { queryClient } from '@/lib/queryClient';
import { propertyKeys } from '@/hooks/queryKeys';
import type {
  Property,
  PropertyCreate,
  PropertyUpdate,
  PropertiesResponse,
  SelectionOption,
  ClassProperty,
  ClassPropertiesResponse,
  ClassExtends,
  ClassExtendsResponse,
  InheritedProperty,
  ExtendedByClass,
} from '@/types/api';
import { resolveNodeUuid, resolvePropertyUuid } from '@/utils/resolveNodeUuid';

const BASE = '/properties';

function resolveRequiredPropertyUuid(id: string | number): string {
  const uuid = typeof id === 'string' ? id : resolvePropertyUuid(id);
  if (!uuid) {
    throw new Error(`Unable to resolve UUID for property id ${id}`);
  }
  return uuid;
}

function resolveSelectionLineUuid(id: string | number): string | null {
  if (typeof id === 'string') return id;

  const queryCache = queryClient.getQueryCache();
  const candidates = queryCache.findAll({ queryKey: propertyKeys.all });
  for (const query of candidates) {
    const uuid = findUuidForId(query.state.data, id);
    if (uuid) return uuid;
  }
  return null;
}

function resolveRequiredSelectionLineUuid(id: string | number): string {
  const uuid = resolveSelectionLineUuid(id);
  if (!uuid) {
    throw new Error(`Unable to resolve UUID for selection line id ${id}`);
  }
  return uuid;
}

function findUuidForId(data: unknown, targetId: number): string | null {
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findUuidForId(item, targetId);
      if (found) return found;
    }
    return null;
  }

  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    if (typeof record.id === 'number' && record.id === targetId) {
      if (typeof record.uuid === 'string') {
        return record.uuid;
      }
      if (typeof record.selection_line_uuid === 'string') {
        return record.selection_line_uuid;
      }
    }

    for (const value of Object.values(record)) {
      if (Array.isArray(value)) {
        const found = findUuidForId(value, targetId);
        if (found) return found;
      }
    }
  }

  return null;
}

/**
 * List all property definitions
 */
export async function listProperties(): Promise<Property[]> {
  const response = await api.get<PropertiesResponse>(`${BASE}/`);
  return response.data.properties ?? [];
}

/**
 * Get properties available in a given context:
 * global properties + class-scoped properties (if contextClassIds) + node-scoped (if contextNodeId)
 */
export async function getAvailableProperties(opts: {
  contextNodeId?: string | number;
  contextClassIds?: (string | number)[];
}): Promise<Property[]> {
  const params: Record<string, string> = {};
  if (opts.contextNodeId != null) {
    params.context_node_uuid = resolveNodeUuid(opts.contextNodeId);
  }
  if (opts.contextClassIds?.length) {
    params.context_class_ids = opts.contextClassIds.map(resolveNodeUuid).join(',');
  }
  const response = await api.get<PropertiesResponse>(`${BASE}/available`, { params });
  return response.data.properties ?? [];
}

/**
 * Create a new property
 */
export async function createProperty(data: PropertyCreate): Promise<Property> {
  const response = await api.post<Property>(`${BASE}/`, data);
  return response.data;
}

/**
 * Get a property by ID
 */
export async function getProperty(id: string | number): Promise<Property> {
  const response = await api.get<Property>(`${BASE}/${resolveRequiredPropertyUuid(id)}`);
  return response.data;
}

/**
 * Get a property by UUID
 */
export async function getPropertyByUuid(propertyUuid: string): Promise<Property> {
  const response = await api.get<Property>(`${BASE}/uuid/${propertyUuid}`);
  return response.data;
}

/**
 * Update a property
 */
export async function updateProperty(
  id: string | number,
  data: PropertyUpdate
): Promise<Property> {
  const response = await api.put<Property>(
    `${BASE}/${resolveRequiredPropertyUuid(id)}`,
    data
  );
  return response.data;
}

/**
 * Delete a property
 */
export async function deleteProperty(id: string | number): Promise<void> {
  await api.delete(`${BASE}/${resolveRequiredPropertyUuid(id)}`);
}

// ============== Selection Options ==============

/**
 * Add a selection option
 */
export async function addSelectionOption(
  propertyId: string | number,
  name: string,
  icon?: string | null,
  sequence?: number,
  color?: string | null
): Promise<SelectionOption> {
  const response = await api.post<SelectionOption>(
    `${BASE}/${resolveRequiredPropertyUuid(propertyId)}/selection-lines`,
    {
      name,
      icon,
      color,
      order: sequence ?? 0,
    }
  );
  return response.data;
}

/**
 * Update a selection option (e.g. change icon or color)
 */
export async function updateSelectionOption(
  propertyId: string | number,
  optionId: string | number,
  data: { icon?: string | null; name?: string; order?: number; color?: string | null }
): Promise<SelectionOption> {
  const response = await api.put<SelectionOption>(
    `${BASE}/${resolveRequiredPropertyUuid(propertyId)}/selection-lines/${resolveRequiredSelectionLineUuid(optionId)}`,
    data
  );
  return response.data;
}

/**
 * Delete a selection option
 */
export async function deleteSelectionOption(
  propertyId: string | number,
  optionId: string | number
): Promise<void> {
  await api.delete(
    `${BASE}/${resolveRequiredPropertyUuid(propertyId)}/selection-lines/${resolveRequiredSelectionLineUuid(optionId)}`
  );
}

/**
 * Reorder selection options by updating their order field.
 * Accepts the options in the desired new order.
 */
export async function reorderSelectionOptions(
  propertyId: string | number,
  orderedOptions: Array<{ id: string | number }>
): Promise<void> {
  const propertyUuid = resolveRequiredPropertyUuid(propertyId);
  await Promise.all(
    orderedOptions.map((opt, index) =>
      api.put(`${BASE}/${propertyUuid}/selection-lines/${resolveRequiredSelectionLineUuid(opt.id)}`, {
        order: index,
      })
    )
  );
}

// ============== Class Filters ==============

/**
 * Add a class filter to a node-type property
 */
export async function addClassFilter(
  propertyId: string | number,
  classNodeId: string | number
): Promise<{ id: number; class_node_id: number }> {
  const response = await api.post<{ id: number; class_node_id: number }>(
    `${BASE}/${resolveRequiredPropertyUuid(propertyId)}/class-filters`,
    null,
    { params: { class_node_uuid: resolveNodeUuid(classNodeId) } }
  );
  return response.data;
}

/**
 * Remove a class filter from a property
 */
export async function removeClassFilter(
  propertyId: string | number,
  classNodeId: string | number
): Promise<void> {
  await api.delete(
    `${BASE}/${resolveRequiredPropertyUuid(propertyId)}/class-filters/${resolveNodeUuid(classNodeId)}`
  );
}

// ============== Type Properties ==============

/**
 * Get properties linked to a class
 */
export async function getClassProperties(
  classNodeId: string | number,
  includeInherited: boolean = false
): Promise<ClassProperty[]> {
  const response = await api.get<ClassPropertiesResponse>(
    `${BASE}/classes/${resolveNodeUuid(classNodeId)}/properties`,
    { params: { include_inherited: includeInherited } }
  );
  return response.data.class_properties ?? [];
}

/**
 * Link a property to a class
 */
export async function addClassProperty(
  classNodeId: string | number,
  propertyId: string | number,
  sequence?: number,
  defaultValue?: unknown,
  required?: boolean
): Promise<ClassProperty> {
  const response = await api.post<ClassProperty>(
    `${BASE}/classes/${resolveNodeUuid(classNodeId)}/properties`,
    {
      property_uuid: resolveRequiredPropertyUuid(propertyId),
      sequence: sequence ?? 0,
      default_value: defaultValue,
      required: required ?? false,
    }
  );
  return response.data;
}

/**
 * Remove a property from a class
 */
export async function removeClassProperty(
  classNodeId: string | number,
  propertyId: string | number
): Promise<void> {
  await api.delete(
    `${BASE}/classes/${resolveNodeUuid(classNodeId)}/properties/${resolveRequiredPropertyUuid(propertyId)}`
  );
}

/**
 * Reorder properties within a class by providing property IDs in the desired order
 */
export async function reorderClassProperties(
  classNodeId: string | number,
  propertyIds: (string | number)[]
): Promise<void> {
  await api.put(`${BASE}/classes/${resolveNodeUuid(classNodeId)}/properties/reorder`, {
    property_uuids: propertyIds.map(resolveRequiredPropertyUuid),
  });
}

/**
 * Update class property binding (required, hidden flags)
 */
export async function updateClassProperty(
  classNodeId: string | number,
  propertyId: string | number,
  data: { required?: boolean; hidden?: boolean }
): Promise<ClassProperty> {
  const response = await api.patch<ClassProperty>(
    `${BASE}/classes/${resolveNodeUuid(classNodeId)}/properties/${resolveRequiredPropertyUuid(propertyId)}`,
    data
  );
  return response.data;
}

/**
 * Get property usage stats (usage_count per property_id)
 */
export async function getPropertyStats(): Promise<
  Array<{ property_id: number; property_uuid: string; usage_count: number }>
> {
  const response = await api.get<{
    stats: Array<{ property_id: number; property_uuid: string; usage_count: number }>;
  }>(`${BASE}/stats`);
  return response.data.stats ?? [];
}

/**
 * Get property suggestions for a node, ranked by usage frequency
 */
export async function getPropertySuggestions(nodeId?: string | number): Promise<
  Array<{
    property_id: number;
    property_uuid: string;
    name: string;
    icon: string | null;
    type: string;
    usage_count: number;
    already_assigned: boolean;
  }>
> {
  const params = nodeId != null ? { node_uuid: resolveNodeUuid(nodeId) } : {};
  const response = await api.get<{
    suggestions: Array<{
      property_id: number;
      property_uuid: string;
      name: string;
      icon: string | null;
      type: string;
      usage_count: number;
      already_assigned: boolean;
    }>;
  }>(`${BASE}/suggestions`, { params });
  return response.data.suggestions ?? [];
}

// ============== Class Extends (Inheritance) ==============

/**
 * Get classes that a class extends (inherits from)
 */
export async function getClassExtends(classNodeId: string | number): Promise<ClassExtends[]> {
  const response = await api.get<ClassExtendsResponse>(
    `${BASE}/classes/${resolveNodeUuid(classNodeId)}/extends`
  );
  return response.data.extends ?? [];
}

/**
 * Add a class that this class extends (inherits from)
 */
export async function addClassExtends(
  classNodeId: string | number,
  extendsClassNodeId: string | number,
  sequence?: number
): Promise<ClassExtends> {
  const response = await api.post<ClassExtends>(
    `${BASE}/classes/${resolveNodeUuid(classNodeId)}/extends`,
    {
      extends_class_node_uuid: resolveNodeUuid(extendsClassNodeId),
      sequence: sequence ?? 0,
    }
  );
  return response.data;
}

/**
 * Remove a class extension (inheritance link)
 */
export async function removeClassExtends(
  classNodeId: string | number,
  extendsClassNodeId: string | number
): Promise<void> {
  await api.delete(
    `${BASE}/classes/${resolveNodeUuid(classNodeId)}/extends/${resolveNodeUuid(extendsClassNodeId)}`
  );
}

/**
 * Get inherited properties for a class (from extended classes)
 */
export async function getInheritedProperties(
  classNodeId: string | number
): Promise<InheritedProperty[]> {
  const response = await api.get<{ inherited_properties: InheritedProperty[] }>(
    `${BASE}/classes/${resolveNodeUuid(classNodeId)}/inherited-properties`
  );
  return response.data.inherited_properties ?? [];
}

/**
 * Get classes that extend this class (reverse lookup)
 */
export async function getExtendedByClasses(
  classNodeId: string | number
): Promise<ExtendedByClass[]> {
  const response = await api.get<{ classes: ExtendedByClass[] }>(
    `${BASE}/classes/${resolveNodeUuid(classNodeId)}/extended-by`
  );
  return response.data.classes ?? [];
}

/**
 * Validate class extends (check for circular inheritance)
 */
export async function validateClassExtends(
  classNodeId: string | number,
  extendsIds: (string | number)[]
): Promise<{ valid: boolean; error?: string; cycle_path?: string[] }> {
  const response = await api.post<{
    valid: boolean;
    error?: string;
    cycle_path?: string[];
  }>(
    `${BASE}/classes/${resolveNodeUuid(classNodeId)}/validate-extends`,
    extendsIds.map(resolveNodeUuid)
  );
  return response.data;
}

// ============== Batch Operations ==============

export interface BatchSetPropertyItem {
  node_id: string | number;
  property_id: string | number;
  value: unknown;
}

export interface BatchSetPropertyResponse {
  results: Array<{ index: number; success: boolean; error?: string | null }>;
  succeeded: number;
  failed: number;
}

/**
 * Set property values on multiple nodes in a single request.
 */
export async function batchSetPropertyValues(
  items: BatchSetPropertyItem[]
): Promise<BatchSetPropertyResponse> {
  const response = await api.post<BatchSetPropertyResponse>(`${BASE}/batch/set`, {
    items: items.map((item) => ({
      node_uuid: resolveNodeUuid(item.node_id),
      property_uuid: resolveRequiredPropertyUuid(item.property_id),
      value: item.value,
    })),
  });
  return response.data;
}

export interface BatchClassPropertyItem {
  class_node_id: string | number;
  property_id: string | number;
}

export interface BatchClassPropertyResponse {
  results: Array<{ index: number; success: boolean; error?: string | null }>;
  succeeded: number;
  failed: number;
}

/**
 * Link properties to classes in bulk.
 */
export async function batchAddClassProperties(
  items: BatchClassPropertyItem[]
): Promise<BatchClassPropertyResponse> {
  const response = await api.post<BatchClassPropertyResponse>(
    `${BASE}/classes/batch/properties`,
    {
      items: items.map((item) => ({
        class_node_uuid: resolveNodeUuid(item.class_node_id),
        property_uuid: resolveRequiredPropertyUuid(item.property_id),
      })),
    }
  );
  return response.data;
}

// ============== Node Properties ==============

/**
 * Node with property value response
 */
export interface NodeWithPropertyValue {
  node_id: number;
  node_uuid: string;
  node_name: string;
  node_icon: string | null;
  node_color: string | null;
  parent_id: number | null;
  page_id: number | null;
  is_page: boolean;
  is_class: boolean;
  create_date: string;
  write_date: string;
  property_value: unknown;
  properties?: Record<string, unknown>;
  class_ids?: number[];
}

/**
 * Get all nodes that have a value for a specific property
 */
export async function getNodesWithProperty(
  propertyId: string | number
): Promise<{ nodes: NodeWithPropertyValue[]; property: Property }> {
  const response = await api.get<{ nodes: NodeWithPropertyValue[]; property: Property }>(
    `${BASE}/${resolveRequiredPropertyUuid(propertyId)}/nodes`
  );
  return response.data;
}
