/**
 * PDF font bundle (§34.24 P1) — Gentium, SIL Open Font License v1.1.
 *
 * Privacy law: the fonts are repo assets (src/assets/fonts/, OFL.txt
 * alongside) bundled at build time — the PDF renderer never fetches from a
 * CDN at runtime. Vite emits the four TTFs as static asset files referenced
 * by URL, so they leave the JS bundle entirely and are only requested when
 * the lazily-imported PDF engine actually renders.
 *
 * Registration runs once per module load; the module is only loaded on the
 * first PDF export/preview (dynamic import from the export modal), so the
 * font descriptors cost nothing until then.
 */

import { Font } from "@react-pdf/renderer";

import regularUrl from "../../assets/fonts/Gentium-Regular.ttf?url";
import boldUrl from "../../assets/fonts/Gentium-Bold.ttf?url";
import italicUrl from "../../assets/fonts/Gentium-Italic.ttf?url";
import boldItalicUrl from "../../assets/fonts/Gentium-BoldItalic.ttf?url";

/** The serif family every layout themes around. */
export const PDF_SERIF_FAMILY = "Gentium";

Font.register({
  family: PDF_SERIF_FAMILY,
  fonts: [
    { src: regularUrl },
    { src: boldUrl, fontWeight: 700 },
    { src: italicUrl, fontStyle: "italic" },
    { src: boldItalicUrl, fontWeight: 700, fontStyle: "italic" },
  ],
});
