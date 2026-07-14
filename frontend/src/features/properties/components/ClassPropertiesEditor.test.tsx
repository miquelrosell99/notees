/**
 * ClassPropertiesEditor tri-state override tests.
 *
 * Each property row exposes three tri-state toggles (required / readonly /
 * hide-when-empty) that cycle inherit -> on -> off -> inherit, and a
 * default-value override editor (unset = inherit from the property base).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { ClassPropertiesEditor } from './ClassPropertiesEditor';
import type { ClassProperty, Property } from '@/types/api';

const mocks = vi.hoisted(() => ({
  updateMutate: vi.fn(),
  classProperties: [] as ClassProperty[],
}));

const CLASS_PROPERTY: ClassProperty = {
  class_node_uuid: 'class-1',
  class_node_name: 'Task',
  property_uuid: 'prop-status',
  property_name: 'Status',
  property_type: 'selection',
  sequence: 0,
  default_value: null,
  hidden: false,
  required: null,
  readonly: null,
  hide_when_empty: null,
};

const PROPERTY: Property = {
  uuid: 'prop-status',
  name: 'Status',
  icon: null,
  type: 'selection',
  multi: false,
  is_system: false,
  scope: 'global',
  node_uuid: null,
  icon_visibility: 'hidden',
  validation_rules: null,
  required: true,
  readonly: false,
  hide_when_empty: false,
  default_value: null,
  create_date: '2026-01-01T00:00:00Z',
  write_date: '2026-01-01T00:00:00Z',
  class_filter_uuids: [],
  options: [
    { uuid: 'opt-pending', name: 'Pending', icon: null, color: null, sequence: 0 },
  ],
} as Property;

// The component imports every class-property hook from the feature barrel;
// mock the whole barrel so no real queries/mutations are constructed.
vi.mock('../hooks', () => ({
  useClassProperties: () => ({ data: mocks.classProperties, isLoading: false }),
  useProperties: () => ({ data: [PROPERTY] }),
  useAddPropertyToClass: () => ({ mutate: vi.fn() }),
  useCreateProperty: () => ({ mutate: vi.fn() }),
  useRemovePropertyFromClass: () => ({ mutate: vi.fn() }),
  useReorderClassProperties: () => ({ mutate: vi.fn() }),
  useUpdateClassProperty: () => ({ mutate: mocks.updateMutate }),
}));

vi.mock('@/features/content', () => ({
  NodeViewSection: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));

vi.mock('./PropertySuggestionPopup', () => ({
  PropertySuggestionPopup: () => null,
}));

function renderEditor() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Fresh element per render — React bails out on referentially identical
  // elements, which would skip re-reading the mocked hooks.
  const makeTree = () => createElement(
    QueryClientProvider,
    { client },
    createElement(ClassPropertiesEditor, { classNodeUuid: 'class-1' }),
  );
  const utils = render(makeTree());
  return { ...utils, rerenderEditor: () => utils.rerender(makeTree()) };
}

describe('ClassPropertiesEditor tri-state overrides', () => {
  beforeEach(() => {
    mocks.updateMutate.mockClear();
    mocks.classProperties = [CLASS_PROPERTY];
  });

  it('cycles required inherit -> on -> off -> inherit', () => {
    renderEditor();
    const btn = screen.getByTitle(/inherit \(required\)/i);

    fireEvent.click(btn);
    expect(mocks.updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ required: true }) }),
      expect.objectContaining({ onError: expect.any(Function) }),
    );
    mocks.updateMutate.mockClear();

    fireEvent.click(btn);
    expect(mocks.updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ required: false }) }),
      expect.objectContaining({ onError: expect.any(Function) }),
    );
    mocks.updateMutate.mockClear();

    fireEvent.click(btn);
    expect(mocks.updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ required: null }) }),
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });

  it('rolls back to the server value when the mutation fails', () => {
    let capturedOpts: { onError?: () => void } | undefined;
    mocks.updateMutate.mockImplementation((_vars, opts) => { capturedOpts = opts; });
    renderEditor();

    fireEvent.click(screen.getByTitle(/inherit \(required\)/i));
    // Optimistic state applies immediately...
    expect(screen.getByTitle(/required \(click to make optional\)/i)).toBeInTheDocument();

    act(() => { capturedOpts?.onError?.(); });
    // ...and a failed PATCH reverts to the server value (edge null, base required)
    expect(screen.getByTitle(/inherit \(required\)/i)).toBeInTheDocument();
  });

  it('re-syncs the toggle when the server value changes after a refetch', () => {
    const { rerenderEditor } = renderEditor();

    fireEvent.click(screen.getByTitle(/inherit \(required\)/i));
    expect(screen.getByTitle(/required \(click to make optional\)/i)).toBeInTheDocument();

    // The PATCH succeeded and the refetch now reports the saved value
    mocks.classProperties = [{ ...CLASS_PROPERTY, required: false }];
    rerenderEditor();
    expect(screen.getByTitle(/optional \(click to inherit\)/i)).toBeInTheDocument();
  });

  it('shows the resolved base in inherit state', () => {
    renderEditor();
    // property base required=true, edge=null -> "Inherit (required)"
    expect(screen.getByTitle(/inherit \(required\)/i)).toBeInTheDocument();
    // property base readonly=false, edge=null -> "Inherit (editable)"
    expect(screen.getByTitle(/inherit \(editable\)/i)).toBeInTheDocument();
    // property base hide_when_empty=false, edge=null -> "Inherit (always shown)"
    expect(screen.getByTitle(/inherit \(always shown\)/i)).toBeInTheDocument();
  });

  it('toggles carry an accessible name and are keyboard-operable buttons', () => {
    renderEditor();
    const btn = screen.getByRole('button', { name: /inherit \(required\)/i });
    expect(btn.tagName).toBe('BUTTON');
  });

  it('setting a default override calls the mutation with default_value', () => {
    renderEditor();
    const select = screen.getByRole('combobox', { name: /default value/i });
    fireEvent.change(select, { target: { value: 'opt-pending' } });
    expect(mocks.updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        classId: 'class-1',
        propertyId: 'prop-status',
        data: expect.objectContaining({ default_value: 'opt-pending' }),
      }),
    );
  });

  it('clearing a default override sends default_value: null (inherit)', () => {
    renderEditor();
    const select = screen.getByRole('combobox', { name: /default value/i });
    fireEvent.change(select, { target: { value: 'opt-pending' } });
    mocks.updateMutate.mockClear();
    fireEvent.change(select, { target: { value: '' } });
    expect(mocks.updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ default_value: null }) }),
    );
  });
});
