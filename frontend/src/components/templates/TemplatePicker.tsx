/**
 * TemplatePicker — Modal for selecting a template to instantiate.
 *
 * Shows a searchable list of all workspace templates. When the user selects
 * one, it fetches the template's {{variable}} placeholders. If any exist it
 * opens TemplateVariableModal; otherwise it calls onInstantiate immediately.
 */
import { useState, useMemo, type JSX } from 'react';
import { Modal } from '../core/Modal';
import { Button } from '../core/Button';
import { SearchField } from '../core/SearchField';
import { useTemplates, useTemplateVariables, useInstantiateTemplate } from '@/hooks/useTemplates';
import { TemplateVariableModal } from './TemplateVariableModal';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import type { Node } from '@/types';

export interface TemplatePickerProps {
  isOpen: boolean;
  onClose: () => void;
  /** The page node that owns the inserted blocks (parent_id for as_blocks mode). */
  pageNodeId: number;
  /** Called after successful instantiation. Passes the new root node when as_blocks=false. */
  onSuccess?: (result: { node: Node | null; blocks: Node[] }) => void;
}

export function TemplatePicker({
  isOpen,
  onClose,
  pageNodeId,
  onSuccess,
}: TemplatePickerProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [selectedTemplateId, setSelectedTemplateId] = useState<number | null>(null);
  const [variableModalOpen, setVariableModalOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: templatesData, isLoading } = useTemplates();
  const { data: variablesData } = useTemplateVariables(
    variableModalOpen ? null : selectedTemplateId,
  );
  const instantiate = useInstantiateTemplate();

  const templates = templatesData?.templates ?? [];

  const filtered = useMemo(() => {
    if (!query.trim()) return templates;
    const lower = query.toLowerCase();
    return templates.filter(t => {
      const name = nodeNameToText(t.name || '').toLowerCase();
      return name.includes(lower);
    });
  }, [templates, query]);

  const handleSelect = async (template: Node) => {
    setError(null);
    setSelectedTemplateId(template.id);
    // Fetch variables (the useTemplateVariables hook will re-run via the id change)
    // We do a direct fetch here to avoid waiting for the query to update
    try {
      const res = await import('@/api/nodes').then(m =>
        m.getTemplateVariables(template.id),
      );
      if (res.variables.length > 0) {
        setVariableModalOpen(true);
      } else {
        await doInstantiate(template.id, {});
      }
    } catch (e: unknown) {
      setError((e as { message?: string })?.message ?? 'Failed to load template variables');
    }
  };

  const doInstantiate = async (templateId: number, variables: Record<string, string>) => {
    try {
      const result = await instantiate.mutateAsync({
        nodeId: templateId,
        options: {
          parent_id: pageNodeId,
          as_blocks: true,
          variables,
        },
      });
      onSuccess?.(result);
      onClose();
    } catch (e: unknown) {
      setError((e as { message?: string })?.message ?? 'Failed to instantiate template');
    }
  };

  const handleVariableConfirm = async (variables: Record<string, string>) => {
    setVariableModalOpen(false);
    if (selectedTemplateId != null) {
      await doInstantiate(selectedTemplateId, variables);
    }
  };

  const handleClose = () => {
    setQuery('');
    setSelectedTemplateId(null);
    setVariableModalOpen(false);
    setError(null);
    onClose();
  };

  const selectedTemplate = selectedTemplateId != null
    ? templates.find(t => t.id === selectedTemplateId) ?? null
    : null;

  return (
    <>
      <Modal
        isOpen={isOpen && !variableModalOpen}
        onClose={handleClose}
        title="Insert Template"
        size="sm"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder="Search templates…"
            autoFocus
          />

          {isLoading && <p style={{ margin: 0, color: 'var(--text-secondary)' }}>Loading…</p>}

          {!isLoading && filtered.length === 0 && (
            <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
              {templates.length === 0 ? 'No templates found. Add the Template class to a page to create one.' : 'No templates match your search.'}
            </p>
          )}

          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            {filtered.map(template => (
              <li key={template.id}>
                <button
                  onClick={() => handleSelect(template)}
                  disabled={instantiate.isPending}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    background: 'none',
                    border: '1px solid transparent',
                    borderRadius: '6px',
                    padding: '0.5rem 0.75rem',
                    cursor: 'pointer',
                    color: 'var(--text-primary)',
                    fontSize: '0.9rem',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                >
                  {template.icon && <span style={{ marginRight: '0.5rem' }}>{template.icon}</span>}
                  {nodeNameToText(template.name || '') || 'Untitled'}
                </button>
              </li>
            ))}
          </ul>

          {error && <p style={{ margin: 0, color: 'var(--color-error)' }}>{error}</p>}
        </div>
      </Modal>

      {variableModalOpen && selectedTemplate != null && (
        <TemplateVariableModal
          isOpen={variableModalOpen}
          onClose={() => setVariableModalOpen(false)}
          templateId={selectedTemplate.id}
          templateName={nodeNameToText(selectedTemplate.name || '') || 'Untitled'}
          onConfirm={handleVariableConfirm}
        />
      )}
    </>
  );
}
