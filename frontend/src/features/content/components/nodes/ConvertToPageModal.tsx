import { useState, useCallback } from 'react';
import { Modal } from '@/components/ui/Modal';
import { TextField } from '@/components/ui/TextField';
import { Button } from '@/components/ui/Button';
import { useConvertToPage } from '@/features/content/hooks/useConvertNode';
import { nodeNameToText } from '@/features/queries';
import type { Node } from '@/types/api';
import './ConvertToPageModal.css';

interface ConvertToPageModalProps {
  node: Node;
  isOpen: boolean;
  onClose: () => void;
}

export function ConvertToPageModal({ node, isOpen, onClose }: ConvertToPageModalProps) {
  const [name, setName] = useState(nodeNameToText(node.name));
  const [error, setError] = useState<string | null>(null);
  const convert = useConvertToPage();

  const handleClose = useCallback(() => {
    setError(null);
    onClose();
  }, [onClose]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);

      const trimmed = name.trim();
      const newName = trimmed === nodeNameToText(node.name) ? undefined : trimmed;

      try {
        await convert.mutateAsync({ nodeId: node.id, name: newName, oldParentId: node.parent_id });
        handleClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Conversion failed');
      }
    },
    [convert, name, node, handleClose]
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Convert to page"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={handleClose} disabled={convert.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={convert.isPending || !name.trim()}
            loading={convert.isPending}
          >
            Convert
          </Button>
        </>
      }
    >
      <form id="convert-to-page-form" onSubmit={handleSubmit}>
        <TextField
          label="Page name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Page name"
          autoFocus
          error={!!error}
          errorMessage={error ?? undefined}
        />
      </form>
    </Modal>
  );
}
