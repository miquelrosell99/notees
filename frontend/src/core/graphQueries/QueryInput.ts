export interface NodeInput { nodeUuid: string; }
export interface PaginatedInput extends NodeInput { limit?: number; offset?: number; }
