/**
 * QueryAST v1 — re-exported from @notees/protocol.
 *
 * The zod AST model lives in `packages/protocol/src/query-ast.ts` (the
 * wire-adjacent home: the content grammar's `query` token embeds it, so
 * protocol must not depend on this package). This module keeps the module
 * path stable: `import { … } from "@notees/query"` keeps working, and the
 * compiler/dsl/executor below import from here unchanged.
 */

export {
  aggregationDimensionSchema,
  aggregationMeasureSchema,
  aggregationSchema,
  childSchema,
  conditionSchema,
  groupSchema,
  notSchema,
  parseQueryAst,
  queryAstSchema,
  safeParseQueryAst,
  scopeSchema,
  sortSpecSchema,
} from "@notees/protocol";

export type {
  Aggregation,
  AggregationDimension,
  AggregationMeasure,
  Child,
  Condition,
  ContentOp,
  Group,
  Not,
  PropertyOp,
  QueryAst,
  Scope,
  SortDir,
  SortField,
  SortSpec,
} from "@notees/protocol";
