import { BridgeOfflineError } from "../bridge/client";
import type { Bridge, BridgeResponse } from "../bridge/types";
import { planRefresh, isSkippedField } from "../citation/refresh-plan";
import {
  buildCitationCode,
  withStyle,
} from "../citation/embed";
import { scanDocumentXml, classify, type ScannedField } from "../citation/ooxml";
import { CapabilityError, scanDocument } from "./document";

export interface RefreshOutcome {
  /** Fields whose display text was rewritten from a fresh render. */
  refreshed: number;
  /** Foreign/corrupted citation-code fields left untouched (never bibliographies). */
  skipped: number;
  /** Fields whose render or update failed; their existing text is preserved. */
  failed: number;
}

/**
 * The ONLY Word-runtime seam refresh goes through. `listFields` returns every
 * field's instruction code + current display text in stable document order;
 * `updateResultText` rewrites the display text of the field at that index;
 * `updateCode` rewrites the field's instruction code (used by the explicit
 * restyle action). Implemented over `body.fields` (Word desktop) and over a
 * read-only OOXML scan (other hosts) — and faked in tests, which is why this
 * is an interface.
 */
export interface WordFieldAccess {
  listFields(): Promise<{ code: string; resultText: string }[]>;
  updateResultText(index: number, text: string): Promise<void>;
  updateCode(index: number, code: string): Promise<void>;
}

/**
 * Rescan every field and re-render each notees citation in place, using the
 * styleId + locator stored in the field's own embed (a document-level style
 * switch never rewrites fields implicitly).
 *
 * Never throws and never corrupts: a field whose render fails keeps its text;
 * a hand-corrupted embed is skipped, not deleted; a thrown BridgeOfflineError
 * aborts the remaining fields and the counts report completed work only
 * (unattempted fields appear in none of the three counters).
 */
export async function refreshCitations(
  bridge: Bridge,
  fieldsApi: WordFieldAccess,
): Promise<RefreshOutcome> {
  let fields: ScannedField[];
  try {
    fields = await scanDocument(fieldsApi);
  } catch {
    // The document could not be scanned at all — report zero progress rather
    // than throwing; the pane shows the scan failure from the zero outcome.
    return { refreshed: 0, skipped: 0, failed: 0 };
  }
  const plan = planRefresh(fields);
  const outcome: RefreshOutcome = {
    refreshed: 0,
    skipped: fields.filter(isSkippedField).length,
    failed: 0,
  };
  for (const entry of plan) {
    let res: BridgeResponse<{ citation: string }>;
    try {
      res = await bridge.renderCitation(entry.embed.nodeIds, entry.embed.styleId, entry.embed.locator);
    } catch (e) {
      if (e instanceof BridgeOfflineError) break;
      // Shape/host render error: per-field failure, never aborts the rest.
      outcome.failed += 1;
      continue;
    }
    if (!res.ok) {
      outcome.failed += 1;
      continue;
    }
    try {
      await fieldsApi.updateResultText(entry.fieldIndex, res.citation);
      outcome.refreshed += 1;
    } catch {
      outcome.failed += 1;
    }
  }
  return outcome;
}

/** Pane copy for a refresh run: "2 refreshed · 1 skipped (foreign/corrupted) · 0 failed". */
export function describeRefreshOutcome(outcome: RefreshOutcome): string {
  return `${String(outcome.refreshed)} refreshed · ${String(outcome.skipped)} skipped (foreign/corrupted) · ${String(outcome.failed)} failed`;
}

export interface RestyleRewriteOutcome {
  /** Citation fields whose embed code was rewritten to the picked style. */
  rewritten: number;
  /** Foreign/corrupted fields left untouched. */
  skipped: number;
  /** Code rewrites rejected by the host; the field keeps its old code. */
  failed: number;
}

/**
 * Rewrite every well-formed citation field's embed to carry `styleId` —
 * the explicit half of "Refresh all with this style". Never throws and never
 * corrupts: the SAME `classify` scanDocument uses decides what counts — a
 * foreign or hand-corrupted code is skipped byte-identical and reported in
 * `skipped`, a bibliography field is simply not a citation and is left alone
 * uncounted; a host rejection of one rewrite counts as failed and never
 * aborts the remaining fields. A scan failure reports a zero outcome.
 */
export async function rewriteCitationStyles(
  fieldsApi: WordFieldAccess,
  styleId: string,
): Promise<RestyleRewriteOutcome> {
  let raw: { code: string; resultText: string }[];
  try {
    raw = await fieldsApi.listFields();
  } catch {
    return { rewritten: 0, skipped: 0, failed: 0 };
  }
  const outcome: RestyleRewriteOutcome = { rewritten: 0, skipped: 0, failed: 0 };
  for (const [index, field] of raw.entries()) {
    const { kind, embed } = classify(field.code.trim());
    if (kind !== "citation" || embed === null || !("nodeIds" in embed)) {
      if (kind === "foreign") outcome.skipped += 1;
      continue;
    }
    try {
      await fieldsApi.updateCode(index, buildCitationCode(withStyle(embed, styleId)));
      outcome.rewritten += 1;
    } catch {
      outcome.failed += 1;
    }
  }
  return outcome;
}

