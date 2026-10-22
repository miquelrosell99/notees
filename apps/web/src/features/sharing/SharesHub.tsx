/**
 * SharesHub — the Shares management hub behind the account popup's Shares
 * entry (owner 2026-10-19): the v1 SharesUnifiedView's "Shared Out" tab,
 * ported to the v2 share surface. v2's server shares are read-only PUBLIC
 * LINKS only (routes-shares.ts: POST/GET/DELETE /api/shares) — there is no
 * user-share inbox endpoint, so the v1 Inbox tab has no v2 data to list;
 * this hub covers the whole v2 share register: every live link in the
 * workspace, newest first.
 *
 * Rows: the shared node's icon + name (resolved through the local
 * projection — the server record carries no name), the link with the
 * shared copy pattern, created/expiry stamps, Open (the node) and Revoke
 * (the public view 404s from the next request on). Names re-render on
 * client notifications; the list refreshes after a revoke.
 */

import { useCallback, useEffect, useState } from "react";

import { deriveDisplayName } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client/index.js";

import { Icon } from "../../ui/Icon.js";
import { nodeIcon } from "../../ui/iconFor.js";
import { relativeTime } from "../page-sections/ActivityLogSection.js";
import { Button } from "../../components/ui/fleet/Button.js";
import { EmptyState } from "../../components/ui/fleet/EmptyState.js";
import { InlineConfirmButton } from "../../components/ui/fleet/InlineConfirmButton.js";
import { Spinner } from "../../components/ui/fleet/Spinner.js";
import { SurfaceTopBar } from "../../components/ui/fleet/SurfaceTopBar.js";
import { copyToClipboard } from "../modals/clipboard.js";
import { listShares, revokeShare, type ShareEntry } from "./shareApi.js";
import "./SharesHub.css";

type AnyClient = WorkspaceClient | WorkerClient;

export function SharesHub({
  client,
  serverUrl,
  credential,
  onOpenNode,
}: {
  client: AnyClient;
  serverUrl: string;
  credential: string;
  onOpenNode: (nodeId: string) => void;
}) {
  const [shares, setShares] = useState<ShareEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  /** Live node names/icons: re-render on any client notification. */
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  const load = useCallback(() => {
    setError(null);
    listShares(serverUrl, credential)
      .then((result) => setShares(result.shares))
      .catch((err: unknown) => {
        setShares(null);
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [serverUrl, credential]);
  useEffect(() => {
    load();
  }, [load]);

  const liveShares = (shares ?? []).filter((entry) => entry.revokedAt === null);

  async function handleCopy(entry: ShareEntry): Promise<void> {
    try {
      await copyToClipboard(shareUrl(serverUrl, entry));
      setCopiedToken(entry.token);
      window.setTimeout(() => setCopiedToken((current) => (current === entry.token ? null : current)), 1500);
    } catch {
      setError("Clipboard access was denied — select the link text and copy manually.");
    }
  }

  function handleRevoke(token: string): void {
    revokeShare(serverUrl, credential, token)
      .then(load)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }

  return (
    <div className="nt-shares-hub">
      {/* The hub chrome rides the shared SurfaceTopBar (owner 2026-10-22),
          pinned above the body; the rows scroll at the card border inside
          the capped content column below. */}
      <SurfaceTopBar icon="mdi-share-variant" title="Shares" count={liveShares.length} />

      <div className="nt-shares-hub__body">
        <div className="nt-shares-hub__content">
          {shares === null && error === null ? (
            <div className="nt-shares-hub__loading">
              <Spinner />
            </div>
          ) : error !== null && shares === null ? (
            <EmptyState
              icon={<Icon path="mdi-cloud-off-outline" size={2} />}
              title="Failed to load shared links"
              description={error}
              actionLabel="Try again"
              onAction={load}
            />
          ) : liveShares.length === 0 ? (
            <EmptyState
              icon={<Icon path="mdi-share-variant" size={2} />}
              title="No shared links yet"
              description="Share a page from its Share dialog (the page menu → Share) to publish a read-only link; the link lands here."
            />
          ) : (
            <ul className="nt-shares-hub__rows">
          {liveShares.map((entry) => {
            const node = client.getNode(entry.nodeId);
            const name = node !== undefined ? deriveDisplayName(node) || "Untitled" : "Untitled";
            const icon =
              node !== undefined
                ? (nodeIcon(node, client.effectiveClassIcons()) ?? "mdi-file-outline")
                : "mdi-share-variant";
            return (
              <li key={entry.token} className="nt-shares-hub__row">
                <span className="nt-shares-hub__icon" aria-hidden="true">
                  <Icon path={icon} size={0.9} />
                </span>
                <button
                  type="button"
                  className="nt-shares-hub__name"
                  title={node !== undefined ? name : `${name} (${entry.nodeId})`}
                  onClick={() => onOpenNode(entry.nodeId)}
                >
                  {name}
                </button>
                <span className="nt-shares-hub__meta">
                  <code className="nt-shares-hub__url">{shareUrl(serverUrl, entry)}</code>
                  <span className="nt-shares-hub__stamp">
                    Created {relativeTime(new Date(entry.createdAt).toISOString())}
                    {entry.expiresAt !== null && (
                      <> · Expires {relativeTime(new Date(entry.expiresAt).toISOString())}</>
                    )}
                  </span>
                </span>
                <span className="nt-shares-hub__actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="mdi mdi-content-copy"
                    onClick={() => void handleCopy(entry)}
                  >
                    {copiedToken === entry.token ? "Copied" : "Copy"}
                  </Button>
                  <Button variant="ghost" size="sm" icon="mdi mdi-open-in-app" onClick={() => onOpenNode(entry.nodeId)}>
                    Open
                  </Button>
                  <InlineConfirmButton
                    variant="danger"
                    size="sm"
                    title="Revoke this link"
                    confirmTitle="Revoke now — anyone holding the link loses access immediately"
                    cancelTitle="Keep the link"
                    onConfirm={() => handleRevoke(entry.token)}
                  >
                    Revoke
                  </InlineConfirmButton>
                </span>
              </li>
            );
          })}
            </ul>
          )}
        </div>
      </div>
      {error !== null && shares !== null && <p className="nt-error">{error}</p>}
    </div>
  );
}

/** The public route's absolute URL — the server origin prefixes the path. */
function shareUrl(serverUrl: string, entry: ShareEntry): string {
  return `${serverUrl.replace(/\/$/, "")}${entry.urlPath}`;
}
