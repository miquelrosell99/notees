/**
 * SharePageModal — create / list / revoke a page's READ-ONLY public share
 * links (the shipped share slice).
 *
 * Anyone holding a link gets a static, read-only render of the page (the
 * server's `GET /s/<token>` — no app, no account, no write path); revocation
 * is immediate and an optional server-side expiry exists for agents (the
 * modal keeps the one honest default: links live until revoked). The URL is
 * shown once per row with the shared copy pattern (clipboard + transient
 * "Copied" state), and revoke rides the Button primitive's built-in
 * confirm. Kit primitives only (Modal / Button / Spinner / EmptyState).
 */

import { useCallback, useEffect, useState } from "react";

import { Icon } from "../../Icon.js";
import { Modal } from "../ui/Modal.js";
import { Button } from "../ui/Button.js";
import { Spinner } from "../ui/Spinner.js";
import { EmptyState } from "../ui/EmptyState.js";
import { InlineConfirmButton } from "../ui/InlineConfirmButton.js";
import { copyToClipboard } from "./clipboard";
import { createShare, listShares, revokeShare, type ShareEntry } from "./shareApi";
import "./SharePageModal.css";

export interface SharePageModalProps {
  isOpen: boolean;
  onClose: () => void;
  serverUrl: string;
  /** The session token or operator key (Authorization slot). */
  token: string;
  nodeUuid: string;
  nodeName?: string | undefined;
}

function shareUrl(serverUrl: string, entry: ShareEntry): string {
  return `${serverUrl.replace(/\/$/, "")}${entry.urlPath}`;
}

function statusLabel(entry: ShareEntry): string {
  if (entry.revokedAt !== null) return "Revoked";
  if (entry.expiresAt !== null) return `Expires ${new Date(entry.expiresAt).toLocaleDateString()}`;
  return `Created ${new Date(entry.createdAt).toLocaleDateString()}`;
}

export function SharePageModal({ isOpen, onClose, serverUrl, token, nodeUuid, nodeName }: SharePageModalProps) {
  const [shares, setShares] = useState<ShareEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const { shares: list } = await listShares(serverUrl, token, nodeUuid);
    setShares(list);
  }, [serverUrl, token, nodeUuid]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setCopiedToken(null);
    refresh()
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, refresh]);

  async function handleCreate() {
    setBusy(true);
    setError(null);
    try {
      await createShare(serverUrl, token, nodeUuid);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke(shareToken: string) {
    setError(null);
    try {
      await revokeShare(serverUrl, token, shareToken);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleCopy(entry: ShareEntry) {
    try {
      await copyToClipboard(shareUrl(serverUrl, entry));
      setCopiedToken(entry.token);
    } catch {
      setError("Clipboard access was denied — select the link text and copy manually.");
    }
  }

  const liveShares = shares.filter((entry) => entry.revokedAt === null);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={nodeName !== undefined && nodeName.length > 0 ? `Share "${nodeName}"` : "Share page"}
      size="sm"
      footer={
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      }
    >
      <p className="nt-share__hint">
        Anyone with the link can read this page — a static, read-only view. Links work until
        revoked.
      </p>

      {loading ? (
        <div className="nt-share__loading">
          <Spinner />
        </div>
      ) : shares.length === 0 ? (
        <EmptyState
          icon={<Icon path="mdi-share-variant" size={1.5} />}
          title="No share links yet"
          description="Create a link to publish a read-only copy of this page."
          actionLabel="Create link"
          onAction={() => void handleCreate()}
        />
      ) : (
        <ul className="nt-share__list">
          {shares.map((entry) => (
            <li
              key={entry.token}
              className={entry.revokedAt !== null ? "nt-share__row nt-share__row--revoked" : "nt-share__row"}
            >
              <span className="nt-share__meta">{statusLabel(entry)}</span>
              <code className="nt-share__url">{shareUrl(serverUrl, entry)}</code>
              <span className="nt-share__actions">
                <Button
                  variant="ghost"
                  size="sm"
                  icon="mdi mdi-content-copy"
                  disabled={entry.revokedAt !== null}
                  onClick={() => void handleCopy(entry)}
                >
                  {copiedToken === entry.token ? "Copied" : "Copy"}
                </Button>
                {entry.revokedAt === null && (
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
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {shares.length > 0 && liveShares.length > 0 && (
        <div className="nt-share__create">
          <Button variant="primary" icon="mdi mdi-plus" disabled={busy} onClick={() => void handleCreate()}>
            {busy ? "Creating…" : "Create another link"}
          </Button>
        </div>
      )}
      {shares.length > 0 && liveShares.length === 0 && !loading && (
        <div className="nt-share__create">
          <Button variant="primary" icon="mdi mdi-plus" disabled={busy} onClick={() => void handleCreate()}>
            {busy ? "Creating…" : "Create a new link"}
          </Button>
        </div>
      )}
      {error !== null && <p className="nt-error">{error}</p>}
    </Modal>
  );
}
