/**
 * The datetime domain (SCHEMA.md "Datetime" — a date is a node, not a
 * string): the year/month/day chain ensure + heal, the schema-precision ref
 * resolution, the unified point/range datetime write, and the annotation
 * write (composed from the primitive ops in types.ts's createAnnotation).
 * Standalone domain — takes the reads, reads-props, and writes domains, no
 * inheritance.
 */

import {
  chainNodeIds,
  dateNodeId,
  dateNodeLabel,
  parseIsoDate,
  SYSTEM_CLASS_UUIDS,
  type DatePrecision,
  type DatetimeSlot,
} from "@notees/domain";

import {
  createAnnotation,
  type CreateAnnotationInput,
  type DatetimePointInput,
  type DatetimeValueInput,
} from "./types.js";
import { WorkspaceClientReads } from "./client-reads.js";
import { WorkspaceClientReadsProps } from "./client-reads-props.js";
import { WorkspaceClientWrites } from "./client-writes.js";

export class WorkspaceClientDates {
  constructor(
    private readonly reads: WorkspaceClientReads,
    private readonly props: WorkspaceClientReadsProps,
    private readonly writes: WorkspaceClientWrites,
  ) {}

  // --- dates (SCHEMA.md "Datetime" — a date is a node, not a string) ----------

  /** The schema's date precision (default day when the row predates the field). */
  private datePrecisionOf(propertySchemaId: string): DatePrecision {
    const schema = this.props.listPropertySchemas().find((s) => s.id === propertySchemaId);
    return schema?.datePrecision ?? "day";
  }

  /**
   * Ensure the year/month/day node chain for an ISO date exists (journal
   * layout: year as a workspace-root page, month under year, day under month,
   * named by the compact labels) and return the three deterministic ids.
   * Ids are content-addressed from the date (@notees/domain dates.ts), so a
   * re-run creates nothing — the client-level existence check is op-log
   * hygiene, not correctness; even a raced create is an applier no-op.
   * "Exists" also means LIVE: a trashed or archived chain node is restored
   * (owner bug 2026-10-22 — the listing reads filter `is_active = 1`, so a
   * trashed day page made the ensure a silent no-op while the journal
   * showed nothing for today).
   */
  async ensureDateChain(
    isoDate: string,
  ): Promise<{ year: string; month: string; day: string }> {
    const parts = parseIsoDate(isoDate);
    const ids = chainNodeIds(isoDate);
    if (this.reads.getNodeRaw(ids.year) === undefined) {
      await this.writes.createObject({
        id: ids.year,
        isEmbedded: false,
        parentId: null,
        name: dateNodeLabel(parts, "year"),
        classIds: [SYSTEM_CLASS_UUIDS.year],
      });
    }
    if (this.reads.getNodeRaw(ids.month) === undefined) {
      await this.writes.createObject({
        id: ids.month,
        isEmbedded: false,
        parentId: ids.year,
        name: dateNodeLabel(parts, "month"),
        classIds: [SYSTEM_CLASS_UUIDS.month],
      });
    }
    if (this.reads.getNodeRaw(ids.day) === undefined) {
      await this.writes.createObject({
        id: ids.day,
        isEmbedded: false,
        parentId: ids.month,
        name: dateNodeLabel(parts, "day"),
        classIds: [SYSTEM_CLASS_UUIDS.day],
      });
    }
    // A trashed (or archived) chain node is not "ensured" for the journal:
    // every normal read filters `is_active = 1` (client-reads listPages), so
    // with a trashed today page the feed stayed empty for today while the
    // existence checks above no-op'd — and Jump to today landed on a past
    // day (owner bug 2026-10-22). Restore brings the node back live;
    // object.restore no-ops on active nodes, and as a log-ordered op it
    // wins over the earlier delete.
    const ensureLive = async (id: string): Promise<void> => {
      if (this.reads.getNodeRaw(id) !== undefined && this.reads.getNode(id) === undefined) {
        await this.writes.restoreObject(id);
      }
    };
    await ensureLive(ids.year);
    await ensureLive(ids.month);
    await ensureLive(ids.day);
    // Heal the chain parentage AND labels: older writers created chain nodes
    // parentless and with ISO-dashed content ("2026-10-05"); the stored label
    // must be the compact form ("20261005" — the lookup/sort contract), so
    // an existing-but-wrong level is rewritten, idempotently — one op per
    // stray, only while it actually differs.
    const healLevel = async (
      id: string,
      parentId: string | null,
      precision: "year" | "month" | "day",
    ): Promise<void> => {
      const node = this.reads.getNodeRaw(id);
      if (node === undefined) return;
      if ((node.parentId ?? null) !== parentId) {
        await this.writes.moveObject(id, parentId);
      }
      const label = dateNodeLabel(parts, precision);
      const first = node.contentAst[0];
      const text =
        first !== undefined && (first as { type?: unknown }).type === "text"
          ? String((first as { text?: unknown }).text ?? "")
          : "";
      if (text !== label) {
        await this.writes.updateObject(id, { contentAst: [{ type: "text", text: label }] });
      }
    };
    await healLevel(ids.year, null, "year");
    await healLevel(ids.month, ids.year, "month");
    await healLevel(ids.day, ids.month, "day");
    return ids;
  }

