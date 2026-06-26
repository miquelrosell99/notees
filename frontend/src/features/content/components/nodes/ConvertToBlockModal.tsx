import { useState, useCallback } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { NodeSelector } from '@/features/content';
import { useConvertToBlock } from '@/features/content/hooks/useConvertNode';
import type { Node } from '@/types/api';
import './ConvertToBlockModal.css';

interface ConvertToBlockModalProps {
  node: Node;
  isOpen: boolean;
  onClose: () => void;
  onConverted?: (node: Node) => void;
}

export function ConvertToBlockModal({ node, isOpen, onClose, onConverted }: ConvertToBlockModalProps) {
  const [selectedParentId, setSelectedParentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const convert = useConvertToBlock();

  const handleClose = useCallback(() => {
    setSelectedParentId(null);
    setError(null);
    onClose();
  }, [onClose]);

  const handleSubmit = useCallback(async () => {
    if (selectedParentId == null) return;
    setError(null);

    try {
      const converted = await convert.mutateAsync({
        nodeUuid: node.uuid,
        parentId: selectedParentId,
        oldParentId: node.parent_uuid,
      });
      handleClose();
      onConverted?.(converted);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Conversion failed');
    }
  }, [convert, node, selectedParentId, handleClose, onConverted]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Convert to block"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={handleClose} disabled={convert.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={convert.isPending || selectedParentId == null}
            loading={convert.isPending}
          >
            Convert
          </Button>
        </>
      }
    >
      <div className="convert-to-block-modal__selector">
        <label className="convert-to-block-modal__label" htmlFor="convert-to-block-selector">
          Destination page
        </label>
        <NodeSelector
          id="convert-to-block-selector"
          trigger="inline"
          value={selectedParentId}
          searchMode="pages"
          excludeNodeId={node.uuid}
          placeholder="Search pages…"
          onChange={(val) => {
            if (typeof val === 'string') {
              setSelectedParentId(val);
            } else {
              setSelectedParentId(null);
            }
          }}
          allowCreate={false}
        />
        {error && <p className="convert-to-block-modal__error">{error}</p>}
      </div>
    </Modal>
  );
}
