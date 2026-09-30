/**
 * WorkspaceNameModal Component
 *
 * Reusable modal for entering a workspace name. Used for renaming an
 * existing workspace (and, with different copy, for naming new ones).
 */
import { useState, useEffect, useRef } from "react";
import { Icon } from "../../Icon.js";

import { Modal } from "./Modal";
import { Button } from "./Button";
import { TextField } from "./TextField";
import "./WorkspaceNameModal.css";

interface WorkspaceNameModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (name: string) => void;
  title: string;
  submitLabel: string;
  isLoading?: boolean;
  error?: string | null;
}

export function WorkspaceNameModal({
  isOpen,
  onClose,
  onSubmit,
  title,
  submitLabel,
  isLoading = false,
  error: externalError = null,
}: WorkspaceNameModalProps) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    }
  }, [isOpen]);

  // Reset state when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      setName("");
      setError(null);
    }
  }, [isOpen]);

  // Sync external error
  useEffect(() => {
    setError(externalError);
  }, [externalError]);

  const handleClose = () => {
    setName("");
    setError(null);
    onClose();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError("Please enter a workspace name");
      return;
    }

    if (name.trim().length < 2) {
      setError("Workspace name must be at least 2 characters");
      return;
    }

    onSubmit(name.trim());
  };

  const nameIsValid = name.trim().length >= 2;

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button type="button" variant="default" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={isLoading || !nameIsValid}
            loading={isLoading}
            onClick={handleSubmit}
          >
            {isLoading ? "Processing..." : submitLabel}
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit}>
        <TextField
          id="workspace-name"
          label="Workspace Name"
          type="text"
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-notes"
          icon={
            name.trim().length >= 2 ? (
              <Icon path={nameIsValid ? "mdi mdi-check" : "mdi mdi-close"} size={0.6} />
            ) : undefined
          }
        />

        {error && (
          <div className="workspace-name-modal__error">
            <Icon path="mdi-alert-outline" size="sm" /> {error}
          </div>
        )}
      </form>
    </Modal>
  );
}
