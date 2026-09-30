import { useEffect, useRef, useState } from "react";

import { createWorkspace, listWorkspaces, type WorkspaceEntry } from "@/core/auth-api.js";

import { Icon } from "../Icon.js";
import "./WorkspaceSwitcher.css";

/**
 * WorkspaceSwitcher — searchable dropdown for switching between workspaces,
 * mounted at the top of the sidebar. Online only (offline mode has exactly
 * one well-known local workspace, so the switcher stays hidden there).
 */
export function WorkspaceSwitcher({
  serverUrl,
  credential,
  activeWorkspaceId,
  activeName,
  onSwitch,
  onSignOut,
}: {
  serverUrl: string;
  credential: string;
  activeWorkspaceId: string;
  activeName: string;
  onSwitch: (workspaceId: string, name: string) => void;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
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

  async function handleCreate(): Promise<void> {
    const name = newName.trim();
    if (name === "") return;
    setError(null);
    try {
      const { id } = await createWorkspace(serverUrl, credential, name);
      setCreating(false);
      setNewName("");
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
        <button
          type="button"
          className="workspace-switcher__add-btn"
          title="New workspace"
          aria-label="New workspace"
          onClick={() => {
            setCreating(true);
            setOpen(true);
          }}
        >
          <Icon path="mdi-plus" size={1} />
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
                <li key={ws.id}>
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
                </li>
              );
            })}
            {workspaces !== null && filtered.length === 0 && (
              <li className="workspace-switcher__empty">No workspaces match.</li>
            )}
          </ul>
          {creating ? (
            <div className="workspace-switcher__create">
              <input
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                placeholder="Workspace name"
                autoFocus
                onKeyDown={(event) => {
                  if (event.key === "Enter") void handleCreate();
                }}
              />
              <button type="button" onClick={() => void handleCreate()} disabled={newName.trim() === ""}>
                Create
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="workspace-switcher__manage"
              onClick={() => {
                setOpen(false);
                onSignOut();
              }}
            >
              <Icon path="mdi-logout-variant" size={0.9} />
              <span>Sign out</span>
            </button>
          )}
          {error !== null && <p className="workspace-switcher__error">{error}</p>}
        </div>
      )}
    </div>
  );
}
