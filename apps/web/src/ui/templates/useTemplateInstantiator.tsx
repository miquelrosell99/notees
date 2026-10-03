/**
 * useTemplateInstantiator — §34.25 T4 shared instantiation flow for every
 * "use this template" surface (the slash flow, the TemplateGallery).
 *
 * begin(templateId) runs the caller's family ensure, extracts the template's
 * `{{variables}}`, and either instantiates directly (no variables) or opens
 * the TemplateVariableDialog; confirmation substitutes the values at
 * composition time (client-side, zero wire impact) and creates a fresh
 * root-level page from the template, then reports its id.
 */

import { useCallback, useState, type ReactNode } from "react";

import { extractTemplateVariables } from "@/core/clone.js";
import type { ClientNode } from "@/core/workspace-client.js";

import { TemplateVariableDialog } from "./TemplateVariableDialog.js";
import { instantiateTemplateToNewPage, type TemplateApplyClient } from "./templateApply.js";
import {
  computeDynamicTemplateVariables,
  isDynamicTemplateVariable,
  type DynamicVariableContext,
} from "./templateVariables.js";

export interface UseTemplateInstantiatorOptions {
  /** Structural surface (the outliner seam satisfies it). */
  client: TemplateApplyClient & { getNode(id: string): ClientNode | undefined };
  /** The template family self-heal (the outliner seam or the raw client ensure). */
  ensure: () => Promise<void>;
  /** The view root's display name — feeds the {{current_page}} variable. */
  currentPageName?: string | undefined;
  /** Called with the instantiated node's id once the graft lands. */
  onInstantiated?: ((nodeId: string) => void) | undefined;
}

export interface TemplateInstantiator {
  /** Begin: opens the variable dialog when needed, else instantiates now. */
  begin: (templateId: string) => void;
  /** Mount inside the host's JSX; renders the variable dialog when pending. */
  dialog: ReactNode;
}

interface PendingTemplate {
  template: ClientNode;
  variableNames: string[];
  dynamicValues: Record<string, string>;
}

export function useTemplateInstantiator({
  client,
  ensure,
  currentPageName,
  onInstantiated,
}: UseTemplateInstantiatorOptions): TemplateInstantiator {
  const [pending, setPending] = useState<PendingTemplate | null>(null);

  const instantiate = useCallback(
    async (templateId: string, variables: Record<string, string>) => {
      const id = await instantiateTemplateToNewPage(client, templateId, variables);
      onInstantiated?.(id);
    },
    [client, onInstantiated],
  );

  const begin = useCallback(
    (templateId: string) => {
      void (async () => {
        await ensure();
        const template = client.getNode(templateId);
        if (template === undefined) return;
        const variableNames = extractTemplateVariables(client, templateId);
        if (variableNames.length === 0) {
          await instantiate(templateId, {});
          return;
        }
        const dynamicContext: DynamicVariableContext = { currentPageName };
        const dynamicValues: Record<string, string> = {};
        for (const name of variableNames) {
          if (isDynamicTemplateVariable(name)) {
            Object.assign(dynamicValues, computeDynamicTemplateVariables([name], dynamicContext));
          }
        }
        setPending({ template, variableNames, dynamicValues });
      })().catch((error: unknown) => {
        console.warn("[templates] instantiation failed:", error);
      });
    },
    [client, ensure, currentPageName, instantiate],
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
        void instantiate(current.template.id, values).catch((error: unknown) => {
          console.warn("[templates] instantiation failed:", error);
        });
      }}
    />
  );

  return { begin, dialog };
}
