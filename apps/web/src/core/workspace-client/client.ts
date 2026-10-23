/**
 * WorkspaceClient — the Notees web data path (slice 1).
 *
 * A thin, fully Node-testable layer over three pieces: a Store over the sql.js
 * backend (local derived state), a SyncEngine (outbox push + seq-cursor
 * catch-up pull + snapshot shortcut), and a Transport (HttpTransport against a
 * relay server in the app, MemoryTransport over a MemoryRelay in tests).
 *
 * Reads always hit the LOCAL store. Writes build protocol envelopes
 * (`newEnvelope`, deviceId "web"), apply optimistically via the engine's
 * enqueue (local-first), then push. `subscribe` is a naive notification fired
 * on local apply and on sync completion — enough for a render-refresh loop.
 *
 * The class is composed, not inherited: a shared ClientContext
 * (client-context.ts) holds the infrastructure (store handle + options,
 * envelope/outbox seam, engine lifecycle, notify funnel, read caches, undo
 * journal), and the operation domains (client-*.ts) are standalone classes the
 * client owns and delegates its entire public surface to — one-line
 * delegations below, grouped by domain. The public API (class name, method
 * surface, factories, the `store` field) is exactly the former concrete
 * class's; ~110 importers and `instanceof WorkspaceClient` are unaffected.
 */

import initSqlJs, { type SqlJsStatic } from "sql.js";

import { HttpTransport, OfflineTransport } from "@notees/sync";
import type { Envelope } from "@notees/protocol";
import { Store, type GraphOptions } from "@notees/store";
import { sqljsBackend } from "@notees/store/sqljs";
import type { WorkspaceFeature } from "@notees/protocol";

import type { WorkspaceClientOptions } from "./types.js";
import type { PrefsPatch } from "./prefs.js";
import type {
  AssetUploadResult,
  ChangeNotification,
  ClientNode,
  CreateAnnotationInput,
  CreateObjectInput,
  CreatePropertySchemaInput,
  DatetimeValueInput,
  DeleteObjectOptions,
  SetClassPropertyInput,
  UpdateObjectInput,
  UpdatePropertySchemaInput,
} from "./types.js";
import { ClientContext } from "./client-context.js";
import { WorkspaceClientReads } from "./client-reads.js";
import { WorkspaceClientReadsProps } from "./client-reads-props.js";
import { WorkspaceClientReadsRefs } from "./client-reads-refs.js";
import { WorkspaceClientSync } from "./client-sync.js";
import { WorkspaceClientServer } from "./client-server.js";
import { WorkspaceClientUndo, buildUndoCaptureSource } from "./client-undo.js";
import { WorkspaceClientWrites } from "./client-writes.js";
import { WorkspaceClientDates } from "./client-dates.js";

export class WorkspaceClient {
  /** The shared infrastructure the domains delegate to. */
  private readonly ctx: ClientContext;
  private readonly reads: WorkspaceClientReads;
  private readonly readsProps: WorkspaceClientReadsProps;
  private readonly readsRefs: WorkspaceClientReadsRefs;
  private readonly syncDomain: WorkspaceClientSync;
  private readonly server: WorkspaceClientServer;
  private readonly undoDomain: WorkspaceClientUndo;
  private readonly writes: WorkspaceClientWrites;
  private readonly dates: WorkspaceClientDates;

  readonly store: Store;

  constructor(store: Store, options: WorkspaceClientOptions) {
    this.store = store;
    this.ctx = new ClientContext(store, options, buildUndoCaptureSource);
    this.reads = new WorkspaceClientReads(this.ctx);
    this.readsProps = new WorkspaceClientReadsProps(this.ctx, this.reads);
    this.readsRefs = new WorkspaceClientReadsRefs(this.ctx, this.reads, this.readsProps);
    this.syncDomain = new WorkspaceClientSync(this.ctx);
    this.server = new WorkspaceClientServer(this.ctx);
    this.undoDomain = new WorkspaceClientUndo(this.ctx);
    this.writes = new WorkspaceClientWrites(this.ctx, this.reads, this.readsProps);
    this.dates = new WorkspaceClientDates(this.reads, this.readsProps, this.writes);
  }

