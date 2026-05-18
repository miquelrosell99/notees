/**
 * TemplateVariableModal — Form for filling in {{variable}} placeholders.
 *
 * Shows one labelled text input per variable found in the template's content.
 * Calls onConfirm with the filled-in values when the user submits the form.
 */
import { useState, useEffect, type JSX, type FormEvent } from 'react';
import { Modal } from '@/components/core/Modal';
import { Button } from '@/components/core/Button';
import { useTemplateVariables } from '@/hooks/useTemplates';

export interface TemplateVariableModalProps {
  isOpen: boolean;
  onClose: () => void;
  templateId: number;
  templateName: string;
  onConfirm: (variables: Record<string, string>) => void | Promise<void>;
}

export function TemplateVariableModal({
  isOpen,
  onClose,
  templateId,
  templateName,
  onConfirm,
}: TemplateVariableModalProps): JSX.Element {
  const { data, isLoading } = useTemplateVariables(isOpen ? templateId : null);
  const variables = data?.variables ?? [];

  const [values, setValues] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Reset values when the modal opens or variable list changes
  useEffect(() => {
    if (isOpen) {
      setValues({});
    }
  }, [isOpen, templateId]);

  const handleChange = (varName: string, value: string) => {
    setValues(prev => ({ ...prev, [varName]: value }));
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      await onConfirm(values);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Fill in variables — ${templateName}`}
      size="sm"
      footer={
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose} disabled={isSubmitting}>Cancel</Button>
          <Button variant="primary" type="submit" form="template-variable-form" disabled={isLoading || isSubmitting}>
            {isSubmitting ? 'Inserting…' : 'Insert'}
          </Button>
        </div>
      }
    >
      {isLoading ? (
        <p style={{ margin: 0, color: 'var(--text-secondary)' }}>Loading variables…</p>
      ) : variables.length === 0 ? (
        <p style={{ margin: 0, color: 'var(--text-secondary)' }}>No variables found in this template.</p>
      ) : (
        <form
          id="template-variable-form"
          onSubmit={handleSubmit}
          style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
        >
          {variables.map(varName => (
            <label key={varName} style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.9rem' }}>
              <span style={{ fontWeight: 500 }}>{varName}</span>
              <input
                type="text"
                value={values[varName] ?? ''}
                onChange={e => handleChange(varName, e.target.value)}
                placeholder={`Value for {{${varName}}}`}
                autoFocus={varName === variables[0]}
                style={{
                  padding: '0.4rem 0.6rem',
                  borderRadius: '4px',
                  border: '1px solid var(--border-color)',
                  background: 'var(--bg-input)',
                  color: 'var(--text-primary)',
                  fontSize: '0.9rem',
                }}
              />
            </label>
          ))}
        </form>
      )}
    </Modal>
  );
}
