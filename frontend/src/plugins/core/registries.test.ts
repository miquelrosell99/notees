import { describe, it, expect, vi } from 'vitest';
import {
  registerNodeAction,
  unregisterNodeAction,
  getNodeAction,
  getRegisteredNodeActions,
  subscribeNodeActions,
  getVisibleNodeActions,
  type NodeActionContext,
  type NodeActionDefinition,
} from './registries';

const context: NodeActionContext = { menu: 'node', nodeUuid: 'u1', node: null, close: () => {} };

function def(partial: Partial<NodeActionDefinition> & { id: string }): NodeActionDefinition {
  return { label: partial.id, execute: () => {}, ...partial };
}

describe('nodeActionRegistry', () => {
  it('registers, gets, lists and unregisters actions', () => {
    const a = def({ id: 'test.a' });

    registerNodeAction(a);
    expect(getNodeAction('test.a')).toBe(a);
    expect(getRegisteredNodeActions()).toContain(a);

    unregisterNodeAction('test.a');
    expect(getNodeAction('test.a')).toBeUndefined();
    expect(getRegisteredNodeActions()).not.toContain(a);
  });

  it('notifies subscribers on register and unregister, and stops after unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNodeActions(listener);

    registerNodeAction(def({ id: 'test.sub' }));
    unregisterNodeAction('test.sub');
    unsubscribe();
    registerNodeAction(def({ id: 'test.sub2' }));
    unregisterNodeAction('test.sub2');

    expect(listener).toHaveBeenCalledTimes(2);
  });

  describe('getVisibleNodeActions', () => {
    it('filters by scope', () => {
      const actions = [
        def({ id: 'both' }),
        def({ id: 'page-only', scope: 'page' }),
        def({ id: 'block-only', scope: 'block' }),
      ];

      const pageVisible = getVisibleNodeActions(actions, {
        nodeScope: 'page',
        showDevOptions: true,
        context,
      });
      expect(pageVisible.map((a) => a.id)).toEqual(['both', 'page-only']);

      const blockVisible = getVisibleNodeActions(actions, {
        nodeScope: 'block',
        showDevOptions: true,
        context,
      });
      expect(blockVisible.map((a) => a.id)).toEqual(['both', 'block-only']);
    });

    it('passes the scope filter when the target node is unresolved (nodeScope null)', () => {
      const actions = [def({ id: 'page-only', scope: 'page' })];
      const visible = getVisibleNodeActions(actions, {
        nodeScope: null,
        showDevOptions: true,
        context,
      });
      expect(visible).toHaveLength(1);
    });

    it('hides devOnly actions unless dev options are enabled', () => {
      const actions = [def({ id: 'dev', devOnly: true }), def({ id: 'normal' })];

      expect(
        getVisibleNodeActions(actions, { nodeScope: null, showDevOptions: false, context }).map((a) => a.id),
      ).toEqual(['normal']);
      expect(
        getVisibleNodeActions(actions, { nodeScope: null, showDevOptions: true, context }).map((a) => a.id),
      ).toEqual(['dev', 'normal']);
    });

    it('applies the visible predicate with the action context', () => {
      const actions = [
        def({ id: 'match', visible: (c) => c.nodeUuid === 'u1' }),
        def({ id: 'no-match', visible: (c) => c.nodeUuid === 'other' }),
      ];
      const visible = getVisibleNodeActions(actions, {
        nodeScope: null,
        showDevOptions: true,
        context,
      });
      expect(visible.map((a) => a.id)).toEqual(['match']);
    });

    it('preserves registration order', () => {
      const actions = [def({ id: 'z' }), def({ id: 'a' }), def({ id: 'm' })];
      const visible = getVisibleNodeActions(actions, {
        nodeScope: null,
        showDevOptions: true,
        context,
      });
      expect(visible.map((a) => a.id)).toEqual(['z', 'a', 'm']);
    });

    it('filters by target menu, defaulting to node and link', () => {
      const actions = [
        def({ id: 'default' }),
        def({ id: 'everywhere', menus: ['node', 'link', 'archived'] }),
        def({ id: 'archived-only', menus: ['archived'] }),
      ];

      const nodeVisible = getVisibleNodeActions(actions, {
        nodeScope: null,
        showDevOptions: true,
        context: { ...context, menu: 'node' },
      });
      expect(nodeVisible.map((a) => a.id)).toEqual(['default', 'everywhere']);

      const linkVisible = getVisibleNodeActions(actions, {
        nodeScope: null,
        showDevOptions: true,
        context: { ...context, menu: 'link' },
      });
      expect(linkVisible.map((a) => a.id)).toEqual(['default', 'everywhere']);

      const archivedVisible = getVisibleNodeActions(actions, {
        nodeScope: null,
        showDevOptions: true,
        context: { ...context, menu: 'archived' },
      });
      expect(archivedVisible.map((a) => a.id)).toEqual(['everywhere', 'archived-only']);
    });
  });
});
