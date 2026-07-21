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
 * Everything in Notees is a node. Nodes are differentiated by system classes:
 * - Page: has the "page" system class
 * - Block: has parent_uuid (child of another node)
 * - Date nodes: have "day", "month", or "year" system class
 * - Tags: pages referenced by other nodes' tag_uuids array
 */
export interface Node {
  uuid: string;
  name: string;
  /** Raw stored content (AST JSON or plain text) from the operation-log derived store. */
  content?: string;
  icon: string | null;
  color: string | null;
  parent_uuid: string | null;
  page_uuid: string | null;
  sequence: number;
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

  // Computed fields
  display_name?: string | null;
  tags_uuid?: string[];
  classes_uuid?: string[];
  classes_path_uuid?: string[];
  properties_uuid?: Record<string, unknown>;
  is_daily?: boolean; // Whether this is a daily note
  is_monthly?: boolean; // Whether this is a monthly note
  is_yearly?: boolean; // Whether this is a yearly note
  is_comment?: boolean; // Whether this node is a comment
  is_task?: boolean; // Whether this node is a task item
  is_asset?: boolean; // Whether this node is an asset/file block
  is_template?: boolean; // Whether this node is a template page
  is_card?: boolean; // Whether this node is a flashcard/quiz card
  parent_locked?: boolean; // Whether this node's parent is locked
  is_private?: boolean; // If true, only the owner can access this node

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
  aliased_uuid?: string | null;
  aliases_uuid?: string[];

  // Class extension (Extends chain) - parent class UUIDs in order
  extends_uuid?: string[];

  // Resolved permissions for the current user on this node.
  // Only populated for top-level node fetches.
  permissions?: {
    can_read: boolean;
    can_write: boolean;
    can_create: boolean;
    can_delete: boolean;
  };

  // Referenced nodes map — uuid → node data for outgoing link targets.
  // Populated by page content endpoint so inline links resolve without N+1 queries.
  referenced_nodes?: Record<string, Node>;

  // Metadata for linked references (attached client-side)
  _linkedRefMetadata?: {
    linkType: 'text' | 'property';
    propertyUuid?: string;
    propertyName?: string;
    targetNodeUuid?: string;
    // The actual source node UUID (when displaying page in list view, this is the block with the property)
    sourceNodeUuid?: string;
  };
}

/**
 * Helper to check if a node is a page
 */
export function isPage(node: Node): boolean {
  return node.is_page ?? false;
}

/**
 * Helper to check if a node is a block
 */
export function isBlock(node: Node): boolean {
  return node.parent_uuid !== null;
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
  source_node_uuid: string;
  source_node_name: string;
  source_page_uuid: string | null;
  source_page_name: string | null;
  link_type: LinkType;
  position: number;
}

/**
 * Breadcrumb segment for showing path hierarchy
 */
export interface BreadcrumbSegment {
  node_uuid: string | null;
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
  property_uuid?: string;
  property_name?: string;
  /** For text-property-context links: root block UUID of the text property */
  text_property_root_block_uuid?: string;
}

export type LinkType = 'page' | 'block';

// ==================== Graph Types ====================

/**
 * Graph node for visualization
 */
export interface GraphNode {
  uuid: string;
  name: string;
  type?: 'page' | 'block';
  tags?: string[];
  class_uuids?: string[];
  properties?: Record<string, unknown>;
  is_daily?: boolean;
  is_class?: boolean;
  is_monthly?: boolean;
  is_yearly?: boolean;
  icon?: string;
  created_at?: string;
  backlink_count?: number;
  internal_link_count?: number;
  block_count?: number;
  aliased_uuid?: string | null;
}

/**
 * Graph link for visualization
 */
export interface GraphLink {
  source: string;
  target: string;
  type: 'parent' | 'reference' | 'class' | 'extends' | 'property-reference' | 'cooccurrence';
  weight?: number;
}

/**
 * Graph data response
 * @deprecated Use graph nodes + graph links separately instead
 */
export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
  total?: number;
  page?: number;
  page_size?: number;
  has_next?: boolean;
  has_prev?: boolean;
}

