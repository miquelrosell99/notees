/**
 * The property + asset + tree + search/query read domain: effective
 * properties, property/asset references, the block-tree projection (with the
 * node-backed-property carrier exclusion), FTS search (sync, paginated,
 * snippets), name resolution, the live-query bridge (runQueryAst /
 * runAggregateAst over @notees/query), and direct-children reads.
 * All reads hit the LOCAL store only. Standalone domain — takes the shared
 * ClientContext and the reads domain, no inheritance.
 */

import {
  deriveDisplayName,
  rendersWithDocumentChrome,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
} from "@notees/domain";
import { parseQueryAst, runAggregate, runQuery, type QueryAst } from "@notees/query";
import { visiblePropertyValueRows, type NodeRow } from "@notees/store";

import { aliasValuesOf } from "../../features/metadata/aliasProperty.js";
import { fetchAssetBlob, readBlobAsDataUrl } from "./asset-transport.js";
import { mapNode } from "./mappers.js";
import {
  DEFAULT_TREE_DEPTH,
  InvalidQueryAstError,
  UUID_LIKE,
  type AssetInfo,
  type BlockTreeNode,
  type EffectiveProperty,
  type ClientNode,
  type ClientPropertyOption,
  type ClientPropertySchema,
  type QueryAggregateResult,
  type QueryRunResult,
  type SearchPageResult,
  type SearchSnippetData,
} from "./types.js";
import type { ClientContext } from "./client-context.js";
import { WorkspaceClientReads } from "./client-reads.js";

export class WorkspaceClientReadsProps {
  constructor(
    private readonly ctx: ClientContext,
    private readonly reads: WorkspaceClientReads,
  ) {}

  /**
   * Alias pages of `id`: every live document-chrome node whose alias-terminal
   * is this node (the store's recursive reverse-walk over `aliased_node_id` —
   * chains included). The page restriction is the client convention
   * (SCHEMA.md "Node aliases"): non-page carriers don't act as aliases, so
   * they filter out here.
   */
  aliasPageIdsOf(id: string): string[] {
    const ids: string[] = [];
    for (const aliasId of this.ctx.store.aliasNodesOf(id)) {
      const alias = this.reads.getNode(aliasId);
      if (
        alias === undefined ||
        !rendersWithDocumentChrome(alias, this.reads.parentFactsOf(alias), (classId) =>
          this.reads.effectiveClassParentlessBlock(classId),
        )
      )
        continue;
      ids.push(aliasId);
    }
    return ids;
  }

  /**
   * The node's name-equivalents: every text alias value plus the title of
   * every alias page of the node — an alias page's title names its main page
   * for search (resolve + unlinked references).
   */
  nameEquivalentsOf(id: string): string[] {
    const names = aliasValuesOf(
      {
        getNode: (nodeId) => this.reads.getNode(nodeId),
        getEffectiveProperties: (nodeId) => this.getEffectiveProperties(nodeId),
      },
      id,
    );
    for (const aliasId of this.aliasPageIdsOf(id)) {
      const alias = this.reads.getNode(aliasId);
      if (alias === undefined) continue;
      const title = deriveDisplayName(alias);
      if (title !== null && title.trim() !== "") names.push(title);
    }
    return names;
  }
  /**
   * Effective properties of a node (SCHEMA.md "Class properties"): authored
   * values plus derived binding defaults, aggregated across all its classes
   * with first-class-applied-wins conflicts. Pure read over the local store.
   */
  getEffectiveProperties(id: string): EffectiveProperty[] {
    return this.ctx.store.getEffectiveProperties(id);
  }

  /**
   * Nodes carrying an authored value for the property schema (the
   * PropertyView's references population). Pure read over the local
   * store; derived defaults never materialize, so unvalued bindings never
   * list.
   */
  getPropertyReferences(schemaId: string): ClientNode[] {
    return this.ctx.store.propertyValueCarriers(schemaId).map((entry) => mapNode(entry.node));
  }

