/**
 * TemplatePicker — Floating node picker for selecting a template to instantiate.
 *
 * Renders as a fixed-position popup (like SuggestionPopup / node link picker).
 * Uses NodeSelector filtered to the template class. When the user selects a
 * template, it fetches {{variable}} placeholders. If any, opens
 * TemplateVariableModal; otherwise instantiates immediately.
 */
import { useState, useMemo, useEffect, useRef, useCallback, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { NodeSelector } from '@/components/nodes/NodeSelector';
import { useClasses } from '@/hooks';
import { useInstantiateTemplate } from '@/hooks/useTemplates';
import { TemplateVariableModal } from './TemplateVariableModal';
import { apiNodesToGraphNodes } from '@/hooks/useRuntimeSync';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { SYSTEM_CLASS_UUIDS } from '@/constants';
import type { Node } from '@/types';
import '../nodes/SuggestionPopup.css';

export interface TemplatePickerProps {
  /** Cursor-relative position to anchor the popup. Null = hidden. */
  position: { top: number; left: number } | null;
  onClose: () => void;
  /** The page node that owns the inserted blocks (parent_id for as_blocks mode). */
  pageNodeId: number;
  /** UUID of the page node — needed to properly link new blocks in the runtime. */
  pageUuid: string;
  /** Called after successful instantiation. */
  onSuccess?: (result: { node: Node | null; blocks: Node[] }) => void;
}

export function TemplatePicker({
  position,
  onClose,
  pageNodeId,
  pageUuid,
  onSuccess,
}: TemplatePickerProps): JSX.Element | null {
  const containerRef = useRef<HTMLDivElement>(null);
  const [adjustedPos, setAdjustedPos] = useState(position);
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

  // Adjust position to stay within viewport
  useEffect(() => {
    if (!position || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const pad = 8;
    let { top, left } = position;
    if (left + rect.width > window.innerWidth - pad) left = window.innerWidth - rect.width - pad;
    if (left < pad) left = pad;
    if (top + rect.height > window.innerHeight - pad) {
      const above = position.top - rect.height - 24;
      top = above >= pad ? above : window.innerHeight - rect.height - pad;
    }
    if (top < pad) top = pad;
    setAdjustedPos({ top, left });
  }, [position, templateClassId]);

  // Close on click outside
  useEffect(() => {
    if (!position) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as globalThis.Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [position, onClose]);

  // Close on Escape
  useEffect(() => {
    if (!position) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [position, onClose]);

  const handleSelect = useCallback(async (template: Node) => {
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
  }, []);

  const doInstantiate = useCallback(async (templateId: number, variables: Record<string, string>) => {
    try {
      const result = await instantiate.mutateAsync({
        nodeId: templateId,
        options: { parent_id: pageNodeId, as_blocks: true, variables },
      });
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
  }, [instantiate, pageNodeId, pageUuid, onSuccess, onClose]);

  const handleVariableConfirm = useCallback(async (variables: Record<string, string>) => {
    setVariableModalOpen(false);
    if (selectedTemplateId != null) await doInstantiate(selectedTemplateId, variables);
  }, [selectedTemplateId, doInstantiate]);

  const handleClose = useCallback(() => {
    setSelectedTemplateId(null);
    setVariableModalOpen(false);
    setError(null);
    onClose();
  }, [onClose]);

  if (!position) return null;

  return (
    <>
      {!variableModalOpen && createPortal(
        <div
          ref={containerRef}
          className="suggestion-popup"
          style={{
            position: 'fixed',
            top: (adjustedPos ?? position).top,
            left: (adjustedPos ?? position).left,
            zIndex: 1000,
          }}
          onMouseDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
        >
          <div className="suggestion-popup__header">
            <span>Insert template</span>
          </div>
          <div className="suggestion-popup__list" style={{ padding: '4px 0' }}>
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
              <div className="suggestion-popup__loading">Loading…</div>
            )}
            {error && (
              <div style={{ padding: '4px 8px', color: 'var(--color-error, red)', fontSize: '0.8rem' }}>
                {error}
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}

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
