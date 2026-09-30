import { useEffect, useRef, useState } from "react";

import { createWorkspace, listWorkspaces, type WorkspaceEntry } from "@/core/auth-api.js";

import { Icon } from "../Icon.js";
import { Separator } from "./ui/Separator.js";
import { WorkspaceSettingsModal } from "./modals/WorkspaceSettingsModal.js";
import "./WorkspaceSwitcher.css";

/**
 * WorkspaceSwitcher — searchable dropdown for switching between workspaces,
 * mounted at the top of the sidebar. Online only (offline mode has exactly
 * one well-known local workspace, so the switcher stays hidden there).
 * Each row carries a gear button (visible on hover/focus) that opens the
 * workspace settings modal for that workspace. Typing a query that matches
 * nothing offers to create a workspace with that name; the footer opens the
 * Manage Workspaces view.
 */
export function WorkspaceSwitcher({
  serverUrl,
  credential,
  activeWorkspaceId,
  activeName,
  onSwitch,
  onManageWorkspaces,
  onRenamed,
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
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settingsWorkspace, setSettingsWorkspace] = useState<WorkspaceEntry | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listWorkspaces(serverUrl, credential)
      .then(({ workspaces: list }) => {
        if (!cancelled) setWorkspaces(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open, serverUrl, credential]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const filtered =
    workspaces === null
      ? []
      : query.trim() === ""
        ? workspaces
        : workspaces.filter((ws) => (ws.name ?? "").toLowerCase().includes(query.trim().toLowerCase()));

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
    <div className="workspace-switcher" ref={rootRef}>
      <div className="workspace-switcher__row">
        <button
          type="button"
          className="workspace-switcher__trigger"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="workspace-switcher__name">{(activeName || "Workspace").toUpperCase()}</span>
          <Icon path={open ? "mdi-chevron-up" : "mdi-chevron-down"} size={0.9} />
        </button>
      </div>

      {open && (
        <div className="workspace-switcher__popup" role="listbox" aria-label="Workspaces">
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
            {filtered.map((ws) => {
              const isActive = ws.id === activeWorkspaceId;
              return (
                <li key={ws.id} className="workspace-switcher__row-item">
                  <button
                    type="button"
                    className="workspace-switcher__item"
                    role="option"
                    aria-selected={isActive}
                    onClick={() => {
                      setOpen(false);
                      if (!isActive) onSwitch(ws.id, ws.name ?? "Workspace");
                    }}
                  >
                    <Icon path="mdi-database-outline" size={0.8} className="workspace-switcher__item-icon" />
                    <span className="workspace-switcher__item-name">{ws.name ?? "Workspace"}</span>
                    {isActive && <span className="workspace-switcher__item-badge">Active</span>}
                  </button>
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
                </li>
              );
            })}
            {workspaces !== null && filtered.length === 0 && (
              <li className="workspace-switcher__row-item">
                {query.trim() === "" ? (
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