  /**
   * Nodes whose `coverAssetId` wire field points at the asset (the card-view
   * Cover badge's derivation — isCoverAsset). Direct node-column probe, the
   * getAssetInfo precedent: the wire node fields are NOT mined into the edge
   * index yet (the backlinks roll-up follow-on owns that), so the badge
   * cannot ride getLinkedReferences. Pure read over the local store.
   */
  getCoverReferences(assetId: string): ClientNode[] {
    const rows = this.ctx.store.database
      .prepare(
        `SELECT * FROM node
         WHERE workspace_id = ? AND cover_asset_id = ? AND is_active = 1
         ORDER BY id`,
      )
      .all(this.ctx.workspaceId, assetId) as NodeRow[];
    return rows.map((row) => this.ctx.mapNodeCached(row));
  }

  /**
   * Asset metadata for a node reference (the derived node_asset rows that
   * asset.attach/detach maintain): the panel resolves attachment chips to
   * original names and download ids through this read. Purely local; the row
   * arrives with the asset.attach op (optimistic local write or catch-up).
   */
  getAssetInfo(id: string): AssetInfo | undefined {
    const row = this.ctx.store.database
      .prepare(
        `SELECT asset_id, hash, mime_type, size, original_name, uploaded_at
         FROM node_asset WHERE node_id = ? ORDER BY uploaded_at DESC LIMIT 1`,
      )
      .get(id) as Record<string, unknown> | undefined;
    const mapped = (r: Record<string, unknown>): AssetInfo => ({
      assetId: String(r.asset_id),
      hash: String(r.hash),
      mimeType: String(r.mime_type),
      size: Number(r.size),
      originalName: String(r.original_name),
      uploadedAt: r.uploaded_at === null || r.uploaded_at === undefined ? null : String(r.uploaded_at),
    });
    if (row !== undefined) return mapped(row);
    // Fallback: id is an asset id itself (e.g. resolved from an asset_ref).
    const byAsset = this.ctx.store.database
      .prepare(
        `SELECT asset_id, hash, mime_type, size, original_name, uploaded_at
         FROM node_asset WHERE asset_id = ? ORDER BY uploaded_at DESC LIMIT 1`,
      )
      .get(id) as Record<string, unknown> | undefined;
    return byAsset !== undefined ? mapped(byAsset) : undefined;
  }

  /**
   * An image asset's bytes as a data URL (card covers / thumbnails). Null
   * for non-image assets and when the REST surface is unconfigured —
   * callers render the no-image card in that case.
   */
  async getAssetDataUrl(assetNodeId: string): Promise<string | null> {
    const info = this.getAssetInfo(assetNodeId);
    if (info === undefined || !info.mimeType.startsWith("image/")) return null;
    if (this.ctx.restServerUrl === null || this.ctx.restApiKey === null) return null;
    try {
      const blob = await fetchAssetBlob(this.ctx.restServerUrl, this.ctx.restApiKey, info.assetId, this.ctx.workspaceId);
      return await readBlobAsDataUrl(blob);
    } catch {
      return null;
    }
  }

