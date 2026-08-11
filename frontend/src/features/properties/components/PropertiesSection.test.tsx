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
  nodeClassPropertyEdges: vi.fn(),
  setPropertyMutate: vi.fn(),
  notifyError: vi.fn(),
  popupProperty: null as Property | null,
}));

vi.mock('@/features/properties/hooks', () => ({
  useProperties: () => ({ data: mocks.allProperties }),
  useSetNodeProperty: () => ({ mutate: mocks.setPropertyMutate, isPending: false }),
  useCreateProperty: () => ({ mutate: vi.fn() }),
  useClassProperties: () => ({ data: mocks.classProperties }),
  useNodeClassPropertyEdges: (classUuids: string[]) => mocks.nodeClassPropertyEdges(classUuids),
}));

vi.mock('@/stores/notificationStore', () => ({
  useNotifications: () => ({ error: mocks.notifyError }),
}));

// Stub the suggestion popup with a button that selects a test-chosen
// property, so add-property flow tests can drive handleSelectProperty.
vi.mock('./PropertySuggestionPopup', () => ({
  PropertySuggestionPopup: ({ onSelect }: { onSelect: (p: Property) => void }) =>
    createElement(
      'button',
      { type: 'button', onClick: () => onSelect(mocks.popupProperty as Property) },
      'pick-property',
    ),
}));

