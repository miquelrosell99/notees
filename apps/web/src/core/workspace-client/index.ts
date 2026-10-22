/**
 * The workspace-client folder module's public surface — identical to the
 * original single-file module (the historical file shim is gone; this
 * barrel is the only import surface). Internal family helpers (row
 * mappers, constants) stay unexported here on purpose.
 */
// The type-only names ride `export type` — a value-syntax re-export of an
// interface/type dies at the browser's ESM link step in dev (esbuild erases
// the type; the linker then finds no such export), even though tsc and the
// test runner tolerate it. Values stay in the value export.
export {
  InvalidQueryAstError,
  createAnnotation,
} from "./types.js";
export type {
  AssetInfo,
  AssetUploadResult,
  BlockTreeNode,
  ChangeNotification,
  ClassBinding,
  ClientEdge,
  ClientNode,
  ClientPropertyOption,
  ClientPropertySchema,
  ClientValidationRules,
  ConflictHistoryEntry,
  CreateAnnotationInput,
  CreateObjectInput,
  CreatePropertySchemaInput,
  DeleteObjectOptions,
  DatetimePointInput,
  DatetimeValueInput,
  EffectiveProperty,
  OperationFeedEntry,
  PropertyDisplay,
  QueryAggregateResult,
  QueryRunResult,
  QueryRunSummary,
  ReferenceEntry,
  SearchPageResult,
  SearchSnippetData,
  SetClassPropertyInput,
  SyncStatusSnapshot,
  ArchivedEntry,
  TrashedEntry,
  UpdateObjectInput,
  UpdatePropertySchemaInput,
  WorkspaceClientOptions,
} from "./types.js";
export { fetchAssetBlob, postAssetUpload, readBlobAsDataUrl } from "./asset-transport.js";
export {
  MAX_SYNCED_RECENTS,
  mergeFavoriteToggle,
  mergeRecentOpen,
  readDevicePrefList,
  writeDevicePrefList,
  type PrefsPatch,
  type UserPrefs,
  type UserPrefsSource,
} from "./prefs.js";
export {
  HOSTED_SECTION_KEYS,
  type HostedSectionKey,
  type SectionView,
} from "./section-views.js";
export * from "./client.js";
