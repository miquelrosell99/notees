/**
 * Notees V2 API Types
 * 
 * New schema with nodes as the core entity.
 * - Pages = nodes tagged as "page"
 * - Blocks = nodes with parent_id
 * - Tags = nodes tagged as "tag" (and "page")
 * - Properties = polymorphic values with SuperTag support
 */

// ==================== Node Types ====================

/**
 * Core Node entity
 * 
 * Everything in Notees is a node. Nodes are differentiated by their tags:
 * - Page: has "page" tag
 * - Block: has parent_id (child of another node)
 * - Tag: has "tag" tag (always also has "page" tag)
 * - Date nodes: have "day", "month", or "year" tag
 */
export interface Node {
  id: number;
  uuid: string;
  name: string;
  icon: string | null;
  color: string | null;
  parent_id: number | null;
  page_id: number | null;
  sequence: number;
  collapsed: boolean;
  active: boolean;
  is_page: boolean; // Whether this node is a page
  is_type?: boolean; // Whether this node defines a type
  usable_in?: 'pages' | 'blocks' | 'both'; // Where this type can be applied (only meaningful when is_type=true)
  create_date: string;
  write_date: string;
  open_date?: string | null; // When the page was last opened/viewed
  
  // Page information for grouping (populated by query results)
  page_name?: string | null;
  page_uuid?: string | null;
  
  // Computed fields
  display_name?: string | null;
  tags?: number[];  // Tag node IDs (descriptive linking with #)
  types?: number[]; // Type node IDs (categorization with @)
  properties?: Record<string, unknown>;
  is_daily?: boolean; // Whether this is a daily note
  is_monthly?: boolean; // Whether this is a monthly note
  is_yearly?: boolean; // Whether this is a yearly note
  
  // For tree responses
  children?: Node[];
  
  // For backlinks/references
  backlinks?: Backlink[];
  linked_references?: LinkedReference[];
  backlink_count?: number; // Count of backlinks to this node
  
  // For comments
  comment_count?: number;
}

/**
 * Comment node - a node attached to another node as a comment
 */
export interface Comment {
  id: number;
  uuid: string;
  name: string;
  icon: string | null;
  parent_id: number | null;
  sequence: number;
  collapsed: boolean;
  create_date: string;
  write_date: string;
  children?: Comment[];
}

/**
 * Helper to check if a node is a page
 */
export function isPage(node: Node, pageTagId: number): boolean {
  return node.tags?.includes(pageTagId) ?? false;
}

/**
 * Helper to check if a node is a block
 */
export function isBlock(node: Node): boolean {
  return node.parent_id !== null;
}

/**
 * Parse a date UUID to extract date info
 * Date UUIDs: YYYYMMDD (day), YYYYMM00 (month), YYYY0000 (year)
 */
export function parseDateUuid(uuid: string): DateInfo | null {
  if (!uuid || uuid.length !== 8 || !/^\d{8}$/.test(uuid)) {
    return null;
  }
  
  const year = parseInt(uuid.substring(0, 4), 10);
  const month = parseInt(uuid.substring(4, 6), 10);
  const day = parseInt(uuid.substring(6, 8), 10);
  
  if (year < 1900 || year > 2200) {
    return null;
  }
  
  if (month === 0 && day === 0) {
    return { type: 'year', year };
  } else if (day === 0 && month >= 1 && month <= 12) {
    return { type: 'month', year, month };
  } else if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
    return { type: 'day', year, month, day };
  }
  
  return null;
}

export interface DateInfo {
  type: 'year' | 'month' | 'day';
  year: number;
  month?: number;
  day?: number;
}

/**
 * Backlink info
 */
export interface Backlink {
  source_node_id: number;
  source_node_uuid: string;
  source_node_name: string;
  source_page_id: number | null;
  source_page_name: string | null;
  link_type: LinkType;
  position: number;
}

/**
 * Breadcrumb segment for showing path hierarchy
 */
export interface BreadcrumbSegment {
  node_id: number | null;
  name: string;
  is_property: boolean;
}

/**
 * Linked reference with context
 */
export interface LinkedReference {
  source_node: Node;
  source_page: Node | null;
  link_type: LinkType;
  context: string;
  breadcrumb_path: BreadcrumbSegment[];
}

export type LinkType = 'page' | 'block';

/**
 * Data for creating a new node
 */
export interface NodeCreate {
  name?: string;
  icon?: string | null;
  color?: string | null;
  parent_id?: number | null;
  sequence?: number;
  tags?: number[];
  types?: number[];
  properties?: Record<number, unknown>;
  is_page?: boolean;  // Create as a page (no parent needed)
  is_type?: boolean;  // Create as a type (is_type=true)
  // For date nodes
  is_daily?: boolean;
  daily_date?: string | null;
  is_monthly?: boolean;
  monthly_date?: string | null;
  is_yearly?: boolean;
  yearly_date?: string | null;
}

