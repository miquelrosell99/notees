/**
 * Fixture: a minimal third-party-style plugin that registers a custom
 * class-filtered dashboard view composed ONLY from the exposed view
 * primitives (PluginContext.primitives) — no app-internal components.
 *
 * Used by viewPlatform.test.tsx to prove the plugin view platform is
 * sufficient for external view plugins.
 */
import type { PluginContext } from '@/plugins/core';
import type { QueryAST } from '@/types/queryAST';

export const FIXTURE_VIEW_ID = 'fixture.books-dashboard';
export const FIXTURE_DASHBOARD_TITLE = 'Fixture Books Dashboard';

/** class-filtered query AST the fixture dashboard would run. */
export function buildFixtureQueryAst(classUuid: string): QueryAST {
  return {
    type: 'query',
    version: '1.0',
    id: 'fixture_books_dashboard',
    scope: { type: 'scope', scope_type: 'entire_workspace' },
    root_group: {
      type: 'group',
      logic: 'AND',
      children: [
        {
          type: 'condition',
          condition_type: 'class',
          operator: 'is_any_of',
          class_uuids: [classUuid],
        },
      ],
    },
  };
}

/**
 * Third-party-style setup(): everything the view needs comes from the plugin
 * context — primitives for components, register* for contributions.
 */
export function setup(context: PluginContext, options?: { classUuid?: string }) {
  const classUuid = options?.classUuid ?? '00000000-0000-0000-0001-000000000024'; // system book class
  const { PageViewHeader, QueryNodeCollection, NodeSelector } = context.primitives;

  const FixtureDashboard = ({ renderCollection = false }: { renderCollection?: boolean }) => (
    <article className="node-view node-view--page fixture-dashboard">
      <PageViewHeader title={<h1>{FIXTURE_DASHBOARD_TITLE}</h1>} />
      {renderCollection && (
        <QueryNodeCollection nodeUuid={classUuid} viewType="classed_nodes" queryAST={buildFixtureQueryAst(classUuid)}>
          {({ results }) => <>{results}</>}
        </QueryNodeCollection>
      )}
      {/* Referenced to prove the picker primitive is part of the exposed surface. */}
      <span data-testid="fixture-picker-available" data-has-picker={String(!!NodeSelector)} />
    </article>
  );

  context.registerView({
    viewId: FIXTURE_VIEW_ID,
    id: FIXTURE_VIEW_ID,
    label: 'Books Dashboard',
    icon: 'book-open-variant',
    component: FixtureDashboard,
  });

  context.registerSidebarItem({
    id: 'fixture-books-sidebar',
    label: 'Books Dashboard',
    icon: 'book-open-variant',
    viewId: FIXTURE_VIEW_ID,
  });
}
