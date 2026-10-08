/**
 * PDF layout themes — the Notes/Essay/Academic
 * render themes as data. react-pdf has no stylesheets, so the app token
 * VALUES (apps/web/src/ui/variables.css, light theme) live here as the
 * constants the Notes theme is built from; this file is the single place a
 * literal may appear (the html serializer keeps the same discipline with its
 * `--nt-*` token block). Essay/Academic are typographic variations over the
 * same bundled Gentium serif.
 *
 *  - Notes    — the app's look: warm-paper page, colored mention/chip pills,
 *               sans (Helvetica) headings over the serif body, accent rules.
 *  - Essay    — single column, generous margins, the bundled serif for
 *               headings and body, quiet chrome.
 *  - Academic — two-column body ({@link twoColumnBody}; the document splits
 *               its blocks across two flex Views), numbered outline headings,
 *               tighter margins.
 */

export type PdfLayout = "notes" | "essay" | "academic";

export interface PdfThemeColors {
  text: string;
  muted: string;
  accent: string;
  /** Page background (Notes: the warm paper canvas; Essay/Academic: white). */
  paper: string;
  /** Bordered boxes (asset placeholders, verbatim JSON). */
  surfaceVariant: string;
  /** Inline pill background (mentions/chips). */
  pill: string;
  pillText: string;
  rule: string;
  highlight: string;
}

export interface PdfTheme {
  layout: PdfLayout;
  page: { paddingTop: number; paddingBottom: number; paddingLeft: number; paddingRight: number };
  fonts: { heading: string; body: string; mono: string };
  type: { bodySize: number; bodyLineHeight: number; titleSize: number; outlineTitleSize: number };
  colors: PdfThemeColors;
  /** Academic: the body renders as two flex Views side by side. */
  twoColumnBody: boolean;
  /** Column gap in pt when {@link twoColumnBody}. */
  columnGap: number;
  /** Academic: outline entries render "1.", "1.1.", … numbering. */
  numberedHeadings: boolean;
}

export const PDF_THEMES: Record<PdfLayout, PdfTheme> = {
  notes: {
    layout: "notes",
    page: { paddingTop: 56, paddingBottom: 56, paddingLeft: 56, paddingRight: 56 },
    fonts: { heading: "Helvetica", body: "Gentium", mono: "Courier" },
    type: { bodySize: 10.5, bodyLineHeight: 1.6, titleSize: 22, outlineTitleSize: 13 },
    colors: {
      // The app's light-token values (--color-on-surface / on-surface-variant
      // / background / surface-variant / outline-variant), inlined because
      // react-pdf has no stylesheet access. The accent is deliberately a
      // neutral ink, not --color-accent: an exported document cannot know
      // the reader's live accent preset.
      text: "#221a13",
      muted: "#5c544c",
      accent: "#404040",
      paper: "#f7f4ec",
      surfaceVariant: "#edeae2",
      pill: "#edeae2",
      pillText: "#5c544c",
      rule: "#e8e6e3",
      highlight: "#ece4b8",
    },
    twoColumnBody: false,
    columnGap: 18,
    numberedHeadings: false,
  },
  essay: {
    layout: "essay",
    page: { paddingTop: 72, paddingBottom: 72, paddingLeft: 72, paddingRight: 72 },
    fonts: { heading: "Gentium", body: "Gentium", mono: "Courier" },
    type: { bodySize: 11, bodyLineHeight: 1.75, titleSize: 24, outlineTitleSize: 13 },
    colors: {
      text: "#1a1a1a",
      muted: "#5c5c5c",
      accent: "#404040",
      paper: "#ffffff",
      surfaceVariant: "#f5f5f5",
      pill: "#f5f5f5",
      pillText: "#5c5c5c",
      rule: "#e3e3e3",
      highlight: "#ece4b8",
    },
    twoColumnBody: false,
    columnGap: 18,
    numberedHeadings: false,
  },
  academic: {
    layout: "academic",
    page: { paddingTop: 48, paddingBottom: 48, paddingLeft: 46, paddingRight: 46 },
    fonts: { heading: "Gentium", body: "Gentium", mono: "Courier" },
    type: { bodySize: 9.5, bodyLineHeight: 1.5, titleSize: 18, outlineTitleSize: 11.5 },
    colors: {
      text: "#1a1a1a",
      muted: "#5c5c5c",
      accent: "#1a1a1a",
      paper: "#ffffff",
      surfaceVariant: "#f5f5f5",
      pill: "#f5f5f5",
      pillText: "#5c5c5c",
      rule: "#dcdcdc",
      highlight: "#ece4b8",
    },
    twoColumnBody: true,
    columnGap: 16,
    numberedHeadings: true,
  },
};
