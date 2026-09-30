/**
 * ManageWorkspacesModal Component
 *
 * Modal for managing the account's workspaces: lists them (name, membership
 * role, active badge), switches by clicking a row, renames via the shared
 * WorkspaceNameModal (PATCH /workspaces/:id, owner-only), and creates new
 * ones. Ported from the archived fullscreen workspace-management view;
 * features with no backend in this build (delete, members/sharing, duplicate,
 * import, export, restore) are omitted rather than faked.
 */
import { useEffect, useState } from "react";

import {
  createWorkspace,
  listWorkspaces,
  type WorkspaceEntry,
} from "@/core/auth-api.js";

import { Icon } from "../../Icon.js";
import { Badge } from "../ui/Badge.js";
import { Modal } from "../ui/Modal.js";
import { Spinner } from "../ui/Spinner.js";
import { WorkspaceNameModal } from "./WorkspaceNameModal.js";
import { renameWorkspace } from "./workspaceApi.js";
import "./ManageWorkspacesModal.css";

export interface ManageWorkspacesModalProps {
  isOpen: boolean;
  onClose: () => void;
  serverUrl: string;
  credential: string;
  /** The workspace the shell is currently connected to. */
  activeWorkspaceId: string;
  /** Switch the shell to a workspace (row click, and after create). */
  onSwitch?: ((workspaceId: string, name: string) => void) | undefined;
  /** Called after a rename so the shell can update its label. */
  onRenamed?: ((workspaceId: string, name: string) => void) | undefined;
}

type NameModalState =
  | { mode: "create" }
  | { mode: "rename"; workspace: WorkspaceEntry };

export function ManageWorkspacesModal({
  isOpen,
  onClose,
  serverUrl,
  credential,
  activeWorkspaceId,
  onSwitch,
  onRenamed,
}: ManageWorkspacesModalProps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [nameModal, setNameModal] = useState<NameModalState | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
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
  }, [isOpen, serverUrl, credential]);

  const refresh = (): void => {
    listWorkspaces(serverUrl, credential)
      .then(({ workspaces: list }) => setWorkspaces(list))
      .catch((err: unknown) => setListError(err instanceof Error ? err.message : String(err)));
  };

  const openWorkspace = (workspace: WorkspaceEntry): void => {
    if (workspace.id === activeWorkspaceId) {
      onClose();
      return;
    }
    onClose();
    onSwitch?.(workspace.id, workspace.name ?? "Workspace");
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
          onClose();
          onSwitch?.(id, name);
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
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Manage Workspaces"
      size="md"
      closeOnBackdrop
      closeOnEscape
    >
      <div className="manage-workspaces">
        <p className="manage-workspaces__subtitle">
          Select a workspace to open it, or create a new one.
        </p>

        {listError !== null && (
          <div className="manage-workspaces__error" role="alert">
            <span>{listError}</span>
            <button type="button" onClick={refresh}>
              Retry
            </button>
          </div>
        )}

        {workspaces === null && listError === null ? (
          <div className="manage-workspaces__loading">
            <Spinner size="sm" label="Loading workspaces…" />
          </div>
        ) : (
          <ul className="manage-workspaces__list">
            {(workspaces ?? []).map((workspace) => {
              const isActive = workspace.id === activeWorkspaceId;
              const displayName = workspace.name ?? "Workspace";
              const canRename = workspace.role === "owner";
              return (
                <li
                  key={workspace.id}
                  className={
                    isActive
                      ? "manage-workspaces__row manage-workspaces__row--active"
                      : "manage-workspaces__row"
                  }
                >
                  <button
                    type="button"
                    className="manage-workspaces__open"
                    onClick={() => openWorkspace(workspace)}
                  >
                    <Icon
                      path="mdi-database-outline"
                      size={0.9}
                      className="manage-workspaces__icon"
                    />
                    <span className="manage-workspaces__identity">
                      <span className="manage-workspaces__name">{displayName}</span>
                      <span className="manage-workspaces__meta">
                        {workspace.role} · {workspace.envelopeCount} ops
                      </span>
                    </span>
                    {isActive && <Badge variant="primary">Active</Badge>}
                  </button>
                  <button
                    type="button"
                    className="manage-workspaces__rename"
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
          </ul>
        )}

        <button
          type="button"
          className="manage-workspaces__create"
          onClick={() => {
            setNameError(null);
            setNameModal({ mode: "create" });
          }}
        >
          <Icon path="mdi-plus" size={0.9} />
          <span>Create workspace</span>
        </button>
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
    </Modal>
  );
}
