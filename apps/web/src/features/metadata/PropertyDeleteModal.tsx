/**
 * PropertyDeleteModal — the standalone delete flow (S2:
 * conversion no longer owns deletion). v1's confirmation copy 1:1. The
 * delete is the soft propertySchema.delete — authored values survive in the
 * log (the applier marks the schema inactive; recreate-under-the-same-id
 * reactivates). Hosts: the settings (definition) modal's footer and the
 * PropertyView footer.
 */

import type { ClientPropertySchema } from "@/core/workspace-client/index.js";

import { ConfirmationModal } from "../../components/ui/fleet/ConfirmationModal.js";
import type { AnyClient } from "./shared.js";

export function PropertyDeleteModal({
  client,
  schema,
  onClose,
  onDeleted,
}: {
  client: AnyClient;
  schema: ClientPropertySchema;
  onClose: () => void;
  /** Called after the delete lands (hosts close themselves). */
  onDeleted?: (() => void) | undefined;
}) {
  return (
    <ConfirmationModal
      isOpen
      title="Delete Property"
      message={`Are you sure you want to delete the property "${schema.name}"? This will remove the property and all its values from all nodes.`}
      confirmLabel="Delete"
      cancelLabel="Cancel"
      variant="danger"
      onConfirm={() =>
        client
          .deletePropertySchema(schema.id)
          .then(() => {
            onClose();
            onDeleted?.();
          })
          .catch((err: unknown) => {
            // The confirmation modal shows its own inline error on throw;
            // stay open so the user can retry or cancel.
            throw err instanceof Error ? err : new Error(String(err));
          })
      }
      onCancel={onClose}
    />
  );
}
