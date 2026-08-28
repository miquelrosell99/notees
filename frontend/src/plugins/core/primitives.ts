/**
 * View primitives exposed to plugins.
 *
 * Plugins compose their top-level views from the app's own building blocks
 * instead of re-implementing them, so plugin views inherit the design system,
 * the local-first query runtime, and hierarchy-aware class filtering for free.
 *
 * The surface is deliberately small and stable:
 *
 * - `QueryNodeCollection` — a complete query-driven collection: give it a
 *   QueryAST (inline mode) or a node/view type and it runs the query against
 *   the local derived store and renders the result with the standard view
 *   modes (list, table, kanban, ...). Class conditions in the AST are
 *   hierarchy-aware (a `class:source` filter matches books, papers, ...).
 * - `NodeCollection` — the lower-level renderer for an already-fetched list of
 *   nodes, with view-mode switching handled by the caller.
 * - `NodeSelector` — the universal, class-aware node picker (pill-row, select,
 *   or inline trigger). `classFilters` accept superclass UUIDs (e.g. `agent`)
 *   and match subclass instances (persons, organizations).
 * - `PropertiesSection` — the standard class-bound property panel for a node.
 * - `PageViewHeader` — the standard header chrome (title / middle / actions)
 *   used by hub views such as Pages and Whiteboards.
 *
 * Usage inside a plugin setup():
 *
 *   export function setup(context: PluginContext) {
 *     const { PageViewHeader, QueryNodeCollection } = context.primitives;
 *     const MyDashboard = () => (
 *       <article className="node-view node-view--page">
 *         <PageViewHeader title={<h1>My dashboard</h1>} />
 *         <QueryNodeCollection ... />
 *       </article>
 *     );
 *     context.registerView({ viewId: 'my-view', id: 'my-view', label: 'My View', component: MyDashboard });
 *   }
 *
 * Everything registered through the context is torn down automatically when
 * the plugin is disabled (see PluginContext.unregisterAll).
 */

import { NodeCollection } from '@/features/content/components/nodes/NodeCollection';
import { NodeSelector } from '@/features/content/components/nodes/NodeSelector';
import { PageViewHeader } from '@/features/content/components/nodes/PageViewHeader';
import { QueryNodeCollection } from '@/features/content/components/nodes/QueryNodeCollection';
import { PropertiesSection } from '@/features/properties/components/PropertiesSection';

export interface ViewPrimitives {
  /** Query-driven collection: runs a QueryAST and renders results with the standard view modes. */
  QueryNodeCollection: typeof QueryNodeCollection;
  /** Renderer for an already-fetched node list (list/table/kanban/... modes). */
  NodeCollection: typeof NodeCollection;
  /** Universal class-aware node picker (`classFilters` are hierarchy-aware). */
  NodeSelector: typeof NodeSelector;
  /** Standard class-bound property panel for a node. */
  PropertiesSection: typeof PropertiesSection;
  /** Standard hub-view header chrome (title / middle / actions). */
  PageViewHeader: typeof PageViewHeader;
}

/**
 * The primitives exposed to every plugin via `PluginContext.primitives`.
 * Frozen: plugins receive the same references, they cannot be replaced.
 */
export const viewPrimitives: ViewPrimitives = Object.freeze({
  QueryNodeCollection,
  NodeCollection,
  NodeSelector,
  PropertiesSection,
  PageViewHeader,
});
