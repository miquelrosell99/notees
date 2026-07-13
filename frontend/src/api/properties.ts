/**
 * Properties API functions
 */
import api from '@/api/client';
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

const BASE = '/properties';

/**
 * List all property definitions
 */
export async function listProperties(): Promise<Property[]> {
  const response = await api.get<PropertiesResponse>(`${BASE}/`);
  return response.data.properties ?? [];
}

/**
 * Get properties available in a given context:
 * global properties + class-scoped properties (if contextClassUuids) + node-scoped (if contextNodeUuid)
 */
export async function getAvailableProperties(opts: {
  contextNodeUuid?: string;
  contextClassUuids?: string[];
}): Promise<Property[]> {
  const params: Record<string, string> = {};
  if (opts.contextNodeUuid != null) {
    params.context_node_uuid = opts.contextNodeUuid;
  }
  if (opts.contextClassUuids?.length) {
    params.context_class_ids = opts.contextClassUuids.join(',');
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
 * Get a property by UUID
 */
export async function getProperty(propertyUuid: string): Promise<Property> {
  const response = await api.get<Property>(`${BASE}/${propertyUuid}`);
  return response.data;
}

/**
 * Get a property by UUID (legacy alias)
 * @deprecated Use getProperty instead.
 */
export const getPropertyByUuid = getProperty;

/**
 * Update a property
 */
export async function updateProperty(
  propertyUuid: string,
  data: PropertyUpdate
): Promise<Property> {
  const response = await api.put<Property>(`${BASE}/${propertyUuid}`, data);
  return response.data;
}

/**
 * Delete a property
 */
export async function deleteProperty(propertyUuid: string): Promise<void> {
  await api.delete(`${BASE}/${propertyUuid}`);
}

// ============== Selection Options ==============

/**
 * Add a selection option
 */
export async function addSelectionOption(
  propertyUuid: string,
  name: string,
  icon?: string | null,
  sequence?: number,
  color?: string | null
): Promise<SelectionOption> {
  const response = await api.post<SelectionOption>(
    `${BASE}/${propertyUuid}/selection-lines`,
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
  propertyUuid: string,
  optionUuid: string,
  data: { icon?: string | null; name?: string; order?: number; color?: string | null }
): Promise<SelectionOption> {
  const response = await api.put<SelectionOption>(
    `${BASE}/${propertyUuid}/selection-lines/${optionUuid}`,
    data
  );
  return response.data;
}

/**
 * Delete a selection option
 */
export async function deleteSelectionOption(
  propertyUuid: string,
  optionUuid: string
): Promise<void> {
  await api.delete(`${BASE}/${propertyUuid}/selection-lines/${optionUuid}`);
}

/**
 * Reorder selection options by updating their order field.
 * Accepts the options in the desired new order.
 */
export async function reorderSelectionOptions(
  propertyUuid: string,
  orderedOptions: Array<{ uuid: string }>
): Promise<void> {
  await Promise.all(
    orderedOptions.map((opt, index) =>
      api.put(`${BASE}/${propertyUuid}/selection-lines/${opt.uuid}`, {
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
  propertyUuid: string,
  classNodeUuid: string
): Promise<{ uuid: string; class_node_uuid: string }> {
  const response = await api.post<{ uuid: string; class_node_uuid: string }>(
    `${BASE}/${propertyUuid}/class-filters`,
    null,
    { params: { class_node_uuid: classNodeUuid } }
  );
  return response.data;
}

/**
 * Remove a class filter from a property
 */
export async function removeClassFilter(
  propertyUuid: string,
  classNodeUuid: string
): Promise<void> {
  await api.delete(`${BASE}/${propertyUuid}/class-filters/${classNodeUuid}`);
}

// ============== Type Properties ==============

/**
 * Get properties linked to a class
 */
export async function getClassProperties(
  classNodeUuid: string,
  includeInherited: boolean = false
): Promise<ClassProperty[]> {
  const response = await api.get<ClassPropertiesResponse>(
    `${BASE}/classes/${classNodeUuid}/properties`,
    { params: { include_inherited: includeInherited } }
  );
  return response.data.class_properties ?? [];
}

/**
 * Link a property to a class.
 *
 * Tri-state flags (required/readonly/hide_when_empty) are sent as null when
 * unset so the binding inherits from the property base — forcing `false`
 * here would mean "explicitly off", defeating inheritance.
 */
export async function addClassProperty(
  classNodeUuid: string,
  propertyUuid: string,
  sequence?: number,
  defaultValue?: unknown,
  required?: boolean | null,
  readonly?: boolean | null,
  hideWhenEmpty?: boolean | null
): Promise<ClassProperty> {
  const response = await api.post<ClassProperty>(
    `${BASE}/classes/${classNodeUuid}/properties`,
    {
      property_uuid: propertyUuid,
      sequence: sequence ?? 0,
      default_value: defaultValue,
      required: required ?? null,
      readonly: readonly ?? null,
      hide_when_empty: hideWhenEmpty ?? null,
    }
  );
  return response.data;
}

/**
 * Remove a property from a class
 */
export async function removeClassProperty(
  classNodeUuid: string,
  propertyUuid: string
): Promise<void> {
  await api.delete(`${BASE}/classes/${classNodeUuid}/properties/${propertyUuid}`);
}

/**
 * Reorder properties within a class by providing property UUIDs in the desired order
 */
export async function reorderClassProperties(
  classNodeUuid: string,
  propertyUuids: string[]
): Promise<void> {
  await api.put(`${BASE}/classes/${classNodeUuid}/properties/reorder`, {
    property_uuids: propertyUuids,
  });
}

/**
 * Update class property binding (attribute flags, hidden, default).
 * Explicit null on a tri-state flag is sent verbatim: it resets the flag
 * to "inherit from property".
 */
export async function updateClassProperty(
  classNodeUuid: string,
  propertyUuid: string,
  data: {
    required?: boolean | null;
    hidden?: boolean;
    readonly?: boolean | null;
    hide_when_empty?: boolean | null;
    default_value?: unknown | null;
  }
): Promise<ClassProperty> {
  const response = await api.patch<ClassProperty>(
    `${BASE}/classes/${classNodeUuid}/properties/${propertyUuid}`,
    data
  );
  return response.data;
}

/**
 * Get property usage stats (usage_count per property_uuid)
 */
export async function getPropertyStats(): Promise<
  Array<{ property_uuid: string; usage_count: number }>
> {
  const response = await api.get<{
    stats: Array<{ property_uuid: string; usage_count: number }>;
  }>(`${BASE}/stats`);
  return response.data.stats ?? [];
}

/**
 * Get property suggestions for a node, ranked by usage frequency
 */
export async function getPropertySuggestions(nodeUuid?: string): Promise<
  Array<{
    property_uuid: string;
    name: string;
    icon: string | null;
    type: string;
    usage_count: number;
    already_assigned: boolean;
  }>
> {
  const params = nodeUuid != null ? { node_uuid: nodeUuid } : {};
  const response = await api.get<{
    suggestions: Array<{
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
export async function getClassExtends(classNodeUuid: string): Promise<ClassExtends[]> {
  const response = await api.get<ClassExtendsResponse>(
    `${BASE}/classes/${classNodeUuid}/extends`
  );
  return response.data.extends ?? [];
}

/**
 * Add a class that this class extends (inherits from)
 */
export async function addClassExtends(
  classNodeUuid: string,
  extendsClassNodeUuid: string,
  sequence?: number
): Promise<ClassExtends> {
  const response = await api.post<ClassExtends>(
    `${BASE}/classes/${classNodeUuid}/extends`,
    {
      extends_class_node_uuid: extendsClassNodeUuid,
      sequence: sequence ?? 0,
    }
  );
  return response.data;
}

/**
 * Remove a class extension (inheritance link)
 */
export async function removeClassExtends(
  classNodeUuid: string,
  extendsClassNodeUuid: string
): Promise<void> {
  await api.delete(
    `${BASE}/classes/${classNodeUuid}/extends/${extendsClassNodeUuid}`
  );
}

/**
 * Get inherited properties for a class (from extended classes)
 */
export async function getInheritedProperties(
  classNodeUuid: string
): Promise<InheritedProperty[]> {
  const response = await api.get<{ inherited_properties: InheritedProperty[] }>(
    `${BASE}/classes/${classNodeUuid}/inherited-properties`
  );
  return response.data.inherited_properties ?? [];
}

/**
 * Get classes that extend this class (reverse lookup)
 */
export async function getExtendedByClasses(
  classNodeUuid: string
): Promise<ExtendedByClass[]> {
  const response = await api.get<{ classes: ExtendedByClass[] }>(
    `${BASE}/classes/${classNodeUuid}/extended-by`
  );
  return response.data.classes ?? [];
}

/**
 * Validate class extends (check for circular inheritance)
 */
export async function validateClassExtends(
  classNodeUuid: string,
  extendsUuids: string[]
): Promise<{ valid: boolean; error?: string; cycle_path?: string[] }> {
  const response = await api.post<{
    valid: boolean;
    error?: string;
    cycle_path?: string[];
  }>(`${BASE}/classes/${classNodeUuid}/validate-extends`, extendsUuids);
  return response.data;
}

// ============== Batch Operations ==============

export interface BatchSetPropertyItem {
  node_uuid: string;
  property_uuid: string;
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
    items,
  });
  return response.data;
}

export interface BatchClassPropertyItem {
  class_node_uuid: string;
  property_uuid: string;
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
    { items }
  );
  return response.data;
}

// ============== Node Properties ==============

/**
 * Node with property value response
 */
export interface NodeWithPropertyValue {
  node_uuid: string;
  node_name: string;
  node_icon: string | null;
  node_color: string | null;
  parent_uuid: string | null;
  page_uuid: string | null;
  is_page: boolean;
  is_class: boolean;
  create_date: string;
  write_date: string;
  property_value: unknown;
  properties?: Record<string, unknown>;
  class_uuids?: string[];
}

/**
 * Get all nodes that have a value for a specific property
 */
export async function getNodesWithProperty(
  propertyUuid: string
): Promise<{ nodes: NodeWithPropertyValue[]; property: Property }> {
  const response = await api.get<{ nodes: NodeWithPropertyValue[]; property: Property }>(
    `${BASE}/${propertyUuid}/nodes`
  );
  return response.data;
}
