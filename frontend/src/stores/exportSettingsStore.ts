/**
 * Export settings store using Zustand with localStorage persistence.
 *
 * Persists all export options (format, layout, style, etc.) so they
 * are remembered across export modal sessions.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ExportFormat = 'markdown' | 'html' | 'pdf';
export type ExportLayout = 'outline' | 'flat';
export type ExportStyle = 'modern' | 'editorial' | 'technical' | 'book';
export type ExportProperties = 'none' | 'main' | 'all';
export type ExportDensity = 'comfortable' | 'compact';
export type ExportNumbering = 'none' | 'hierarchical' | 'legal' | 'appendix';
export type ExportMeasure = 'full' | 'readable' | 'book' | 'two-column';
export type ExportDoctype = 'none' | 'article' | 'report' | 'book' | 'legal' | 'academic';
export type ExportLinkStyle = 'raw' | 'text';
export type ExportThemeMode = 'light' | 'dark';

interface ExportSettingsState {
  format: ExportFormat;
  layout: ExportLayout;
  style: ExportStyle;
  properties: ExportProperties;
  density: ExportDensity;
  numbering: ExportNumbering;
  measure: ExportMeasure;
  doctype: ExportDoctype;
  sectionBreak: boolean;
  formatting: boolean;
  showUuid: boolean;
  linkStyle: ExportLinkStyle;
  cssOverrides: string;
  themeMode: ExportThemeMode;
  coverPage: boolean;

  setFormat: (format: ExportFormat) => void;
  setLayout: (layout: ExportLayout) => void;
  setStyle: (style: ExportStyle) => void;
  setProperties: (properties: ExportProperties) => void;
  setDensity: (density: ExportDensity) => void;
  setNumbering: (numbering: ExportNumbering) => void;
  setMeasure: (measure: ExportMeasure) => void;
  setDoctype: (doctype: ExportDoctype) => void;
  setSectionBreak: (sectionBreak: boolean) => void;
  setFormatting: (formatting: boolean) => void;
  setShowUuid: (showUuid: boolean) => void;
  setLinkStyle: (linkStyle: ExportLinkStyle) => void;
  setCssOverrides: (cssOverrides: string) => void;
  setThemeMode: (themeMode: ExportThemeMode) => void;
  setCoverPage: (coverPage: boolean) => void;
  applyPreset: (preset: 'casual' | 'editorial' | 'technical' | 'book') => void;
}

export const useExportSettingsStore = create<ExportSettingsState>()(
  persist(
    (set) => ({
      format: 'markdown',
      layout: 'outline',
      style: 'modern',
      properties: 'main',
      density: 'comfortable',
      numbering: 'none',
      measure: 'full',
      doctype: 'none',
      sectionBreak: false,
      formatting: true,
      showUuid: false,
      linkStyle: 'raw',
      cssOverrides: '',
      themeMode: 'light',
      coverPage: false,

      setFormat: (format) => set({ format }),
      setLayout: (layout) => set({ layout }),
      setStyle: (style) => set({ style }),
      setProperties: (properties) => set({ properties }),
      setDensity: (density) => set({ density }),
      setNumbering: (numbering) => set({ numbering }),
      setMeasure: (measure) => set({ measure }),
      setDoctype: (doctype) => set({ doctype }),
      setSectionBreak: (sectionBreak) => set({ sectionBreak }),
      setFormatting: (formatting) => set({ formatting }),
      setShowUuid: (showUuid) => set({ showUuid }),
      setLinkStyle: (linkStyle) => set({ linkStyle }),
      setCssOverrides: (cssOverrides) => set({ cssOverrides }),
      setThemeMode: (themeMode) => set({ themeMode }),
      setCoverPage: (coverPage) => set({ coverPage }),

      applyPreset: (preset: 'casual' | 'editorial' | 'technical' | 'book') => {
        if (preset === 'casual') {
          set({
            style: 'modern',
            density: 'comfortable',
            measure: 'readable',
            numbering: 'none',
            doctype: 'article',
            sectionBreak: false,
            formatting: true,
            layout: 'outline',
            themeMode: 'light',
            coverPage: false,
          });
        } else if (preset === 'editorial') {
          set({
            style: 'editorial',
            density: 'comfortable',
            measure: 'readable',
            numbering: 'none',
            doctype: 'article',
            sectionBreak: false,
            formatting: true,
            layout: 'outline',
            themeMode: 'light',
            coverPage: true,
          });
        } else if (preset === 'technical') {
          set({
            style: 'technical',
            density: 'compact',
            measure: 'full',
            numbering: 'hierarchical',
            doctype: 'report',
            sectionBreak: true,
            formatting: true,
            layout: 'flat',
            themeMode: 'light',
            coverPage: true,
          });
        } else if (preset === 'book') {
          set({
            style: 'book',
            density: 'comfortable',
            measure: 'book',
            numbering: 'hierarchical',
            doctype: 'book',
            sectionBreak: true,
            formatting: true,
            layout: 'flat',
            themeMode: 'light',
            coverPage: true,
          });
        }
      },
    }),
    {
      name: 'export-settings',
    },
  ),
);