/**
 * Data for creating a new node
 */
export interface NodeCreate {
  name?: string;
  icon?: string | null;
  color?: string | null;
  parent_uuid?: string | null;
  sequence?: number;
  tag_uuids?: string[];
  class_uuids?: string[];
  property_uuids?: Record<string, unknown>;
  uuid?: string; // Optional: override auto-generated UUID (e.g. from Logseq import)
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
  parent_uuid?: string | null;
  sequence?: number | null;
  is_private?: boolean | null;
  is_page?: boolean | null;
  is_favorite?: boolean | null;
  /** When provided, reconcile node classes to exactly this set (Odoo-style write) */
  class_uuids?: string[];
  tag_uuids?: string[];
  /** When provided, apply each property_uuid -> value pair */
  property_uuids?: Record<string, unknown>;
}

// ==================== Batch Read Operations ====================

/**
 * Request to fetch multiple nodes by UUID in a single call
 */
export interface BatchGetNodesByUuidRequest {
  uuids: string[];
  include_properties?: boolean;
}

/**
 * Response for batch node fetch by UUID — keyed by node UUID
 */
export interface BatchGetNodesByUuidResponse {
  nodes: Record<string, Node>;
}

/**
 * A single breadcrumb in the ancestor chain
 */
export interface BreadcrumbItemResponse {
  uuid: string;
  name: string;
  display_name: string;
  icon: string | null;
  is_page: boolean;
  parent_locked: boolean;
  is_property?: boolean;
  property_uuid?: string | null;
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
  parent_uuid?: string | null;
  sequence?: number;
  tag_uuids?: string[];
  class_uuids?: string[];
  property_uuids?: Record<string, unknown>;
  uuid?: string; // Optional: provide a UUID (e.g. from Logseq)
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
  uuid: string;
  name?: string | null;
  icon?: string | null;
  color?: string | null;
  parent_uuid?: string | null;
  sequence?: number | null;
  /** When provided, reconcile node classes to exactly this set */
  class_uuids?: string[];
  tag_uuids?: string[];
  /** When provided, apply each property_uuid -> value pair */
  property_uuids?: Record<string, unknown>;
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
  uuids: string[];
}

/**
 * Result for a single permanent delete in a batch
 */
export interface BatchPermanentDeleteResultItem {
  index: number;
  uuid: string;
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
export type PropertyType = 'integer' | 'float' | 'text' | 'boolean' | 'url' | 'email' | 'node' | 'selection' | 'date' | 'date_range' | 'image';

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
  uuid: string;
  name: string;
  icon: string | null;
  description?: string; // Optional description for the property
  type: PropertyType;
  multi: boolean;
  is_system: boolean;
  scope: PropertyScope; // 'global' | 'class' | 'node'
  node_uuid: string | null;
  icon_visibility: PropertyIconVisibility; // Where to show selection value icon at block level
  validation_rules: Record<string, unknown> | null; // Optional validation constraints
  // Attribute bases (class bindings may override the flags tri-state)
  required: boolean;
  readonly: boolean;
  hide_when_empty: boolean;
  default_value: unknown | null; // UUIDs for selection/node defaults; null when unset
  create_date: string;
  write_date: string;
  // For node-type properties
  class_filter_uuids: string[];
  // For selection-type properties
  options: SelectionOption[];
}

/**
 * Property backlink (pages that reference via property)
 */
export interface PropertyBacklink {
  source_page: Node;
  property_uuid: string;
  property_name: string;
}

/**
 * Text link info
 */
export interface TextLink {
  uuid: string;
  source_node_uuid: string;
  target_node_uuid: string;
  position: number;
  name?: string | null;
}

/**
 * Selection option for selection-type properties
 */
export interface SelectionOption {
  uuid: string;
  name: string;
  icon: string | null; // plain icon name
  color: string | null; // Hex or CSS color for the pill (#e2e8f0, blue, etc.)
  sequence: number;
}

/**
 * Class property (property linked to a class)
 */
