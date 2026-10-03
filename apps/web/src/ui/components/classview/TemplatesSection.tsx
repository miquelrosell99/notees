/**
 * TemplatesSection — the class's assigned templates (§34.25 T3) as a card
 * row: one compact card per bound template (icon + name, hover-reveal × to
 * unbind, click opens the template), plus the "＋ Bind template" affordance
 * opening the template-class-filtered NodeSelector (the ONE class-filtered
 * surface; instantiation surfaces stay unfiltered per the D1 amendment).
 * Expanded when empty (invites setup), collapsed once bound.
 */

import { useState } from "react";

import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { displayNameForSettings } from "../../dateDisplay.js";
import { Icon } from "../../Icon.js";
import { NodeSelector } from "../pickers/NodeSelector.js";
import { AddPill } from "../ui/AddPill.js";
import { NodeViewSection } from "../NodeViewSection.js";
import {
  ensureTemplateFamily,
  listClassTemplateBindings,
} from "../templateFamily.js";
import "./TemplatesSection.css";

type AnyClient = WorkspaceClient | WorkerClient;

export function TemplatesSection({
  client,
  classId,
  onOpenPage,
}: {
  client: AnyClient;
  classId: string;
  onOpenPage?: ((pageId: string) => void) | undefined;
}) {
  const [pickerAnchor, setPickerAnchor] = useState<HTMLButtonElement | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  /** The class's bound templates, each with its authored value's idx (unbind target). */
  const templateBindings = listClassTemplateBindings(client, classId);

  /** Append a has-template value at the next free idx (the metadata-section pattern). */
  const bindTemplate = async (templateId: string) => {
    const authoredIdx = client
      .getEffectiveProperties(classId)
      .filter(
        (entry) =>
          entry.propertySchemaId === SYSTEM_PROPERTY_UUIDS.hasTemplate &&
          entry.source === "authored",
      )
      .map((entry) => entry.idx);
    const nextIdx = authoredIdx.length > 0 ? Math.max(...authoredIdx) + 1 : 0;
    await client.setProperty(
      classId,
      SYSTEM_PROPERTY_UUIDS.hasTemplate,
      { nodeId: templateId },
      nextIdx,
    );
  };

  return (
    <NodeViewSection
      title="Templates"
      icon={<Icon path="mdi-clipboard-text" size={0.9} />}
      count={templateBindings.length}
      defaultExpanded={templateBindings.length === 0}
      className="nt-templates"
    >
      {templateBindings.length === 0 ? (
        <span className="nt-templates-empty">No templates bound.</span>
      ) : (
        <ul className="nt-template-cards">
          {templateBindings.map(({ node, idx }) => {
            const label = displayNameForSettings(node) ?? node.id;
            return (
              <li key={`${node.id}:${idx}`} className="nt-template-card">
                <button
                  type="button"
                  className="nt-template-card-open"
                  onClick={() => onOpenPage?.(node.id)}
                >
                  <Icon path={client.effectiveClassIcon(node.id)} size={0.9} />
                  <span className="nt-template-card-name">{label}</span>
                </button>
                <button
                  type="button"
                  className="nt-template-card-unbind"
                  aria-label={`Unbind template ${label}`}
                  onClick={() =>
                    void client.unsetProperty(
                      classId,
                      SYSTEM_PROPERTY_UUIDS.hasTemplate,
                      idx,
                    )
                  }
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {/*
        The bind affordance renders even when empty (a class without
        templates still offers the gesture).
      */}
      <AddPill
        label="Bind template"
        aria-expanded={pickerOpen}
        onClick={(element) => {
          setPickerAnchor(element);
          setPickerOpen(true);
          void ensureTemplateFamily(client);
        }}
      />
      {pickerOpen && pickerAnchor !== null && (
        <NodeSelector
          client={client}
          anchorEl={pickerAnchor}
          searchMode="pages"
          classFilters={[SYSTEM_CLASS_UUIDS.template]}
          nodes={templateBindings.map((binding) => binding.node)}
          excludeNodeId={classId}
          searchPlaceholder="Search templates…"
          onClose={() => setPickerOpen(false)}
          onAdd={(node) => {
            setPickerOpen(false);
            void bindTemplate(node.id);
          }}
        />
      )}
    </NodeViewSection>
  );
}
