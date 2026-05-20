/**
 * MergePagesModal - Merge two pages into one
 *
 * Lets the user pick a source and a target page, then merges them:
 * all blocks from source are appended to target, backlinks are redirected,
 * and the source page is soft-deleted.
 */
import { useState, useCallback, useEffect } from 'react';
import { Modal } from '@/components/core/Modal';
import { Button } from '@/components/core/Button';
import { NodeSelector } from '@/components/nodes/NodeSelector';
import { mergePages } from '@/api/nodes';
import { useQueryClient } from '@tanstack/react-query';
import { nodeKeys } from '@/hooks/queryKeys';
import { useNavigationStore } from '@/stores';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { useNode } from '@/hooks';
import type { Node } from '@/types';
import './MergePagesModal.css';

export interface MergePagesModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function MergePagesModal({ isOpen, onClose }: MergePagesModalProps) {
  const { currentNodeId, openNode } = useNavigationStore();
  const { data: currentNode } = useNode(currentNodeId);
  const queryClient = useQueryClient();

  const [sourceNode, setSourceNode] = useState<Node | null>(null);
  const [targetNode, setTargetNode] = useState<Node | null>(null);
  const [isMerging, setIsMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // When the modal opens, pre-select the currently open page as source
  useEffect(() => {
    if (isOpen) {
      setError(null);
      setIsMerging(false);
      setTargetNode(null);
      setSourceNode(currentNode?.is_page ? currentNode : null);
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleClose = useCallback(() => {
    setError(null);
    onClose();
  }, [onClose]);

  const handleProceed = useCallback(async () => {
    if (!sourceNode || !targetNode) return;
    setIsMerging(true);
    setError(null);
    try {
      await mergePages(sourceNode.id, targetNode.id);
      // Invalidate all node queries: the merge updates content in any node that
      // linked to the source (link redirections), so we can't predict which
      // specific caches are stale.
      queryClient.invalidateQueries({ queryKey: nodeKeys.all });
      openNode(targetNode.id);
      handleClose();
    } catch (e: unknown) {
      const msg =
        (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
        (e instanceof Error ? e.message : 'Merge failed');
      setError(msg);
    } finally {
      setIsMerging(false);
    }
  }, [sourceNode, targetNode, queryClient, openNode, handleClose]);

  const isSameNode =
    sourceNode !== null &&
    targetNode !== null &&
    (sourceNode.id === targetNode.id || (sourceNode.uuid && targetNode.uuid && sourceNode.uuid === targetNode.uuid));

  const canProceed =
    sourceNode !== null &&
    targetNode !== null &&
    !isSameNode &&
    !isMerging;

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Merge Pages"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={handleClose} disabled={isMerging}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={"mdi mdi-merge"}
            onClick={handleProceed}
            disabled={!canProceed}
            confirm
            confirmMessage={
              sourceNode && targetNode
                ? `This will move all blocks from "${nodeNameToText(sourceNode.name) || 'source'}" into "${nodeNameToText(targetNode.name) || 'target'}" and delete the source. This cannot be easily undone.`
                : 'Are you sure you want to merge these pages?'
            }
          >
            {isMerging ? 'Merging…' : 'Proceed'}
          </Button>
        </>
      }
    >
      <div className="merge-pages__body">
        <p className="merge-pages__description">
          All blocks from the <strong>source</strong> page will be appended to the{' '}
          <strong>target</strong> page. Any links pointing to the source will be redirected to
          the target. The source page will be moved to trash.
        </p>

        {error && (
          <div className="merge-pages__error">
            <strong>Error:</strong> {error}
          </div>
        )}

        <div className="merge-pages__field">
          <label className="merge-pages__label">Source page (will be deleted)</label>
          <NodeSelector
            trigger="select"
            value={sourceNode?.id ?? null}
            searchMode="pages"
            placeholder="Select source page…"
            searchPlaceholder="Search pages…"
            excludeNodeId={targetNode?.id}
            onAdd={(node: Node) => setSourceNode(node)}
            onClearAll={() => setSourceNode(null)}
          />
        </div>

        <div className="merge-pages__field">
          <label className="merge-pages__label">Target page (merge destination)</label>
          <NodeSelector
            trigger="select"
            value={targetNode?.id ?? null}
            searchMode="pages"
            placeholder="Select target page…"
            searchPlaceholder="Search pages…"
            excludeNodeId={sourceNode?.id}
            onAdd={(node: Node) => setTargetNode(node)}
            onClearAll={() => setTargetNode(null)}
          />
        </div>

        {isSameNode && (
          <p className="merge-pages__warning">Source and target must be different pages.</p>
        )}
      </div>
    </Modal>
  );
}
