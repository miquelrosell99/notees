/**
 * The server-facing REST domain: asset upload/download over the CAS routes,
 * the per-user prefs endpoints (with the device-local offline fallback),
 * the hosted section-view CRUD under /api/me/nodes/:id/sections/:key/views,
 * and the paginated GET /api/operations history feeds. Everything here
 * speaks fetch against the configured relay; graph writes ride the op-log
 * path (attachAsset) or none at all (uploadAsset is bytes only). Standalone
 * domain — takes the shared ClientContext, no inheritance.
 */

import {
  readDevicePrefList,
  readDevicePrefScalar,
  writeDevicePrefList,
  writeDevicePrefScalar,
  type PrefsPatch,
  type UserPrefs,
  type UserPrefsSource,
} from "./prefs.js";
import { pullServerPrefs, pushServerPrefs } from "./prefs-rest.js";
import { fetchAndOpenAsset, sealAndUploadAsset } from "./asset-transport.js";
import {
  normalizeSectionView,
  normalizeSectionViewList,
  type HostedSectionKey,
  type SectionView,
} from "./section-views.js";
import type { AssetUploadResult, OperationFeedEntry } from "./types.js";
import type { ClientContext } from "./client-context.js";

export class WorkspaceClientServer {
  constructor(private readonly ctx: ClientContext) {}

  /**
   * The operator API key is not a user — GET /api/me/prefs 401s it (the
   * route's documented contract) and the prefs probe would fire a known-401
   * on every boot (console noise, wasted request). Resolved lazily ONCE per
   * client through GET /api/auth/me: the operator key answers 200 as its
   * synthetic identity (`id: "operator"`), a user principal answers with
   * their account row. Unknown/unreachable/legacy answers resolve "not
   * operator" — the prefs probe then runs exactly as before.
   */
  private operatorKey: Promise<boolean> | null = null;

  private isOperatorKey(): Promise<boolean> {
    if (this.ctx.restServerUrl === null || this.ctx.restApiKey === null) {
      return Promise.resolve(false);
    }
    this.operatorKey ??= (async () => {
      try {
        const response = await fetch(
          `${this.ctx.restServerUrl!.replace(/\/$/, "")}/api/auth/me`,
          { headers: { "X-API-Key": this.ctx.restApiKey! } },
        );
        if (!response.ok) return false;
        const identity = (await response.json()) as { id?: unknown };
        return identity.id === "operator";
      } catch {
        return false;
      }
    })();
    return this.operatorKey;
  }

  // --- assets (REST upload + op-log link) -------------------------------------

  private requireRest(): { serverUrl: string; apiKey: string } {
    if (this.ctx.restServerUrl === null || this.ctx.restApiKey === null) {
      throw new Error(
        "WorkspaceClient: this call requires serverUrl + apiKey (use createHttp)",
      );
    }
    return { serverUrl: this.ctx.restServerUrl, apiKey: this.ctx.restApiKey };
  }

  // --- per-user UI prefs (favorites/recents — server-side UI state) -------------

  /**
   * GET /api/me/prefs (session or API-key credential). On success the local
   * cache is refreshed so device-local readers (sidebar lists, palette
   * Recent) see the same source. Offline/unreachable (or a client without
   * REST config): the cached copy answers, tagged `source: "local"`. An
   * operator-key credential skips the probe (the server 401s it by design)
   * and answers from the cache directly.
   */
  async getPrefs(): Promise<UserPrefs & { source: UserPrefsSource }> {
    if (
      this.ctx.restServerUrl !== null &&
      this.ctx.restApiKey !== null &&
      !(await this.isOperatorKey())
    ) {
      const prefs = await pullServerPrefs(this.ctx.restServerUrl, this.ctx.restApiKey);
      if (prefs !== null) return { ...prefs, source: "server" };
    }
    return {
      favorites: readDevicePrefList("favorites"),
      recents: readDevicePrefList("recents"),
      cardsAlgorithm: readDevicePrefScalar("cardsAlgorithm"),
      // Server-only by design — the ADS credential never caches device-locally.
      adsApiToken: "",
      source: "local",
    };
  }