  /** Create/refresh the chain and return the node id at the schema's precision. */
  private async dateRefFor(isoDate: string, precision: DatePrecision): Promise<string> {
    const ids = await this.ensureDateChain(isoDate);
    return precision === "year" ? ids.year : precision === "month" ? ids.month : ids.day;
  }

  /**
   * Set a datetime property value (SCHEMA.md "Datetime" — the unified date
   * type): ensure the chain(s), then write the value union — a point
   * `{ "nodeId": …, "time"?: "HH:MM" }` or a range `{ "start", "end" }` of
   * slots, either side open. Refs land at the schema's precision (the edge
   * index projects them, so the year node backlinks everything dated that
   * year); a `time` rides ONLY a day-precision anchor (schema ceiling AND
   * day ref) — passing one at year/month precision fails loud. One chain is
   * ensured per distinct day. Editing overwrites the same slot's ref;
   * `metadata` passes through (recurrence rides it).
   */
  async setDatetimeProperty(
    objectId: string,
    propertySchemaId: string,
    value: DatetimeValueInput,
    idx = 0,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const precision = this.datePrecisionOf(propertySchemaId);
    const slotOf = async (input: DatetimePointInput): Promise<DatetimeSlot> => {
      if (input.time !== undefined && precision !== "day") {
        throw new Error(
          `datetime time requires day precision (schema ${propertySchemaId} is ${precision})`,
        );
      }
      const nodeId = await this.dateRefFor(input.iso, precision);
      return input.time !== undefined ? { nodeId, time: input.time } : { nodeId };
    };
    if ("start" in value || "end" in value) {
      const rangeInput = value as {
        start?: DatetimePointInput | null;
        end?: DatetimePointInput | null;
      };
      const range: { start: DatetimeSlot | null; end: DatetimeSlot | null } = {
        start: null,
        end: null,
      };
      if (rangeInput.start !== null && rangeInput.start !== undefined) {
        range.start = await slotOf(rangeInput.start);
      }
      if (rangeInput.end !== null && rangeInput.end !== undefined) {
        range.end = await slotOf(rangeInput.end);
      }
      await this.writes.setProperty(objectId, propertySchemaId, range, idx, metadata);
      return;
    }
    const slot = await slotOf(value);
    await this.writes.setProperty(objectId, propertySchemaId, slot, idx, metadata);
  }

  /**
   * Create an annotation on an asset (the composed write behind the chips'
   * annotations form): the highlight-classed object named by the quote
   * excerpt, the highlight_asset link, the provenance text, and the optional
   * note child block. Applied locally, push kicked off.
   */
  createAnnotation(input: CreateAnnotationInput): Promise<string> {
    return createAnnotation(this.writes, input);
  }
}
