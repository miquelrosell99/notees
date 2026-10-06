/**
 * useTemplateApplyToExisting — the apply-to-existing flow: graft a
 * template onto a node that already exists and
 * record generatedFrom provenance. Mirrors useTemplateInstantiator's
 * variables handling (dialog when the template carries {{variables}};
 * dynamic names computed readonly) but targets a caller-chosen node instead
 * of a fresh page. The Class View's TemplatesSection is the host.
 */

import { useCallback, useState, type ReactNode } from "react";

import { extractTemplateVariables } from "@/core/clone.js";
import type { ClientNode } from "@/core/workspace-client.js";

import { TemplateVariableDialog } from "./TemplateVariableDialog.js";
import { applyTemplateToExistingNode, type TemplateApplyClient } from "./templateApply.js";
import {
  computeDynamicTemplateVariables,
  isDynamicTemplateVariable,
  type DynamicVariableContext,
} from "./templateVariables.js";

export interface UseTemplateApplyToExistingOptions {
  /** Structural surface (the outliner seam satisfies it). */
  client: TemplateApplyClient & { getNode(id: string): ClientNode | undefined };
  /** The template family self-heal. */
  ensure: () => Promise<void>;
  /** Called with the outcome once the graft lands (or is skipped). */
  onApplied?: ((nodeId: string, outcome: "applied" | "already-applied") => void) | undefined;
}

export interface TemplateApplyToExisting {
  /** Begin applying `templateId` onto the existing `nodeId`. */
  begin: (templateId: string, nodeId: string) => void;
  /** Mount inside the host's JSX; renders the variable dialog when pending. */
  dialog: ReactNode;
}

interface PendingApply {
  template: ClientNode;
  nodeId: string;
  variableNames: string[];
  dynamicValues: Record<string, string>;
}

export function useTemplateApplyToExisting({
  client,
  ensure,
  onApplied,
}: UseTemplateApplyToExistingOptions): TemplateApplyToExisting {
  const [pending, setPending] = useState<PendingApply | null>(null);

  const apply = useCallback(
    async (templateId: string, nodeId: string, variables: Record<string, string>) => {
      const outcome = await applyTemplateToExistingNode(client, templateId, nodeId, variables);
      onApplied?.(nodeId, outcome);
    },
    [client, onApplied],
  );

  const begin = useCallback(
    (templateId: string, nodeId: string) => {
      void (async () => {
        await ensure();
        const template = client.getNode(templateId);
        if (template === undefined) return;
        const variableNames = extractTemplateVariables(client, templateId);
        if (variableNames.length === 0) {
          await apply(templateId, nodeId, {});
          return;
        }
        const dynamicContext: DynamicVariableContext = {};
        const dynamicValues: Record<string, string> = {};
        for (const name of variableNames) {
          if (isDynamicTemplateVariable(name)) {
            Object.assign(dynamicValues, computeDynamicTemplateVariables([name], dynamicContext));
          }
        }
        setPending({ template, nodeId, variableNames, dynamicValues });
      })().catch((error: unknown) => {
        console.warn("[templates] apply-to-existing failed:", error);
      });
    },
    [client, ensure, apply],
  );

  const dialog = pending === null ? null : (
    <TemplateVariableDialog
      isOpen
      template={pending.template}
      variableNames={pending.variableNames}
      dynamicValues={pending.dynamicValues}
      onCancel={() => setPending(null)}
      onConfirm={(values) => {
        const current = pending;
        setPending(null);
        void apply(current.template.id, current.nodeId, values).catch((error: unknown) => {
          console.warn("[templates] apply-to-existing failed:", error);
        });
      }}
    />
  );

  return { begin, dialog };
}