  /** Open a Store over the sql.js backend and wrap it in a client. */
  static async create(options: WorkspaceClientOptions): Promise<WorkspaceClient> {
    const SQL = options.sqlJs ?? (await initSqlJs(options.sqlJsConfig));
    const store = Store.open(sqljsBackend(SQL));
    return new WorkspaceClient(store, options);
  }

  /**
   * Wrap an already-open Store (worker persistence path: the caller restores
   * saved bytes into the store before wrapping it).
   */
  static wrap(store: Store, options: WorkspaceClientOptions): WorkspaceClient {
    return new WorkspaceClient(store, options);
  }

  /** Factory for the app path: HTTP transport against a relay server. The
   * `apiKey` slot carries the credential — the operator API key or an
   * account session token (the server accepts both, see routes-auth). */
  static async createHttp(options: {
    serverUrl: string;
    apiKey: string;
    workspaceId: string;
    sqlJsConfig?: Parameters<typeof initSqlJs>[0];
  }): Promise<WorkspaceClient> {
    const transport = new HttpTransport({
      baseUrl: options.serverUrl,
      apiKey: options.apiKey,
      workspaceId: options.workspaceId,
    });
    return WorkspaceClient.create({
      transport,
      serverUrl: options.serverUrl,
      apiKey: options.apiKey,
      sqlJsConfig: options.sqlJsConfig,
    });
  }

  /**
   * Offline-first factory: no server, no account. Edits apply locally and
   * are recorded in the durable local op log; when the user later connects
   * this workspace to a server (login), the backlog pushes through the
   * normal outbox path.
   */
  static async createOffline(options: {
    workspaceId: string;
    sqlJs?: SqlJsStatic;
    sqlJsConfig?: Parameters<typeof initSqlJs>[0];
  }): Promise<WorkspaceClient> {
    return WorkspaceClient.create({
      transport: new OfflineTransport(),
      ...(options.sqlJs !== undefined ? { sqlJs: options.sqlJs } : {}),
      ...(options.sqlJsConfig !== undefined ? { sqlJsConfig: options.sqlJsConfig } : {}),
    });
  }

  // --- identity + lifecycle (context) ------------------------------------------

  getWorkspaceId(): string {
    return this.ctx.getWorkspaceId();
  }

  graphTopology(options?: GraphOptions) {
    return this.ctx.graphTopology(options);
  }

  subscribe(listener: (change: ChangeNotification) => void): () => void {
    return this.ctx.subscribe(listener);
  }

  close(): void {
    this.ctx.close(() => this.syncDomain.stopRealtime());
  }

  // --- sync (engine bootstrap, push/pull, realtime, status) ---------------------

  bootstrapWorkspace(workspaceId: string): Promise<void> {
    return this.syncDomain.bootstrapWorkspace(workspaceId);
  }

  sync(): Promise<void> {
    return this.syncDomain.sync();
  }

  push(): Promise<void> {
    return this.syncDomain.push();
  }

  pull(): Promise<void> {
    return this.syncDomain.pull();
  }

  startRealtime(): void {
    this.syncDomain.startRealtime();
  }

  stopRealtime(): void {
    this.syncDomain.stopRealtime();
  }

  isRealtimeActive(): boolean {
    return this.syncDomain.isRealtimeActive();
  }

  conflictHistory() {
    return this.syncDomain.conflictHistory();
  }

  status() {
    return this.syncDomain.status();
  }

  applyRemoteBatch(envelopes: Envelope[], seqs?: Record<string, number> | null): void {
    this.syncDomain.applyRemoteBatch(envelopes, seqs);
  }

  // --- node + listing + class-binding reads -------------------------------------

  getNode(id: string) {
    return this.reads.getNode(id);
  }

  getNodeRaw(id: string) {
    return this.reads.getNodeRaw(id);
  }

