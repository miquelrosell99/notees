/**
 * Substitute runtime parameter placeholders into a QueryAST.
 *
 * The backend resolves placeholders like `{current_node_uuid}` from the
 * `runtime_params` map. For client-side SQLite evaluation we perform the same
 * substitution before handing the AST to the SQLite compiler.
 */

import type { QueryAST } from '@/types/queryAST';

const PLACEHOLDERS = ['{current_node_uuid}', '{current_node_id}', '{current_node_name}'] as const;

type Placeholder = (typeof PLACEHOLDERS)[number];

function isPlaceholder(value: unknown): value is Placeholder {
  return typeof value === 'string' && PLACEHOLDERS.includes(value as Placeholder);
}

function substituteValue(value: unknown, params: Record<string, unknown>): unknown {
  if (!isPlaceholder(value)) return value;

  if (value === '{current_node_uuid}' || value === '{current_node_id}') {
    const uuid = params.current_node_uuid ?? params.current_node_id;
    return typeof uuid === 'string' ? uuid : value;
  }

  if (value === '{current_node_name}') {
    const name = params.current_node_name;
    return typeof name === 'string' ? name : value;
  }

  return value;
}

function substituteInObject(obj: unknown, params: Record<string, unknown>): unknown {
  if (Array.isArray(obj)) {
    return obj.map((item) => substituteInObject(item, params));
  }

  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = substituteInObject(value, params);
    }
    return result;
  }

  return substituteValue(obj, params);
}

/**
 * Return a deep clone of the AST with runtime placeholders resolved.
 */
export function substituteRuntimeParams(
  ast: QueryAST,
  params: Record<string, unknown>,
): QueryAST {
  return substituteInObject(ast, params) as QueryAST;
}
