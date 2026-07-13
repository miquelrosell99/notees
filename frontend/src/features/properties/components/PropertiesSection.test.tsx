/**
 * PropertiesSection onlyWithValues tests.
 *
 * List-view rows render the section inline with onlyWithValues: only
 * properties that actually have a value set on the node should show, and
 * properties surfaced inline via icon_visibility (after_bullet/before_content)
 * must stay out of the list (they already render as block icons).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
// on which property rows are listed. `data-readonly` lets attribute tests
// assert the effective readOnly flag handed to the editor.
vi.mock('./PropertyValue', () => ({
  PropertyValue: ({ readOnly }: { readOnly?: boolean }) =>
    createElement('div', { 'data-testid': 'property-value', 'data-readonly': String(Boolean(readOnly)) }),
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

/**
 * Attribute display: effective attributes resolve as class-edge value ??
 * property base value (tri-state inherit). hide_when_empty buckets empty
 * entries into the hidden section; readonly disables the editor and the
 * destructive context actions; required without a default hides "Empty
 * property" (the backend would reject the write).
 *
 * These tests render non-inline so the hidden bucket is reachable via the
 * "Hidden properties (N)" toggle (showHiddenSection defaults to true).
 */
function makeProperty(partial: Record<string, unknown>): Property {
  return {
    icon: null,
    multi: false,
    icon_visibility: null,
    required: false,
    readonly: false,
    hide_when_empty: false,
    default_value: null,
    ...partial,
  } as unknown as Property;
}

function makeClassProperty(partial: Record<string, unknown>) {
  return {
    class_node_uuid: 'class-1',
    class_node_name: 'Class 1',
    hidden: false,
    default_value: null,
    required: null,
    readonly: null,
    hide_when_empty: null,
    ...partial,
  };
}

function openRowContextMenu(name: string) {
  fireEvent.contextMenu(screen.getByText(name));
}