  getDisplayName(id: string) {
    return this.reads.getDisplayName(id);
  }

  getPage(id: string) {
    return this.reads.getPage(id);
  }

  listPages() {
    return this.reads.listPages();
  }

  roots() {
    return this.reads.roots();
  }

  listTrashed() {
    return this.reads.listTrashed();
  }

  /** The Archived surface's read — archived rows (no trash row), newest first. */
  listArchived() {
    return this.reads.listArchived();
  }

  /** Archived CLASS nodes (the class picker's dimmed enable matches). */
  listArchivedClasses() {
    return this.reads.listArchivedClasses();
  }

  listClasses() {
    return this.reads.listClasses();
  }

  classIcons() {
    return this.reads.classIcons();
  }

  effectiveClassIcons() {
    return this.reads.effectiveClassIcons();
  }

  getClassParents(classId: string) {
    return this.reads.getClassParents(classId);
  }

  getDirectClassChildren(classId: string) {
    return this.reads.getDirectClassChildren(classId);
  }

  getClassChildren(classId: string) {
    return this.reads.getClassChildren(classId);
  }

  getClassMembers(classId: string) {
    return this.reads.getClassMembers(classId);
  }

  getClassMemberCount(classId: string) {
    return this.reads.getClassMemberCount(classId);
  }

  getClassBindings(classId: string) {
    return this.reads.getClassBindings(classId);
  }

  getRegistryBindings(classId: string) {
    return this.reads.getRegistryBindings(classId);
  }

  // --- property + asset + tree + search/query reads -------------------------------

  getEffectiveProperties(id: string) {
    return this.readsProps.getEffectiveProperties(id);
  }

  getPropertyReferences(schemaId: string) {
    return this.readsProps.getPropertyReferences(schemaId);
  }

  getCoverReferences(assetId: string) {
    return this.readsProps.getCoverReferences(assetId);
  }

  getAssetInfo(id: string) {
    return this.readsProps.getAssetInfo(id);
  }

  getAssetDataUrl(assetNodeId: string) {
    return this.readsProps.getAssetDataUrl(assetNodeId);
  }

  getAnnotationsForAsset(assetId: string) {
    return this.readsProps.getAnnotationsForAsset(assetId);
  }

  listPropertySchemas() {
    return this.readsProps.listPropertySchemas();
  }

  getBlockTree(pageId: string, depth?: number | null) {
    return this.readsProps.getBlockTree(pageId, depth);
  }

  search(query: string, limit?: number) {
    return this.readsProps.search(query, limit);
  }

  searchPage(
    query: string,
    opts?: { limit?: number; cursor?: string | null } | null,
  ) {
    return this.readsProps.searchPage(query, opts);
  }

  getSearchSnippet(
    nodeId: string,
    query: string,
    opts?: { maxTokens?: number; ellipsis?: string } | null,
  ) {
    return this.readsProps.getSearchSnippet(nodeId, query, opts);
  }

  resolveNodeByName(name: string) {
    return this.readsProps.resolveNodeByName(name);
  }

  runQueryAst(rawAst: unknown) {
    return this.readsProps.runQueryAst(rawAst);
  }

  runAggregateAst(rawAst: unknown) {
    return this.readsProps.runAggregateAst(rawAst);
  }

  getChildren(id: string) {
    return this.readsProps.getChildren(id);
  }

  getChildrenFresh(id: string) {
    return this.readsProps.getChildrenFresh(id);
  }

  // --- references + render derivation + features -----------------------------------

  effectiveClassColor(classId: string) {
    return this.readsRefs.effectiveClassColor(classId);
  }

  effectiveClassIcon(classId: string) {
    return this.readsRefs.effectiveClassIcon(classId);
  }

  effectiveNodeIcon(
    node: Pick<ClientNode, "icon" | "classIds" | "isClass" | "isEmbedded" | "parentId">,
  ) {
    return this.readsRefs.effectiveNodeIcon(node);
  }

  effectiveNodeColor(node: Pick<ClientNode, "color" | "classIds">) {
    return this.readsRefs.effectiveNodeColor(node);
  }

