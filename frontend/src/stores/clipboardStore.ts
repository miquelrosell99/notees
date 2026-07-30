/**
 * Clipboard Store
 *
 * In-memory tracking of the last copy operation performed within Notees.
 * This supplements the system clipboard by providing context about HOW
 * the copy was performed, so paste can choose the right mode:
 *
 * - 'blocks': Ctrl+C on one or more selected blocks (or "Copy" context menu).
 *             Carries structured BlockCopyData (AST + children + metadata).
 * - 'link':   Ctrl+C in edit mode with no text selected.
 *             System clipboard has the formal UUID/link_id. No block data stored here.
 *
 * The system clipboard always contains a serialised copy of the data
 * (JSON for blocks, UUID/link_id for links) so that cross-app paste still
 * works. This store exists only to avoid an async clipboard.readText()
 * round-trip in the hot paste path.
 */
import { create } from 'zustand';
import type { BlockCopyData } from '@/utils/clipboardManager';

/** How the last copy was performed */
export type ClipboardMode = 'blocks' | 'link' | null;

interface ClipboardState {
  /** Structured block data from the most recent block-copy operation */
  copiedBlocks: BlockCopyData | null;
  /** Mode of the most recent copy */
  mode: ClipboardMode;

  /** Record a block-copy. Stores block data AND sets mode = 'blocks'. */
  setCopied: (data: BlockCopyData) => void;
  /** Record a link-copy. No block data to store; mode = 'link'. */
  setLinkMode: () => void;
  /** Reset clipboard state (e.g. after a cut operation completes). */
  clear: () => void;
}

export const useClipboardStore = create<ClipboardState>((set) => ({
  copiedBlocks: null,
  mode: null,

  setCopied: (data) => set({ copiedBlocks: data, mode: 'blocks' }),
  setLinkMode: () => set({ copiedBlocks: null, mode: 'link' }),
  clear: () => set({ copiedBlocks: null, mode: null }),
}));
