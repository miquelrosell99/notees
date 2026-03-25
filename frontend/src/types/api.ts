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
  is_class?: boolean; // Whether this node defines a class
  create_date: string;
  write_date: string;
  open_date?: string | null; // When the page was last opened/viewed
  
  // Soft delete
  is_deleted?: boolean; // Whether node is in trash
  deleted_at?: string | null; // When the node was deleted
  
  // Page information for grouping (populated by query results)
  page_name?: string | null;
  page_uuid?: string | null;
  
  // Computed fields
  display_name?: string | null;
  tags?: number[];  // Tag node IDs (descriptive linking with #)
  classes?: number[]; // Class node IDs (categorization with @)
  properties?: Record<number, unknown>;  // Property values keyed by property ID
  is_daily?: boolean; // Whether this is a daily note
  is_monthly?: boolean; // Whether this is a monthly note
  is_yearly?: boolean; // Whether this is a yearly note
  is_comment?: boolean; // Whether this node is a comment
  parent_locked?: boolean; // Whether this node's parent is locked
  
  // For tree responses
  children?: Node[];
  has_children?: boolean; // True if node has children (even if not loaded, e.g. collapsed)
  
  // For backlinks/references
  backlinks?: Backlink[];
  linked_references?: LinkedReference[];
  backlink_count?: number; // Count of backlinks to this node
  
  // For comments
  comment_count?: number;
  
  // Alias support
  aliased_id?: number | null;  // If set, this node is an alias of the node with this ID
  aliases?: number[];  // IDs of nodes that are aliases of this node

  // Class extension (Extends chain) - parent class IDs in order
  extends?: number[];

  // Referenced nodes map — uuid → node data for outgoing link targets.
  // Populated by page content endpoint so inline links resolve without N+1 queries.
  referenced_nodes?: Record<string, Node>;
  
  // Metadata for linked references (attached client-side)
  _linkedRefMetadata?: {
    linkType: 'text' | 'property';
    propertyId?: number;
    propertyName?: string;
    targetNodeId: number;
    // The actual source node ID (when displaying page in list view, this is the block with the property)
    sourceNodeId?: number;
  };
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
 * Date UUIDs: 
 * - Day: 00000000-0000-0000-00dd-YYYYMMDD0000
 * - Month: 00000000-0000-0000-00aa-YYYYMM000000
 * - Year: 00000000-0000-0000-00bb-YYYY00000000
 */