  /**
   * Annotations on an asset (SCHEMA.md annotation family): active objects
   * classed with the seeded `highlight` class whose highlight_asset property
   * (…000000000020) links this asset node. The read runs over the derived
   * edge index — node-typed property values project into edge (type
   * 'property', verb = propertySchemaId), so this is an indexed lookup by
   * target id, not a workspace scan. Pure read over the local store;
   * deterministic display order (name, then id).
   */
  getAnnotationsForAsset(assetId: string): ClientNode[] {
    const rows = this.ctx.store.database
      .prepare(
        `SELECT source_id FROM edge
         WHERE target_id = ? AND type = 'property' AND verb = ?
         ORDER BY source_id`,
      )
      .all(assetId, SYSTEM_PROPERTY_UUIDS.highlightAsset) as Array<{ source_id: string }>;
    const seen = new Set<string>();
    const annotations: ClientNode[] = [];
    for (const row of rows) {
      const sourceId = String(row.source_id);
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);
      const node = this.reads.getNode(sourceId);
      if (node === undefined || !node.classIds.includes(SYSTEM_CLASS_UUIDS.highlight)) continue;
      annotations.push(node);
    }
    return annotations.sort(
      (a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id) || a.id.localeCompare(b.id),
    );
  }

  /** Active property schemas of the workspace (the add-binding picker set). */
  listPropertySchemas(): ClientPropertySchema[] {
    const rows = this.ctx.store.database
      .prepare(
        `SELECT id, name, type, multi, icon, scope_class_ids, validation_rules, options, target_class_filter, date_precision, date_qualified,
                number_pad, number_decimals, number_rounding, display, hide_when_empty, default_value
         FROM property_schema WHERE workspace_id = ? AND active = 1
         ORDER BY name, id`,
      )
      .all(this.ctx.workspaceId) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const parseJsonArray = (raw: unknown): string[] | null => {
        if (raw === null || raw === undefined) return null;
        try {
          const parsed: unknown = JSON.parse(raw as string);
          return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : null;
        } catch {
          return null;
        }
      };
      let options: ClientPropertyOption[] | null = null;
      try {
        const parsed: unknown = JSON.parse((row.options as string | null) ?? "null");
        if (Array.isArray(parsed)) {
          options = parsed
            .filter(
              (v): v is Record<string, unknown> =>
                typeof v === "object" && v !== null && "id" in v && "label" in v,
            )
            .map((v) => ({
              id: String(v.id),
              label: String(v.label),
              // Option colors ride the color grammar; absent/null = none.
              ...("color" in v && (typeof v.color === "string" || v.color === null)
                ? { color: v.color as string | null }
                : {}),
              // Option icons ride as an MDI name; absent/null = none.
              ...("icon" in v && (typeof v.icon === "string" || v.icon === null)
                ? { icon: v.icon as string | null }
                : {}),
            }));
        }
      } catch {
        options = null;
      }
      return {
        id: String(row.id),
        name: String(row.name),
        type: String(row.type),
        multi: row.multi === 1,
        icon: row.icon === null || row.icon === undefined ? null : String(row.icon),
        scopeClassIds: parseJsonArray(row.scope_class_ids),
        options,
        targetClassFilter: parseJsonArray(row.target_class_filter),
        datePrecision:
          row.date_precision === "year" || row.date_precision === "month" || row.date_precision === "day"
            ? row.date_precision
            : null,
        dateQualified:
          row.date_qualified === null || row.date_qualified === undefined
            ? null
            : row.date_qualified === 1,
        numberPad: row.number_pad === null || row.number_pad === undefined ? null : Number(row.number_pad),
        numberDecimals:
          row.number_decimals === null || row.number_decimals === undefined ? null : Number(row.number_decimals),
        numberRounding:
          row.number_rounding === null || row.number_rounding === undefined
            ? null
            : (row.number_rounding as "round" | "floor" | "ceil" | "truncate"),
        // The render contracts (PROPERTY-level; null = panel / unset).
        // (`readonly` retired 2026-10-21 — derived from the system list,
        // not stored.)
        display: row.display === "bullet" || row.display === "inline" ? row.display : null,
        hideWhenEmpty:
          row.hide_when_empty === null || row.hide_when_empty === undefined
            ? null
            : row.hide_when_empty === 1,
        // The GLOBAL default (owner ruling 2026-10-20): parsed JSON, null = none.
        defaultValue: (() => {
          const raw = row.default_value as string | null;
          if (raw === null || raw === undefined) return null;
          try {
            return JSON.parse(raw) as unknown;
          } catch {
            return null;
          }
        })(),
        // Value-validation rules (owner 2026-10-20): JSON object or null.
        validationRules: (() => {
          const raw = row.validation_rules as string | null;
          if (raw === null || raw === undefined) return null;
          try {
            const parsed: unknown = JSON.parse(raw);
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
            const rules = parsed as Record<string, unknown>;
            return {
              ...(typeof rules.min === "number" ? { min: rules.min } : {}),
              ...(typeof rules.max === "number" ? { max: rules.max } : {}),
              ...(typeof rules.pattern === "string" ? { pattern: rules.pattern } : {}),
            };
          } catch {
            return null;
          }
        })(),
      };
    });
  }

  /**
   * Block-subtree rooted at `id`, capped at `depth` levels (cycle protection).
   * `depth` normalizes null → default: the worker RPC boundary turns an
   * omitted optional into JSON null, and `null <= 0` is true — without the
   * normalization the worker path silently renders every page with zero
   * block rows.
   *
   * The node-backed-property exclusion is computed PER SUBTREE ROOT —
   * a nested block's own carriers are excluded from ITS body, and an
   * excluded carrier's whole subtree is pruned with it (children of an
   * excluded row are never visited).
   */
  getBlockTree(pageId: string, depth?: number | null): BlockTreeNode[] {
    // The deferred follow-up: `useOutlinerValue` calls this on every
    // view render, so it rides the revision cache like the list reads (the
    // worker client already cachedReads it; now the in-process path matches).
    return this.reads.cachedListRead(`getBlockTree:${pageId}:${depth ?? "*"}`, () => {
      const cap = depth ?? DEFAULT_TREE_DEPTH;
      const build = (id: string, remaining: number): BlockTreeNode[] => {
        if (remaining <= 0) return [];
        // Node-backed property values live as children of the owner but render
        // inside the property cell — exclude them here or they appear twice.
        // Two shapes: node-typed references ({"nodeId"}) and text properties,
        // whose scalar value may be the carrier block's uuid (legacy shape).
        const propertyRefIds = this.propertyCarrierIdsOf(id);
        return this.ctx.store
          .children(id)
          .filter(
            (row) =>
              row.is_class === 0 &&
              row.is_embedded === 1 &&
              row.is_active === 1 &&
              !propertyRefIds.has(row.id),
          )
          .map((row) => ({
            node: this.ctx.mapNodeCached(row),
            children: build(row.id, remaining - 1),
          }));
      };
      return build(pageId, cap);
    });
  }

  /**
   * The node ids referenced by `nodeId`'s property values (canonical
   * `{nodeId}` refs and legacy bare-uuid text values) — the carrier set the
   * body render excludes. Scoped to ONE node: each subtree root filters its
   * own carriers.
   */
  private propertyCarrierIdsOf(nodeId: string): Set<string> {
    const propertyRefIds = new Set<string>();
    for (const row of visiblePropertyValueRows(this.ctx.store.database, nodeId)) {
      try {
        const parsed: unknown = JSON.parse(row.value);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "nodeId" in parsed &&
          typeof (parsed as { nodeId: unknown }).nodeId === "string"
        ) {
          propertyRefIds.add((parsed as { nodeId: string }).nodeId);
        } else if (typeof parsed === "string" && UUID_LIKE.test(parsed)) {
          propertyRefIds.add(parsed);
        }
      } catch {
        // Scalar value — not a node reference.
      }
    }
    return propertyRefIds;
  }

  /** FTS prefix-AND search over active nodes (ranked; limit defaults to 50). */
  search(query: string, limit?: number): ClientNode[] {
    return this.ctx.store
      .search(query, limit)
      .map((hit) => this.reads.getNode(hit.nodeId))
      .filter((node): node is ClientNode => node !== undefined);
  }

  /**
   * Cursor-paginated ranked search: the async counterpart of the cached sync
   * `search` for load-more surfaces. `cursor` is the opaque
   * `nextCursor` of the previous page (null/absent = first page); the result
   * carries the next cursor (null = exhausted).
   */
  searchPage(
    query: string,
    opts?: { limit?: number; cursor?: string | null } | null,
  ): Promise<SearchPageResult> {
    const page = this.ctx.store.searchPage(query, { limit: opts?.limit, cursor: opts?.cursor ?? null });
    return Promise.resolve({
      nodes: page.hits
        .map((hit) => this.reads.getNode(hit.nodeId))
        .filter((node): node is ClientNode => node !== undefined),
      nextCursor: page.nextCursor,
    });
  }

  /**
   * Match-context snippet around the densest query-term cluster in one node's
   * indexed plaintext — the results panels' excerpt. Null when
   * the node is unknown or carries no match. Sync like the other cached reads.
   */
  getSearchSnippet(
    nodeId: string,
    query: string,
    opts?: { maxTokens?: number; ellipsis?: string } | null,
  ): SearchSnippetData | null {
    return this.ctx.store.getSearchSnippet(nodeId, query, opts ?? undefined);
  }

  /**
   * Name→id resolution: the local twin of GET /api/resolve —
   * case-insensitive EXACT display-name match over the ranked FTS candidates
   * (blocks included). An exact case-insensitive ALIAS VALUE is a
   * name-equivalent — the candidate pool already folds alias text into the
   * FTS row (text-scalar indexing), so resolution follows search semantics.
   * An alias page's own title resolves to the ALIAS page (links keep the
   * alias uuid — navigation redirects to the terminal; the server /resolve
   * answers the terminal for API consumers). Null when no active node
   * carries the name or alias.
   */
  resolveNodeByName(name: string): string | null {
    const wanted = name.toLowerCase();
    for (const hit of this.ctx.store.search(name, 100)) {
      const node = this.reads.getNode(hit.nodeId);
      if (node === undefined) continue;
      if ((deriveDisplayName(node) || "").toLowerCase() === wanted) return node.id;
      if (this.nameEquivalentsOf(node.id).some((alias) => alias.toLowerCase() === wanted)) {
        return node.id;
      }
    }
    return null;
  }

  /**
   * Live-query bridge for `query` content tokens: validate the token's
   * serialized AST with @notees/query's fail-loud parser (unknown condition
   * types / versions throw InvalidQueryAstError — the view renders an
   * "invalid query" placeholder) and execute it against the local store. The
   * Store satisfies the query package's structural QueryStore interface, so
   * no mapping layer is needed. Rows come back as node summaries (id, name,
   * isClass/isEmbedded, parentId, createdAt) — enough for the result
   * list, the simple table, and the containing-node walk. ASTs carrying an
   * aggregation run through runAggregateAst instead.
   */
  runQueryAst(rawAst: unknown): QueryRunResult {
    let ast: QueryAst;
    try {
      ast = parseQueryAst(rawAst);
    } catch (error) {
      throw new InvalidQueryAstError(
        `invalid query AST: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (ast.aggregation !== undefined) {
      throw new InvalidQueryAstError(
        "query run: AST carries an aggregation — run it through runAggregateAst",
      );
    }
    let result: ReturnType<typeof runQuery>;
    try {
      result = runQuery(this.ctx.store, ast);
    } catch (error) {
      throw new InvalidQueryAstError(
        `query not supported: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {
      ids: result.ids,
      rows: result.rows.map((row) => {
        const node = this.reads.getNode(String(row.id));
        return {
          id: String(row.id),
          // Title-is-content: the summary name derives from the node's
          // content (the retired name column is always null).
          name: node !== undefined ? deriveDisplayName(node) || null : null,
          isClass: row.is_class === 1,
          isEmbedded: row.is_embedded === 1,
          parentId: (row.parent_id as string | null) ?? null,
          createdAt: (row.created_at as string | null) ?? null,
        };
      }),
    };
  }

  /**
   * Aggregation counterpart of runQueryAst: the grouped grid (columns +
   * rows) for a `query` token whose AST carries an `aggregation`. Throws
   * InvalidQueryAstError for unparseable ASTs and ASTs without one.
   */
  runAggregateAst(rawAst: unknown): QueryAggregateResult {
    let ast: QueryAst;
    try {
      ast = parseQueryAst(rawAst);
    } catch (error) {
      throw new InvalidQueryAstError(
        `invalid query AST: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      return runAggregate(this.ctx.store, ast);
    } catch (error) {
      throw new InvalidQueryAstError(
        `query not supported: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Direct children of a node in child order, active only (export's nested-bullets read). */
  getChildren(id: string): ClientNode[] {
    return this.ctx.store
      .children(id)
      .filter((row) => row.is_active === 1)
      .map((row) => this.ctx.mapNodeCached(row));
  }

  /**
   * Uncached alias of {@link getChildren} for write-compositions that must
   * not read render-cache state (extractBlockToPage's child reparenting).
   * In-process reads are already fresh; the Promise shape matches the
   * WorkerClient's raw-RPC variant.
   */
  getChildrenFresh(id: string): Promise<ClientNode[]> {
    return Promise.resolve(this.getChildren(id));
  }
}
