/**
 * ClassHeader — Header for the class node detail view.
 *
 * Shows the class icon, name, and color. The name and icon are editable inline;
 * changes are written directly to the dedicated `class` table via the workspace
 * store client because classes are not rows in the `node` table.
 */
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { NodeIcon } from '@/components/ui/icons';
import { EmojiPicker } from '@/components/ui/EmojiPicker';
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';
import { nodeNameToText } from '@/features/queries';
import { formatIconField } from '@/utils/iconDom';
import type { Node } from '@/types/api';
import './ClassHeader.css';

interface ClassHeaderProps {
  /** The class node being viewed. */
  node: Node;
  /** When true, fades non-essential chrome for focus mode. */
  focusMode?: boolean;
  /** Additional CSS class for the root element. */
  className?: string;
}

export function ClassHeader({ node, focusMode = false, className = '' }: ClassHeaderProps) {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { client } = useWorkspaceStoreClient(workspaceId ?? '');

  const [inputValue, setInputValue] = useState(nodeNameToText(node.name) || '');
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const iconRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setInputValue(nodeNameToText(node.name) || '');
  }, [node.name]);

  useEffect(() => {
    const textarea = titleRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  }, [inputValue]);

  const displayIcon = node.icon || 'mdi-tag';

  const handleSave = useCallback(
    async (updates: { name?: string; icon?: string }) => {
      if (!client || !workspaceId) return;
      setIsSaving(true);
      try {
        await client.mutate<void>('updateClass', [
          {
            classId: node.uuid,
            ...(updates.name !== undefined ? { name: updates.name } : {}),
            ...(updates.icon !== undefined ? { icon: updates.icon } : {}),
          },
        ]);
      } finally {
        setIsSaving(false);
      }
    },
    [client, node.uuid, workspaceId]
  );

  const handleNameChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setInputValue(e.target.value);
    },
    []
  );

  const handleNameBlur = useCallback(() => {
    const newName = inputValue.trim();
    const currentName = nodeNameToText(node.name) || '';
    if (newName && newName !== currentName) {
      void handleSave({ name: newName });
    } else if (!newName) {
      setInputValue(currentName);
    }
  }, [inputValue, node.name, handleSave]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        titleRef.current?.blur();
      }
      if (e.key === 'Escape') {
        setInputValue(nodeNameToText(node.name) || '');
        titleRef.current?.blur();
      }
    },
    [node.name]
  );

  const handleIconSelect = useCallback(
    (icon: string) => {
      void handleSave({ icon: formatIconField(icon) });
      setShowIconPicker(false);
    },
    [handleSave]
  );

  const titleSizeClass = useMemo(() => {
    const len = inputValue.length;
    if (len > 60) return 'class-header__title--compact';
    if (len > 40) return 'class-header__title--medium';
    return '';
  }, [inputValue.length]);

  return (
    <div
      className={`class-header ${className}`}
      data-focus-mode={focusMode || undefined}
    >
      <div className="class-header__row">
        <button
          ref={iconRef}
          type="button"
          className="class-header__icon-btn"
          onClick={() => setShowIconPicker(true)}
          aria-label="Change class icon"
          title="Change class icon"
        >
          <span className="class-header__icon">
            <NodeIcon icon={displayIcon} isPage={false} size="xl" />
          </span>
        </button>

        <textarea
          ref={titleRef}
          className={`class-header__title ${titleSizeClass}`}
          value={inputValue}
          onChange={handleNameChange}
          onBlur={handleNameBlur}
          onKeyDown={handleKeyDown}
          rows={1}
          aria-label="Class name"
          disabled={isSaving}
        />
      </div>

      {showIconPicker && (
        <EmojiPicker
          onSelect={handleIconSelect}
          onClose={() => setShowIconPicker(false)}
          anchorRef={iconRef}
        />
      )}
    </div>
  );
}
