/**
 * Plugins API — the plugin-registry slice of the sync server's admin
 * surface. Plain fetch helpers mirroring workspaceApi's request
 * shape; the routes are owner/admin-scoped server side (operator key,
 * administrator session, or an admin-scoped API key).
 *
 * The registry is INERT: these helpers move manifest data and an enable
 * bit — nothing is loaded, spawned, or executed (the runtime is parked).
 */

import type { PluginManifest } from "@notees/protocol";

export interface PluginListEntry {
  id: string;
  version: string;
  name: string;
  description: string | null;
  author: string | null;
  manifest: PluginManifest;
  enabled: boolean;
  installedAt: number;
}

async function request<T>(
  serverUrl: string,
  path: string,
  init: RequestInit = {},
  token?: string,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api${path}`, {
    ...init,
    headers,
  });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      // Keep the HTTP status message.
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

/** List installed plugin manifests (idempotent read). */
export function listPlugins(
  serverUrl: string,
  token: string,
): Promise<{ plugins: PluginListEntry[] }> {
  return request(serverUrl, "/plugins", {}, token);
}

/** Install a plugin manifest. Idempotent on id+version (alreadyInstalled flag). */
export function installPlugin(
  serverUrl: string,
  token: string,
  manifest: PluginManifest,
): Promise<{ plugin: PluginListEntry; alreadyInstalled: boolean }> {
  return request(
    serverUrl,
    "/plugins",
    { method: "POST", body: JSON.stringify(manifest) },
    token,
  );
}

/** Uninstall every version of the plugin id. */
export function uninstallPlugin(
  serverUrl: string,
  token: string,
  id: string,
): Promise<{ ok: boolean }> {
  return request(
    serverUrl,
    `/plugins/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    token,
  );
}

/** Enable/disable the plugin (stored bit only — the runtime is parked). */
export function setPluginEnabled(
  serverUrl: string,
  token: string,
  id: string,
  enabled: boolean,
): Promise<{ plugins: PluginListEntry[] }> {
  return request(
    serverUrl,
    `/plugins/${encodeURIComponent(id)}/enabled`,
    { method: "POST", body: JSON.stringify({ enabled }) },
    token,
  );
}
