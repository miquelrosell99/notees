/**
 * Composition layer for node context menus.
 *
 * Core items (built by each menu) and contributed items (from the
 * NodeActionRegistry — core features and plugins) are tagged with a
 * `group` (menu section) and an `order` (position within the section).
 * `composeMenuItems` merges them into the canonical section order with a
 * separator between non-empty sections, so contributed actions slot into
 * the menu instead of being appended at a fixed point.
 */
import type { ContextMenuItem } from '@/components/ui/ContextMenu';
import {
  NODE_MENU_GROUP_ORDER,
  type NodeMenuGroup,
} from '@/plugins/core';

export interface ComposableMenuItem extends ContextMenuItem {
  /** Menu section; defaults to 'main'. Unknown values fall back to 'main'. */
  group?: NodeMenuGroup;
  /** Sort order within the section. Lower renders first; ties keep insertion order. */
  order?: number;
}

function normalizeGroup(group: NodeMenuGroup | undefined): NodeMenuGroup {
  return group && (NODE_MENU_GROUP_ORDER as readonly string[]).includes(group) ? group : 'main';
}

export function composeMenuItems(items: ComposableMenuItem[]): ContextMenuItem[] {
  const grouped = new Map<NodeMenuGroup, ComposableMenuItem[]>();
  for (const item of items) {
    const group = normalizeGroup(item.group);
    const list = grouped.get(group);
    if (list) {
      list.push(item);
    } else {
      grouped.set(group, [item]);
    }
  }

  const result: ContextMenuItem[] = [];
  for (const group of NODE_MENU_GROUP_ORDER) {
    const list = grouped.get(group);
    if (!list || list.length === 0) continue;
    const sorted = [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    if (result.length > 0) {
      result.push({ id: `sep-${group}`, label: '', separator: true });
    }
    result.push(...sorted);
  }
  return result;
}