/**
 * Data for updating a node
 */
export interface NodeUpdate {
  name?: string | null;
  icon?: string | null;
  color?: string | null;
  parent_id?: number | null;
  sequence?: number | null;
  collapsed?: boolean | null;
}

// ==================== Property Types ====================

/**
 * Property types
 */
export type PropertyType = 'integer' | 'float' | 'text' | 'boolean' | 'node' | 'selection' | 'date';

/**
 * Property definition
 */
export interface Property {
  id: number;
  uuid: string;
  name: string;
  icon: string | null;
  type: PropertyType;
  multi: boolean;
  is_system: boolean;
  is_local: boolean;  // Local properties apply only to specific nodes, not globally unique
  create_date: string;
  write_date: string;
  // For node-type properties
  tag_filters: number[];
  // For selection-type properties
  options: SelectionOption[];
}

/**
 * Property backlink (pages that reference via property)
 */
export interface PropertyBacklink {
  source_page: Node;
  property_id: number;
  property_name: string;
}

/**
 * Selection option for selection-type properties
 */
export interface SelectionOption {
  id: number;
  name: string;
  icon: string | null;
  color: string | null;
  sequence: number;
}

/**
 * Type property (property linked to a type/class)
 */
export interface TypeProperty {
  id: number;
  type_node_id: number;
  type_node_name: string;
  property_id: number;
  property_name: string;
  property_type: PropertyType;
  sequence: number;
  default_value: unknown;
  hidden: boolean;  // Whether this property is hidden by default in the UI
}

/**
 * Type extends (inheritance relationship)
 */
export interface TypeExtends {
  id: number;
  type_node_id: number;
  type_node_name: string;
  extends_type_node_id: number;
  extends_type_node_name: string;
  sequence: number;
}

/**
 * Property value for a node
 */
export interface PropertyValue {
  property_id: number;
  property_name: string;
  property_type: PropertyType;
  value: unknown;
  display_value: string;
}

/**
 * Data for creating a property
 */
export interface PropertyCreate {
  name: string;
  icon?: string | null;
  type?: PropertyType;
  multi?: boolean;
  is_local?: boolean;  // Local properties only apply to specific nodes
  tag_filters?: number[];
  options?: string[];
}

/**
 * Data for updating a property
 */
export interface PropertyUpdate {
  name?: string | null;
  icon?: string | null;
}

// ==================== User Types ====================

/**
 * User entity
 */
export interface User {
  id: number;
  uuid: string;
  username: string;
  is_active: boolean;
}

/**
 * User creation data
 */
export interface UserCreate {
  username: string;
  password: string;
}

/**
 * User login credentials
 */
export interface UserLogin {
  username: string;
  password: string;
}

/**
 * Token response
 */
export interface Token {
  access_token: string;
  token_type: string;
  user: User;
}

// ==================== API Response Types ====================

export interface NodesResponse {
  nodes: Node[];
}

export interface BacklinksResponse {
  backlinks: Backlink[];
}

export interface LinkedReferencesResponse {
  linked_references: LinkedReference[];
}

export interface PropertiesResponse {
  properties: Property[];
}

export interface TypePropertiesResponse {
  type_properties: TypeProperty[];
}

export interface TypeExtendsResponse {
  extends: TypeExtends[];
}

export interface SearchResponse {
  results: Node[];
  count?: number;
}

// ==================== System Tags ====================

/**
 * Well-known system tag names
 */
export const SystemTags = {
  TAG: 'tag',
  PAGE: 'page',
  YEAR: 'year',
  MONTH: 'month',
  DAY: 'day',
  QUOTE: 'quote',
  QUERY: 'query',
  CODE: 'code',
  ASSET: 'asset',
  WHITEBOARD: 'whiteboard',
  CARD: 'card',
  TASK: 'task',
  TEMPLATE: 'template',
} as const;

export type SystemTag = typeof SystemTags[keyof typeof SystemTags];

// ==================== Date Helpers ====================

/**
 * Generate a day UUID from a Date
 */
export function generateDayUuid(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

/**
 * Generate a month UUID
 */
export function generateMonthUuid(year: number, month: number): string {
  return `${year}${String(month).padStart(2, '0')}00`;
}

/**
 * Generate a year UUID
 */
export function generateYearUuid(year: number): string {
  return `${year}0000`;
}

/**
 * Check if a UUID is a date UUID
 */
export function isDateUuid(uuid: string): boolean {
  return parseDateUuid(uuid) !== null;
}

/**
 * Get a Date object from a day UUID
 */
export function dateFromUuid(uuid: string): Date | null {
  const info = parseDateUuid(uuid);
  if (!info || info.type !== 'day' || !info.month || !info.day) {
    return null;
  }
  return new Date(info.year, info.month - 1, info.day);
}