export interface ClassProperty {
  class_node_uuid: string;
  class_node_name: string;
  property_uuid: string;
  property_name: string;
  property_type: PropertyType;
  sequence: number;
  default_value: unknown | null; // null when unset (backend contract)
  hidden: boolean; // Whether this property is hidden by default in the UI
  required: boolean | null; // tri-state: null = inherit from property
  readonly: boolean | null; // tri-state: null = inherit from property
  hide_when_empty: boolean | null; // tri-state: null = inherit from property
}

/**
 * Inherited property (property inherited from an extended class)
 */
export interface InheritedProperty {
  property_uuid: string;
  property_name: string;
  property_type: PropertyType;
  from_class_uuid: string;
  from_class_name: string;
  sequence: number;
  default_value: unknown;
  hidden: boolean;
  is_overridden: boolean; // True if exists as a dedicated class property
}

/**
 * Extended by class info (classes that extend this class)
 */
export interface ExtendedByClass {
  nodeUuid: string;
  uuid: string;
  name: string;
  icon: string | null;
}

/**
 * Class extends (inheritance relationship)
 */
export interface ClassExtends {
  class_node_uuid: string;
  class_node_name: string;
  extends_class_node_uuid: string;
  extends_class_node_name: string;
  extends_class_icon?: string | null;
  sequence: number;
}

/**
 * Property value for a node
 */
export interface PropertyValue {
  property_uuid: string;
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
  scope?: PropertyScope; // 'global' | 'class' | 'node'
  node_uuid?: string | null;
  class_filter_uuids?: string[];
  options?: string[];
}

/**
 * Data for updating a property
 */
export interface PropertyUpdate {
  name?: string | null;
  icon?: string | null;
  multi?: boolean | null; // Aligned with backend naming
  class_filter_uuids?: string[] | null;
  icon_visibility?: PropertyIconVisibility | null;
  validation_rules?: Record<string, unknown> | null;
  // Attribute bases; explicit null on default_value clears the default
  required?: boolean;
  readonly?: boolean;
  hide_when_empty?: boolean;
  default_value?: unknown | null;
}

// ==================== User Types ====================

/**
 * User entity
 */
export interface User {
  nodeUuid: string;
  uuid: string;
  email: string;
  name: string | null;
  surnames: string | null;
  profile_pic: string | null;
  role: string;
  is_active: boolean;
  totp_enabled: boolean;
}

/**
 * User creation data
 */
export interface UserCreate {
  email: string;
  password: string;
  name?: string;
  surnames?: string;
  profile_pic?: string;
  remember_me?: boolean;
}

/**
 * User login credentials
 */
export interface UserLogin {
  email: string;
  password: string;
  remember_me?: boolean;
}

/**
 * User update data
 */
export interface UserUpdate {
  name?: string | null;
  surnames?: string | null;
  profile_pic?: string | null;
}

/**
 * Self-service password change request
 */
export interface PasswordChangeRequest {
  current_password: string;
  new_password: string;
}

/**
 * Pending invitation acceptance request
 */
export interface InviteAcceptRequest {
  token: string;
  password?: string;
  name?: string;
  remember_me?: boolean;
}

/**
 * Auth status response
 */
export interface AuthStatus {
  needs_onboarding: boolean;
  authenticated: boolean;
  registration_enabled: boolean;
}

/**
 * Admin user
 */
export interface AdminUser {
  id: string;
  uuid: string;
  email: string;
  name: string | null;
  surnames: string | null;
  profile_pic: string | null;
  role: string;
  active: boolean;
  created_at: string | null;
}

/**
 * Admin user creation
 */
export interface AdminUserCreate {
  email: string;
  password: string;
  name?: string;
  surnames?: string;
  profile_pic?: string;
  role?: string;
  active?: boolean;
}

/**
 * Admin user update
 */
export interface AdminUserUpdate {
  email?: string;
  password?: string;
  name?: string;
  surnames?: string;
  profile_pic?: string;
  role?: string;
  active?: boolean;
}

/**
 * Admin metrics response
 */
export interface AdminMetrics {
  nodes: {
    total: number;
    pages: number;
    blocks: number;
    daily_journals: number;
  };
  users: number;
  workspaces: number;
  shares: {
    public: number;
    user: number;
  };
  storage_used: number;
}

