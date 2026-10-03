/**
 * WorkspacesView — the FULLSCREEN workspace manager: the first screen after
 * login and reachable later from the switcher's "Manage workspaces".
 * Faithful transfer of the archived WorkspaceManagementView: centered column,
 * "Your workspaces" welcome, action buttons, and a responsive CARD GRID with
 * per-card open/actions menu, created date, and an Active pill; the account
 * button sits at the header right. Features with no backend in this build
 * (import, share, restore) are omitted rather than faked.
 */

import { useEffect, useState } from "react";

import {
  createWorkspace,
  listWorkspaces,
  type AccountUser,
  type WorkspaceEntry,
} from "@/core/auth-api.js";

import { Icon } from "../Icon.js";
import { Button } from "./ui/Button.js";
import { Card } from "./ui/Card.js";
import { ConfirmationModal } from "./ui/ConfirmationModal.js";
import { ContextMenu } from "./ui/ContextMenu.js";
import { DataStateView } from "./ui/DataStateView.js";
import { Pill } from "./ui/Pill.js";
import { downloadBlob } from "./modals/download.js";
import { WorkspaceExportModal } from "./modals/WorkspaceExportModal.js";
import { WorkspaceNameModal } from "./modals/WorkspaceNameModal.js";
import { deleteWorkspace, exportWorkspace, renameWorkspace } from "./modals/workspaceApi.js";
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
  /** Open the user settings modal (header account menu). */
  onOpenUserSettings?: (() => void) | undefined;
  onSignOut?: (() => void) | undefined;
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
  onOpenUserSettings,
  onSignOut,
  onClose,
}: WorkspacesViewProps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[] | null>(null);
  const [listError, setListError] = useState<Error | null>(null);
  const [nameModal, setNameModal] = useState<NameModalState | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [cardMenu, setCardMenu] = useState<{
    workspace: WorkspaceEntry;
    x: number;
    y: number;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceEntry | null>(null);
  const [exportTarget, setExportTarget] = useState<WorkspaceEntry | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setWorkspaces(null);
    setListError(null);
    listWorkspaces(serverUrl, credential)
      .then(({ workspaces: list }) => {
        if (!cancelled) setWorkspaces(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setListError(err instanceof Error ? err : new Error(String(err)));
      });
    return () => {
      cancelled = true;
    };
  }, [serverUrl, credential]);

  const refresh = (): void => {
    listWorkspaces(serverUrl, credential)
      .then(({ workspaces: list }) => setWorkspaces(list))
      .catch((err: unknown) => setListError(err instanceof Error ? err : new Error(String(err))));
  };

  const handleSelectWorkspace = (workspace: WorkspaceEntry): void => {
    if (workspace.id === activeWorkspaceId) {
      onClose?.();
      return;
    }
    setSwitching(true);
    onEnter(workspace.id, workspace.name ?? "Workspace");
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
          setSwitching(true);
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

  const handleExport = (includeAssets: boolean): void => {
    if (exportTarget === null) return;
    const target = exportTarget;
    setExporting(true);
    setExportError(null);
    void exportWorkspace(serverUrl, credential, target.id, target.name ?? "Workspace", {
      includeAssets,
    })
      .then(({ blob, filename }) => {
        downloadBlob(blob, filename);
        setExportTarget(null);
      })
      .catch((err: unknown) => {
        setExportError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setExporting(false);
      });
  };

  const list = workspaces ?? [];
  const hasNoWorkspaces = workspaces !== null && list.length === 0;
  const fullName =
    user !== null
      ? [user.name, user.surnames].filter((p) => p !== null && p !== "").join(" ").trim()
      : "";
  const accountLabel = fullName !== "" ? fullName : (user?.displayName ?? user?.email ?? "Account");

  return (
    <div className="workspace-management">
      <div className="workspace-management__container">
        {/* Header */}
        <header className="workspace-management__header">
          <div className="workspace-management__header-content">
            <div className="workspace-management__logo">
              <h1 className="workspace-management__title">Notees</h1>
            </div>
          </div>
          <span className="workspace-management__account">
            <button
              type="button"
              className="workspace-management__account-btn"
              aria-label="Account"
              aria-expanded={accountOpen}
              onClick={() => setAccountOpen((open) => !open)}
            >
              <span className="workspace-management__account-avatar" aria-hidden="true">
                {user?.avatarUrl ? (
                  <img src={user.avatarUrl} alt="" />
                ) : (
                  <Icon path="mdi-account-circle-outline" size={1.2} />
                )}
              </span>
              <span className="workspace-management__account-name">{accountLabel}</span>
              <Icon path={accountOpen ? "mdi-chevron-up" : "mdi-chevron-down"} size={0.8} />
            </button>
            {accountOpen && (
              <span className="workspace-management__account-menu" role="menu">
                {onOpenUserSettings !== undefined && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setAccountOpen(false);
                      onOpenUserSettings();
                    }}
                  >
                    <Icon path="mdi-cog-outline" size={0.9} />
                    <span>Settings</span>
                  </button>
                )}
                {onSignOut !== undefined && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setAccountOpen(false);
                      onSignOut();
                    }}
                  >
                    <Icon path="mdi-logout-variant" size={0.9} />
                    <span>Sign out</span>
                  </button>
                )}
              </span>
            )}
          </span>
        </header>

        {/* Main Content */}
        <main className="workspace-management__main">
          <div className="workspace-management__welcome">
            <h2>{hasNoWorkspaces ? "Welcome! Create your first workspace" : "Your workspaces"}</h2>
            <p className="workspace-management__subtitle">
              {hasNoWorkspaces
                ? "A workspace holds all your notes and pages — click the + card below to create one."
                : "Select a workspace to open, or create a new one."}
            </p>
          </div>

          {/* Workspace cards */}
          <DataStateView
            isLoading={workspaces === null && listError === null}
            error={listError}
            onRetry={refresh}
            skeletonRows={4}
          >
            {list.length > 0 || hasNoWorkspaces ? (
              <div className="workspace-management__grid">
                {list.map((workspace) => {
                  const isActive = workspace.id === activeWorkspaceId;
                  const displayName = workspace.name ?? "Workspace";
                  return (
                    <Card
                      key={workspace.id}
                      className={`workspace-management__card ${isActive ? "workspace-management__card--active" : ""}`}
                      elevation="low"
                      padding={false}
                    >
                      <div className="workspace-management__card-header">
                        <div className="workspace-management__card-title">
                          <span className="workspace-management__card-name">{displayName}</span>
                          <div className="workspace-management__card-badges" />
                        </div>
                        <div className="workspace-management__card-actions">
                          <Button
                            aria-label={`Open ${displayName}`}
                            variant="ghost"
                            size="sm"
                            onClick={() => handleSelectWorkspace(workspace)}
                            title="Open workspace"
                            className="workspace-management__access-btn"
                            disabled={switching}
                            icon="mdi mdi-arrow-right"
                          />
                          <Button
                            aria-label={`Actions for ${displayName}`}
                            variant="ghost"
                            size="sm"
                            onClick={(event) =>
                              setCardMenu({
                                workspace,
                                x: event.clientX,
                                y: event.clientY,
                              })
                            }
                            title="Workspace actions"
                            disabled={switching}
                            icon="mdi mdi-dots-vertical"
                          />
                        </div>
                      </div>
                      <div className="workspace-management__card-content">
                        <div className="workspace-management__card-footer">
                          <div className="workspace-management__card-meta">
                            <span>
                              Created {new Date(workspace.createdAt).toLocaleDateString()}
                            </span>
                            <span>{workspace.envelopeCount} operations</span>
                          </div>
                          {isActive && (
                            <Pill text="Active" className="workspace-management__pill--active" />
                          )}
                        </div>
                      </div>
                    </Card>
                  );
                })}
                <button
                  type="button"
                  className="workspace-management__card workspace-management__card--create"
                  aria-label="Create workspace"
                  onClick={() => {
                    setNameError(null);
                    setNameModal({ mode: "create" });
                  }}
                >
                  <Icon path="mdi-plus" size={1.4} />
                  <span>New workspace</span>
                </button>
              </div>
            ) : null}
          </DataStateView>
        </main>

        {/* Footer */}
        <footer className="workspace-management__footer">
          <p>Notees - Your personal knowledge base</p>
        </footer>
      </div>

      {nameModal !== null && (
        <WorkspaceNameModal
          isOpen
          onClose={() => {
            setNameModal(null);
            setNameError(null);
          }}
          onSubmit={handleNameSubmit}
          title={
            nameModal.mode === "create"
              ? "Create New Workspace"
              : `Rename "${nameModal.workspace.name ?? "Workspace"}"`
          }
          submitLabel={nameModal.mode === "create" ? "Create Workspace" : "Rename Workspace"}
          isLoading={submitting}
          error={nameError}
        />
      )}

      {cardMenu !== null && (
        <ContextMenu
          position={{ x: cardMenu.x, y: cardMenu.y }}
          alignRight
          onClose={() => setCardMenu(null)}
          items={[
            {
              id: "rename",
              label: "Rename",
              icon: "mdi mdi-pencil-outline",
              disabled: cardMenu.workspace.role !== "owner",
              onClick: () => {
                setNameError(null);
                setNameModal({ mode: "rename", workspace: cardMenu.workspace });
              },
            },
            {
              id: "export",
              label: "Export",
              icon: "mdi mdi-export",
              onClick: () => {
                setExportError(null);
                setExportTarget(cardMenu.workspace);
              },
            },
            {
              id: "delete",
              label: "Delete",
              icon: "mdi mdi-delete-outline",
              danger: true,
              disabled: cardMenu.workspace.role !== "owner",
              onClick: () => setDeleteTarget(cardMenu.workspace),
            },
          ]}
        />
      )}

      {exportTarget !== null && (
        <WorkspaceExportModal
          isOpen
          workspaceName={exportTarget.name ?? "Workspace"}
          isLoading={exporting}
          error={exportError}
          onClose={() => {
            setExportTarget(null);
            setExportError(null);
          }}
          onExport={handleExport}
        />
      )}

      {deleteTarget !== null && (
        <ConfirmationModal
          isOpen
          variant="danger"
          title={`Delete "${deleteTarget.name ?? "Workspace"}"?`}
          message="This permanently deletes the workspace and all of its data: pages, blocks, classes, assets, and the full edit history."
          secondaryMessage="Other members will lose access immediately. This cannot be undone."
          confirmLabel="Delete workspace"
          onCancel={() => setDeleteTarget(null)}
          onConfirm={async () => {
            const target = deleteTarget;
            await deleteWorkspace(serverUrl, credential, target.id);
            setDeleteTarget(null);
            refresh();
            if (target.id === activeWorkspaceId) onClose?.();
          }}
        />
      )}

      {switching && (
        <div className="workspace-management__switching-overlay" aria-live="assertive" role="status">
          <div className="workspace-management__switching-box">Opening workspace…</div>
        </div>
      )}
    </div>
  );
}
