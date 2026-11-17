import { BridgeOfflineError } from "../bridge/client";
import type { Bridge, BridgeResponse } from "../bridge/types";
import { collectCitationNodeIds } from "../citation/collect";
import { bibliographyFieldXml, type ScannedField } from "../citation/ooxml";
import { CapabilityError, scanDocument } from "./document";
import type { WordFieldAccess } from "./refresh";

export type BibliographyOutcome =
  | { status: "inserted"; nodeCount: number }
  | { status: "replaced"; nodeCount: number; /** Bibliography fields beyond the first — the user duplicated one; never silently left counted. */ extra: number }
  | { status: "no-citations" }
  | { status: "offline" }
  | { status: "render-failed"; code: string; message: string }
  | { status: "scan-failed" }
  | { status: "write-failed"; message: string };

/**
 * Where the bibliography paragraph goes: replace the paragraph holding the
 * FIRST bibliography field, or append a new paragraph at the body end.
 * Pure — the testable decision half of insertOrReplaceBibliography.
 */
export function bibliographyTarget(
  fields: ScannedField[],
): { kind: "replace"; index: number } | { kind: "append" } {
  for (let i = 0; i < fields.length; i += 1) {
    if (fields[i].kind === "bibliography") return { kind: "replace", index: i };
  }
  return { kind: "append" };
}

/**
 * The ONLY Word-runtime seam the bibliography write goes through: append a
 * whole paragraph at the body end, or replace the whole paragraph holding the
 * field at that scan index. Faked in tests.
 */
export interface BibliographyWriter {
  appendParagraph(xml: string): Promise<void>;
  replaceParagraphAtField(fieldIndex: number, xml: string): Promise<void>;
}

function bibliographyParagraphXml(styleId: string, displayText: string): string {
  // Same wrapper contract as citationParagraphXml: the fldSimple run must be a
  // direct child of w:p and the w namespace declared for a bare paragraph.
  return `<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${bibliographyFieldXml({ styleId }, displayText)}</w:p>`;
}

/**
 * Desktop writer: `body.fields` locates the field to replace (WordApi 1.5);
 * OOXML insertion rewrites the paragraph. Throws CapabilityError when the
 * host lacks OOXML paragraph insertion (Word for the web) or rejects a write.
 */
export function bodyBibliographyWriter(): BibliographyWriter {
  const ensureWritable = () => {
    if (!Office.context.requirements.isSetSupported("WordApi", "1.5")) {
      throw new CapabilityError(
        "bibliography-insert",
        "This Word host cannot insert a bibliography (OOXML insertion requires WordApi 1.5 — use the Word desktop app).",
      );
    }
  };
  return {
    appendParagraph: async (xml) => {
      ensureWritable();
      try {
        await Word.run(async (context) => {
          context.document.body.insertOoxml(xml, Word.InsertLocation.end);
          await context.sync();
        });
      } catch (cause) {
        throw new CapabilityError("bibliography-insert", "The Word host rejected the bibliography insert.", { cause });
      }
    },
    replaceParagraphAtField: async (fieldIndex, xml) => {
      ensureWritable();
      try {
        await Word.run(async (context) => {
          const fields = context.document.body.fields;
          fields.load("items");
          await context.sync();
          const field = fields.items[fieldIndex];
          if (field === undefined) {
            throw new CapabilityError("bibliography-insert", "Bibliography field disappeared before it could be replaced.");
          }
          const paragraph = field.result.getRange().paragraphs.getFirst();
          paragraph.getRange().insertOoxml(xml, Word.InsertLocation.replace);
          await context.sync();
        });
      } catch (cause) {
        if (cause instanceof CapabilityError) throw cause;
        throw new CapabilityError("bibliography-insert", "The Word host rejected the bibliography replace.", { cause });
      }
    },
  };
}

/**
 * Insert the one bibliography field, or replace the existing one in place:
 * collects the document's citation node ids (document order, deduplicated),
 * renders the bibliography through the bridge, and writes a single
 * `ADDIN notees.Bibliography` field. A second call replaces the first —
 * never two bibliographies. When the user duplicated the field, the FIRST is
 * replaced and the extras are reported in the outcome, never silently left.
 *
 * Never throws; every failure mode is a distinct outcome for the pane
 * (bridge-offline vs render-failure vs host-write vs no citations yet).
 */
export async function insertOrReplaceBibliography(
  bridge: Bridge,
  styleId: string,
  fieldsApi: WordFieldAccess,
  writer: BibliographyWriter,
): Promise<BibliographyOutcome> {
  let fields: ScannedField[];
  try {
    fields = await scanDocument(fieldsApi);
  } catch {
    return { status: "scan-failed" };
  }
  const nodeIds = collectCitationNodeIds(fields);
  if (nodeIds.length === 0) {
    // Honest "nothing to cite" — never an empty bibliography field.
    return { status: "no-citations" };
  }
  const target = bibliographyTarget(fields);
  const bibliographyCount = fields.filter((f) => f.kind === "bibliography").length;
  const extra = target.kind === "replace" ? bibliographyCount - 1 : 0;

  let res: BridgeResponse<{ bibliography: string }>;
  try {
    res = await bridge.renderBibliography(nodeIds, styleId);
  } catch (e) {
    if (e instanceof BridgeOfflineError) return { status: "offline" };
    return {
      status: "render-failed",
      code: "shape",
      message: e instanceof Error ? e.message : String(e),
    };
  }
  if (!res.ok) {
    return { status: "render-failed", code: res.error.code, message: res.error.message };
  }

  const xml = bibliographyParagraphXml(styleId, res.bibliography);
  try {
    if (target.kind === "replace") {
      await writer.replaceParagraphAtField(target.index, xml);
    } else {
      await writer.appendParagraph(xml);
    }
  } catch (e) {
    return { status: "write-failed", message: e instanceof Error ? e.message : String(e) };
  }
  return target.kind === "replace"
    ? { status: "replaced", nodeCount: nodeIds.length, extra }
    : { status: "inserted", nodeCount: nodeIds.length };
}

/** Pane copy for a bibliography run. */
export function describeBibliographyOutcome(outcome: BibliographyOutcome): string {
  switch (outcome.status) {
    case "inserted":
      return `bibliography inserted (${String(outcome.nodeCount)} sources)`;
    case "replaced":
      return outcome.extra > 0
        ? `bibliography replaced (${String(outcome.nodeCount)} sources) · ${String(outcome.extra)} extra bibliography field${outcome.extra === 1 ? "" : "s"} left in the document`
        : `bibliography replaced (${String(outcome.nodeCount)} sources)`;
    case "no-citations":
      return "no Notees citations in this document yet";
    case "offline":
      return "Notees bridge unreachable — the bibliography was not written";
    case "render-failed":
      return `bibliography render failed (${outcome.code}): ${outcome.message}`;
    case "scan-failed":
      return "could not scan the document fields — nothing was written";
    case "write-failed":
      return outcome.message;
  }
}
