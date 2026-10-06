/**
 * WorkspaceExportModal — the workspace-level export options dialog:
 * one zip download, an include-assets toggle, and a short
 * format note. Presentational — the view owns the fetch/download and feeds
 * back isLoading/error (the WorkspaceNameModal convention).
 */

import { useEffect, useState } from "react";

import { Modal } from "../ui/Modal.js";
import { Button } from "../ui/Button.js";
import { Checkbox } from "../ui/Checkbox.js";
import "./WorkspaceExportModal.css";

interface WorkspaceExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Workspace display name (modal title). */
  workspaceName: string;
  /** True while the server builds/fetches the zip — buttons disable, Export spins. */
  isLoading?: boolean;
  /** Export failure, rendered in-modal (one line). */
  error?: string | null;
  onExport: (includeAssets: boolean) => void;
}

export function WorkspaceExportModal({
  isOpen,
  onClose,
  workspaceName,
  isLoading = false,
  error = null,
  onExport,
}: WorkspaceExportModalProps) {
  const [includeAssets, setIncludeAssets] = useState(false);

  // The toggle defaults off per open.
  useEffect(() => {
    if (isOpen) setIncludeAssets(false);
  }, [isOpen]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Export "${workspaceName}"`}
      size="sm"
      footer={
        <>
          <Button type="button" variant="default" onClick={onClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            icon="mdi mdi-download"
            disabled={isLoading}
            loading={isLoading}
            onClick={() => onExport(includeAssets)}
          >
            {isLoading ? "Exporting…" : "Export"}
          </Button>
        </>
      }
    >
      <div className="workspace-export-modal__body">
        <p className="workspace-export-modal__note">
          Downloads as one zip archive: a Markdown file per top-level page and its child pages,
          plus a manifest. With asset files included, referenced assets are added under an
          assets/ folder and linked with relative paths.
        </p>
        <Checkbox
          size="sm"
          label="Include asset files"
          checked={includeAssets}
          disabled={isLoading}
          onChange={(event) => setIncludeAssets(event.target.checked)}
        />
        {error !== null && (
          <div className="workspace-export-modal__error" role="alert">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
