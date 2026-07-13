import { describe, it, expect, beforeEach } from 'vitest';
import { usePinnedPagesStore } from '@/stores/pinnedPagesStore';

beforeEach(() => {
  usePinnedPagesStore.setState({ pinnedPages: [] });
});

describe('pinnedPagesStore — pinPage', () => {
  it('appends a page to the pinned list', () => {
    usePinnedPagesStore.getState().pinPage('page-1');
    expect(usePinnedPagesStore.getState().pinnedPages).toEqual(['page-1']);
  });

  it('is idempotent — pinning twice does not duplicate', () => {
    const { pinPage } = usePinnedPagesStore.getState();
    pinPage('page-1');
    pinPage('page-1');
    expect(usePinnedPagesStore.getState().pinnedPages).toEqual(['page-1']);
  });

  it('preserves insertion order across multiple pins', () => {
    const { pinPage } = usePinnedPagesStore.getState();
    pinPage('page-1');
    pinPage('page-2');
    pinPage('page-3');
    expect(usePinnedPagesStore.getState().pinnedPages).toEqual(['page-1', 'page-2', 'page-3']);
  });
});

describe('pinnedPagesStore — unpinPage', () => {
  it('removes the page from the pinned list', () => {
    const store = usePinnedPagesStore.getState();
    store.pinPage('page-1');
    store.pinPage('page-2');
    usePinnedPagesStore.getState().unpinPage('page-1');
    expect(usePinnedPagesStore.getState().pinnedPages).toEqual(['page-2']);
  });

  it('is a no-op for pages that are not pinned', () => {
    usePinnedPagesStore.getState().pinPage('page-1');
    usePinnedPagesStore.getState().unpinPage('page-99');
    expect(usePinnedPagesStore.getState().pinnedPages).toEqual(['page-1']);
  });
});

describe('pinnedPagesStore — togglePin', () => {
  it('pins an unpinned page', () => {
    usePinnedPagesStore.getState().togglePin('page-1');
    expect(usePinnedPagesStore.getState().pinnedPages).toEqual(['page-1']);
  });

  it('unpins a pinned page', () => {
    usePinnedPagesStore.getState().pinPage('page-1');
    usePinnedPagesStore.getState().togglePin('page-1');
    expect(usePinnedPagesStore.getState().pinnedPages).toEqual([]);
  });
});
