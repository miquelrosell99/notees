/**
 * useTaskCreate — the shared task-create flow behind the tasks hub's **New**
 * button and the global Ctrl/Cmd+Shift+N chord: ensure the task family,
 * then a class with bound templates opens the template picker (the pick
 * instantiates through the clone engine) while a class without templates
 * creates directly. The new task lands Unscheduled (the date pill schedules
 * it) and opens through the caller's navigation.
 *
 * The hook owns the pending-picker state and returns the modal element for
 * the host to render wherever its overlay layer lives (HubView renders it
 * beside the collection; the App shell beside the app modals).
 */

import { useState, type ReactNode } from "react";

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { ClientNode } from "@/core/workspace-client/index.js";

import { instantiateTemplate } from "@/core/clone.js";
import { TemplatePickerModal } from "../templates/TemplatePickerModal.js";
import { ensureTemplateProperty, listClassTemplates } from "../templates/templateFamily.js";
import { ensureTaskFamily } from "./taskFamily.js";
import type { AnyClient } from "../../ui/app/clients.js";

export function useTaskCreate({
  client,
  onOpenNode,
}: {
  /** The live client; null (signed out / connecting) makes the offer a no-op. */
  client: AnyClient | null;
  onOpenNode: (nodeId: string) => void;
}): {
  /** The New-task gesture: template picker when templates exist, else direct create. */
  offerTaskCreate: () => Promise<void>;
  /** The pending template picker — render it in the host's overlay layer. */
  taskCreateModal: ReactNode;
} {
  const [pending, setPending] = useState<{ templates: ClientNode[] } | null>(null);

  const createTaskWithTemplate = async (templateId: string | null): Promise<void> => {
    if (client === null) return;
    const id = await client.createObject({
      isEmbedded: false,
      classIds: [SYSTEM_CLASS_UUIDS.task],
    });
    if (templateId !== null) {
      await instantiateTemplate(
        { reads: client, writes: client },
        { templateRootId: templateId, objectId: id },
      );
    }
    onOpenNode(id);
  };

  const offerTaskCreate = async (): Promise<void> => {
    if (client === null) return;
    // The chord can fire before the tasks hub ever opened — author the
    // family first (idempotent no-op once present) so the fresh task reads
    // its derived Pending status.
    await ensureTaskFamily(client).catch(() => {});
    await ensureTemplateProperty(client);
    const templates = listClassTemplates(client, SYSTEM_CLASS_UUIDS.task);
    if (templates.length === 0) {
      await createTaskWithTemplate(null);
      return;
    }
    setPending({ templates });
  };

  const taskCreateModal =
    pending !== null && client !== null ? (
      <TemplatePickerModal
        isOpen
        onClose={() => setPending(null)}
        classLabel="Task"
        templates={pending.templates}
        onPick={(templateId) => {
          setPending(null);
          void createTaskWithTemplate(templateId);
        }}
      />
    ) : null;

  return { offerTaskCreate, taskCreateModal };
}
