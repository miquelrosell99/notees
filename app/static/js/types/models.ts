/**
 * AUTO-GENERATED TYPE DEFINITIONS
 * Generated from Python Pydantic models
 * DO NOT EDIT MANUALLY - Run: python scripts/generate_types.py
 */

// ==================== ENUMS ====================

export const NodeType = {
  TAG: "tag",
  PAGE: "page",
  YEAR: "year",
  MONTH: "month",
  DAY: "day",
  QUOTE: "quote",
  QUERY: "query",
  CODE: "code",
  ASSET: "asset",
  WHITEBOARD: "whiteboard",
  CARD: "card",
  TASK: "task",
  TEMPLATE: "template",
} as const;

export type NodeType = typeof NodeType[keyof typeof NodeType];

// ==================== NODE TYPES ====================

export interface NodeBase {
  name?: any | null;
  display_name?: any | null;
  content?: string;  // default: 
  title?: any | null;
  parent_id?: any | null;
  page_id?: any | null;
  order?: number;  // default: 0
  collapsed?: boolean;  // default: False
  tags?: string[];  // default: []
  properties?: Record<string, any>;  // default: {}
  is_page?: boolean;  // default: False
  is_tag?: boolean;  // default: False
  is_property?: boolean;  // default: False
  is_template?: boolean;  // default: False
  is_task?: boolean;  // default: False
  is_system?: boolean;  // default: False
  is_daily?: boolean;  // default: False
  is_monthly?: boolean;  // default: False
  is_yearly?: boolean;  // default: False
  daily_date?: any | null;
}

export interface NodeCreate {
  name?: any | null;
  display_name?: any | null;
  content?: string;  // default: 
  title?: any | null;
  parent_id?: any | null;
  page_id?: any | null;
  order?: number;  // default: 0
  collapsed?: boolean;  // default: False
  tags?: string[];  // default: []
  properties?: Record<string, any>;  // default: {}
  is_page?: boolean;  // default: False
  is_tag?: boolean;  // default: False
  is_property?: boolean;  // default: False
  is_template?: boolean;  // default: False
  is_task?: boolean;  // default: False
  is_system?: boolean;  // default: False
  is_daily?: boolean;  // default: False
  is_monthly?: boolean;  // default: False
  is_yearly?: boolean;  // default: False
  daily_date?: any | null;
  id?: any | null;
  uuid?: any | null;
}

export interface NodeUpdate {
  name?: any | null;
  display_name?: any | null;
  content?: any | null;
  title?: any | null;
  parent_id?: any | null;
  page_id?: any | null;
  order?: any | null;
  collapsed?: any | null;
  tags?: string[];
  properties?: Record<string, any>;
}

export interface Node {
  name?: any | null;
  display_name?: any | null;
  content?: string;  // default: 
  title?: any | null;
  parent_id?: any | null;
  page_id?: any | null;
  order?: number;  // default: 0
  collapsed?: boolean;  // default: False
  tags?: string[];  // default: []
  properties?: Record<string, any>;  // default: {}
  is_page?: boolean;  // default: False
  is_tag?: boolean;  // default: False
  is_property?: boolean;  // default: False
  is_template?: boolean;  // default: False
  is_task?: boolean;  // default: False
  is_system?: boolean;  // default: False
  is_daily?: boolean;  // default: False
  is_monthly?: boolean;  // default: False
  is_yearly?: boolean;  // default: False
  daily_date?: any | null;
  id: string;
  uuid: string;
  created_at: string;
  updated_at: string;
  create_uid?: any | null;
  write_uid?: any | null;
  version?: number;  // default: 1
}

// ==================== USER TYPES ====================

// ==================== HELPER TYPES ====================

/**
 * Node data for sync operations
 */
export type NodeSyncData = Partial<Node> & {
  id: string;
};

/**
 * All node type flags
 */
export interface NodeTypeFlags {
  is_page?: boolean;
  is_tag?: boolean;
  is_property?: boolean;
  is_template?: boolean;
  is_task?: boolean;
  is_system?: boolean;
  is_daily?: boolean;
  is_monthly?: boolean;
  is_yearly?: boolean;
}

/**
 * API Response wrapper
 */
export interface ApiResponse<T> {
  data: T;
  success: boolean;
  message?: string;
}

/**
 * Paginated response
 */
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
