import { describe, it, expect, beforeEach } from 'vitest';
import { useNavigationStore } from '@/stores/navigationStore';

const resetState = () =>
  useNavigationStore.setState({
    activeNodeUuid: null,
    currentNodeUuid: null,
    currentPropertyContext: null,
    sidebarOpen: true,
    isSidebarCollapsed: false,
    sidebarTab: 'pages',
    rightSidebarOpen: false,
    rightSidebarContent: null,
    sidebarNode: null,
    sidebarCards: [],
    localGraphNodeUuid: null,
    viewMode: 'default',
    preFocusModeSidebarCollapsed: null,
    mainViewType: 'node',
    currentPropertyUuid: null,
  });

beforeEach(resetState);

describe('navigationStore — openNode', () => {
  it('sets currentNodeUuid and mainViewType to node', () => {
    useNavigationStore.getState().openNode('node-uuid-42');
    const s = useNavigationStore.getState();
    expect(s.currentNodeUuid).toBe('node-uuid-42');
    expect(s.mainViewType).toBe('node');
    expect(s.currentPropertyContext).toBeNull();
  });

  it('stores propertyContext when provided', () => {
    useNavigationStore.getState().openNode('node-uuid-10', { propertyUuid: 'prop-uuid-5', propertyName: 'Status' });
    expect(useNavigationStore.getState().currentPropertyContext).toEqual({ propertyUuid: 'prop-uuid-5', propertyName: 'Status' });
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
    useNavigationStore.getState().addSidebarCard('node-uuid-7', 'page');
    const s = useNavigationStore.getState();
    expect(s.sidebarCards).toHaveLength(1);
    expect(s.sidebarCards[0].nodeUuid).toBe('node-uuid-7');
    expect(s.sidebarCards[0].cardType).toBe('page');
    expect(s.rightSidebarOpen).toBe(true);
  });

  it('addSidebarCard deduplicates: moves existing card to front', () => {
    useNavigationStore.getState().addSidebarCard('node-uuid-7', 'page');
    useNavigationStore.getState().addSidebarCard('node-uuid-8', 'block');
    useNavigationStore.getState().addSidebarCard('node-uuid-7', 'page');
    const cards = useNavigationStore.getState().sidebarCards;
    expect(cards).toHaveLength(2);
    expect(cards[0].nodeUuid).toBe('node-uuid-7');
  });

  it('removeSidebarCard removes a card by id', () => {
    useNavigationStore.getState().addSidebarCard('node-uuid-5', 'block');
    const { sidebarCards } = useNavigationStore.getState();
    const cardId = sidebarCards[0].nodeUuid;
    useNavigationStore.getState().removeSidebarCard(cardId);
    expect(useNavigationStore.getState().sidebarCards).toHaveLength(0);
  });

  it('clearSidebarCards empties the list', () => {
    useNavigationStore.getState().addSidebarCard('node-uuid-1', 'page');
    useNavigationStore.getState().addSidebarCard('node-uuid-2', 'localGraph');
    useNavigationStore.getState().clearSidebarCards();
    expect(useNavigationStore.getState().sidebarCards).toHaveLength(0);
  });
});

describe('navigationStore — local graph', () => {
  it('openLocalGraph sets localGraphNodeUuid', () => {
    useNavigationStore.getState().openLocalGraph('node-uuid-99');
    expect(useNavigationStore.getState().localGraphNodeUuid).toBe('node-uuid-99');
  });

  it('closeLocalGraph clears localGraphNodeUuid', () => {
    useNavigationStore.getState().openLocalGraph('node-uuid-99');
    useNavigationStore.getState().closeLocalGraph();
    expect(useNavigationStore.getState().localGraphNodeUuid).toBeNull();
  });
});

describe('navigationStore — property view', () => {
  it('openPropertyView sets mainViewType and currentPropertyUuid', () => {
    useNavigationStore.getState().openPropertyView('prop-uuid-3');
    const s = useNavigationStore.getState();
    expect(s.mainViewType).toBe('property');
    expect(s.currentPropertyUuid).toBe('prop-uuid-3');
  });
});
