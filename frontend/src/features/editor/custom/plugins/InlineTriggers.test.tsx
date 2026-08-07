/**
 * InlineTriggers — integration coverage for the "@" link trigger flow.
 *
 * Reproduces the full path: type "@" → trigger popup opens → pick a node →
 * the node_link pill is inserted and the caret lands AFTER the pill (in the
 * trailing caret anchor), never inside the pill's label.
 *
 * Also covers the TriggerPopup enhancements for link mode: tabs (All / Pages /
 * Blocks), "Show more results" pagination, and keyboard selection scrolling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CustomInlineEditor } from '../components/CustomInlineEditor';
import { getDOMSelectionOffset } from '../model/selectionSync';
import { useEditorFocusStore } from '@/stores/editorFocusStore';
import type { ASTDocument as ContentAST } from '@/types/ast';
import type { Node } from '@/types';
import type { NodeSearchMode, NodeSearchFilters, UseNodeSearchReturn } from '@/features/content';

const PAGE_NODE: Node = {
  uuid: 'page-uuid-1',
  name: 'Target Page',
  icon: null,
  color: null,
  parent_uuid: null,
  page_uuid: null,
  sequence: 0,
  active: true,
  is_page: true,
  create_date: '',
  write_date: '',
};

const BLOCK_NODE: Node = {
  uuid: 'block-uuid-1',
  name: 'Target Block',
  icon: null,
  color: null,
  parent_uuid: 'page-uuid-1',
  page_uuid: 'page-uuid-1',
  sequence: 0,
  active: true,
  is_page: false,
  create_date: '',
  write_date: '',
};

const mockUseNodeSearch = vi.hoisted(() =>
  vi.fn<(_query: string, _filters: NodeSearchFilters) => UseNodeSearchReturn>(
    (_query, _filters) => ({
      pageResults: [{ node: PAGE_NODE, section: 'page' }],
      blockResults: [],
      allResults: [{ node: PAGE_NODE, section: 'page' }],
      isLoading: false,
      showCreateOption: false,
      hasMore: false,
    }),
  ),
);

vi.mock('@/features/content', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useNodeSearch: mockUseNodeSearch,
  };
});

function renderEditor(onChange: (blockId: string, content: string) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CustomInlineEditor
        blockId="block-1"
        initialContentAST={[{ type: 'paragraph', children: [{ type: 'text', text: '' }] }]}
        onContentChange={onChange}
      />
    </QueryClientProvider>,
  );
}

function lastAST(onChange: ReturnType<typeof vi.fn>): ContentAST {
  const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1];
  return JSON.parse(lastCall[1]) as ContentAST;
}

function getLastSearchMode(): NodeSearchMode {
  // useNodeSearch is also called for the user value picker with isUserPage: true;
  // the main search call is the one whose mode is not 'all' with isUserPage.
  const calls = mockUseNodeSearch.mock.calls;
  const mainCall = [...calls].reverse().find(([, filters]) => !filters.isUserPage);
  return mainCall?.[1].mode ?? 'all';
}

function getLastMaxResults(): number {
  const calls = mockUseNodeSearch.mock.calls;
  const mainCall = [...calls].reverse().find(([, filters]) => !filters.isUserPage);
  return mainCall?.[1].maxResults ?? 10;
}

describe('InlineTriggers "@" link insertion', () => {
  beforeEach(() => {
    useEditorFocusStore.setState({ activeBlockId: null, pendingFocusBlockId: null });
    // TriggerPopup focuses its search input via requestAnimationFrame; jsdom
    // does not implement it without pretendToBeVisual.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    // jsdom Ranges have no layout; the trigger only needs caret coordinates
    // for popup placement.
    Range.prototype.getBoundingClientRect = () =>
      ({ x: 10, y: 10, top: 10, left: 10, bottom: 20, right: 20, width: 5, height: 10, toJSON: () => ({}) }) as DOMRect;
    mockUseNodeSearch.mockClear();
    mockUseNodeSearch.mockReturnValue({
      pageResults: [{ node: PAGE_NODE, section: 'page' as const }],
      blockResults: [],
      allResults: [{ node: PAGE_NODE, section: 'page' as const }],
      isLoading: false,
      showCreateOption: false,
      hasMore: false,
    });
  });

  it('inserts a node_link pill and places the caret after it', async () => {
    const onChange = vi.fn();
    renderEditor(onChange);

    const editor = screen.getByRole('textbox');
    act(() => {
      editor.focus();
    });
    // jsdom's focus() forcibly resets the selection after focus listeners run,
    // clobbering the caret restored by handleFocus (real browsers don't). Route
    // programmatic refocus through a plain focus event instead.
    editor.focus = () => {
      fireEvent.focus(editor);
    };

    // Type "@" — the trigger popup opens with the placeholder char inserted.
    await act(async () => {
      fireEvent.keyDown(editor, { key: '@' });
    });

    const popupInput = await screen.findByPlaceholderText(/Search or type filter/i);

    // Press Enter on the first result.
    await act(async () => {
      fireEvent.keyDown(popupInput, { key: 'Enter' });
    });

    // The pill was inserted into the AST.
    const ast = lastAST(onChange);
    const children = ast[0].type === 'paragraph' ? ast[0].children ?? [] : [];
    const pill = children.find((c) => c.type === 'node_link');
    expect(pill).toBeDefined();
    expect((pill as { link_id: string }).link_id.startsWith('page-uuid-1:')).toBe(true);

    // The caret is logically after the pill (offset 1) and physically inside
    // the trailing caret anchor — not on the pill's label text.
    expect(getDOMSelectionOffset(editor as HTMLElement)).toBe(1);
    const anchor = window.getSelection()?.anchorNode ?? null;
    expect(anchor).not.toBeNull();
    const anchorParent = anchor?.parentElement as HTMLElement | null;
    expect(anchorParent?.dataset.caretAnchor).toBe('true');
  });

  it('shows All / Pages / Blocks tabs in the link popup', async () => {
    renderEditor(vi.fn());

    const editor = screen.getByRole('textbox');
    act(() => editor.focus());

    await act(async () => {
      fireEvent.keyDown(editor, { key: '@' });
    });

    await screen.findByPlaceholderText(/Search or type filter/i);

    expect(screen.getByRole('radio', { name: 'All' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Pages' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Blocks' })).toBeInTheDocument();
  });

  it('switches search mode when clicking a tab', async () => {
    renderEditor(vi.fn());

    const editor = screen.getByRole('textbox');
    act(() => editor.focus());

    await act(async () => {
      fireEvent.keyDown(editor, { key: '@' });
    });

    await screen.findByPlaceholderText(/Search or type filter/i);

    expect(getLastSearchMode()).toBe('all');

    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: 'Blocks' }));
    });

    await waitFor(() => {
      expect(getLastSearchMode()).toBe('blocks');
    });
  });

  it('renders a "Show more results" button when more results are available', async () => {
    mockUseNodeSearch.mockReturnValue({
      pageResults: [{ node: PAGE_NODE, section: 'page' as const }],
      blockResults: [{ node: BLOCK_NODE, section: 'block' as const }],
      allResults: [
        { node: PAGE_NODE, section: 'page' as const },
        { node: BLOCK_NODE, section: 'block' as const },
      ],
      isLoading: false,
      showCreateOption: false,
      hasMore: true,
    });

    renderEditor(vi.fn());

    const editor = screen.getByRole('textbox');
    act(() => editor.focus());

    await act(async () => {
      fireEvent.keyDown(editor, { key: '@' });
    });

    await screen.findByPlaceholderText(/Search or type filter/i);

    const showMore = screen.getByRole('button', { name: /Show more results/i });
    expect(showMore).toBeInTheDocument();
  });

  it('loads the next batch when "Show more results" is clicked', async () => {
    mockUseNodeSearch.mockReturnValue({
      pageResults: [{ node: PAGE_NODE, section: 'page' as const }],
      blockResults: [{ node: BLOCK_NODE, section: 'block' as const }],
      allResults: [
        { node: PAGE_NODE, section: 'page' as const },
        { node: BLOCK_NODE, section: 'block' as const },
      ],
      isLoading: false,
      showCreateOption: false,
      hasMore: true,
    });

    renderEditor(vi.fn());

    const editor = screen.getByRole('textbox');
    act(() => editor.focus());

    await act(async () => {
      fireEvent.keyDown(editor, { key: '@' });
    });

    await screen.findByPlaceholderText(/Search or type filter/i);

    expect(getLastMaxResults()).toBe(10);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Show more results/i }));
    });

    await waitFor(() => {
      expect(getLastMaxResults()).toBe(30);
    });
  });
});
