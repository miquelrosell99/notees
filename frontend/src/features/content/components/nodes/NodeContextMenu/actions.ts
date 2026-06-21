export type ActionScope = 'page' | 'block' | 'both';

export type ActionName =
  | 'favorite'
  | 'move-to'
  | 'convert-to-page'
  | 'convert-to-block'
  | 'toggle-header'
  | 'copy-uuid'
  | 'copy-link'
  | 'open-main-view'
  | 'copy-blocks'
  | 'paste-blocks'
  | 'open-sidebar'
  | 'local-graph'
  | 'export'
  | 'presentation'
  | 'copy-text'
  | 'share'
  | 'view-ast'
  | 'toggle-private'
  | 'add-banner'
  | 'archive'
  | 'delete';

export type ActionConfig = readonly [ActionName, ActionScope];

/**
 * Default action list. Order determines menu order.
 * Callers can pass a custom subset/reordering via the `actions` prop.
 */
export const DEFAULT_ACTIONS: ActionConfig[] = [
  ['copy-link',       'both'],
  ['open-main-view',  'both'],
  ['share',           'both'],
  ['open-sidebar',    'both'],
  ['copy-blocks',     'both'],
  ['paste-blocks',    'both'],
  ['move-to',         'both'],
  ['convert-to-page', 'block'],
  ['convert-to-block', 'page'],
  ['toggle-header',   'block'],
  ['copy-text',       'both'],
  ['export',          'both'],
  ['presentation',    'both'],
  ['view-ast',        'both'],
  ['archive',         'both'],
  ['toggle-private',  'page'],
  ['add-banner',      'page'],
  ['delete',          'both'],
];

// A separator is inserted before these actions (when they are visible and there are preceding items)
export const SEP_BEFORE = new Set<ActionName>(['copy-text', 'view-ast', 'delete']);
