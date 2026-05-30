/**
 * BlockAfterContent — Placeholder for post-content block chrome.
 *
 * In Phase 4 this will render:
 * - Class pills
 * - Task badges
 * - Backlink count
 * - Query toolbar
 * - Property rows
 * - Asset / table / code previews
 *
 * For Phase 1 it's an empty shell.
 */

import type { Node } from '@/types/api';
import type { JSX } from 'react';
import './BlockAfterContent.css';

interface BlockAfterContentProps {
  node: Node;
}

export function BlockAfterContent(_props: BlockAfterContentProps): JSX.Element {
  void _props;
  return <div className="block-after-content" />;
}
