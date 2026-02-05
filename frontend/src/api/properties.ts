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
 * Create a new property
 */
export async function createProperty(data: PropertyCreate): Promise<Property> {
  const response = await api.post<Property>(`${BASE}/`, data);
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
 * Get a property by UUID
 */
export async function getPropertyByUuid(uuid: string): Promise<Property> {
  const response = await api.get<Property>(`${BASE}/uuid/${uuid}`);
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

// ============== Class Filters ==============

/**
 * Add a class filter to a node-type property
 */
export async function addClassFilter(
  propertyId: number,
  classNodeId: number
): Promise<{ id: number; class_node_id: number }> {
  const response = await api.post<{ id: number; class_node_id: number }>(
    `${BASE}/${propertyId}/class-filters`,
    null,
    { params: { class_node_id: classNodeId } }
  );
  return response.data;
}

/**
 * Remove a class filter from a property
 */
export async function removeClassFilter(
  propertyId: number,
  classNodeId: number
): Promise<void> {
  await api.delete(`${BASE}/${propertyId}/class-filters/${classNodeId}`);
}

// ============== Type Properties ==============

/**
 * Get properties linked to a class
 */
export async function getClassProperties(
  classNodeId: number,
  includeInherited: boolean = false
): Promise<ClassProperty[]> {
  const response = await api.get<ClassPropertiesResponse>(
    `${BASE}/classes/${classNodeId}/properties`,
    { params: { include_inherited: includeInherited } }
  );
  return response.data.class_properties ?? [];
}

/**
 * Link a property to a class
 */
export async function addClassProperty(
  classNodeId: number,
  propertyId: number,
  sequence?: number,
  defaultValue?: unknown
): Promise<ClassProperty> {
  const response = await api.post<ClassProperty>(
    `${BASE}/classes/${classNodeId}/properties`,
    {
      property_id: propertyId,
      sequence: sequence ?? 0,
      default_value: defaultValue,
    }
  );
  return response.data;
}

/**
 * Remove a property from a class
 */
export async function removeClassProperty(
  classNodeId: number,
  propertyId: number
): Promise<void> {
  await api.delete(`${BASE}/classes/${classNodeId}/properties/${propertyId}`);
}

// ============== Class Extends (Inheritance) ==============

/**
 * Get classes that a class extends (inherits from)
 */
export async function getClassExtends(classNodeId: number): Promise<ClassExtends[]> {
  const response = await api.get<ClassExtendsResponse>(
    `${BASE}/classes/${classNodeId}/extends`
  );
  return response.data.extends ?? [];
}

/**
 * Add a class that this class extends (inherits from)
 */
export async function addClassExtends(
  classNodeId: number,
  extendsClassNodeId: number,
  sequence?: number
): Promise<ClassExtends> {
  const response = await api.post<ClassExtends>(
    `${BASE}/classes/${classNodeId}/extends`,
    {
      extends_class_node_id: extendsClassNodeId,
      sequence: sequence ?? 0,
    }
  );
  return response.data;
}

/**
 * Remove a class extension (inheritance link)
 */
export async function removeClassExtends(
  classNodeId: number,
  extendsClassNodeId: number
): Promise<void> {
  await api.delete(`${BASE}/classes/${classNodeId}/extends/${extendsClassNodeId}`);
}

/**
 * Get inherited properties for a class (from extended classes)
 */
export async function getInheritedProperties(
  classNodeId: number
): Promise<InheritedProperty[]> {
  const response = await api.get<{ inherited_properties: InheritedProperty[] }>(
    `${BASE}/classes/${classNodeId}/inherited-properties`
  );
  return response.data.inherited_properties ?? [];
}

/**
 * Get classes that extend this class (reverse lookup)
 */
export async function getExtendedByClasses(
  classNodeId: number
): Promise<ExtendedByClass[]> {
  const response = await api.get<{ classes: ExtendedByClass[] }>(
    `${BASE}/classes/${classNodeId}/extended-by`
  );
  return response.data.classes ?? [];
}

/**
 * Validate class extends (check for circular inheritance)
 */
export async function validateClassExtends(
  classNodeId: number,
  extendsIds: number[]
): Promise<{ valid: boolean; error?: string; cycle_path?: number[] }> {
  const response = await api.post<{ valid: boolean; error?: string; cycle_path?: number[] }>(
    `${BASE}/classes/${classNodeId}/validate-extends`,
    extendsIds
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
