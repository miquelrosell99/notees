/**
 * fetchMetadataFill — the detail pane's "Fetch metadata": the resolver-backed
 * fill for an EXISTING source (the Add Source dialog owns the create-time
 * fetch; this is its on-node counterpart, the same shape the CLI's
 * `notees source fetch-metadata` implements). Resolve the node's DOI (else
 * its PMID) and fill the properties the node does not already hold:
 *
 *  - Notees-wins (the zotero-rdf import's contract): an authored value
 *    survives, never clobbered; the title and the class are the node's own
 *    identity, never rewritten; authors/editors fill only when the node
 *    holds no authored rows (the citation track present wins).
 *  - Locality: a field the node's class closure may not carry never fills
 *    (isSchemaEligibleForNode — scopeClassIds is the sole authority), even
 *    though the resolver already filtered `fields` to the RESOLVED class's
 *    own bindings — the node may carry a different source type.
 *  - The publication date rides the year date-chain node (ensure-then-link,
 *    the imports' idiom).
 *
 * Plan/apply split: planFetchMetadataFill is pure over the client read +
 * the record (unit-testable without a store write); applyFetchMetadataFill
 * performs the writes (one write per filled field — the same granularity
 * the properties table authors, so each fill undoes like any property edit).
 */

import {
  SYSTEM_PROPERTY_UUIDS,
  type SystemPropertyName,
} from "@notees/domain";

import type { AnyClient } from "../../ui/app/clients.js";
import type { ClientNode } from "../../core/workspace-client/index.js";
import { isSchemaEligibleForNode } from "../metadata/schemaEligibility.js";
import type { ResolvedSourceRecord } from "./resolver.js";

export type FetchMetadataIdentifier = { kind: "doi" | "pmid"; value: string };

/** The first resolvable identifier on the source: authored DOI, else PMID. */
export function sourceIdentifierOf(client: AnyClient, nodeId: string): FetchMetadataIdentifier | null {
  const effective = client.getEffectiveProperties(nodeId);
  for (const kind of ["doi", "pmid"] as const) {
    const schemaId = SYSTEM_PROPERTY_UUIDS[kind];
    const row = effective.find(
      (entry) => entry.propertySchemaId === schemaId && entry.source === "authored",
    );
    const value = row?.value;
    if (typeof value === "string" && value.trim() !== "") {
      return { kind, value: value.trim() };
    }
  }
  return null;
}

/** Authored-with-a-value schema ids — the Notees-wins "already held" set. */
function heldSchemaIds(client: AnyClient, nodeId: string): Set<string> {
  const held = new Set<string>();
  for (const row of client.getEffectiveProperties(nodeId)) {
    if (row.source !== "authored") continue;
    const value = row.value;
    const empty =
      value === null ||
      value === undefined ||
      (typeof value === "string" && value.trim() === "");
    if (!empty) held.add(row.propertySchemaId);
  }
  return held;
}

export interface FetchMetadataPlan {
  identifier: FetchMetadataIdentifier;
  /** Scalar fills (the record's venue fields + the base-family extras). */
  fills: Array<{ schemaId: string; name: string; value: string }>;
  /** The year date-chain fill (null when held or the record carries no year). */
  dateYear: number | null;
  /** Text-track creator fills (null when held or the record names none). */
  authors: string[] | null;
  editors: string[] | null;
}

export function planIsEmpty(plan: FetchMetadataPlan): boolean {
  return plan.fills.length === 0 && plan.dateYear === null && plan.authors === null && plan.editors === null;
}

/** The filled-field display names (the button's outcome line). */
export function planFillNames(plan: FetchMetadataPlan, schemaName: (schemaId: string) => string): string[] {
  return [
    ...plan.fills.map((fill) => fill.name),
    ...(plan.dateYear !== null ? [schemaName(SYSTEM_PROPERTY_UUIDS.publicationDate)] : []),
    ...(plan.authors !== null ? [schemaName(SYSTEM_PROPERTY_UUIDS.authors)] : []),
    ...(plan.editors !== null ? [schemaName(SYSTEM_PROPERTY_UUIDS.editors)] : []),
  ];
}

export function planFetchMetadataFill(
  client: AnyClient,
  node: ClientNode,
  record: ResolvedSourceRecord,
): FetchMetadataPlan {
  const identifier = sourceIdentifierOf(client, node.id);
  if (identifier === null) {
    throw new Error("This source has no DOI or PMID to fetch with.");
  }
  const held = heldSchemaIds(client, node.id);
  const schemasById = new Map(client.listPropertySchemas().map((schema) => [schema.id, schema]));
  const fills: FetchMetadataPlan["fills"] = [];
  const push = (key: SystemPropertyName, value: string | undefined): void => {
    if (value === undefined || value.length === 0) return;
    const schemaId = SYSTEM_PROPERTY_UUIDS[key];
    if (held.has(schemaId)) return;
    const schema = schemasById.get(schemaId);
    if (schema === undefined || !isSchemaEligibleForNode(client, schema, node)) return;
    fills.push({ schemaId, name: schema.name, value });
  };
  // The record's fields are already the RESOLVED class's own venue bindings;
  // the eligibility re-gate above covers a node carrying a different type.
  for (const [key, value] of Object.entries(record.fields)) {
    push(key as SystemPropertyName, value);
  }
  // Base-family extras the record carries top-level (a PMID-resolved record
  // may still hand back the DOI — and vice versa).
  push("doi", record.doi);
  push("isbn", record.isbn);
  push("pmid", record.pmid);
  push("pmcid", record.pmcid);
  push("url", record.url);
  push("publisher", record.publisher);
  const dateYear =
    record.year !== undefined && !held.has(SYSTEM_PROPERTY_UUIDS.publicationDate)
      ? record.year
      : null;
  const authors =
    record.authors.some((literal) => literal.length > 0) && !held.has(SYSTEM_PROPERTY_UUIDS.authors)
      ? record.authors.filter((literal) => literal.length > 0)
      : null;
  const editors =
    record.editors.some((literal) => literal.length > 0) && !held.has(SYSTEM_PROPERTY_UUIDS.editors)
      ? record.editors.filter((literal) => literal.length > 0)
      : null;
  return { identifier, fills, dateYear, authors, editors };
}

export async function applyFetchMetadataFill(
  client: AnyClient,
  nodeId: string,
  plan: FetchMetadataPlan,
): Promise<void> {
  for (const fill of plan.fills) {
    await client.setProperty(nodeId, fill.schemaId, fill.value);
  }
  if (plan.dateYear !== null) {
    // The year node's id is content-addressed, so ensure-then-link is
    // idempotent — the import's date-chain idiom.
    const iso = `${plan.dateYear}-01-01`;
    await client.ensureDateChain(iso);
    await client.setDatetimeProperty(nodeId, SYSTEM_PROPERTY_UUIDS.publicationDate, { iso });
  }
  if (plan.authors !== null) {
    for (const [idx, literal] of plan.authors.entries()) {
      await client.setProperty(nodeId, SYSTEM_PROPERTY_UUIDS.authors, literal, idx);
    }
  }
  if (plan.editors !== null) {
    for (const [idx, literal] of plan.editors.entries()) {
      await client.setProperty(nodeId, SYSTEM_PROPERTY_UUIDS.editors, literal, idx);
    }
  }
}
