/**
 * BlockRow tests — focus on mount/unmount behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEditorFocusStore } from '@/stores/editorFocusStore';
import { BlockRow } from './BlockRow';
import { CustomInlineEditor } from '@/features/editor/custom/components/CustomInlineEditor';
import { PropertiesSection } from '@/features/properties';
import type { Node } from '@/types/api';

const baseNode: Node = {
  uuid: 'block-a',
  name: JSON.stringify([
    { type: 'paragraph', children: [{ type: 'text', text: 'Hello world' }] },
  ]),
  icon: null,
  color: null,
  parent_uuid: null,
  page_uuid: null,
  sequence: 0,
  active: true,
  is_page: false,
  classes_uuid: [],
  tags_uuid: [],
  properties_uuid: {},
  create_date: '',
  write_date: '',
};

vi.mock('@/features/tasks', () => ({
  useTaskActions: () => ({ cycleTaskStatus: vi.fn() }),
}));

vi.mock('@/features/properties', () => ({
  useProperties: () => ({ data: [] }),
  useSetNodeProperty: () => ({ mutate: vi.fn() }),
  PropertiesSection: vi.fn(() => null),
}));

vi.mock('@/features/content', () => ({
  useResolvedClassDetails: () => [],
  useClasses: () => ({ data: [] }),
  useReferencedNode: () => null,
}));

vi.mock('@/hooks', () => ({
  useBatchedNodeByUuid: () => ({ data: null }),
  useFocusMode: () => false,
}));

vi.mock('@/features/editor/custom/components/CustomInlineEditor', () => ({
  CustomInlineEditor: vi.fn(() => <div data-testid="inline-editor">Editor</div>),
}));

vi.mock('@/features/editor/editor/utils/cursorOffsetFromPoint', () => ({
  getLogicalOffsetFromPoint: vi.fn(() => 5),
}));

function Wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('BlockRow', () => {
  beforeEach(() => {
    useEditorFocusStore.setState({ activeBlockId: null, pendingFocusBlockId: null });
  });

  it('renders static content by default and mounts editor on click', () => {
    render(<BlockRow node={baseNode} />, { wrapper: Wrapper });

    expect(screen.getByText('Hello world')).toBeInTheDocument();
    expect(screen.queryByTestId('inline-editor')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Hello world'));

    expect(screen.getByTestId('inline-editor')).toBeInTheDocument();
  });

  it('does not mount editor for read-only blocks', () => {
    render(<BlockRow node={baseNode} readOnly />, { wrapper: Wrapper });

    expect(screen.getByText('Hello world')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Hello world'));
    expect(screen.queryByTestId('inline-editor')).not.toBeInTheDocument();
  });

  it('passes the captured cursor offset to InlineEditor on mount', () => {
    render(<BlockRow node={baseNode} />, { wrapper: Wrapper });

    fireEvent.click(screen.getByText('Hello world'));

    expect(screen.getByTestId('inline-editor')).toBeInTheDocument();
    const lastCallProps = vi.mocked(CustomInlineEditor).mock.calls.at(-1)![0] as { initialCursorOffset?: number };
    expect(lastCallProps.initialCursorOffset).toBeGreaterThanOrEqual(0);
  });

  it('renders class-declared properties even when empty', () => {
    // A classed block must show its class-declared properties inline even
    // when they have no value yet — so BlockRow must not pass onlyWithValues.
    const classedNode: Node = { ...baseNode, classes_uuid: ['class-1'] };

    render(<BlockRow node={classedNode} />, { wrapper: Wrapper });

    expect(PropertiesSection).toHaveBeenCalled();
    const lastCallProps = vi.mocked(PropertiesSection).mock.calls.at(-1)![0];
    expect(lastCallProps.onlyWithValues).toBeUndefined();
    expect(lastCallProps.inline).toBe(true);
  });

  it('renders a full properties panel for the root focused block', () => {
    // In focused block view the root block renders its full PropertiesSection
    // after the row, not inline, so the focused block is the first thing visible.
    vi.mocked(PropertiesSection).mockClear();
    render(<BlockRow node={baseNode} depth={0} rootIsBlock />, { wrapper: Wrapper });

    const calls = vi.mocked(PropertiesSection).mock.calls.map(([props]) => props);
    const fullPanelCall = calls.find((p) => p.isMainNode === true && p.inline !== true);
    expect(fullPanelCall).toBeDefined();
    expect(fullPanelCall?.showHiddenSection).toBe(true);
    expect(fullPanelCall?.showAddProperty).toBe(true);
    expect(fullPanelCall?.className).toBe('block-row__root-properties');
    expect(calls.some((p) => p.inline === true)).toBe(false);
  });

  it('still renders inline properties for children in focused block view', () => {
    // Only the root focused block should render the full panel; child blocks
    // at depth > 0 keep their compact inline section.
    const childNode: Node = { ...baseNode, uuid: 'block-child', classes_uuid: ['class-1'] };
    vi.mocked(PropertiesSection).mockClear();
    render(<BlockRow node={childNode} depth={1} rootIsBlock />, { wrapper: Wrapper });

    const calls = vi.mocked(PropertiesSection).mock.calls.map(([props]) => props);
    const inlineCall = calls.find((p) => p.inline === true);
    expect(inlineCall).toBeDefined();
    expect(inlineCall?.isMainNode).toBe(false);
    expect(calls.some((p) => p.isMainNode === true)).toBe(false);
  });
});
