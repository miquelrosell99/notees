/**
 * Properties API functions
 */
import api from './client';
import type {
  Property,
  PropertyCreate,
  PropertyUpdate,
  PropertiesResponse,
  SelectionOption,
  TypeProperty,
  TypePropertiesResponse,
  TypeExtends,
  TypeExtendsResponse,
} from '@/types/api';

const BASE = '/properties';

/**
 * List all property definitions
 */
export async function listProperties(): Promise<Property[]> {
  const response = await api.get<PropertiesResponse>(`${BASE}/`);
  return response.data.properties;
}

/**
 * Create a new property
 */
export async function createProperty(data: PropertyCreate): Promise<Property> {
  const response = await api.post<Property>(BASE, data);
  return response.data;
}

/**
 * Get a property by ID
 */
export async function getProperty(id: number): Promise<Property> {
  const response = await api.get<Property>(`${BASE}/${id}`);
  return response.data;
}

/**
 * Update a property
 */
export async function updateProperty(
  id: number,
  data: PropertyUpdate
): Promise<Property> {
  const response = await api.put<Property>(`${BASE}/${id}`, data);
  return response.data;
}

/**
 * Delete a property
 */
export async function deleteProperty(id: number): Promise<void> {
  await api.delete(`${BASE}/${id}`);
}

// ============== Selection Options ==============

/**
 * Add a selection option
 */
export async function addSelectionOption(
  propertyId: number,
  name: string,
  icon?: string | null,
  color?: string | null,
  sequence?: number
): Promise<SelectionOption> {
  const response = await api.post<SelectionOption>(`${BASE}/${propertyId}/options`, {
    name,
    icon,
    color,
    sequence: sequence ?? 0,
  });
  return response.data;
}

/**
 * Delete a selection option
 */
export async function deleteSelectionOption(
  propertyId: number,
  optionId: number
): Promise<void> {
  await api.delete(`${BASE}/${propertyId}/options/${optionId}`);
}

// ============== Tag Filters ==============

/**
 * Add a tag filter to a node-type property
 */
export async function addTagFilter(
  propertyId: number,
  tagNodeId: number
): Promise<{ id: number; tag_node_id: number }> {
  const response = await api.post<{ id: number; tag_node_id: number }>(
    `${BASE}/${propertyId}/tag-filters`,
    null,
    { params: { tag_node_id: tagNodeId } }
  );
  return response.data;
}

/**
 * Remove a tag filter from a property
 */
export async function removeTagFilter(
  propertyId: number,
  tagNodeId: number
): Promise<void> {
  await api.delete(`${BASE}/${propertyId}/tag-filters/${tagNodeId}`);
}

// ============== Type Properties ==============

/**
 * Get properties linked to a type/class
 */
export async function getTypeProperties(
  typeNodeId: number,
  includeInherited: boolean = false
): Promise<TypeProperty[]> {
  const response = await api.get<TypePropertiesResponse>(
    `${BASE}/types/${typeNodeId}/properties`,
    { params: { include_inherited: includeInherited } }
  );
  return response.data.type_properties;
}

/**
 * Link a property to a type/class
 */
export async function addTypeProperty(
  typeNodeId: number,
  propertyId: number,
  sequence?: number,
  defaultValue?: unknown
): Promise<TypeProperty> {
  const response = await api.post<TypeProperty>(
    `${BASE}/types/${typeNodeId}/properties`,
    {
      property_id: propertyId,
      sequence: sequence ?? 0,
      default_value: defaultValue,
    }
  );
  return response.data;
}

/**
 * Remove a property from a type/class
 */
export async function removeTypeProperty(
  typeNodeId: number,
  propertyId: number
): Promise<void> {
  await api.delete(`${BASE}/types/${typeNodeId}/properties/${propertyId}`);
}

// ============== Type Extends (Inheritance) ==============

/**
 * Get types that a type/class extends (inherits from)
 */
export async function getTypeExtends(typeNodeId: number): Promise<TypeExtends[]> {
  const response = await api.get<TypeExtendsResponse>(
    `${BASE}/types/${typeNodeId}/extends`
  );
  return response.data.extends;
}

/**
 * Add a type that this type extends (inherits from)
 */
export async function addTypeExtends(
  typeNodeId: number,
  extendsTypeNodeId: number,
  sequence?: number
): Promise<TypeExtends> {
  const response = await api.post<TypeExtends>(
    `${BASE}/types/${typeNodeId}/extends`,
    {
      extends_type_node_id: extendsTypeNodeId,
      sequence: sequence ?? 0,
    }
  );
  return response.data;
}

/**
 * Remove a type extension (inheritance link)
 */
export async function removeTypeExtends(
  typeNodeId: number,
  extendsTypeNodeId: number
): Promise<void> {
  await api.delete(`${BASE}/types/${typeNodeId}/extends/${extendsTypeNodeId}`);
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
  is_type: boolean;
  create_date: string;
  write_date: string;
  property_value: unknown;
}

/**
 * Get all nodes that have a value for a specific property
 */
export async function getNodesWithProperty(
  propertyId: number
): Promise<{ nodes: NodeWithPropertyValue[]; property: Property }> {
  const response = await api.get<{ nodes: NodeWithPropertyValue[]; property: Property }>(
    `${BASE}/${propertyId}/nodes`
  );
  return response.data;
}
