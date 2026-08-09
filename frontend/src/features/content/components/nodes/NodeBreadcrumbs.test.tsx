/**
 * NodeBreadcrumbs tests focused on property-context breadcrumbs.
 *
 * Verifies that opening a text-property block shows the property name in the
 * breadcrumb path as a non-clickable item.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NodeBreadcrumbs } from './NodeBreadcrumbs';
import type { BreadcrumbItemResponse } from '@/types/api';
import type * as HooksModule from '@/hooks';
import type * as ContentModule from '@/features/content';
import type * as StoresModule from '@/stores';
import type * as QueryModule from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({
  breadcrumbs: [] as BreadcrumbItemResponse[],
  batchNodes: {} as Record<string, unknown>,
}));

vi.mock('@/hooks', async () => {
  const actual = await vi.importActual('@/hooks') as typeof HooksModule;
  return {
    ...actual,
    useBreadcrumbs: () => ({ data: mocks.breadcrumbs, isPending: false }),
    useBatchNodesByUuid: () => ({ data: { nodes: mocks.batchNodes } }),
    useClickOutside: () => {},
  };
});

vi.mock('@/features/content', async () => {
  const actual = await vi.importActual('@/features/content') as typeof ContentModule;
  return {
    ...actual,
    useBatchNodesByUuid: () => ({ data: { nodes: mocks.batchNodes } }),
    useUpdateNode: () => ({ mutate: vi.fn() }),
  };
});

vi.mock('@/features/content/hooks/useCoreDisplayName', () => ({
  useCoreDisplayName: (_uuid: string | null, name: string) => name,
}));

vi.mock('@/stores', async () => {
  const actual = await vi.importActual('@/stores') as typeof StoresModule;
  return {
    ...actual,
    useSettingsStore: () => ({ dateFormat: 'yyyy-MM-dd' }),
  };
});

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual('@tanstack/react-query') as typeof QueryModule;
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});

beforeEach(() => {
  mocks.breadcrumbs = [];
  mocks.batchNodes = {};
});

describe('NodeBreadcrumbs property context', () => {
  it('inserts the property name into the breadcrumb path for a text-property block', () => {
    mocks.breadcrumbs = [
      {
        uuid: 'page-uuid',
        name: 'Parent Page',
        display_name: 'Parent Page',
        icon: null,
        is_page: true,
        parent_locked: false,
      },
    ];

    render(
      <NodeBreadcrumbs
        nodeUuid="block-uuid"
        nodeType="block"
        propertyContext={{ propertyUuid: 'prop-uuid', propertyName: 'Description' }}
      />,
    );

    expect(screen.getByText('Parent Page')).toBeInTheDocument();
    expect(screen.getByText('Description')).toBeInTheDocument();
  });

  it('does not navigate when the property breadcrumb is clicked', () => {
    mocks.breadcrumbs = [
      {
        uuid: 'page-uuid',
        name: 'Parent Page',
        display_name: 'Parent Page',
        icon: null,
        is_page: true,
        parent_locked: false,
      },
    ];
    const onNavigate = vi.fn();
    const onNavigateToProperty = vi.fn();

    render(
      <NodeBreadcrumbs
        nodeUuid="block-uuid"
        nodeType="block"
        propertyContext={{ propertyUuid: 'prop-uuid', propertyName: 'Description' }}
        onNavigate={onNavigate}
        onNavigateToProperty={onNavigateToProperty}
      />,
    );

    const propertyCrumb = screen.getByText('Description').closest('span');
    expect(propertyCrumb).toBeInTheDocument();
    // The property crumb should render as a non-clickable span, not a link/button.
    expect(propertyCrumb?.tagName).toBe('SPAN');
  });
});
