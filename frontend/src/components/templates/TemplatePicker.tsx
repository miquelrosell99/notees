/**
 * TemplatePicker — Node picker for selecting a template to instantiate.
 *
 * Uses NodeSelector filtered to the template class. When the user selects
 * a template, it fetches {{variable}} placeholders. If any exist it opens
 * TemplateVariableModal; otherwise it instantiates immediately and injects
 * the resulting blocks into the runtime.
 */
import { useState, useMemo, type JSX } from 'react';
import { Modal } from '../core/Modal';
import { NodeSelector } from '../nodes/NodeSelector';
import { useClasses } from '@/hooks';
import { useInstantiateTemplate } from '@/hooks/useTemplates';
import { TemplateVariableModal } from './TemplateVariableModal';
import { apiNodesToGraphNodes } from '@/hooks/useRuntimeSync';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { SYSTEM_CLASS_UUIDS } from '@/constants';
import type { Node } from '@/types';

export interface TemplatePickerProps {
  isOpen: boolean;
  onClose: () => void;
  /** The page node that owns the inserted blocks (parent_id for as_blocks mode). */
  pageNodeId: number;
  /** UUID of the page node — needed to properly link new blocks in the runtime. */
  pageUuid: string;
  /** Called after successful instantiation. */
  onSuccess?: (result: { node: Node | null; blocks: Node[] }) => void;
}

export function TemplatePicker({
  isOpen,
  onClose,
  pageNodeId,
  pageUuid,
  onSuccess,
}: TemplatePickerProps): JSX.Element {
  const [selectedTemplateId, setSelectedTemplateId] = useState<number | null>(null);
  const [variableModalOpen, setVariableModalOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: allClasses = [] } = useClasses();
  const instantiate = useInstantiateTemplate();

  const templateClassId = useMemo(
    () => allClasses.find(c => c.uuid === SYSTEM_CLASS_UUIDS.template)?.id ?? null,
    [allClasses],
  );

  const classFilters = useMemo(
    () => (templateClassId != null ? [templateClassId] : []),
    [templateClassId],
  );

  const handleSelect = async (template: Node) => {
    setError(null);
    setSelectedTemplateId(template.id);
    try {
      const { getTemplateVariables } = await import('@/api/nodes');
      const res = await getTemplateVariables(template.id);
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
        options: { parent_id: pageNodeId, as_blocks: true, variables },
      });
      // Inject the new blocks directly into the runtime so they appear immediately
      if (result.blocks.length > 0) {
        const runtime = getNodeGraphRuntime();
        const { graphNodes } = apiNodesToGraphNodes(result.blocks, pageNodeId, pageUuid);
        runtime.upsertNodes(graphNodes);
      }
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
    setSelectedTemplateId(null);
    setVariableModalOpen(false);
    setError(null);
    onClose();
  };

  return (
    <>
      <Modal
        isOpen={isOpen && !variableModalOpen}
        onClose={handleClose}
        title="Insert Template"
        size="sm"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {classFilters.length > 0 ? (
            <NodeSelector
              trigger="inline"
              searchMode="pages"
              classFilters={classFilters}
              multi={false}
              searchPlaceholder="Search templates…"
              onAdd={handleSelect}
            />
          ) : (
            <p style={{ margin: 0, color: 'var(--text-secondary)' }}>Loading…</p>
          )}
          {error && (
            <p style={{ margin: 0, color: 'var(--color-error, red)', fontSize: '0.85rem' }}>
              {error}
            </p>
          )}
        </div>
      </Modal>

      {variableModalOpen && selectedTemplateId != null && (
        <TemplateVariableModal
          isOpen={variableModalOpen}
          onClose={handleClose}
          templateId={selectedTemplateId}
          templateName=""
          onConfirm={handleVariableConfirm}
        />
      )}
    </>
  );
}