  /**
   * PUT /api/me/prefs (merge patch; each present list replaces wholesale, a
   * present cardsAlgorithm replaces the scalar).
   * The local cache updates first — optimistic and honest offline: when the
   * server cannot be reached the write persists device-locally and the next
   * successful call syncs it. Resolves `source: "server" | "local"`. An
   * operator-key credential never PUTs (no user owns the prefs server-side):
   * the write stays device-local, `source: "local"`.
   */
  async patchPrefs(patch: PrefsPatch): Promise<UserPrefs & { source: UserPrefsSource }> {
    const merged: UserPrefs = {
      favorites: patch.favorites ?? readDevicePrefList("favorites"),
      recents: patch.recents ?? readDevicePrefList("recents"),
      cardsAlgorithm: patch.cardsAlgorithm ?? readDevicePrefScalar("cardsAlgorithm"),
      // The ADS credential rides the patch to the server only — never cached.
      adsApiToken: patch.adsApiToken ?? "",
    };
    if (patch.favorites !== undefined) writeDevicePrefList("favorites", patch.favorites);
    if (patch.recents !== undefined) writeDevicePrefList("recents", patch.recents);
    if (patch.cardsAlgorithm !== undefined) {
      writeDevicePrefScalar("cardsAlgorithm", patch.cardsAlgorithm);
    }
    if (
      this.ctx.restServerUrl !== null &&
      this.ctx.restApiKey !== null &&
      !(await this.isOperatorKey())
    ) {
      const prefs = await pushServerPrefs(this.ctx.restServerUrl, this.ctx.restApiKey, merged);
      if (prefs !== null) return { ...prefs, source: "server" };
    }
    return { ...merged, source: "local" };
  }

  // --- node-scoped hosted views (custom tabs — the prefs channel) -------------

