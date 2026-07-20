import { describe, it, expect, beforeEach } from 'vitest';
import { useModalStore } from '@/stores/modalStore';

beforeEach(() => {
  useModalStore.setState({
    isCalendarOpen: false,

    isCommandPaletteOpen: false,
    isImportDataModalOpen: false,
    isImportMarkdownModalOpen: false,
    isImportLogseqFolderModalOpen: false,
    isExportPageModalOpen: false,
    isRebuildLinksModalOpen: false,
    isFixRawLinksModalOpen: false,
    isMergePagesModalOpen: false,
    showWorkspaceManager: false,
    isMinimapOpen: false,
    isScratchpadOpen: false,
  });
});

describe('modalStore — setters', () => {
  it('setCalendarOpen sets isCalendarOpen', () => {
    useModalStore.getState().setCalendarOpen(true);
    expect(useModalStore.getState().isCalendarOpen).toBe(true);
    useModalStore.getState().setCalendarOpen(false);
    expect(useModalStore.getState().isCalendarOpen).toBe(false);
  });

  it('setCommandPaletteOpen sets isCommandPaletteOpen', () => {
    useModalStore.getState().setCommandPaletteOpen(true);
    expect(useModalStore.getState().isCommandPaletteOpen).toBe(true);
  });

  it('setImportDataModalOpen sets isImportDataModalOpen', () => {
    useModalStore.getState().setImportDataModalOpen(true);
    expect(useModalStore.getState().isImportDataModalOpen).toBe(true);
  });

  it('setImportMarkdownModalOpen sets isImportMarkdownModalOpen', () => {
    useModalStore.getState().setImportMarkdownModalOpen(true);
    expect(useModalStore.getState().isImportMarkdownModalOpen).toBe(true);
  });

  it('setImportLogseqFolderModalOpen sets isImportLogseqFolderModalOpen', () => {
    useModalStore.getState().setImportLogseqFolderModalOpen(true);
    expect(useModalStore.getState().isImportLogseqFolderModalOpen).toBe(true);
  });

  it('setExportPageModalOpen sets isExportPageModalOpen', () => {
    useModalStore.getState().setExportPageModalOpen(true);
    expect(useModalStore.getState().isExportPageModalOpen).toBe(true);
  });

  it('setRebuildLinksModalOpen sets isRebuildLinksModalOpen', () => {
    useModalStore.getState().setRebuildLinksModalOpen(true);
    expect(useModalStore.getState().isRebuildLinksModalOpen).toBe(true);
  });

  it('setFixRawLinksModalOpen sets isFixRawLinksModalOpen', () => {
    useModalStore.getState().setFixRawLinksModalOpen(true);
    expect(useModalStore.getState().isFixRawLinksModalOpen).toBe(true);
  });

  it('setMergePagesModalOpen sets isMergePagesModalOpen', () => {
    useModalStore.getState().setMergePagesModalOpen(true);
    expect(useModalStore.getState().isMergePagesModalOpen).toBe(true);
  });

  it('setShowWorkspaceManager sets showWorkspaceManager', () => {
    useModalStore.getState().setShowWorkspaceManager(true);
    expect(useModalStore.getState().showWorkspaceManager).toBe(true);
  });

  it('setMinimapOpen sets isMinimapOpen', () => {
    useModalStore.getState().setMinimapOpen(true);
    expect(useModalStore.getState().isMinimapOpen).toBe(true);
  });

  it('setScratchpadOpen sets isScratchpadOpen', () => {
    useModalStore.getState().setScratchpadOpen(true);
    expect(useModalStore.getState().isScratchpadOpen).toBe(true);
  });
});

describe('modalStore — toggles', () => {
  it('toggleCalendar flips isCalendarOpen', () => {
    expect(useModalStore.getState().isCalendarOpen).toBe(false);
    useModalStore.getState().toggleCalendar();
    expect(useModalStore.getState().isCalendarOpen).toBe(true);
    useModalStore.getState().toggleCalendar();
    expect(useModalStore.getState().isCalendarOpen).toBe(false);
  });

  it('toggleCommandPalette flips isCommandPaletteOpen', () => {
    useModalStore.getState().toggleCommandPalette();
    expect(useModalStore.getState().isCommandPaletteOpen).toBe(true);
    useModalStore.getState().toggleCommandPalette();
    expect(useModalStore.getState().isCommandPaletteOpen).toBe(false);
  });

  it('toggleMinimap flips isMinimapOpen', () => {
    useModalStore.getState().toggleMinimap();
    expect(useModalStore.getState().isMinimapOpen).toBe(true);
  });

  it('toggleScratchpad flips isScratchpadOpen', () => {
    useModalStore.getState().toggleScratchpad();
    expect(useModalStore.getState().isScratchpadOpen).toBe(true);
  });
});

describe('modalStore — isolation', () => {
  it('opening one modal does not affect others', () => {
    useModalStore.getState().setCalendarOpen(true);
    const state = useModalStore.getState();

    expect(state.isCommandPaletteOpen).toBe(false);
    expect(state.showWorkspaceManager).toBe(false);
  });
});