  getBacklinks(id: string) {
    return this.readsRefs.getBacklinks(id);
  }

  getLinkedReferences(id: string) {
    return this.readsRefs.getLinkedReferences(id);
  }

  getReferences(id: string) {
    return this.readsRefs.getReferences(id);
  }

  getReferenceCount(id: string) {
    return this.readsRefs.getReferenceCount(id);
  }

  getUnlinkedReferences(id: string) {
    return this.readsRefs.getUnlinkedReferences(id);
  }

  getUnlinkedReferenceCount(id: string) {
    return this.readsRefs.getUnlinkedReferenceCount(id);
  }

  aliasNodesOf(id: string) {
    return this.readsRefs.aliasNodesOf(id);
  }

  resolveAlias(id: string) {
    return this.readsRefs.resolveAlias(id);
  }

  getChildPages(id: string) {
    return this.readsRefs.getChildPages(id);
  }

  getBacklinkCount(id: string) {
    return this.readsRefs.getBacklinkCount(id);
  }

  isFeatureEnabled(feature: WorkspaceFeature) {
    return this.readsRefs.isFeatureEnabled(feature);
  }

  listFeatureRows() {
    return this.readsRefs.listFeatureRows();
  }

  getFeatureInstanceCount(feature: WorkspaceFeature) {
    return this.readsRefs.getFeatureInstanceCount(feature);
  }

  setFeatureEnabled(feature: WorkspaceFeature, enabled: boolean) {
    return this.readsRefs.setFeatureEnabled(feature, enabled);
  }

  getChildPageCount(id: string) {
    return this.readsRefs.getChildPageCount(id);
  }

  // --- server-facing REST (assets, prefs, section views, history feeds) ------------

  getPrefs() {
    return this.server.getPrefs();
  }

  patchPrefs(patch: PrefsPatch) {
    return this.server.patchPrefs(patch);
  }

  listSectionViews(nodeId: string, sectionKey: string) {
    return this.server.listSectionViews(nodeId, sectionKey);
  }

  createSectionView(input: {
    nodeId: string;
    sectionKey: string;
    name: string;
    queryAst: unknown;
    viewMode?: string | null;
  }) {
    return this.server.createSectionView(input);
  }

  renameSectionView(nodeId: string, sectionKey: string, viewId: string, name: string) {
    return this.server.renameSectionView(nodeId, sectionKey, viewId, name);
  }

  reorderSectionViews(nodeId: string, sectionKey: string, orderedIds: string[]) {
    return this.server.reorderSectionViews(nodeId, sectionKey, orderedIds);
  }

  deleteSectionView(nodeId: string, sectionKey: string, viewId: string) {
    return this.server.deleteSectionView(nodeId, sectionKey, viewId);
  }

  uploadAsset(file: Blob, filename: string) {
    return this.server.uploadAsset(file, filename);
  }

  attachAsset(objectId: string, asset: AssetUploadResult) {
    return this.server.attachAsset(objectId, asset);
  }

  fetchAssetBytes(assetId: string) {
    return this.server.fetchAssetBytes(assetId);
  }

  downloadAsset(assetId: string) {
    return this.server.downloadAsset(assetId);
  }

  fetchOperationsFor(objectId: string, propertySchemaId: string) {
    return this.server.fetchOperationsFor(objectId, propertySchemaId);
  }

  fetchNodeHistory(nodeId: string) {
    return this.server.fetchNodeHistory(nodeId);
  }

  // --- undo journal chrome ----------------------------------------------------------

  undoState() {
    return this.undoDomain.undoState();
  }

  undoHistory() {
    return this.undoDomain.undoHistory();
  }

  undo() {
    return this.undoDomain.undo();
  }

  redo() {
    return this.undoDomain.redo();
  }

  undoDepth() {
    return this.undoDomain.undoDepth();
  }

  // --- writes (objects, classes, tags, property schemas, property values) -------------