  /**
   * fetch + the shared non-ok error shape for the section-view CRUD verbs:
   * the API-key header always, the JSON content-type only when a body rides.
   * Throws `<verb> failed: HTTP <status>: <text>` on a non-ok answer.
   */
  private async restJson(
    url: string,
    apiKey: string,
    verb: string,
    init: { method?: string; body?: string } = {},
  ): Promise<unknown> {
    const response = await fetch(url, {
      method: init.method ?? "GET",
      headers: {
        "X-API-Key": apiKey,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
    if (!response.ok) {
      throw new Error(`${verb} failed: HTTP ${response.status}: ${await response.text()}`);
    }
    // 204/empty-body answers (DELETE) carry no JSON — parse only real bodies.
    const text = await response.text();
    return text === "" ? null : JSON.parse(text);
  }

  private sectionViewsUrl(nodeId: string, sectionKey: string, suffix = ""): string {
    const { serverUrl } = this.requireRest();
    // The empty section key (a node's main query) travels as the "-" sentinel.
    const key = sectionKey === "" ? "-" : sectionKey;
    return `${serverUrl.replace(/\/$/, "")}/api/nodes/${encodeURIComponent(nodeId)}/sections/${encodeURIComponent(key)}/views${suffix}`;
  }

  /** GET the surface's custom views in tab order. Throws when the server answers non-ok. */
  async listSectionViews(nodeId: string, sectionKey: string): Promise<SectionView[]> {
    const { apiKey } = this.requireRest();
    return normalizeSectionViewList(
      await this.restJson(this.sectionViewsUrl(nodeId, sectionKey), apiKey, "list section views"),
    );
  }

  /** POST a new view (appended after the last tab). Throws on 4xx/5xx (409 = name collision). No viewMode — view modes are transient surface state, not stored. */
  async createSectionView(input: {
    nodeId: string;
    sectionKey: string;
    name: string;
    queryAst: unknown;
  }): Promise<SectionView> {
    const { apiKey } = this.requireRest();
    const body = await this.restJson(
      this.sectionViewsUrl(input.nodeId, input.sectionKey),
      apiKey,
      "create section view",
      {
        method: "POST",
        body: JSON.stringify({
          name: input.name,
          queryAst: input.queryAst,
        }),
      },
    );
    return normalizeSectionView((body as { view: unknown }).view);
  }

  /** PATCH a view's name. 404 = missing/foreign row (also throws). */
  async renameSectionView(
    nodeId: string,
    sectionKey: string,
    viewId: string,
    name: string,
  ): Promise<SectionView> {
    const { apiKey } = this.requireRest();
    const body = await this.restJson(
      this.sectionViewsUrl(nodeId, sectionKey, `/${encodeURIComponent(viewId)}`),
      apiKey,
      "rename section view",
      { method: "PATCH", body: JSON.stringify({ name }) },
    );
    return normalizeSectionView((body as { view: unknown }).view);
  }

  /** PATCH a view's query AST (the per-tab builder commit). 404 = missing/foreign row (also throws). */
  async updateSectionViewAst(
    nodeId: string,
    sectionKey: string,
    viewId: string,
    queryAst: unknown,
  ): Promise<SectionView> {
    const { apiKey } = this.requireRest();
    const body = await this.restJson(
      this.sectionViewsUrl(nodeId, sectionKey, `/${encodeURIComponent(viewId)}`),
      apiKey,
      "update section view query",
      { method: "PATCH", body: JSON.stringify({ queryAst }) },
    );
    return normalizeSectionView((body as { view: unknown }).view);
  }

  /** PUT the full ordered id list; sequences rewrite 0..n-1. Throws on an incomplete list. */  async reorderSectionViews(
    nodeId: string,
    sectionKey: string,
    orderedIds: string[],
  ): Promise<SectionView[]> {
    const { apiKey } = this.requireRest();
    return normalizeSectionViewList(
      await this.restJson(this.sectionViewsUrl(nodeId, sectionKey, "/order"), apiKey, "reorder section views", {
        method: "PUT",
        body: JSON.stringify({ orderedIds }),
      }),
    );
  }

  /** DELETE a view (204). 404 = missing/foreign row (also throws). */
  async deleteSectionView(nodeId: string, sectionKey: string, viewId: string): Promise<void> {
    const { apiKey } = this.requireRest();
    await this.restJson(
      this.sectionViewsUrl(nodeId, sectionKey, `/${encodeURIComponent(viewId)}`),
      apiKey,
      "delete section view",
      { method: "DELETE" },
    );
  }

  /**
   * Upload file bytes to the server's CAS asset store (POST /api/assets).
   * Returns the server-issued asset metadata; the caller links it into the
   * graph (asset node + property.set) — this method does NOT touch the store.
   */
  async uploadAsset(file: Blob, filename: string): Promise<AssetUploadResult> {
    const { serverUrl, apiKey } = this.requireRest();
    return sealAndUploadAsset(serverUrl, apiKey, this.ctx.workspaceId, file, filename);
  }

  /**
   * Record an uploaded asset on a node (asset.attach op, the same envelope
   * the server submits when the multipart carries an objectId). Enqueued
   * client-side so the derived node_asset row — and with it the attachment
   * chip's name/download read — is local immediately (local-first), then
   * pushed with the rest of the outbox.
   */
  async attachAsset(objectId: string, asset: AssetUploadResult): Promise<void> {
    this.ctx.enqueueLocal(
      this.ctx.buildEnvelope(
        "asset.attach",
        {
          objectId,
          assetId: asset.assetId,
          hash: asset.hash,
          mimeType: asset.mimeType,
          size: asset.size,
          originalName: asset.originalName,
        },
        [objectId, asset.assetId],
      ),
    );
  }

  /**
   * Download an asset's bytes (GET /api/assets/:id, workspace key) — the raw
   * read the export engine's include-assets bundle uses (distinct from
   * downloadAsset, which opens a tab, and getAssetDataUrl, images only).
   */
  async fetchAssetBytes(assetId: string): Promise<Blob> {
    const { serverUrl, apiKey } = this.requireRest();
    return fetchAndOpenAsset(serverUrl, apiKey, this.ctx.workspaceId, assetId);
  }

  /**
   * Download an asset's bytes (GET /api/assets/:id, workspace key) and open
   * them in a new tab as a blob URL — the key stays out of any URL.
   */
  async downloadAsset(assetId: string): Promise<void> {
    const { serverUrl, apiKey } = this.requireRest();
    const blob = await fetchAndOpenAsset(serverUrl, apiKey, this.ctx.workspaceId, assetId);
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener");
  }

  /**
   * Property value history feed: paginated GET /api/operations
   * (the relay-log read), filtered client-side to property.* ops
   * for one node + schema, newest-first by HLC. The feed entries are
   * envelope-v3 objects — seq, hlc, actor, timestamp, payload — everything
   * the history modal renders. Throws when the feed is unreachable (the
   * modal renders the device-local note); bounded at 30 pages (300k
   * envelopes) so a huge log cannot hang the UI.
   */
  async fetchOperationsFor(
    objectId: string,
    propertySchemaId: string,
  ): Promise<OperationFeedEntry[]> {
    const matches = (op: OperationFeedEntry): boolean =>
      (op.opType === "property.set" || op.opType === "property.unset") &&
      typeof op.payload === "object" &&
      op.payload !== null &&
      op.payload.objectId === objectId &&
      op.payload.propertySchemaId === propertySchemaId;
    return this.fetchOperationFeed(matches);
  }

  /**
   * Per-node version history feed: the same relay-log read filtered to the
   * ops whose payload names THIS node as `objectId` — object.create/update/
   * delete/restore/move, property.set/unset, class/tag unassigns, asset
   * attach/detach. Newest-first by HLC; same 30-page bound and the same
   * throw-when-unreachable contract as the property feed (the section
   * renders the device-local note). This is a pure projection slice — the
   * wire is untouched.
   */
  async fetchNodeHistory(nodeId: string): Promise<OperationFeedEntry[]> {
    const matches = (op: OperationFeedEntry): boolean =>
      typeof op.payload === "object" &&
      op.payload !== null &&
      op.payload.objectId === nodeId;
    return this.fetchOperationFeed(matches);
  }

  /**
   * The paged GET /api/operations relay-log read both history feeds share:
   * envelope-v3 entries trimmed to seq/hlc/actor/timestamp/payload, filtered
   * by `matches`, sorted newest-first by HLC. Bounded at 30 pages (300k
   * envelopes) so a huge log cannot hang the UI; throws when the feed is
   * unreachable.
   */
  private async fetchOperationFeed(
    matches: (op: OperationFeedEntry) => boolean,
  ): Promise<OperationFeedEntry[]> {
    const { serverUrl, apiKey } = this.requireRest();
    const entries: OperationFeedEntry[] = [];
    let afterSeq = 0;
    for (let page = 0; page < 30; page++) {
      const url = `${serverUrl.replace(/\/$/, "")}/api/operations?afterSeq=${afterSeq}&limit=10000`;
      const response = await fetch(url, {
        headers: { "X-API-Key": apiKey, "X-Workspace-Id": this.ctx.workspaceId },
      });
      if (!response.ok) {
        throw new Error(`operations feed failed: HTTP ${response.status}`);
      }
      const body = (await response.json()) as {
        operations: OperationFeedEntry[];
        nextAfterSeq: number;
        hasMore: boolean;
      };
      for (const op of body.operations) {
        if (matches(op)) entries.push(op);
      }
      if (!body.hasMore) break;
      afterSeq = body.nextAfterSeq;
    }
    entries.sort(
      (a, b) =>
        b.hlc.physical - a.hlc.physical ||
        b.hlc.logical - a.hlc.logical ||
        (a.seq < b.seq ? 1 : -1),
    );
    return entries;
  }
}