export function parseDateUuid(uuid: string): DateInfo | null {
  if (!uuid || uuid.length !== 36) {
    return null;
  }
  
  // Check for day UUID pattern: 00000000-0000-0000-00dd-YYYYMMDD0000
  if (uuid.startsWith('00000000-0000-0000-00dd-')) {
    try {
      const data = uuid.slice(-12); // YYYYMMDD0000
      const year = parseInt(data.substring(0, 4), 10);
      const month = parseInt(data.substring(4, 6), 10);
      const day = parseInt(data.substring(6, 8), 10);
      if (year >= 1900 && year <= 2200 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        return { type: 'day', year, month, day };
      }
    } catch {
      return null;
    }
  }
  
  // Check for month UUID pattern: 00000000-0000-0000-00aa-YYYYMM000000
  if (uuid.startsWith('00000000-0000-0000-00aa-')) {
    try {
      const data = uuid.slice(-12); // YYYYMM000000
      const year = parseInt(data.substring(0, 4), 10);
      const month = parseInt(data.substring(4, 6), 10);
      if (year >= 1900 && year <= 2200 && month >= 1 && month <= 12) {
        return { type: 'month', year, month };
      }
    } catch {
      return null;
    }
  }
  
  // Check for year UUID pattern: 00000000-0000-0000-00bb-YYYY00000000
  if (uuid.startsWith('00000000-0000-0000-00bb-')) {
    try {
      const data = uuid.slice(-12); // YYYY00000000
      const year = parseInt(data.substring(0, 4), 10);
      if (year >= 1900 && year <= 2200) {
        return { type: 'year', year };
      }
    } catch {
      return null;
    }
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
  link_type: 'text' | 'property';
  context: string;
  breadcrumb_path: BreadcrumbSegment[];
  property_id?: number;
  property_name?: string;
  /** For text-property-context links: root block ID of the text property */
  text_property_root_block_id?: number;
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
  classes?: number[];  // Class node IDs - backend computes is_page, is_class etc from these
  properties?: Record<number, unknown>;
  uuid?: string;  // Optional: override auto-generated UUID (e.g. from Logseq import)
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
  expected_version?: number;  // For optimistic locking
  /** When provided, reconcile node classes to exactly this set (Odoo-style write) */
  classes?: number[];
  /** When provided, apply each property_id -> value pair */
  properties?: Record<number, unknown>;
}

// ==================== Batch Read Operations ====================

/**
 * Request to fetch multiple nodes by ID in a single call
 */
export interface BatchGetNodesRequest {
  ids: number[];
  include_properties?: boolean;
}

/**
 * Response for batch node fetch — keyed by node ID
 */
export interface BatchGetNodesResponse {
  nodes: Record<string, Node>;
}

/**
 * A single breadcrumb in the ancestor chain
 */
export interface BreadcrumbItemResponse {
  id: number;
  name: string;
  display_name: string;
  icon: string | null;
  is_page: boolean;
  parent_locked: boolean;
}

/**
 * Response for breadcrumbs endpoint
 */
export interface BreadcrumbsResponse {
  breadcrumbs: BreadcrumbItemResponse[];
}

// ==================== Batch Write Operations ====================

/**
 * A single node to create in a batch operation
 */
export interface BatchNodeCreateItem {
  name?: string;
  icon?: string | null;
  color?: string | null;
  parent_id?: number | null;
  sequence?: number;
  classes?: number[];
  properties?: Record<number, unknown>;
  uuid?: string;  // Optional: provide a UUID (e.g. from Logseq)
}

/**
 * Request to create multiple nodes in a batch
 */
export interface BatchNodeCreateRequest {
  nodes: BatchNodeCreateItem[];
  /** Controls what happens when a node with the given UUID already exists.
   *  - 'block' (default): treat as error
   *  - 'return_existing': return the existing node instead of failing */
  uuid_conflict_mode?: 'block' | 'return_existing';
}

/**
 * Result for a single node in a batch create
 */
export interface BatchNodeCreateResultItem {
  index: number;
  success: boolean;
  node?: Node;
  error?: string;
  /** True when an existing node was returned instead of creating a new one */
  existing?: boolean;
}

/**
 * Response for batch node creation
 */
export interface BatchNodeCreateResponse {
  results: BatchNodeCreateResultItem[];
  created: number;
  failed: number;
}

/**
 * A single node update in a batch operation
 */
export interface BatchNodeUpdateItem {
  id?: number;
  uuid?: string;
  name?: string | null;
  icon?: string | null;
  color?: string | null;
  parent_id?: number | null;
  sequence?: number | null;
  collapsed?: boolean | null;
  expected_version?: number;
  /** When provided, reconcile node classes to exactly this set */
  classes?: number[];
  /** When provided, apply each property_id -> value pair */
  properties?: Record<number, unknown>;
}

/**
 * Request to update multiple nodes in a batch
 */
export interface BatchNodeUpdateRequest {
  nodes: BatchNodeUpdateItem[];
}

/**
 * Result for a single node in a batch update
 */
export interface BatchNodeUpdateResultItem {
  index: number;
  success: boolean;
  node?: Node;
  error?: string;
}

/**
 * Response for batch node update
 */
export interface BatchNodeUpdateResponse {
  results: BatchNodeUpdateResultItem[];
  updated: number;
  failed: number;
}

/**
 * Request to delete multiple nodes by UUID
 */
export interface BatchNodeDeleteRequest {
  uuids: string[];
}

/**
 * Result for a single node in a batch delete
 */
export interface BatchNodeDeleteResultItem {
  index: number;
  uuid: string;
  success: boolean;
  error?: string;
}

/**
 * Response for batch node deletion
 */
export interface BatchNodeDeleteResponse {
  results: BatchNodeDeleteResultItem[];
  deleted: number;
  failed: number;
}

/**
 * Request to permanently delete multiple nodes from trash
 */
export interface BatchPermanentDeleteRequest {
  ids: number[];
}

/**
 * Result for a single permanent delete in a batch
 */
export interface BatchPermanentDeleteResultItem {
  index: number;
  id: number;
  success: boolean;
  error?: string;
}

/**
 * Response for batch permanent deletion
 */
export interface BatchPermanentDeleteResponse {
  results: BatchPermanentDeleteResultItem[];
  deleted: number;
  failed: number;
}

/**
 * Request to get-or-create multiple daily pages
 */
export interface BatchNodeDailyRequest {
  dates: string[]; // YYYY-MM-DD
}

/**
 * Result for a single date in a batch daily request
 */
export interface BatchNodeDailyResultItem {
  date: string;
  success: boolean;
  node?: Node;
  error?: string;
}

/**
 * Response for batch daily get-or-create
 */
export interface BatchNodeDailyResponse {
  results: BatchNodeDailyResultItem[];
}

// ==================== Property Types ====================

/**
 * Property types
 */
export type PropertyType = 'integer' | 'float' | 'text' | 'boolean' | 'url' | 'email' | 'node' | 'selection' | 'date' | 'image';

/**
 * Icon visibility for property values at block level.
 * Controls where the selection property icon appears relative to the block bullet.
 */
export type PropertyIconVisibility = 'hidden' | 'before_content' | 'after_bullet';

/** Property types that support icon visibility settings */
export const ICON_VISIBILITY_PROPERTY_TYPES: PropertyType[] = ['selection'];

/**
 * Property scope: where a property is scoped to.
 * 'global'  — available workspace-wide
 * 'class'   — tied to a class node, shown to all instances of that class
 * 'node'    — tied to a specific page node only
 */
export type PropertyScope = 'global' | 'class' | 'node';

/**
 * Property definition
 */
export interface Property {
  id: number;
  uuid: string;
  name: string;
  icon: string | null;
  description?: string; // Optional description for the property
  type: PropertyType;
  multi: boolean;
  is_system: boolean;
  /** @deprecated use scope instead */
  is_local: boolean;  // True when scope !== 'global'
  scope: PropertyScope;  // 'global' | 'class' | 'node'
  node_id: number | null;  // For scoped properties, the node this property is scoped to
  icon_visibility: PropertyIconVisibility;  // Where to show selection value icon at block level
  validation_rules: Record<string, unknown> | null;  // Optional validation constraints
  create_date: string;
  write_date: string;
  // For node-type properties
  class_filters: number[];
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
  icon: string | null; // plain icon name
  color: string | null; // Hex or CSS color for the pill (#e2e8f0, blue, etc.)
  sequence: number;
}

/**
 * Class property (property linked to a class)
 */
export interface ClassProperty {
  id: number;
  class_node_id: number;
  class_node_name: string;
  property_id: number;
  property_name: string;
  property_type: PropertyType;
  sequence: number;
  default_value: unknown;
  hidden: boolean;  // Whether this property is hidden by default in the UI
  required: boolean;  // Whether this property is required for nodes of this class
}

/**
 * Inherited property (property inherited from an extended class)
 */
export interface InheritedProperty {
  property_id: number;
  property_name: string;
  property_type: PropertyType;
  from_class_id: number;
  from_class_name: string;
  sequence: number;
  default_value: unknown;
  hidden: boolean;
  is_overridden: boolean;  // True if exists as a dedicated class property
}

/**
 * Extended by class info (classes that extend this class)
 */
export interface ExtendedByClass {
  id: number;
  uuid: string;
  name: string;
  icon: string | null;
}

/**
 * Class extends (inheritance relationship)
 */
export interface ClassExtends {
  id: number;
  class_node_id: number;
  class_node_name: string;
  extends_class_node_id: number;
  extends_class_node_name: string;
  extends_class_icon?: string | null;
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
  /** @deprecated use scope instead */
  is_local?: boolean;  // Backward compat — use scope when possible
  scope?: PropertyScope;  // 'global' | 'class' | 'node'
  node_id?: number | null;  // Required when scope is 'class' or 'node'
  class_filters?: number[];
  options?: string[];
}

/**
 * Data for updating a property
 */
export interface PropertyUpdate {
  name?: string | null;
  icon?: string | null;
  multi?: boolean | null;  // Aligned with backend naming
  class_filters?: number[] | null;
  icon_visibility?: PropertyIconVisibility | null;
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

export interface ClassPropertiesResponse {
  class_properties: ClassProperty[];
}

export interface ClassExtendsResponse {
  extends: ClassExtends[];
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
 * Format: 00000000-0000-0000-00dd-YYYYMMDD0000
 */
export function generateDayUuid(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `00000000-0000-0000-00dd-${year}${month}${day}0000`;
}

/**
 * Generate a month UUID
 * Format: 00000000-0000-0000-00aa-YYYYMM000000
 */
export function generateMonthUuid(year: number, month: number): string {
  return `00000000-0000-0000-00aa-${year}${String(month).padStart(2, '0')}000000`;
}

/**
 * Generate a year UUID
 * Format: 00000000-0000-0000-00bb-YYYY00000000
 */
export function generateYearUuid(year: number): string {
  return `00000000-0000-0000-00bb-${year}00000000`;
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
