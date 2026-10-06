/**
 * TemplateVariableDialog — apply-time variable editor (editable
 * static rows + readonly computed dynamic rows).
 * Shown at instantiation whenever the template carries `{{variables}}`;
 * every extracted name gets exactly one row, so an unfilled static variable
 * substitutes empty deliberately (never the silent-empty hole).
 */

import { useEffect, useState } from "react";

import { deriveDisplayName } from "@notees/domain";

import type { ClientNode } from "@/core/workspace-client.js";

import { Button } from "../components/ui/Button.js";
import { Modal } from "../components/ui/Modal.js";
import { TextField } from "../components/ui/TextField.js";
import "./TemplateVariableDialog.css";

export interface TemplateVariableDialogProps {
  isOpen: boolean;
  /** The template being instantiated (name + its extracted variable names). */
  template: ClientNode;
  /** All `{{names}}` found in the template subtree, first-seen order. */
  variableNames: readonly string[];
  /** Dynamic values computed at apply time, displayed readonly. */
  dynamicValues: Readonly<Record<string, string>>;
  onCancel: () => void;
  /** Called with the final value map (static inputs merged over dynamic). */
  onConfirm: (values: Record<string, string>) => void;
}

export function TemplateVariableDialog({
  isOpen,
  template,
  variableNames,
  dynamicValues,
  onCancel,
  onConfirm,
}: TemplateVariableDialogProps) {
  const [staticValues, setStaticValues] = useState<Record<string, string>>({});

  // Fresh inputs per open (the template — and so its names — can change
  // between invocations).
  useEffect(() => {
    if (isOpen) setStaticValues({});
  }, [isOpen, template.id]);

  const templateName = deriveDisplayName(template) || "Untitled template";
  const staticNames = variableNames.filter((name) => !Object.prototype.hasOwnProperty.call(dynamicValues, name));
  const dynamicNames = variableNames.filter((name) =>
    Object.prototype.hasOwnProperty.call(dynamicValues, name),
  );

  /**
   * Every extracted name lands in the map — untouched static inputs
   * substitute empty deliberately (the dialog presented the row; empty is a
   * choice, never the silent hole).
   */
  const confirm = () => {
    const values: Record<string, string> = { ...dynamicValues };
    for (const name of staticNames) values[name] = staticValues[name] ?? "";
    onConfirm(values);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title={`Use "${templateName}"`}
      size="sm"
      footer={
        <div className="template-variable-dialog__footer">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={confirm}>
            Create
          </Button>
        </div>
      }
    >
      <div className="template-variable-dialog__content">
        <p className="template-variable-dialog__description">
          This template uses variables. Values are filled into the{" "}
          <code className="template-variable-dialog__code">{"{{name}}"}</code> placeholders.
        </p>
        {staticNames.length === 0 && dynamicNames.length === 0 && (
          <p className="template-variable-dialog__empty">No variables defined in this template.</p>
        )}
        {staticNames.length > 0 && (
          <div className="template-variable-dialog__section">
            <h4 className="template-variable-dialog__section-title">Template variables</h4>
            {staticNames.map((name) => (
              <TextField
                key={name}
                label={name}
                value={staticValues[name] ?? ""}
                onChange={(event) =>
                  setStaticValues((prev) => ({ ...prev, [name]: event.target.value }))
                }
                placeholder={`Value for {{${name}}}`}
                size="sm"
              />
            ))}
          </div>
        )}
        {dynamicNames.length > 0 && (
          <div className="template-variable-dialog__section">
            <h4 className="template-variable-dialog__section-title">Dynamic variables</h4>
            {dynamicNames.map((name) => (
              <div key={name} className="template-variable-dialog__dynamic-row">
                <span className="template-variable-dialog__dynamic-name">{name}</span>
                <span className="template-variable-dialog__dynamic-value">
                  {dynamicValues[name] ?? ""}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
