import { BridgeOfflineError, BridgeShapeError } from "../bridge/client";
import type { BridgeResponse } from "../bridge/types";
import type { CitationEmbed } from "./embed";

export type RenderCitationFn = (
  objectIds: string[],
  styleId: string,
  locator?: string,
) => Promise<BridgeResponse<{ citation: string }>>;

export type InsertCitationFn = (embed: CitationEmbed, displayText: string) => Promise<void>;

export type CiteError =
  | { kind: "offline" }
  | { kind: "shape"; message: string }
  | { kind: "bridge"; code: string; message: string }
  | { kind: "insert"; message: string };

export type CiteOutcome = { ok: true } | { ok: false; error: CiteError };

export interface CiteDeps {
  renderCitation: RenderCitationFn;
  insertCitation: InsertCitationFn;
  /** Caller-owned minting: one fresh citationId per successful cite. */
  newCitationId: () => string;
}

export interface CiteTarget {
  objectId: string;
  styleId: string;
  locator?: string;
}

function renderThrowError(e: unknown): CiteError {
  if (e instanceof BridgeOfflineError) return { kind: "offline" };
  if (e instanceof BridgeShapeError) return { kind: "shape", message: e.detail };
  return {
    kind: "bridge",
    code: "unknown",
    message: e instanceof Error ? e.message : String(e),
  };
}

/**
 * The Cite decision core for one search result: render via the bridge, then
 * insert as a citation field with a freshly minted citationId. Framework-free
 * with fully injected seams (same pattern as insertCitationFieldWith) so the
 * headline flow is logic-testable without React or a Word host.
 *
 * Never fails silently: every failure mode (offline, malformed bridge payload,
 * command-level render error, host insert rejection) comes back as a
 * classified `CiteError` for the pane to surface. A blank locator is
 * normalized to `undefined` here so the embed stays free of empty strings.
 */
export async function citeResult(deps: CiteDeps, target: CiteTarget): Promise<CiteOutcome> {
  const trimmed = target.locator?.trim();
  const locator = trimmed ? trimmed : undefined;
  let res: BridgeResponse<{ citation: string }>;
  try {
    res = await deps.renderCitation([target.objectId], target.styleId, locator);
  } catch (e) {
    return { ok: false, error: renderThrowError(e) };
  }
  if (!res.ok) {
    // The bridge client synthesizes { code: "shape" } for a malformed wire
    // payload — a shape failure, not a server-side render error.
    const error: CiteError =
      res.error.code === "shape"
        ? { kind: "shape", message: res.error.message }
        : { kind: "bridge", code: res.error.code, message: res.error.message };
    return { ok: false, error };
  }
  const embed: CitationEmbed = {
    citationId: deps.newCitationId(),
    nodeIds: [target.objectId],
    styleId: target.styleId,
    locator,
  };
  try {
    await deps.insertCitation(embed, res.citation);
  } catch (e) {
    return {
      ok: false,
      error: { kind: "insert", message: e instanceof Error ? e.message : String(e) },
    };
  }
  return { ok: true };
}

export function citeErrorMessage(error: CiteError): string {
  switch (error.kind) {
    case "offline":
      return "Bridge offline — is notees serve running?";
    case "shape":
      return `Bridge returned an unexpected payload: ${error.message}`;
    case "bridge":
      return `Could not render the citation (${error.code}): ${error.message}`;
    case "insert":
      return error.message;
  }
}