/**
 * Token response
 */
export interface Token {
  access_token: string;
  refresh_token: string;
  token_type: string;
  user: User;
}

/**
 * Returned by POST /auth/login when a second factor is required instead of a
 * full token set. `purpose` distinguishes a normal verification challenge from
 * a forced first-time enrollment.
 */
export interface TwoFactorRequiredResponse {
  requires_2fa: true;
  preauth_token: string;
  purpose: 'verify' | 'setup';
}

/**
 * Enrollment payload returned by POST /auth/2fa/setup. `qr_svg` is trusted
 * server-rendered SVG markup; `secret` is the base32 key for manual entry.
 */
export interface TwoFactorSetupResponse {
  otpauth_uri: string;
  qr_svg: string;
  secret: string;
}

/**
 * One-time backup codes returned when 2FA is enabled or regenerated.
 */
export interface TwoFactorEnableResponse {
  backup_codes: string[];
}

export type LoginResponse = Token | TwoFactorRequiredResponse;

// ==================== API Key Types ====================

export interface ApiKey {
  id: string;
  name: string;
  scopes: string[];
  last_used_at: string | null;
  revoked: boolean;
  created_at: string;
}

export interface ApiKeyCreate {
  name: string;
  scopes?: string[];
}

export interface ApiKeyWithSecret extends ApiKey {
  key: string;
}

// ==================== API Response Types ====================

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  has_next: boolean;
  has_prev: boolean;
}

export interface NodesResponse {
  nodes: Node[];
}

export interface BacklinksResponse {
  backlinks: Backlink[];
}

export interface LinkedReferencesResponse {
  linked_references: LinkedReference[];
  total_count: number;
}

/**
 * Unlinked mention candidate for a target node.
 */
export interface Mention {
  uuid: string;
  source_node_uuid: string;
  source_node_name: string;
  source_is_page: boolean;
  target_uuid: string;
  match_text: string;
  position: number;
  is_ignored: boolean;
}

export interface MentionsResponse {
  mentions: Mention[];
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

/**
 * Batch property values result: nodeUuid -> propertyUuid -> value.
 */
export type BatchPropertiesResult = Record<string, Record<string, unknown>>;

// ==================== Version History ====================

/**
 * Lightweight node version snapshot
 */
export interface NodeVersion {
  uuid: string;
  name: string | null;
  created_at: string;
  user: string | null;
}

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
 * Notification item
 */
export interface NotificationResponse {
  uuid: string;
  type: string;
  actor_user_uuid: string | null;
  actor_name: string | null;
  node_uuid: string | null;
  node_name: string | null;
  message: string | null;
  is_read: boolean;
  create_date: string;
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

// ==================== Task Recurrence Types ====================

/**
 * Recurrence rule returned by the dedicated task recurrence API.
 */
export interface RecurrenceRule {
  uuid: string;
  task_node_uuid: string;
  rule_type: 'daily' | 'weekday' | 'weekly' | 'monthly' | 'yearly';
  interval: number;
  weekdays: number[] | null;
  day_of_month: number | null;
  week_of_month: number | null;
  month: number | null;
  end_after_count: number | null;
  end_date: string | null;
  active: boolean;
  create_date: string;
  write_date: string;
  description: string;
}

/**
 * Fields the client can set when creating or updating a recurrence rule.
 */
export type RecurrenceRuleInput = Omit<
  RecurrenceRule,
  'uuid' | 'task_node_uuid' | 'create_date' | 'write_date' | 'description'
>;

/**
 * A single recorded completion (or skip) of a recurring task occurrence.
 */
export interface TaskCompletion {
  uuid: string;
  task_node_uuid: string;
  scheduled_date: string | null;
  deadline_date: string | null;
  status: 'done' | 'cancelled' | 'skipped';
  completed_at: string;
  completed_by_uuid: string | null;
  create_date: string;
}

/**
 * Fields the client can send when manually recording a completion.
 */
export interface TaskCompletionInput {
  scheduled_date?: string | null;
  deadline_date?: string | null;
  status?: 'done' | 'cancelled' | 'skipped';
}
