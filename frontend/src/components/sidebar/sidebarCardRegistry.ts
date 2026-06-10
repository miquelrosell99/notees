/**
 * Sidebar Card Registry
 *
 * Declarative registry for sidebar card types.
 * Each card type self-registers its component, eliminating the central
 * switch statement in RightSidebarCards.tsx.
 */

import type { ComponentType } from 'react';
import type { SidebarCard, SidebarCardType } from '@/stores';

export interface SidebarCardRenderer {
  type: SidebarCardType;
  component: ComponentType<{ card: SidebarCard; onClose: () => void }>;
}

const registry = new Map<SidebarCardType, SidebarCardRenderer>();

export function registerSidebarCard(renderer: SidebarCardRenderer): void {
  if (registry.has(renderer.type)) {
    console.warn(`SidebarCardRenderer for type "${renderer.type}" is being overwritten.`);
  }
  registry.set(renderer.type, renderer);
}

export function getSidebarCardRenderer(type: SidebarCardType): SidebarCardRenderer | undefined {
  return registry.get(type);
}
