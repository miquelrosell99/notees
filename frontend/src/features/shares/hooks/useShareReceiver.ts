/**
 * Hook that detects shared content from the PWA share_target.
 * When ?shared=true is in the URL, creates a block in the Scratchpad and opens it.
 */
import { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useModalStore } from '@/stores';
import { useNodeByUuid } from '@/features/content';
import { SYSTEM_PAGE_UUIDS } from '@/constants/systemProperties';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useUndoManager } from '@/core/hooks/useUndoManager';

export function useShareReceiver() {
  const navigate = useNavigate();
  const location = useLocation();
  const workspaceUuid = useCurrentWorkspaceUuid();
  const manager = useUndoManager(workspaceUuid ?? '');
  const { data: scratchpadPage } = useNodeByUuid(
    SYSTEM_PAGE_UUIDS.scratchpad,
    { include_children: true }
  );

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('shared') !== 'true') return;
    if (!scratchpadPage || !manager) return;

    const text = params.get('text') || '';
    const title = params.get('title') || '';
    const url = params.get('url') || '';

    // Build the content to pre-fill
    const parts: string[] = [];
    if (title) parts.push(title);
    if (url) parts.push(url);
    if (text && text !== url) parts.push(text);
    const content = parts.join('\n');

    if (content) {
      // Create a block in the Scratchpad with the shared content
      const nodeId = crypto.randomUUID();
      manager.createBlock({ nodeId, kind: 'block', parentId: scratchpadPage.uuid, content });
      useModalStore.getState().setScratchpadOpen(true);
    }

    // Clean up the URL without reloading
    navigate(location.pathname, { replace: true });
  }, [scratchpadPage, manager, location, navigate]);
}
