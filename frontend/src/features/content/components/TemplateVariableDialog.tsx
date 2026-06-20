import { useMemo, useState } from 'react';
import { Modal, TextField, Button } from '@/components/ui';
import {
  computeDynamicContext,
  isDynamicVariable,
  type TemplateVariableContext,
} from '../utils/templateVariables';
import './TemplateVariableDialog.css';

export interface TemplateVariableDialogProps {
  isOpen: boolean;
  templateName: string;
  variables: string[];
  dynamicVariables: string[];
  context: TemplateVariableContext;
  onCancel: () => void;
  onConfirm: (values: Record<string, string>, dynamicContext: Record<string, string>) => void;
}

export function TemplateVariableDialog({
  isOpen,
  templateName,
  variables,
  dynamicVariables,
  context,
  onCancel,
  onConfirm,
}: TemplateVariableDialogProps) {
  const [values, setValues] = useState<Record<string, string>>({});

  const computedDynamic = useMemo(
    () => computeDynamicContext(dynamicVariables, context),
    [dynamicVariables, context]
  );

  const staticVariables = useMemo(
    () => variables.filter(v => !isDynamicVariable(v)),
    [variables]
  );

  const handleConfirm = () => {
    onConfirm(values, computedDynamic);
  };

  return (
    <Modal isOpen={isOpen} onClose={onCancel} title={`Instantiate "${templateName}"`} size="md">
      <div className="template-variable-dialog__content">
        {staticVariables.length === 0 && dynamicVariables.length === 0 && (
          <p className="template-variable-dialog__empty">No variables defined in this template.</p>
        )}

        {staticVariables.length > 0 && (
          <div className="template-variable-dialog__section">
            <h4 className="template-variable-dialog__section-title">Template variables</h4>
            {staticVariables.map(variable => (
              <div key={variable} className="template-variable-dialog__field">
                <label className="template-variable-dialog__label" htmlFor={`tpl-var-${variable}`}>
                  {variable}
                </label>
                <TextField
                  id={`tpl-var-${variable}`}
                  value={values[variable] || ''}
                  onChange={(e) =>
                    setValues(prev => ({ ...prev, [variable]: e.target.value }))
                  }
                  placeholder={`Enter value for {{${variable}}}`}
                  size="sm"
                />
              </div>
            ))}
          </div>
        )}

        {dynamicVariables.length > 0 && (
          <div className="template-variable-dialog__section">
            <h4 className="template-variable-dialog__section-title">Dynamic variables</h4>
            {dynamicVariables.map(variable => (
              <div key={variable} className="template-variable-dialog__field template-variable-dialog__field--readonly">
                <span className="template-variable-dialog__label">{variable}</span>
                <span className="template-variable-dialog__value">
                  {computedDynamic[variable] ?? `<${variable}>`}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="template-variable-dialog__actions">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={handleConfirm}>
            Create
          </Button>
        </div>
      </div>
    </Modal>
  );
}