  createObject(partial: CreateObjectInput) {
    return this.writes.createObject(partial);
  }

  updateObject(id: string, fields: UpdateObjectInput) {
    return this.writes.updateObject(id, fields);
  }

  setArchived(id: string, active: boolean) {
    return this.writes.setArchived(id, active);
  }

  deleteObject(id: string, opts: DeleteObjectOptions = {}) {
    return this.writes.deleteObject(id, opts);
  }

  restoreObject(id: string) {
    return this.writes.restoreObject(id);
  }

  emptyTrash() {
    return this.writes.emptyTrash();
  }

  moveObject(id: string, parentId: string | null, afterId?: string, beforeId?: string) {
    return this.writes.moveObject(id, parentId, afterId, beforeId);
  }

  mergeNodes(sourceId: string, targetId: string) {
    return this.writes.mergeNodes(sourceId, targetId);
  }

  assignClass(id: string, classId: string) {
    return this.writes.assignClass(id, classId);
  }

  reorderClasses(id: string, classIds: string[]) {
    return this.writes.reorderClasses(id, classIds);
  }

  unassignClass(id: string, classId: string) {
    return this.writes.unassignClass(id, classId);
  }

  assignTag(id: string, tagId: string) {
    return this.writes.assignTag(id, tagId);
  }

  unassignTag(id: string, tagId: string) {
    return this.writes.unassignTag(id, tagId);
  }

  createClass(name: string, opts?: { icon?: string; color?: string; id?: string }) {
    return this.writes.createClass(name, opts);
  }

  setClassExtends(classId: string, parentClassIds: string[]) {
    return this.writes.setClassExtends(classId, parentClassIds);
  }

  setClassProperty(classId: string, propertySchemaId: string, fields: SetClassPropertyInput) {
    return this.writes.setClassProperty(classId, propertySchemaId, fields);
  }

  unsetClassProperty(classId: string, propertySchemaId: string) {
    return this.writes.unsetClassProperty(classId, propertySchemaId);
  }

  createPropertySchema(input: CreatePropertySchemaInput) {
    return this.writes.createPropertySchema(input);
  }

  updatePropertySchema(propertySchemaId: string, fields: UpdatePropertySchemaInput) {
    return this.writes.updatePropertySchema(propertySchemaId, fields);
  }

  deletePropertySchema(propertySchemaId: string) {
    return this.writes.deletePropertySchema(propertySchemaId);
  }

  setProperty(
    objectId: string,
    propertySchemaId: string,
    value: unknown,
    idx = 0,
    metadata?: Record<string, unknown>,
    elementId?: string,
  ) {
    return this.writes.setProperty(objectId, propertySchemaId, value, idx, metadata, elementId);
  }

  unsetProperty(objectId: string, propertySchemaId: string, idx = 0) {
    return this.writes.unsetProperty(objectId, propertySchemaId, idx);
  }

  assignProperty(objectId: string, propertySchemaId: string) {
    return this.writes.assignProperty(objectId, propertySchemaId);
  }

  unassignProperty(objectId: string, propertySchemaId: string) {
    return this.writes.unassignProperty(objectId, propertySchemaId);
  }

  emptyProperty(objectId: string, propertySchemaId: string) {
    return this.writes.emptyProperty(objectId, propertySchemaId);
  }

  promotePropertyCarrier(objectId: string, propertySchemaId: string, idx = 0) {
    return this.writes.promotePropertyCarrier(objectId, propertySchemaId, idx);
  }

  // --- dates + annotations -----------------------------------------------------------

  ensureDateChain(isoDate: string) {
    return this.dates.ensureDateChain(isoDate);
  }

  setDatetimeProperty(
    objectId: string,
    propertySchemaId: string,
    value: DatetimeValueInput,
    idx = 0,
    metadata?: Record<string, unknown>,
  ) {
    return this.dates.setDatetimeProperty(objectId, propertySchemaId, value, idx, metadata);
  }

  createAnnotation(input: CreateAnnotationInput) {
    return this.dates.createAnnotation(input);
  }
}
