/**
 * Hook that detects shared content from Android share intent or PWA share_target.
 * When ?shared=true is in the URL, creates a block in the Scratchpad and opens it.
 */
import { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { createNode } from '@/api/nodes';
import { useModalStore } from '@/stores';
import { useNodeByUuid } from '@/features/content';
import { SYSTEM_PAGE_UUIDS } from '@/constants/systemProperties';

export function useShareReceiver() {
  const navigate = useNavigate();
  const location = useLocation();
  const { data: scratchpadPage } = useNodeByUuid(
    SYSTEM_PAGE_UUIDS.scratchpad,
    { include_children: true }
  );

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('shared') !== 'true') return;
    if (!scratchpadPage) return;

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
      createNode({ name: content, parent_id: scratchpadPage.id }).then(() => {
        useModalStore.getState().setScratchpadOpen(true);
      });
    }

    // Clean up the URL without reloading
    navigate(location.pathname, { replace: true });
  }, [scratchpadPage, location, navigate]);
}
