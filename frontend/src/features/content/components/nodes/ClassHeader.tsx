/**
 * ClassHeader — header for the class detail view.
 *
 * Thin adapter over the shared PageHeader so the class view has the same header
 * UI as the page view. Class-specific behavior is injected via PageHeader's
 * extension props: persistence goes to the dedicated `class` table through the
 * workspace store client (classes are not rows in the `node` table), the fallback
 * icon is a tag, the name is required, and the "+class" title popup is disabled.
 *
 * Pages encode the icon color inside the icon field; the class table keeps icon
 * and color in separate columns. The adapter therefore encodes icon+color into
 * the `page.icon` field handed to PageHeader (so the picker shows/preserves the
 * current color) and splits the field back into columns on save.
 */
import { useCallback, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { PageHeader } from './PageHeader';
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';
import { nodeNameToText } from '@/features/queries';
import { formatIconField, parseIconField } from '@/utils/iconDom';
import type { Node } from '@/types/api';

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

  // Hand PageHeader a node whose icon field carries the class color in the
  // page-style encoded form, so icon display, picker state, and color
  // preservation behave exactly like pages.
  const pageForHeader = useMemo(() => {
    const { icon, color } = parseIconField(node.icon ?? '');
    const effectiveColor = color ?? node.color ?? null;
    const encodedIcon = icon || effectiveColor ? formatIconField(icon, effectiveColor) : null;
    return { ...node, icon: encodedIcon };
  }, [node]);

  const handleNameChange = useCallback(
    (name: string) => {
      const newName = name.trim();
      const currentName = nodeNameToText(node.name) || '';
      if (!client || !newName || newName === currentName) return;
      void client.mutate<void>('updateClass', [{ classId: node.uuid, name: newName }]);
    },
    [client, node.uuid, node.name]
  );

  // Split PageHeader's color-encoded icon field back into the class table's
  // separate icon and color columns.
  const handleIconChange = useCallback(
    (encoded: string) => {
      if (!client) return;
      const { icon, color } = parseIconField(encoded);
      void client.mutate<void>('updateClass', [
        { classId: node.uuid, icon: icon || null, color: color ?? null },
      ]);
    },
    [client, node.uuid]
  );

  return (
    <PageHeader
      page={pageForHeader}
      embedded
      focusMode={focusMode}
      className={className}
      onNameChange={handleNameChange}
      onIconChange={handleIconChange}
      defaultIcon="mdi-tag"
      requireName
      enableClassSuggestions={false}
    />
  );
}
