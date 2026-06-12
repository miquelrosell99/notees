import { describe, it, expect, beforeEach } from 'vitest';
import { useNavigationStore } from '@/stores/navigationStore';

const resetState = () =>
  useNavigationStore.setState({
    activeNodeId: null,
    currentNodeId: null,
    currentPropertyContext: null,
    sidebarOpen: true,
    isSidebarCollapsed: false,
    sidebarTab: 'pages',
    rightSidebarOpen: false,
    rightSidebarContent: null,
    sidebarNode: null,
    sidebarCards: [],
    localGraphNodeId: null,
    viewMode: 'default',
    preFocusModeSidebarCollapsed: null,
    mainViewType: 'node',
    currentPropertyId: null,
  });

beforeEach(resetState);

describe('navigationStore — openNode', () => {
  it('sets currentNodeId and mainViewType to node', () => {
    useNavigationStore.getState().openNode(42);
    const s = useNavigationStore.getState();
    expect(s.currentNodeId).toBe(42);
    expect(s.mainViewType).toBe('node');
    expect(s.currentPropertyContext).toBeNull();
  });

  it('stores propertyContext when provided', () => {
    useNavigationStore.getState().openNode(10, { propertyId: 5, propertyName: 'Status' });
    expect(useNavigationStore.getState().currentPropertyContext).toEqual({ propertyId: 5, propertyName: 'Status' });
  });
});

describe('navigationStore — sidebar', () => {
  it('toggleSidebar flips sidebarOpen and isSidebarCollapsed together', () => {
    useNavigationStore.getState().toggleSidebar();
    const s = useNavigationStore.getState();
    expect(s.sidebarOpen).toBe(false);
    expect(s.isSidebarCollapsed).toBe(true);
  });

  it('toggleRightSidebar flips rightSidebarOpen', () => {
    useNavigationStore.getState().toggleRightSidebar();
    expect(useNavigationStore.getState().rightSidebarOpen).toBe(true);
  });

  it('setSidebarTab updates sidebarTab', () => {
    useNavigationStore.getState().setSidebarTab('pages');
    expect(useNavigationStore.getState().sidebarTab).toBe('pages');
  });
});

describe('navigationStore — focus mode', () => {
  it('toggleFocusMode enters focus: collapses sidebar and saves prior state', () => {
    useNavigationStore.getState().toggleFocusMode();
    const s = useNavigationStore.getState();
    expect(s.viewMode).toBe('focus');
    expect(s.isSidebarCollapsed).toBe(true);
    expect(s.sidebarOpen).toBe(false);
    expect(s.preFocusModeSidebarCollapsed).toBe(false);
  });

  it('toggleFocusMode exits focus: restores prior sidebar state', () => {
    // Enter focus mode
    useNavigationStore.getState().toggleFocusMode();
    // Exit focus mode
    useNavigationStore.getState().toggleFocusMode();
    const s = useNavigationStore.getState();
    expect(s.viewMode).toBe('default');
    expect(s.isSidebarCollapsed).toBe(false);
    expect(s.sidebarOpen).toBe(true);
    expect(s.preFocusModeSidebarCollapsed).toBeNull();
  });
});

describe('navigationStore — sidebarCards', () => {
  it('addSidebarCard adds a new card and opens right sidebar', () => {
    useNavigationStore.getState().addSidebarCard(7, 'page');
    const s = useNavigationStore.getState();
    expect(s.sidebarCards).toHaveLength(1);
    expect(s.sidebarCards[0].nodeId).toBe(7);
    expect(s.sidebarCards[0].cardType).toBe('page');
    expect(s.rightSidebarOpen).toBe(true);
  });

  it('addSidebarCard deduplicates: moves existing card to front', () => {
    useNavigationStore.getState().addSidebarCard(7, 'page');
    useNavigationStore.getState().addSidebarCard(8, 'block');
    useNavigationStore.getState().addSidebarCard(7, 'page');
    const cards = useNavigationStore.getState().sidebarCards;
    expect(cards).toHaveLength(2);
    expect(cards[0].nodeId).toBe(7);
  });

  it('removeSidebarCard removes a card by id', () => {
    useNavigationStore.getState().addSidebarCard(5, 'block');
    const { sidebarCards } = useNavigationStore.getState();
    const cardId = sidebarCards[0].id;
    useNavigationStore.getState().removeSidebarCard(cardId);
    expect(useNavigationStore.getState().sidebarCards).toHaveLength(0);
  });

  it('clearSidebarCards empties the list', () => {
    useNavigationStore.getState().addSidebarCard(1, 'page');
    useNavigationStore.getState().addSidebarCard(2, 'localGraph');
    useNavigationStore.getState().clearSidebarCards();
    expect(useNavigationStore.getState().sidebarCards).toHaveLength(0);
  });
});

describe('navigationStore — local graph', () => {
  it('openLocalGraph sets localGraphNodeId', () => {
    useNavigationStore.getState().openLocalGraph(99);
    expect(useNavigationStore.getState().localGraphNodeId).toBe(99);
  });

  it('closeLocalGraph clears localGraphNodeId', () => {
    useNavigationStore.getState().openLocalGraph(99);
    useNavigationStore.getState().closeLocalGraph();
    expect(useNavigationStore.getState().localGraphNodeId).toBeNull();
  });
});

describe('navigationStore — property view', () => {
  it('openPropertyView sets mainViewType and currentPropertyId', () => {
    useNavigationStore.getState().openPropertyView(3);
    const s = useNavigationStore.getState();
    expect(s.mainViewType).toBe('property');
    expect(s.currentPropertyId).toBe(3);
  });
});
