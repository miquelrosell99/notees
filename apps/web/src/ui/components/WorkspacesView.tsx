/**
 * WorkspacesView — the FULLSCREEN workspace manager (the first screen after
 * login, and reachable later from the switcher's "Manage workspaces").
 * Lists the account's workspaces as cards: click to enter, rename
 * (owner-only), create. Ported from the archived fullscreen management view;
 * features with no backend (delete, members/sharing, duplicate, import,
 * export) are omitted rather than faked.
 */

import { useEffect, useState } from "react";

import {
  createWorkspace,
  listWorkspaces,
  type AccountUser,
  type WorkspaceEntry,
} from "@/core/auth-api.js";

import { Icon } from "../Icon.js";
import { Badge } from "./ui/Badge.js";
import { Spinner } from "./ui/Spinner.js";
import { WorkspaceNameModal } from "./modals/WorkspaceNameModal.js";
import { renameWorkspace } from "./modals/workspaceApi.js";
import "./WorkspacesView.css";

export interface WorkspacesViewProps {
  serverUrl: string;
  credential: string;
  user: AccountUser | null;
  /** The workspace the shell is connected to (null before the first connect). */
  activeWorkspaceId: string | null;
  /** Enter a workspace (connect on first login; switch when connected). */
  onEnter: (workspaceId: string, name: string) => void;
  /** Called after a rename so the shell can update its label. */
  onRenamed?: ((workspaceId: string, name: string) => void | undefined) | undefined;
  /** Present when opened from the switcher while connected: returns to the app. */
  onClose?: (() => void) | undefined;
}

type NameModalState =
  | { mode: "create" }
  | { mode: "rename"; workspace: WorkspaceEntry };

export function WorkspacesView({
  serverUrl,
  credential,
  user,
  activeWorkspaceId,
  onEnter,
  onRenamed,
  onClose,
}: WorkspacesViewProps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [nameModal, setNameModal] = useState<NameModalState | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setWorkspaces(null);
    setListError(null);
    listWorkspaces(serverUrl, credential)
      .then(({ workspaces: list }) => {
        if (!cancelled) setWorkspaces(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setListError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [serverUrl, credential]);

  const refresh = (): void => {
    listWorkspaces(serverUrl, credential)
      .then(({ workspaces: list }) => setWorkspaces(list))
      .catch((err: unknown) => setListError(err instanceof Error ? err.message : String(err)));
  };

  const handleNameSubmit = (name: string): void => {
    if (nameModal === null) return;
    setNameError(null);
    setSubmitting(true);
    if (nameModal.mode === "create") {
      createWorkspace(serverUrl, credential, name)
        .then(({ id }) => {
          setSubmitting(false);
          setNameModal(null);
          onEnter(id, name);
        })
        .catch((err: unknown) => {
          setSubmitting(false);
          setNameError(err instanceof Error ? err.message : String(err));
        });
    } else {
      const { workspace } = nameModal;
      renameWorkspace(serverUrl, credential, workspace.id, name)
        .then((result) => {
          setSubmitting(false);
          setNameModal(null);
          const nextName = result.name ?? name;
          setWorkspaces(
            (prev) => prev?.map((w) => (w.id === workspace.id ? { ...w, name: nextName } : w)) ?? null,
          );
          onRenamed?.(workspace.id, nextName);
        })
        .catch((err: unknown) => {
          setSubmitting(false);
          setNameError(err instanceof Error ? err.message : String(err));
        });
    }
  };

  const closeNameModal = (): void => {
    setNameModal(null);
    setNameError(null);
  };

  return (
    <div className="workspaces-view">
      <header className="workspaces-view__topbar">
        <span className="nt-wordmark">Notees</span>
        <span className="workspaces-view__title">Workspaces</span>
        {onClose !== undefined && (
          <button type="button" className="nt-icon-btn" aria-label="Back to workspace" onClick={onClose}>
            <Icon path="mdi-close" size={1} />
          </button>
        )}
      </header>
      <div className="workspaces-view__body">
        <p className="workspaces-view__subtitle">
          {user !== null ? `Signed in as ${user.email}. ` : ""}
          Choose a workspace to open it, or create a new one.
        </p>

        {listError !== null && (
          <div className="workspaces-view__error" role="alert">
            <span>{listError}</span>
            <button type="button" onClick={refresh}>
              Retry
            </button>
          </div>
        )}

        {workspaces === null && listError === null ? (
          <div className="workspaces-view__loading">
            <Spinner size="sm" label="Loading workspaces…" />
          </div>
        ) : (
          <ul className="workspaces-view__list">
            {(workspaces ?? []).map((workspace) => {
              const isActive = workspace.id === activeWorkspaceId;
              const displayName = workspace.name ?? "Workspace";
              const canRename = workspace.role === "owner";
              return (
                <li
                  key={workspace.id}
                  className={
                    isActive ? "workspaces-view__card workspaces-view__card--active" : "workspaces-view__card"
                  }
                >
                  <button
                    type="button"
                    className="workspaces-view__open"
                    onClick={() => onEnter(workspace.id, displayName)}
                  >
                    <Icon path="mdi-database-outline" size={1.1} className="workspaces-view__icon" />
                    <span className="workspaces-view__identity">
                      <span className="workspaces-view__name">{displayName}</span>
                      <span className="workspaces-view__meta">
                        {workspace.role} · {workspace.envelopeCount} ops
                      </span>
                    </span>
                    {isActive && <Badge variant="primary">Active</Badge>}
                  </button>
                  <button
                    type="button"
                    className="workspaces-view__rename"
                    aria-label={`Rename ${displayName}`}
                    title={canRename ? `Rename ${displayName}` : "Only the workspace owner can rename"}
                    disabled={!canRename}
                    onClick={() => setNameModal({ mode: "rename", workspace })}
                  >
                    <Icon path="mdi-pencil-outline" size={0.9} />
                  </button>
                </li>
              );
            })}
            <li>
              <button
                type="button"
                className="workspaces-view__create"
                onClick={() => {
                  setNameError(null);
                  setNameModal({ mode: "create" });
                }}
              >
                <Icon path="mdi-plus" size={1} />
                <span>Create workspace</span>
              </button>
            </li>
          </ul>
        )}
      </div>

      {nameModal !== null && (
        <WorkspaceNameModal
          isOpen
          onClose={closeNameModal}
          onSubmit={handleNameSubmit}
          title={
            nameModal.mode === "create"
              ? "Create workspace"
              : `Rename "${nameModal.workspace.name ?? "Workspace"}"`
          }
          submitLabel={nameModal.mode === "create" ? "Create" : "Rename"}
          isLoading={submitting}
          error={nameError}
        />
      )}
    </div>
  );
}