vi.mock('@/features/content', () => ({
  useNode: () => ({ data: mocks.node, isLoading: false }),
  useCreateNode: () => ({ mutate: vi.fn() }),
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
// assert the effective readOnly flag handed to the editor; `data-value`
// carries the JSON-encoded value so default-resolution tests can assert what
// would be displayed; the inner button lets error-handling tests fire onChange.
vi.mock('./PropertyValue', () => ({
  PropertyValue: ({ readOnly, value, onChange }: { readOnly?: boolean; value?: unknown; onChange?: (v: unknown) => void }) =>
    createElement(
      'div',
      {
        'data-testid': 'property-value',
        'data-readonly': String(Boolean(readOnly)),
        'data-value': JSON.stringify(value ?? null),
      },
      createElement(
        'button',
        { 'data-testid': 'property-value-change', type: 'button', onClick: () => onChange?.('changed-value') },
        'change',
      ),
    ),
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

beforeEach(() => {
  mocks.nodeClassPropertyEdges = vi.fn(() => mocks.classProperties);
  mocks.setPropertyMutate.mockReset();
  mocks.notifyError.mockReset();
});

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

/**
 * Class-edge resolution for display: every class of the node is fetched (no
 * 3-class cap), edges arrive ordered like backend enforcement (direct first,
 * then inherited — see orderClassPropertyEdges), the first edge per property
 * supplies the effective attributes, and the effective default comes from the
 * first edge WITH a non-null default (backend resolve_attributes).
 */
describe('PropertiesSection class edge resolution', () => {
  beforeEach(() => {
    mocks.allProperties = [];
    mocks.classProperties = [];
  });

  it('fetches class properties for every class of the node (no 3-class cap)', () => {
    mocks.node = {
      uuid: 'node-1',
      name: '[]',
      classes_uuid: ['class-1', 'class-2', 'class-3', 'class-4'],
      properties_uuid: {},
    } as unknown as Node;

    render(createElement(PropertiesSection, { nodeUuid: 'node-1', showAddProperty: false }), { wrapper });

    expect(mocks.nodeClassPropertyEdges).toHaveBeenCalledWith(['class-1', 'class-2', 'class-3', 'class-4']);
  });

  it('first edge in enforcement order wins for effective attributes', () => {
    const prop = makeProperty({ uuid: 'prop-dup', name: 'Dup Prop', type: 'text' });
    mocks.allProperties = [prop];
    // Ordered as the backend would: class-2's edge first.
    mocks.classProperties = [
      makeClassProperty({ property_uuid: prop.uuid, class_node_uuid: 'class-2', class_node_name: 'Class 2', readonly: true }),
      makeClassProperty({ property_uuid: prop.uuid, class_node_uuid: 'class-1', class_node_name: 'Class 1', readonly: null }),
    ];
    mocks.node = makeNode({ [prop.uuid]: 'x' });

    render(createElement(PropertiesSection, { nodeUuid: 'node-1', showAddProperty: false }), { wrapper });

    expect(screen.getByTestId('property-value')).toHaveAttribute('data-readonly', 'true');
  });

  it('resolves the effective default from the first edge WITH a default, not just the nearest edge', () => {
    // NEW-4: nearest (direct) edge has no default; an ancestor edge does.
    // Backend resolve_attributes would reset to the ancestor default — the
    // display must show it too (and "Empty property" stays available for a
    // required property because a default exists).
    const prop = makeProperty({ uuid: 'prop-req', name: 'Required Prop', type: 'text', required: true });
    mocks.allProperties = [prop];
    mocks.classProperties = [
      makeClassProperty({ property_uuid: prop.uuid, class_node_uuid: 'class-1', default_value: null }),
      makeClassProperty({ property_uuid: prop.uuid, class_node_uuid: 'ancestor-1', class_node_name: 'Ancestor', default_value: 'ancestor-default' }),
    ];
    mocks.node = makeNode({ [prop.uuid]: '' }); // assigned but emptied

    render(createElement(PropertiesSection, { nodeUuid: 'node-1', showAddProperty: false }), { wrapper });

    expect(screen.getByTestId('property-value')).toHaveAttribute('data-value', '"ancestor-default"');
    openRowContextMenu('Required Prop');
    expect(screen.getByText('Empty property')).toBeInTheDocument();
  });

  it('falls back to the property default for emptied ad-hoc entries', () => {
    // T9-b: ad-hoc (non-class) entries display the default when emptied,
    // the same way class-bound entries do.
    const prop = makeProperty({ uuid: 'prop-adhoc', name: 'Adhoc Prop', type: 'text', default_value: 'fallback' });
    mocks.allProperties = [prop];
    mocks.node = makeNode({ [prop.uuid]: '' });

    render(createElement(PropertiesSection, { nodeUuid: 'node-1', showAddProperty: false }), { wrapper });

    expect(screen.getByTestId('property-value')).toHaveAttribute('data-value', '"fallback"');
  });

  it('shows emptied ad-hoc entries with no default as empty', () => {
    // Guard for the T9-b fallback: no default anywhere -> still empty.
    const prop = makeProperty({ uuid: 'prop-adhoc-nodef', name: 'Adhoc No Default', type: 'text' });
    mocks.allProperties = [prop];
    mocks.node = makeNode({ [prop.uuid]: '' });

    render(createElement(PropertiesSection, { nodeUuid: 'node-1', showAddProperty: false }), { wrapper });

    expect(screen.getByTestId('property-value')).toHaveAttribute('data-value', 'null');
  });
});

/**
 * NEW-6: coded backend errors ({ code, message } detail) must reach the
 * failure toast, and adding an effective-required property without an
 * effective default must not dead-end on the rejected empty placeholder
 * write — the row is added locally so the first real value is the initial
 * write.
 */
describe('PropertiesSection add-property flow and error toasts', () => {
  beforeEach(() => {
    mocks.allProperties = [];
    mocks.classProperties = [];
    mocks.popupProperty = null;
  });

  it('surfaces the backend coded error message in the failure toast', () => {
    const prop = makeProperty({ uuid: 'prop-1', name: 'Prop 1', type: 'text' });
    mocks.allProperties = [prop];
    mocks.node = makeNode({ [prop.uuid]: 'x' });
    mocks.setPropertyMutate.mockImplementation((_vars, opts) => {
      opts?.onError?.({
        response: { data: { detail: { code: 'required_property', message: 'Prop 1 is required and has no default' } } },
      });
    });

    render(createElement(PropertiesSection, { nodeUuid: 'node-1', showAddProperty: false }), { wrapper });
    fireEvent.click(screen.getByTestId('property-value-change'));

    expect(mocks.notifyError).toHaveBeenCalledWith(
      'Failed to save property',
      'Prop 1 is required and has no default',
    );
  });

  it('surfaces a plain string detail in the failure toast', () => {
    const prop = makeProperty({ uuid: 'prop-1', name: 'Prop 1', type: 'text' });
    mocks.allProperties = [prop];
    mocks.node = makeNode({ [prop.uuid]: 'x' });
    mocks.setPropertyMutate.mockImplementation((_vars, opts) => {
      opts?.onError?.({ response: { data: { detail: 'Property assignment not found' } } });
    });

    render(createElement(PropertiesSection, { nodeUuid: 'node-1', showAddProperty: false }), { wrapper });
    fireEvent.click(screen.getByTestId('property-value-change'));

    expect(mocks.notifyError).toHaveBeenCalledWith('Failed to save property', 'Property assignment not found');
  });

  it('falls back to the generic hint when the error carries no detail', () => {
    const prop = makeProperty({ uuid: 'prop-1', name: 'Prop 1', type: 'text' });
    mocks.allProperties = [prop];
    mocks.node = makeNode({ [prop.uuid]: 'x' });
    mocks.setPropertyMutate.mockImplementation((_vars, opts) => {
      opts?.onError?.({});
    });

    render(createElement(PropertiesSection, { nodeUuid: 'node-1', showAddProperty: false }), { wrapper });
    fireEvent.click(screen.getByTestId('property-value-change'));

    expect(mocks.notifyError).toHaveBeenCalledWith('Failed to save property', 'Please try again.');
  });

  it('adds an effective-required property without a default as an empty row, without a placeholder write', () => {
    const prop = makeProperty({ uuid: 'prop-req-nodef', name: 'Required No Default', type: 'text', required: true });
    mocks.allProperties = [prop];
    mocks.popupProperty = prop;
    mocks.node = makeNode({});

    render(createElement(PropertiesSection, { nodeUuid: 'node-1' }), { wrapper });
    fireEvent.click(screen.getByText('pick-property'));

    // No placeholder write — the backend would 400 required_property on it.
    expect(mocks.setPropertyMutate).not.toHaveBeenCalled();
    // The row is present with an empty value, ready for the first real write.
    expect(screen.getByText('Required No Default')).toBeInTheDocument();
    expect(screen.getByTestId('property-value')).toHaveAttribute('data-value', 'null');
  });

  it('first real value on a pending-add row becomes the initial write', () => {
    const prop = makeProperty({ uuid: 'prop-req-nodef', name: 'Required No Default', type: 'text', required: true });
    mocks.allProperties = [prop];
    mocks.popupProperty = prop;
    mocks.node = makeNode({});

    render(createElement(PropertiesSection, { nodeUuid: 'node-1' }), { wrapper });
    fireEvent.click(screen.getByText('pick-property'));
    fireEvent.click(screen.getByTestId('property-value-change'));

    expect(mocks.setPropertyMutate).toHaveBeenCalledWith(
      { nodeUuid: 'node-1', propertyId: 'prop-req-nodef', value: 'changed-value' },
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });

  it('removing a pending-add row needs no server call', () => {
    const prop = makeProperty({ uuid: 'prop-req-nodef', name: 'Required No Default', type: 'text', required: true });
    mocks.allProperties = [prop];
    mocks.popupProperty = prop;
    mocks.node = makeNode({});

    render(createElement(PropertiesSection, { nodeUuid: 'node-1' }), { wrapper });
    fireEvent.click(screen.getByText('pick-property'));

    openRowContextMenu('Required No Default');
    // Required without a default: no "Empty property" item.
    expect(screen.queryByText('Empty property')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Remove from node'));

    expect(mocks.setPropertyMutate).not.toHaveBeenCalled();
    expect(screen.queryByText('Required No Default')).not.toBeInTheDocument();
  });

  it('keeps the placeholder write for non-required properties', () => {
    const prop = makeProperty({ uuid: 'prop-normal', name: 'Normal Prop', type: 'text' });
    mocks.allProperties = [prop];
    mocks.popupProperty = prop;
    mocks.node = makeNode({});

    render(createElement(PropertiesSection, { nodeUuid: 'node-1' }), { wrapper });
    fireEvent.click(screen.getByText('pick-property'));

    expect(mocks.setPropertyMutate).toHaveBeenCalledWith(
      expect.objectContaining({ nodeUuid: 'node-1', propertyId: 'prop-normal' }),
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });

  it('keeps the placeholder write for required properties WITH a default (enforcement rewrites it)', () => {
    const prop = makeProperty({
      uuid: 'prop-req-def', name: 'Required With Default', type: 'text', required: true, default_value: 'd',
    });
    mocks.allProperties = [prop];
    mocks.popupProperty = prop;
    mocks.node = makeNode({});

    render(createElement(PropertiesSection, { nodeUuid: 'node-1' }), { wrapper });
    fireEvent.click(screen.getByText('pick-property'));

    expect(mocks.setPropertyMutate).toHaveBeenCalledWith(
      expect.objectContaining({ nodeUuid: 'node-1', propertyId: 'prop-req-def' }),
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });

  it('drops pending-add rows when the viewed node changes', () => {
    // F1: the section is not remounted between nodes, so per-node pending
    // state must reset on node identity change or a row added on node A
    // leaks onto node B.
    const prop = makeProperty({ uuid: 'prop-req-nodef', name: 'Required No Default', type: 'text', required: true });
    mocks.allProperties = [prop];
    mocks.popupProperty = prop;
    mocks.node = makeNode({});

    const { rerender } = render(createElement(PropertiesSection, { nodeUuid: 'node-1' }), { wrapper });
    fireEvent.click(screen.getByText('pick-property'));
    expect(screen.getByText('Required No Default')).toBeInTheDocument();

    mocks.node = { ...makeNode({}), uuid: 'node-2' } as unknown as Node;
    rerender(createElement(PropertiesSection, { nodeUuid: 'node-2' }));

    expect(screen.queryByText('Required No Default')).not.toBeInTheDocument();
  });

  it('fails cleanly with a coded toast for required + read-only + no default instead of a stuck pending row', () => {
    // F2: such a pending row could never be filled (read-only editor) or
    // dismissed (Remove disabled) — fail cleanly like the pre-pending flow.
    const prop = makeProperty({ uuid: 'prop-stuck', name: 'Stuck Prop', type: 'text', required: true, readonly: true });
    mocks.allProperties = [prop];
    mocks.popupProperty = prop;
    mocks.node = makeNode({});

    render(createElement(PropertiesSection, { nodeUuid: 'node-1' }), { wrapper });
    fireEvent.click(screen.getByText('pick-property'));

    expect(mocks.setPropertyMutate).not.toHaveBeenCalled();
    expect(screen.queryByText('Stuck Prop')).not.toBeInTheDocument();
    expect(mocks.notifyError).toHaveBeenCalledWith(
      'Failed to save property',
      expect.stringContaining('read-only'),
    );
  });
});
