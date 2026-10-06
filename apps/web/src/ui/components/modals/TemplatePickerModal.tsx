/**
 * TemplatePickerModal — create-with-template picker. Offered by a
 * classed create flow when the picked class has bound templates (SCHEMA.md
 * "Templates"): a blank entry plus one row per template, presented as kit
 * outline buttons (the quick-create chips' idiom). Picking a row confirms
 * immediately — the caller creates the object and instantiates the template
 * through the clone engine.
 */

import { deriveDisplayName } from "@notees/domain";

import type { ClientNode } from "@/core/workspace-client.js";

import { Button } from "../ui/Button.js";
import { Modal } from "../ui/Modal.js";
import "./TemplatePickerModal.css";

export interface TemplatePickerModalProps {
  /** Whether the modal is open. */
  isOpen: boolean;
  /** Callback to close the modal. */
  onClose: () => void;
  /** The picked class's display name — titles the modal and the blank row. */
  classLabel: string;
  /** The class's bound templates (listClassTemplates), in binding order. */
  templates: readonly ClientNode[];
  /** Called with null for a blank create, or the picked template's node id. */
  onPick: (templateId: string | null) => void;
}

export function TemplatePickerModal({
  isOpen,
  onClose,
  classLabel,
  templates,
  onPick,
}: TemplatePickerModalProps) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`New ${classLabel}`} size="sm">
      <div className="template-picker-modal">
        <p className="template-picker-modal__description">
          Start blank, or instantiate a template — its content, structure, and
          properties copy onto the new {classLabel}.
        </p>
        <div className="template-picker-modal__options" role="group" aria-label="Template options">
          <Button
            variant="outline"
            className="template-picker-modal__option"
            onClick={() => onPick(null)}
          >
            Blank {classLabel}
          </Button>
          {templates.map((template) => (
            <Button
              key={template.id}
              variant="outline"
              className="template-picker-modal__option"
              onClick={() => onPick(template.id)}
            >
              {deriveDisplayName(template) || "Untitled template"}
            </Button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
