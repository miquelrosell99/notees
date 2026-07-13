/**
 * PropertiesSection onlyWithValues tests.
 *
 * List-view rows render the section inline with onlyWithValues: only
 * properties that actually have a value set on the node should show, and
 * properties surfaced inline via icon_visibility (after_bullet/before_content)
 * must stay out of the list (they already render as block icons).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { PropertiesSection } from './PropertiesSection';
import type { Node, Property } from '@/types/api';

const mocks = vi.hoisted(() => ({
  node: null as Node | null,
  allProperties: [] as Property[],
  classProperties: [] as unknown[],
}));

vi.mock('@/features/properties/hooks', () => ({
  useProperties: () => ({ data: mocks.allProperties }),
  useSetNodeProperty: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateProperty: () => ({ mutate: vi.fn() }),
  useClassProperties: () => ({ data: mocks.classProperties }),
}));

vi.mock('@/features/content', () => ({
  useNode: () => ({ data: mocks.node, isLoading: false }),
  useCreateNode: () => ({ mutate: vi.fn() }),
  usePageClass: () => ({ pageClassUuid: 'page-class-uuid' }),
  useSystemClasses: () => ({ systemClassUuids: {} }),
  NodeViewSection: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  NodeInline: ({ name }: { name?: string }) => createElement('span', null, name ?? null),
  PageContextMenu: () => null,
}));

vi.mock('@/plugins/builtin/flashcards', () => ({
  FlashcardEditor: () => null,
}));

// Value rendering is covered by the renderer registry; keep this test focused
// on which property rows are listed.
vi.mock('./PropertyValue', () => ({
  PropertyValue: () => createElement('div', { 'data-testid': 'property-value' }),
}));

const TEXT_SET: Property = {
  uuid: 'prop-text-set',
  name: 'Text Set',
  type: 'text',
  icon_visibility: null,
} as unknown as Property;

const ICON_SET: Property = {
  uuid: 'prop-icon-set',
  name: 'Icon Set',
  type: 'text',
  icon_visibility: 'after_bullet',
} as unknown as Property;

const CLASS_UNSET: Property = {
  uuid: 'prop-class-unset',
  name: 'Class Unset',
  type: 'text',
  icon_visibility: null,
} as unknown as Property;

function makeNode(properties: Record<string, unknown>): Node {
  return {
    uuid: 'node-1',
    name: '[]',
    classes_uuid: ['class-1'],
    properties_uuid: properties,
  } as unknown as Node;
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, children);
}

describe('PropertiesSection inline with onlyWithValues', () => {
  beforeEach(() => {
    mocks.allProperties = [TEXT_SET, ICON_SET, CLASS_UNSET];
    mocks.classProperties = [
      {
        property_uuid: CLASS_UNSET.uuid,
        class_node_uuid: 'class-1',
        class_node_name: 'Class 1',
        hidden: false,
      },
    ];
  });

  it('shows only set properties without inline icon visibility', () => {
    mocks.node = makeNode({ [TEXT_SET.uuid]: 'hello', [ICON_SET.uuid]: 'x' });

    render(
      createElement(PropertiesSection, {
        nodeUuid: 'node-1',
        inline: true,
        isMainNode: false,
        showHiddenSection: false,
        showAddProperty: false,
        onlyWithValues: true,
      }),
      { wrapper },
    );

    expect(screen.getByText('Text Set')).toBeInTheDocument();
    // Set, but surfaced as an after_bullet icon — must not duplicate in the list.
    expect(screen.queryByText('Icon Set')).not.toBeInTheDocument();
    // Class-declared but unset on this node — hidden by onlyWithValues.
    expect(screen.queryByText('Class Unset')).not.toBeInTheDocument();
  });

  it('still lists unset class properties when onlyWithValues is false', () => {
    mocks.node = makeNode({ [TEXT_SET.uuid]: 'hello' });

    render(
      createElement(PropertiesSection, {
        nodeUuid: 'node-1',
        inline: true,
        isMainNode: false,
        showHiddenSection: false,
        showAddProperty: false,
      }),
      { wrapper },
    );

    expect(screen.getByText('Text Set')).toBeInTheDocument();
    expect(screen.getByText('Class Unset')).toBeInTheDocument();
  });

  it('renders nothing when the node has no set properties', () => {
    mocks.node = makeNode({});

    const { container } = render(
      createElement(PropertiesSection, {
        nodeUuid: 'node-1',
        inline: true,
        isMainNode: false,
        showHiddenSection: false,
        showAddProperty: false,
        onlyWithValues: true,
      }),
      { wrapper },
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('Class Unset')).not.toBeInTheDocument();
  });
});
