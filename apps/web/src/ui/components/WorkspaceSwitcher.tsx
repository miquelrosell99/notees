import { useEffect, useRef, useState } from "react";

import { createWorkspace, listWorkspaces, type WorkspaceEntry } from "@/core/auth-api.js";
import { localWorkspaceCopies, rememberedWorkspaceList } from "@/core/workspace-registry.js";

import type { AnyClient } from "./Sidebar.js";
import { Icon } from "../Icon.js";
import { Separator } from "./ui/Separator.js";
import { usePopupDismissal } from "./ui/usePopupDismissal.js";
import { WorkspaceSettingsModal } from "./modals/WorkspaceSettingsModal.js";
import "./WorkspaceSwitcher.css";

/**
 * WorkspaceSwitcher — searchable dropdown for switching between workspaces,
 * mounted at the top of the sidebar. Offline-first: when the server can't
 * answer, the popup falls back to the device-local registry — every
 * remembered workspace, the ones without a copy on this device muted with
 * a cloud-off marker and inert, under an explicit "offline" caption;
 * server-only affordances (the per-row settings gear and the create
 * suggestion) wait for recovery instead of failing loudly. Accountless
 * offline mode has exactly one well-known local workspace, so the switcher
 * stays hidden there. Typing a query that matches nothing offers to create
 * a workspace with that name (online); the footer opens the Manage
 * Workspaces view.
 */
