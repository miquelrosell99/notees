/**
 * Sidebar Card Registration
 *
 * Eagerly imports and registers all sidebar card renderers.
 */

import { registerSidebarCard } from './sidebarCardRegistry';
import { SidebarCardLocalGraph } from './SidebarCardLocalGraph';
import { SidebarCardNode } from './SidebarCardNode';
import type { SidebarCard } from '@/stores';

registerSidebarCard({
  type: 'localGraph',
  component: function LocalGraphCard({ card, onClose }: { card: SidebarCard; onClose: () => void }) {
    return <SidebarCardLocalGraph nodeUuid={card.nodeUuid} onClose={onClose} />;
  },
});

registerSidebarCard({
  type: 'page',
  component: function PageCard({ card, onClose }: { card: SidebarCard; onClose: () => void }) {
    return <SidebarCardNode nodeUuid={card.nodeUuid} cardType="page" onClose={onClose} />;
  },
});

registerSidebarCard({
  type: 'block',
  component: function BlockCard({ card, onClose }: { card: SidebarCard; onClose: () => void }) {
    return <SidebarCardNode nodeUuid={card.nodeUuid} cardType="block" onClose={onClose} />;
  },
});