export interface RestyleOutcome extends RestyleRewriteOutcome {
  /**
   * "restyled": the rewrite ran and refresh re-rendered from the new embeds.
   * "unknown-style": `styleId` was not in the bridge's loaded style list, so
   * NOTHING was rewritten or refreshed — the document is untouched (the
   * persisted pick went stale: style removed from the styles dir, re-paired
   * workspace, …).
   */
  status: "restyled" | "unknown-style";
  /** The refresh run over the just-rewritten embeds (zeroed for unknown-style). */
  refresh: RefreshOutcome;
}

/**
 * "Refresh all with this style": validate `styleId` against the bridge's
 * loaded style list FIRST — an unknown style must never reach the rewrite
 * pass (it would re-embed every citation in an unrenderable style). Only a
 * known style rewrites every citation embed's styleId in the field code and
 * then runs the normal refresh so each field re-renders from its own (now
 * updated) embed. Both halves go through the same WordFieldAccess seam, so a
 * read-only host degrades exactly like refresh does.
 */
export async function restyleAllCitations(
  bridge: Bridge,
  fieldsApi: WordFieldAccess,
  styleId: string,
  knownStyleIds: string[],
): Promise<RestyleOutcome> {
  if (!knownStyleIds.includes(styleId)) {
    return {
      status: "unknown-style",
      rewritten: 0,
      skipped: 0,
      failed: 0,
      refresh: { refreshed: 0, skipped: 0, failed: 0 },
    };
  }
  const rewrite = await rewriteCitationStyles(fieldsApi, styleId);
  const refresh = await refreshCitations(bridge, fieldsApi);
  return { status: "restyled", ...rewrite, refresh };
}

/** Pane copy for a restyle run: "3 restyled · 3 refreshed · 0 skipped (foreign/corrupted) · 0 failed". */
export function describeRestyleOutcome(outcome: RestyleOutcome): string {
  if (outcome.status === "unknown-style") {
    return "The picked style is not available from the bridge — nothing was rewritten. Reload styles and pick a listed one.";
  }
  return `${String(outcome.rewritten)} restyled · ${String(outcome.refresh.refreshed)} refreshed · ${String(outcome.skipped + outcome.refresh.skipped)} skipped (foreign/corrupted) · ${String(outcome.failed + outcome.refresh.failed)} failed`;
}

/**
 * Desktop field access over `body.fields` (WordApi 1.5): codes and result
 * text load in one sync; an update replaces the field's result-range text,
 * which keeps the field itself intact.
 */
export function bodyFieldAccess(): WordFieldAccess {
  return {
    listFields: () =>
      Word.run(async (context) => {
        const fields = context.document.body.fields;
        fields.load("code, result");
        await context.sync();
        return fields.items.map((f) => ({ code: f.code, resultText: f.result.text }));
      }),
    updateResultText: (index, text) =>
      Word.run(async (context) => {
        const fields = context.document.body.fields;
        fields.load("items");
        await context.sync();
        const field = fields.items[index];
        if (field === undefined) {
          throw new CapabilityError("field-update", "Field disappeared before its text could be updated.");
        }
        field.result.insertText(text, Word.InsertLocation.replace);
        await context.sync();
      }),
    updateCode: (index, code) =>
      Word.run(async (context) => {
        const fields = context.document.body.fields;
        fields.load("items");
        await context.sync();
        const field = fields.items[index];
        if (field === undefined) {
          throw new CapabilityError("field-update", "Field disappeared before its code could be updated.");
        }
        field.code = code;
        await context.sync();
      }),
  };
}

/**
 * Fallback for hosts without WordApi 1.5 field access (Word for the web):
 * fields are listed via an OOXML body dump + the pure scanner, but neither
 * their display text nor their field code can be rewritten —
 * `updateResultText`/`updateCode` reject with a CapabilityError. Refresh and
 * restyle on such a host report the degradation up front and never touch the
 * document.
 */
export function readOnlyFieldAccess(): WordFieldAccess {
  return {
    listFields: async () => {
      const xml = await Word.run(async (context) => {
        const ooxml = context.document.body.getOoxml();
        await context.sync();
        return ooxml.value;
      });
      return scanDocumentXml(xml).map((f) => ({ code: f.code, resultText: f.displayText }));
    },
    updateResultText: () =>
      Promise.reject(
        new CapabilityError(
          "field-update",
          "Citation fields are read-only on this Word host — open the document in the Word desktop app to refresh.",
        ),
      ),
    updateCode: () =>
      Promise.reject(
        new CapabilityError(
          "field-update",
          "Citation fields are read-only on this Word host — open the document in the Word desktop app to restyle.",
        ),
      ),
  };
}

/**
 * Pick the field access for the current host: writable `body.fields` when the
 * host supports WordApi 1.5, else the read-only OOXML scan. Any capability
 * probe failure degrades to read-only — never to a broken document.
 */
export function wordFieldAccess(): { access: WordFieldAccess; writable: boolean } {
  try {
    if (Office.context.requirements.isSetSupported("WordApi", "1.5")) {
      return { access: bodyFieldAccess(), writable: true };
    }
  } catch {
    // Fall through to the read-only access.
  }
  return { access: readOnlyFieldAccess(), writable: false };
}