export function WorkspaceSwitcher({
  serverUrl,
  credential,
  activeWorkspaceId,
  activeName,
  onSwitch,
  onManageWorkspaces,
  onRenamed,
  client,
}: {
  serverUrl: string;
  credential: string;
  activeWorkspaceId: string;
  activeName: string;
  onSwitch: (workspaceId: string, name: string) => void;
  /** Opens the Manage Workspaces view (the switcher closes its popup first). */
  onManageWorkspaces?: (() => void) | undefined;
  /**
   * Retained for call-site compatibility; sign-out lives in the sidebar's
   * account menu, not in this popup.
   */
  onSignOut?: (() => void) | undefined;
  /** Called after a workspace rename so the shell can update its label. */
  onRenamed?: ((workspaceId: string, name: string) => void) | undefined;
  /** The active workspace's client — threaded into the settings modal. */
  client?: AnyClient | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The list came from the device-local registry (the server didn't answer). */
  const [offline, setOffline] = useState(false);
  const [settingsWorkspace, setSettingsWorkspace] = useState<WorkspaceEntry | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listWorkspaces(serverUrl, credential)
      .then(({ workspaces: list }) => {
        if (cancelled) return;
        setWorkspaces(list);
        setOffline(false);
        setError(null);
      })
      .catch(() => {
        if (cancelled) return;
        // The server didn't answer: the remembered list stands in — rows
        // without a local copy render muted and inert below.
        setWorkspaces(rememberedWorkspaceList());
        setOffline(true);
        setError(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, serverUrl, credential]);

  // The shared dismissal layer: pointer-down outside (the trigger is an
  // anchor, so pressing it toggles instead of dismissing) + Escape.
  usePopupDismissal({
    popupRef,
    anchorRefs: [triggerRef],
    isOpen: open,
    onClose: () => setOpen(false),
  });

  const filtered =
    workspaces === null
      ? []
      : query.trim() === ""
        ? workspaces
        : workspaces.filter((ws) => (ws.name ?? "").toLowerCase().includes(query.trim().toLowerCase()));

  /** Offline: which of the remembered rows actually hold a local copy. */
  const localCopies = offline ? localWorkspaceCopies() : null;

  async function handleCreate(rawName: string): Promise<void> {
    const name = rawName.trim();
    if (name === "") return;
    setError(null);
    try {
      const { id } = await createWorkspace(serverUrl, credential, name);
      setQuery("");
      setOpen(false);
      onSwitch(id, name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="workspace-switcher">
      <div className="workspace-switcher__row">
        <button
          type="button"
          ref={triggerRef}
          className="workspace-switcher__trigger"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="workspace-switcher__name">{(activeName || "Workspace").toUpperCase()}</span>
          <Icon path={open ? "mdi-chevron-up" : "mdi-chevron-down"} size={0.9} />
        </button>
      </div>

      {open && (
        <div
          className="workspace-switcher__popup"
          role="listbox"
          aria-label="Workspaces"
          ref={popupRef}
          // The search input may hold focus; the shared layer skips Esc that
          // originates inside the popup, so the popup root closes on it.
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            setOpen(false);
          }}
        >
          <div className="workspace-switcher__search">
            <input
              className="workspace-switcher__search-input"
              placeholder="Search workspaces…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoFocus
            />
          </div>
          <ul className="workspace-switcher__list">
            {offline && (
              <li className="workspace-switcher__row-item">
                <span className="workspace-switcher__empty">
                  Offline — workspaces without a copy on this device can&apos;t open.
                </span>
              </li>
            )}
            {filtered.map((ws) => {
              const isActive = ws.id === activeWorkspaceId;
              const unavailable = localCopies !== null && !localCopies.has(ws.id);
              return (
                <li key={ws.id} className="workspace-switcher__row-item">
                  <button
                    type="button"
                    className={
                      unavailable
                        ? "workspace-switcher__item workspace-switcher__item--unavailable"
                        : "workspace-switcher__item"
                    }
                    role="option"
                    aria-selected={isActive}
                    disabled={unavailable}
                    title={
                      unavailable
                        ? "Not available offline — open it once while online to keep a copy on this device"
                        : undefined
                    }
                    onClick={() => {
                      setOpen(false);
                      if (!isActive) onSwitch(ws.id, ws.name ?? "Workspace");
                    }}
                  >
                    <Icon
                      path={unavailable ? "mdi-cloud-off-outline" : "mdi-database-outline"}
                      size={0.8}
                      className="workspace-switcher__item-icon"
                    />
                    <span className="workspace-switcher__item-name">{ws.name ?? "Workspace"}</span>
                    {isActive && <span className="workspace-switcher__item-badge">Active</span>}
                  </button>
                  {!offline && (
                    <button
                      type="button"
                      className="workspace-switcher__settings-btn"
                      title={`${ws.name ?? "Workspace"} settings`}
                      aria-label={`${ws.name ?? "Workspace"} settings`}
                      onClick={() => {
                        setOpen(false);
                        setSettingsWorkspace(ws);
                      }}
                    >
                      <Icon path="mdi-cog-outline" size={0.9} />
                    </button>
                  )}
                </li>
              );
            })}
            {workspaces !== null && filtered.length === 0 && (
              <li className="workspace-switcher__row-item">
                {offline ? (
                  <span className="workspace-switcher__empty">
                    {query.trim() === "" ? "No workspaces remembered on this device." : "No remembered workspaces match."}
                  </span>
                ) : query.trim() === "" ? (
                  <span className="workspace-switcher__empty">No workspaces yet.</span>
                ) : (
                  <button
                    type="button"
                    className="workspace-switcher__item workspace-switcher__create-suggestion"
                    onClick={() => void handleCreate(query)}
                  >
                    <Icon path="mdi-plus" size={0.8} className="workspace-switcher__item-icon" />
                    <span className="workspace-switcher__item-name">
                      Create workspace &ldquo;{query.trim()}&rdquo;
                    </span>
                  </button>
                )}
              </li>
            )}
          </ul>
          <div className="workspace-switcher__footer">
            <Separator orientation="horizontal" spacing="none" />
            <button
              type="button"
              className="workspace-switcher__manage"
              onClick={() => {
                setOpen(false);
                onManageWorkspaces?.();
              }}
            >
              <Icon path="mdi-cog-outline" size={0.9} />
              <span>Manage workspaces</span>
            </button>
          </div>
          {error !== null && <p className="workspace-switcher__error">{error}</p>}
        </div>
      )}
      {settingsWorkspace !== null && (
        <WorkspaceSettingsModal
          isOpen
          onClose={() => setSettingsWorkspace(null)}
          serverUrl={serverUrl}
          credential={credential}
          workspaceId={settingsWorkspace.id}
          workspaceName={settingsWorkspace.name ?? "Workspace"}
          workspaceRole={settingsWorkspace.role}
          client={client}
          onRenamed={(name) => {
            setWorkspaces((prev) =>
              prev?.map((w) => (w.id === settingsWorkspace.id ? { ...w, name } : w)) ?? null,
            );
            setSettingsWorkspace((prev) => (prev ? { ...prev, name } : prev));
            onRenamed?.(settingsWorkspace.id, name);
          }}
        />
      )}
    </div>
  );
}
