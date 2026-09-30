/**
 * DuplicatePageModal - Shown when creating a page with a name that already exists
 *
 * Lets the user pick a class to differentiate the new page from existing ones.
 * Example: "Apple" already exists as a Fruit → create "Apple" as a Company.
 */
import { useState, useCallback, useRef, useEffect } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { NodeIcon } from "./NodeIcon";
import type { ClientNode } from "@/core/workspace-client.js";
import type { WorkerClient } from "@/core/worker-client.js";
import "./DuplicatePageModal.css";

export interface DuplicatePageModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback to close the modal */
  onClose: () => void;
  /** The page name that had a conflict */
  pageName: string;
  /** Classes that are already taken for this name */
  conflictingClasses: string[];
  /** The classes the user originally tried to create with */
  originalClasses: string[];
  /** Parent id for the page (for hierarchical pages) */
  parentId: string | null;
  /** The workspace data surface the create writes through. */
  client: WorkspaceClientLike;
  /** Callback when the page is successfully created */
  onSuccess: (node: ClientNode) => void;
}

type WorkspaceClientLike = Pick<
  import("@/core/workspace-client.js").WorkspaceClient | WorkerClient,
  "listClasses" | "createObject" | "createClass" | "getNode"
>;

/**
 * DuplicatePageModal Component
 *
 * Shows when a page name already exists. Lets user pick a different class
 * to create a unique name+class combination.
 */
export function DuplicatePageModal({
  isOpen,
  onClose,
  pageName,
  conflictingClasses,
  originalClasses: _originalClasses,
  parentId,
  client,
  onSuccess,
}: DuplicatePageModalProps) {
  const [classQuery, setClassQuery] = useState("");
  const [selectedClass, setSelectedClass] = useState<ClientNode | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Filter classes based on search query, excluding conflicting ones
  const allClasses = client.listClasses();
  const filteredClasses = allClasses.filter((c) => {
    const name = c.name?.toLowerCase() || "";
    const matchesQuery = !classQuery || name.includes(classQuery.toLowerCase());
    // Exclude classes that are already used with this page name
    const isConflicting = conflictingClasses.some((cc) => cc.toLowerCase() === name);
    return matchesQuery && !isConflicting;
  });

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setClassQuery("");
      setSelectedClass(null);
      setError(null);
      setIsCreating(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  const handleCreate = useCallback(async () => {
    if (!selectedClass) return;

    setIsCreating(true);
    setError(null);

    try {
      const newId = await client.createObject({
        name: pageName,
        nodeType: "page",
        parentId,
        classIds: [selectedClass.id],
      });

      const newNode = client.getNode(newId);
      if (newNode !== undefined) onSuccess(newNode);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create page. Please try again.");
    } finally {
      setIsCreating(false);
    }
  }, [selectedClass, pageName, parentId, client, onSuccess, onClose]);

  const handleCreateNewClass = useCallback(async () => {
    if (!classQuery.trim()) return;

    setIsCreating(true);
    setError(null);

    try {
      // Create the new class first
      const newClassId = await client.createClass(classQuery.trim());

      // Then create the page with the new class
      const newId = await client.createObject({
        name: pageName,
        nodeType: "page",
        parentId,
        classIds: [newClassId],
      });

      const newNode = client.getNode(newId);
      if (newNode !== undefined) onSuccess(newNode);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create page. Please try again.");
    } finally {
      setIsCreating(false);
    }
  }, [classQuery, pageName, parentId, client, onSuccess, onClose]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`"${pageName}" already exists`}
      size="sm"
      footer={
        <div className="duplicate-page-modal__footer">
          <Button variant="ghost" onClick={onClose} size="sm">
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleCreate}
            size="sm"
            disabled={!selectedClass || isCreating}
            loading={isCreating}
          >
            {isCreating ? "Creating..." : "Create"}
          </Button>
        </div>
      }
    >
      <div className="duplicate-page-modal">
        <p className="duplicate-page-modal__description">
          A page named "<strong>{pageName}</strong>" already exists
          {conflictingClasses.length > 0 && (
            <>
              {" "}
              with class{conflictingClasses.length > 1 ? "es" : ""}:{" "}
              {conflictingClasses.map((c, i) => (
                <span key={c}>
                  {i > 0 && ", "}
                  <strong>{c}</strong>
                </span>
              ))}
            </>
          )}
          . Pick a different class to create a new page with the same name.
        </p>

        <div className="duplicate-page-modal__search">
          <input
            ref={inputRef}
            type="text"
            className="duplicate-page-modal__input"
            value={classQuery}
            onChange={(e) => {
              setClassQuery(e.target.value);
              setSelectedClass(null);
            }}
            placeholder="Search or create a class..."
            aria-label="Search or create a class"
            onKeyDown={(e) => {
              if (e.key === "Enter" && selectedClass) {
                e.preventDefault();
                void handleCreate();
              }
            }}
          />
        </div>

        <div className="duplicate-page-modal__class-list">
          {filteredClasses.map((classNode) => {
            const isSelected = selectedClass?.id === classNode.id;
            return (
              <button
                key={classNode.id}
                className={`duplicate-page-modal__class-item ${isSelected ? "duplicate-page-modal__class-item--selected" : ""}`}
                onClick={() => setSelectedClass(isSelected ? null : classNode)}
              >
                <NodeIcon icon={classNode.icon} isPage={true} size="sm" />
                <span className="duplicate-page-modal__class-name">
                  {classNode.name || "Untitled"}
                </span>
              </button>
            );
          })}

          {classQuery.trim() &&
            !filteredClasses.some(
              (c) => c.name?.toLowerCase() === classQuery.trim().toLowerCase(),
            ) && (
              <button
                className="duplicate-page-modal__class-item duplicate-page-modal__class-item--create"
                onClick={() => void handleCreateNewClass()}
                disabled={isCreating}
              >
                <span className="duplicate-page-modal__create-icon">+</span>
                <span className="duplicate-page-modal__class-name">
                  Create class "{classQuery.trim()}"
                </span>
              </button>
            )}

          {filteredClasses.length === 0 && !classQuery.trim() && (
            <p className="duplicate-page-modal__empty">No classes available. Type to create a new one.</p>
          )}
        </div>

        {error && <p className="duplicate-page-modal__error">{error}</p>}
      </div>
    </Modal>
  );
}
