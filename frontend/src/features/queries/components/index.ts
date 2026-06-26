/**
 * Lightweight query components barrel.
 *
 * Heavy query-builder UI (ViewBuilder, ProseScopeSelector, ProseConditionBuilder)
 * is intentionally excluded here so it can be lazy-loaded from
 * `@/features/queries/components/<Component>` only when the query editor is open.
 */
export { QuerySQLPreview } from './QuerySQLPreview';
