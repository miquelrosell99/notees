/**
 * NewTabButton — "+" button that opens a NodeSelector to pick a node for a new tab.
 */
import { useState, useRef, useCallback } from 'react';
import { Button } from '@/components/core/Button';
import { NodeSelector } from '@/components/nodes/NodeSelector';
import type { Node } from '@/types';
import './NewTabButton.css';

interface NewTabButtonProps {
  onSelectNode: (node: Node) => void;
}

export function NewTabButton({ onSelectNode }: NewTabButtonProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  const handleSelect = useCallback((node: Node) => {
    onSelectNode(node);
    setOpen(false);
  }, [onSelectNode]);

  return (
    <div className="new-tab-button">
      <Button
        ref={btnRef}
        icon="mdi mdi-plus"
        variant="ghost"
        size="sm"
        className="new-tab-button__btn"
        onClick={() => setOpen((v) => !v)}
        title="New tab"
      />
      {open && btnRef.current && (
        <NodeSelector
          trigger="inline"
          anchorEl={btnRef.current}
          onClose={() => setOpen(false)}
          onAdd={handleSelect}
          searchPlaceholder="Search for a page to open..."
        />
      )}
    </div>
  );
}
