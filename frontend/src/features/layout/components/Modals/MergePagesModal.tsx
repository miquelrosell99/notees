/**
 * MergePagesModal - Merge two pages into one
 *
 * Lets the user pick a source and a target page, then merges them:
 * all blocks from source are appended to target, backlinks are redirected,
 * and the source page is soft-deleted.
 */
import { useState, useCallback, useEffect } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { ConfirmationModal } from '@/components/ui/ConfirmationModal';
import { NodeSelector, nodeViewKeys } from '@/features/content';
import { mergePages } from '@/api/nodes';
import { useQueryClient } from '@tanstack/react-query';
import { nodeKeys } from '@/hooks/queryKeys';
import { useCurrentNodeUuid, useOpenNode } from '@/features/layout';
import { nodeNameToText } from '@/features/queries';
import { useNode } from '@/features/content';
import type { Node } from '@/types';
import './MergePagesModal.css';

export interface MergePagesModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function MergePagesModal({ isOpen, onClose }: MergePagesModalProps) {
  const currentNodeUuid = useCurrentNodeUuid();
  const openNode = useOpenNode();
  const { data: currentNode } = useNode(currentNodeUuid);
  const queryClient = useQueryClient();

  const [sourceNode, setSourceNode] = useState<Node | null>(null);
  const [targetNode, setTargetNode] = useState<Node | null>(null);
  const [isMerging, setIsMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);

  // When the modal opens, pre-select the currently open page as source
  useEffect(() => {
    if (isOpen) {
      setError(null);
        setIsMerging(false);
        setTargetNode(null);
        setSourceNode(currentNode?.is_page ? currentNode : null);;
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleClose = useCallback(() => {
    setError(null);
    setShowConfirm(false);
    onClose();
  }, [onClose]);

  const handleProceed = useCallback(async () => {
    if (!sourceNode || !targetNode) return;
    setIsMerging(true);
    setError(null);
    try {
      await mergePages(sourceNode.uuid, targetNode.uuid);

      // Remove all queries for the deleted source node so they don't refetch
      // and fail with 404 when we invalidate everything else.
      queryClient.removeQueries({ queryKey: nodeKeys.detailBase(sourceNode.id) });
      queryClient.removeQueries({ queryKey: nodeKeys.metadata(sourceNode.id) });
      queryClient.removeQueries({ queryKey: nodeKeys.pageContent(sourceNode.id) });
      queryClient.removeQueries({ queryKey: nodeKeys.backlinks(sourceNode.id) });
      queryClient.removeQueries({ queryKey: nodeKeys.linkedRefs(sourceNode.id) });
      queryClient.removeQueries({ queryKey: nodeKeys.propertyBacklinks(sourceNode.id) });
      queryClient.removeQueries({ queryKey: nodeKeys.breadcrumbs(sourceNode.id) });
      queryClient.removeQueries({ queryKey: nodeKeys.childrenOnly(sourceNode.id) });
      queryClient.removeQueries({ queryKey: nodeKeys.aliases(sourceNode.id) });
      if (sourceNode.uuid) {
        queryClient.removeQueries({ queryKey: nodeKeys.byUuid(sourceNode.uuid) });
      }

      // Switch to the target page before invalidating so the old view
      // unmounts and doesn't try to refetch the deleted source.
      openNode(targetNode.uuid);

      // Invalidate general queries that may reference the source or target.
      queryClient.invalidateQueries({ queryKey: nodeKeys.pages() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.allBacklinks() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.allLinkedRefs() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pageContents() });
      queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.pseudoNodeQuery() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.inlineQuery() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.graph() });

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

  const handleAskConfirm = useCallback(() => {
    setShowConfirm(true);
  }, []);

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
    <>
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
            onClick={handleAskConfirm}
            disabled={!canProceed}
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
          <label htmlFor="merge-source" className="merge-pages__label">
            Source page (will be deleted)
          </label>
          <NodeSelector
            id="merge-source"
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
          <label htmlFor="merge-target" className="merge-pages__label">
            Target page (merge destination)
          </label>
          <NodeSelector
            id="merge-target"
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

    <ConfirmationModal
      isOpen={showConfirm}
      title="Confirm Merge"
      message={
        sourceNode && targetNode
          ? `This will move all blocks from "${nodeNameToText(sourceNode.name) || 'source'}" into "${nodeNameToText(targetNode.name) || 'target'}" and delete the source. This cannot be easily undone.`
          : 'Are you sure you want to merge these pages?'
      }
      onConfirm={handleProceed}
      onCancel={() => setShowConfirm(false)}
      variant="danger"
    />
    </>
  );
}