describe('PropertiesSection attribute display', () => {
  beforeEach(() => {
    mocks.allProperties = [];
    mocks.classProperties = [];
  });

  it('moves empty hide-when-empty properties to the hidden bucket', () => {
    const prop = makeProperty({ uuid: 'prop-hide-empty', name: 'Hide Empty', type: 'text', hide_when_empty: true });
    mocks.allProperties = [prop];
    mocks.classProperties = [makeClassProperty({ property_uuid: prop.uuid })];
    mocks.node = makeNode({});

    render(createElement(PropertiesSection, { nodeUuid: 'node-1', showAddProperty: false }), { wrapper });

    // Not in the visible list; reachable only via the hidden toggle.
    expect(screen.queryByText('Hide Empty')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Hidden properties (1)'));
    expect(screen.getByText('Hide Empty')).toBeInTheDocument();
  });

  it('shows a hide-when-empty property once it has a value', () => {
    // Guard: a genuinely-valued hide-when-empty property must stay visible —
    // this also passed pre-fix (no hide logic existed); it pins the
    // non-empty side of the hide/show boundary.
    const prop = makeProperty({ uuid: 'prop-hide-empty', name: 'Hide Empty', type: 'text', hide_when_empty: true });
    mocks.allProperties = [prop];
    mocks.classProperties = [makeClassProperty({ property_uuid: prop.uuid })];
    mocks.node = makeNode({ [prop.uuid]: 'hello' });

    render(createElement(PropertiesSection, { nodeUuid: 'node-1', showAddProperty: false }), { wrapper });

    expect(screen.getByText('Hide Empty')).toBeInTheDocument();
    expect(screen.queryByText(/Hidden properties/)).not.toBeInTheDocument();
  });

  it('treats assigned-but-emptied values as empty for hide-when-empty', () => {
    // The backend materializes null/''/[] for assigned-but-emptied properties
    // (e.g. via the "Empty property" action), so key presence is not "has
    // value" — mirror backend is_empty_value (None/''/[] are empty).
    const emptiedString = makeProperty({ uuid: 'prop-empty-str', name: 'Empty String', type: 'text', hide_when_empty: true });
    const emptiedNull = makeProperty({ uuid: 'prop-empty-null', name: 'Empty Null', type: 'text', hide_when_empty: true });
    const emptiedArray = makeProperty({ uuid: 'prop-empty-arr', name: 'Empty Array', type: 'text', hide_when_empty: true });
    mocks.allProperties = [emptiedString, emptiedNull, emptiedArray];
    mocks.classProperties = [
      makeClassProperty({ property_uuid: emptiedString.uuid }),
      makeClassProperty({ property_uuid: emptiedNull.uuid }),
      makeClassProperty({ property_uuid: emptiedArray.uuid }),
    ];
    mocks.node = makeNode({
      [emptiedString.uuid]: '',
      [emptiedNull.uuid]: null,
      [emptiedArray.uuid]: [],
    });

    render(createElement(PropertiesSection, { nodeUuid: 'node-1', showAddProperty: false }), { wrapper });

    expect(screen.queryByText('Empty String')).not.toBeInTheDocument();
    expect(screen.queryByText('Empty Null')).not.toBeInTheDocument();
    expect(screen.queryByText('Empty Array')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Hidden properties (3)'));
    expect(screen.getByText('Empty String')).toBeInTheDocument();
    expect(screen.getByText('Empty Null')).toBeInTheDocument();
    expect(screen.getByText('Empty Array')).toBeInTheDocument();
  });

  it('class-edge hide_when_empty override beats the property base', () => {
    const edgeHidden = makeProperty({ uuid: 'prop-edge-hidden', name: 'Edge Hidden', type: 'text', hide_when_empty: false });
    const edgeVisible = makeProperty({ uuid: 'prop-edge-visible', name: 'Edge Visible', type: 'text', hide_when_empty: true });
    mocks.allProperties = [edgeHidden, edgeVisible];
    mocks.classProperties = [
      makeClassProperty({ property_uuid: edgeHidden.uuid, hide_when_empty: true }),
      makeClassProperty({ property_uuid: edgeVisible.uuid, hide_when_empty: false }),
    ];
    mocks.node = makeNode({});

    render(createElement(PropertiesSection, { nodeUuid: 'node-1', showAddProperty: false }), { wrapper });

    // base false + edge true, empty → hidden; base true + edge false, empty → visible
    expect(screen.queryByText('Edge Hidden')).not.toBeInTheDocument();
    expect(screen.getByText('Edge Visible')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Hidden properties (1)'));
    expect(screen.getByText('Edge Hidden')).toBeInTheDocument();
  });

  it('renders readonly entries with disabled editors and disabled empty/remove actions', () => {
    const prop = makeProperty({ uuid: 'prop-readonly', name: 'Readonly Prop', type: 'text', readonly: true });
    mocks.allProperties = [prop];
    mocks.classProperties = [makeClassProperty({ property_uuid: prop.uuid })];
    mocks.node = makeNode({ [prop.uuid]: 'locked' });

    render(createElement(PropertiesSection, { nodeUuid: 'node-1', showAddProperty: false }), { wrapper });

    expect(screen.getByTestId('property-value')).toHaveAttribute('data-readonly', 'true');

    openRowContextMenu('Readonly Prop');
    expect(screen.getByText('Empty property').closest('button')).toBeDisabled();
    expect(screen.getByText('Remove from node').closest('button')).toBeDisabled();
  });

  it('class-edge readonly override beats the property base, both directions', () => {
    const edgeReadonly = makeProperty({ uuid: 'prop-edge-ro', name: 'Edge Readonly', type: 'text', readonly: false });
    const edgeWritable = makeProperty({ uuid: 'prop-edge-rw', name: 'Edge Writable', type: 'text', readonly: true });
    mocks.allProperties = [edgeReadonly, edgeWritable];
    mocks.classProperties = [
      // base false + edge true → readonly
      makeClassProperty({ property_uuid: edgeReadonly.uuid, readonly: true }),
      // base true + edge false → writable (explicit edge false must win)
      makeClassProperty({ property_uuid: edgeWritable.uuid, readonly: false }),
    ];
    mocks.node = makeNode({ [edgeReadonly.uuid]: 'locked by edge', [edgeWritable.uuid]: 'free by edge' });

    render(createElement(PropertiesSection, { nodeUuid: 'node-1', showAddProperty: false }), { wrapper });

    const editors = screen.getAllByTestId('property-value');
    expect(editors).toHaveLength(2);
    expect(editors[0]).toHaveAttribute('data-readonly', 'true');
    expect(editors[1]).toHaveAttribute('data-readonly', 'false');
  });

  it('class-edge required override beats the property base, both directions', () => {
    const edgeRequired = makeProperty({ uuid: 'prop-edge-req', name: 'Edge Required', type: 'text', required: false });
    const edgeOptional = makeProperty({ uuid: 'prop-edge-opt', name: 'Edge Optional', type: 'text', required: true });
    mocks.allProperties = [edgeRequired, edgeOptional];
    mocks.classProperties = [
      // base false + edge true (no default) → "Empty property" hidden
      makeClassProperty({ property_uuid: edgeRequired.uuid, required: true }),
      // base true (no default) + edge false → "Empty property" available
      makeClassProperty({ property_uuid: edgeOptional.uuid, required: false }),
    ];
    mocks.node = makeNode({ [edgeRequired.uuid]: 'a', [edgeOptional.uuid]: 'b' });

    const { unmount } = render(
      createElement(PropertiesSection, { nodeUuid: 'node-1', showAddProperty: false }),
      { wrapper },
    );

    openRowContextMenu('Edge Required');
    expect(screen.queryByText('Empty property')).not.toBeInTheDocument();
    expect(screen.getByText('Open property')).toBeInTheDocument();
    unmount();

    render(createElement(PropertiesSection, { nodeUuid: 'node-1', showAddProperty: false }), { wrapper });

    openRowContextMenu('Edge Optional');
    expect(screen.getByText('Empty property')).toBeInTheDocument();
  });

  it('hides "Empty property" for required entries without a default, keeps it with a default', () => {
    const requiredNoDefault = makeProperty({ uuid: 'prop-req-nodef', name: 'Required No Default', type: 'text', required: true });
    const requiredWithDefault = makeProperty({
      uuid: 'prop-req-def', name: 'Required With Default', type: 'text', required: true, default_value: 'fallback',
    });
    mocks.allProperties = [requiredNoDefault, requiredWithDefault];
    // Ad-hoc (non-class) entries: values come straight from the node.
    mocks.node = makeNode({ [requiredNoDefault.uuid]: 'a', [requiredWithDefault.uuid]: 'b' });

    const { unmount } = render(
      createElement(PropertiesSection, { nodeUuid: 'node-1', showAddProperty: false }),
      { wrapper },
    );

    openRowContextMenu('Required No Default');
    expect(screen.queryByText('Empty property')).not.toBeInTheDocument();
    expect(screen.getByText('Open property')).toBeInTheDocument();
    unmount();

    render(createElement(PropertiesSection, { nodeUuid: 'node-1', showAddProperty: false }), { wrapper });

    openRowContextMenu('Required With Default');
    expect(screen.getByText('Empty property')).toBeInTheDocument();
  });
});
