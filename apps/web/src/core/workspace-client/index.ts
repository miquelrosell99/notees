/**
 * The workspace-client folder module's public surface — identical to the
 * original single-file module (the compat shim at ../workspace-client.ts
 * re-exports this). Internal family helpers (row mappers, constants) stay
 * unexported here on purpose.
 */
export {
  AssetInfo,
  AssetUploadResult,
  BlockTreeNode,
  ChangeNotification,
  ClassBinding,
  ClientEdge,
  ClientNode,
  ClientPropertyOption,
  ClientPropertySchema,
  ConflictHistoryEntry,
  CreateAnnotationInput,
  CreateObjectInput,
  CreatePropertySchemaInput,
  DeleteObjectOptions,
  DatetimePointInput,
  DatetimeValueInput,
  EffectiveProperty,
  InvalidQueryAstError,
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
  TrashedEntry,
  UpdateObjectInput,
  UpdatePropertySchemaInput,
  WorkspaceClientOptions,
  createAnnotation,
} from "./types.js";
export { fetchAssetBlob, postAssetUpload, readBlobAsDataUrl } from "./asset-transport.js";
export * from "./client.js";
