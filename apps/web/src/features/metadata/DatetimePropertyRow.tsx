import { useRef, useState } from "react";

import {
  isRangeDatetimeValue,
  parseDateNodeId,
  type DatePrecision,
  type DatetimeSlot,
} from "@notees/domain";

import type { EffectiveProperty } from "@/core/workspace-client/index.js";

import { Icon } from "../../ui/Icon.js";
import { labelFromClient, datetimeValueText } from "../../ui/dateDisplay.js";
import { AddPill } from "../../components/ui/fleet/AddPill.js";
import {
  DatePickerPopup,
  type DatetimeCommitValue,
  type DatetimePickerSlot,
  type DatetimePickerValue,
} from "../date-pickers/DatePickerPopup.js";
import { collectMarkedDates } from "../date-pickers/DateSlotControl.js";
import { RepeatPicker } from "../date-pickers/RepeatPicker.js";
import { PropertySelectCell } from "./PropertySelectCell.js";
import type { AnyClient } from "./shared.js";
import { toEditableText } from "./shared.js";
import { isoOfRef, precisionOf, rangeSlotsOf, slotOf } from "./datetimeValue.js";

/**
 * One datetime property (SCHEMA.md "Datetime" — the unified date type):
 * the schema's effective rows render as pills, each value INDEPENDENTLY a
 * point ({ nodeId, time? }) or a range ({ start, end } of slots, either side
 * open) — a range rides ONE pill (`start → end`). Every pill opens the
 * canonical date-picker popup: the suggestions column, the All-day switch
 * (full-day is the default; off reveals the 24h time input), the Range
 * switch (off collapses to the point, start kept, end dropped), the Repeat
 * row (day precision), and Remove (unsets the edited element). Picking
 * ensures the year/month/day chain and links the node at the schema's
 * precision ({ nodeId } — the shape the edge index projects, so the year
 * node backlinks everything dated that year); the value's metadata rides
 * through (a re-pick keeps the recurrence rule; the series follows the
 * event).
 */
export function DatetimePropertyRow({
  client,
  nodeId,
  propertySchemaId,
  label,
  multi,
  schema,
  rows,
  /** Page navigation (the single-value cell's → button, owner 2026-10-20). */
  onOpenPage,
  /** Hide the label/hints (the host chrome carries them — the sidebar). */
  bare = false,
  /** Read-only projection: values render as static pills, no picker. */
  readOnly = false,
  /** Extra li class (the R4 ineligible rendering — " nt-property-ineligible"). */
  rowClassName = "",
}: {
  client: AnyClient;
  nodeId: string;
  propertySchemaId: string;
  label: string;
  multi: boolean;
  schema: { datePrecision?: DatePrecision | null } | null;
  rows: EffectiveProperty[];
  onOpenPage?: ((pageId: string) => void) | undefined;
  bare?: boolean;
  readOnly?: boolean | undefined;
  rowClassName?: string;
}) {
  const [pickerFor, setPickerFor] = useState<number | "new" | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const precision = precisionOf(schema);
  const markedDates = collectMarkedDates(client);

  const ordered = [...rows].sort((a, b) => a.idx - b.idx);
  const authoredIdx = ordered.filter((row) => row.source === "authored").map((row) => row.idx);
  const nextIdx = authoredIdx.length > 0 ? Math.max(...authoredIdx) + 1 : 0;

  /** The row being edited (null for the Add-pill's fresh picker). */
  const pickerRow =
    pickerFor === "new" ? undefined : ordered.find((row) => row.idx === pickerFor);

  /** The popup's working copy of the stored value (the full union as slots). */
  const pickerValue = (): DatetimePickerValue => {
    if (pickerRow === undefined) return { isRange: false, start: null, end: null };
    if (isRangeDatetimeValue(pickerRow.value)) {
      const slots = rangeSlotsOf(pickerRow.value);
      const toSlot = (slot: DatetimeSlot | null): DatetimePickerSlot | null => {
        if (slot === null) return null;
        const iso = isoOfRef(slot.nodeId);
        return iso === null ? null : slot.time !== undefined ? { iso, time: slot.time } : { iso };
      };
      return { isRange: true, start: toSlot(slots.start), end: toSlot(slots.end) };
    }
    const slot = slotOf(pickerRow.value);
    if (slot === null) return { isRange: false, start: null, end: null };
    const iso = isoOfRef(slot.nodeId);
    return {
      isRange: false,
      start: iso === null ? null : slot.time !== undefined ? { iso, time: slot.time } : { iso },
      end: null,
    };
  };

  /**
   * The popup's single commit funnel: the full union rides one write, the
   * slot's metadata (the recurrence rule) preserved across the edit. The
   * popup owns its closing — terminal commits (grid/suggestion/text) close
   * it through onClose; switch/time commits leave it open.
   */
  const commitPicker = (value: DatetimeCommitValue): Promise<void> => {
    const idx = pickerFor === "new" || pickerFor === null ? nextIdx : pickerFor;
    const metadata = ordered.find((row) => row.idx === idx)?.metadata ?? undefined;
    return client.setDatetimeProperty(nodeId, propertySchemaId, value, idx, metadata);
  };

  /** The popup's Remove: unset the element being edited. */
  const removePicked = () => {
    if (pickerRow !== undefined && pickerRow.source === "authored") {
      void client.unsetProperty(nodeId, propertySchemaId, pickerRow.idx);
    }
    setPickerFor(null);
  };

  /** The repeat write (the popup's Repeat row): merge/clear `repeat`. */
  const setRepeat = async (row: EffectiveProperty, rule: string | null): Promise<void> => {
    const metadata: Record<string, unknown> = { ...(row.metadata ?? {}) };
    if (rule === null) delete metadata.repeat;
    else metadata.repeat = rule;
    await client.setProperty(nodeId, propertySchemaId, row.value, row.idx, metadata);
  };

  const pillText = (row: EffectiveProperty): string => {
    const text = datetimeValueText(row.value);
    if (text !== null) return text;
    return toEditableText(row.value); // scalar binding default, shown as-is
  };

  const allDefault = rows.length > 0 && rows.every((row) => row.source === "default");
  const classSourced = rows.some((row) => row.boundBy !== null);

  /** The popup (shared by the single-value and multi branches). */
  const picker = pickerFor !== null && (
    <DatePickerPopup
      value={pickerValue()}
      precision={precision}
      onCommit={(value) => commitPicker(value)}
      onRemove={
        pickerRow !== undefined && pickerRow.source === "authored" ? removePicked : undefined
      }
      onClose={() => setPickerFor(null)}
      anchorRef={anchorRef}
      firstDayOfWeek={1}
      markedDates={markedDates}
      repeat={typeof pickerRow?.metadata?.repeat === "string" ? pickerRow.metadata.repeat : null}
      onRepeatChange={
        pickerRow !== undefined && pickerRow.source === "authored" && precision === "day"
          ? (rule) => void setRepeat(pickerRow, rule)
          : undefined
      }
    />
  );

  // Single-value: the selection dropdown (owner 2026-10-09) — empty renders
  // the "Select" placeholder across the full value cell; the committed value
  // rides the trigger content as the date's display text (datetimeValueText —
  // a range renders `start → end`); the canonical popup edits the element
  // (its Range switch replaces the old two-slot treatment).
  if (multi === false) {
    const single =
      [...ordered].reverse().find((row) => row.source === "authored") ?? ordered[0];
    const singleSlot = slotOf(single?.value) ?? rangeSlotsOf(single?.value).start;
    const singleRef = singleSlot?.nodeId ?? null;
    if (readOnly) {
      const text =
        single === undefined
          ? null
          : singleRef !== null && parseDateNodeId(singleRef) === null
            ? (labelFromClient(client, singleRef) ?? "Untitled")
            : pillText(single);
      if (text === null || text === "") {
        return (
          <li
            className={
              allDefault
                ? `nt-property nt-property-default nt-property-date node-metadata-row${rowClassName}`
                : `nt-property nt-property-date node-metadata-row${rowClassName}`
            }
          >
            {!bare && (
              <>
                <span className="section-label nt-property-name" data-property-schema-id={propertySchemaId}>{label}{classSourced && <span className="nt-property-hint" title="From a class">C</span>}</span>
              </>
            )}
          </li>
        );
      }
      return (
        <li
          className={
            allDefault
              ? `nt-property nt-property-default nt-property-date node-metadata-row${rowClassName}`
              : `nt-property nt-property-date node-metadata-row${rowClassName}`
          }
        >
          {!bare && (
            <>
              <span className="section-label nt-property-name" data-property-schema-id={propertySchemaId}>{label}{classSourced && <span className="nt-property-hint" title="From a class">C</span>}</span>
            </>
          )}
          <span className="nt-property-chips node-metadata-pills">
            <span className={single?.source === "default" ? "pill pill--default" : "pill"}>
              <span className="pill__text nt-chip-label">{text}</span>
            </span>
          </span>
        </li>
      );
    }
    return (
      <li
        className={
          allDefault
            ? `nt-property nt-property-default nt-property-date node-metadata-row${rowClassName}`
            : `nt-property nt-property-date node-metadata-row${rowClassName}`
        }
      >
        {!bare && (
          <>
            <span className="section-label nt-property-name" data-property-schema-id={propertySchemaId}>{label}{classSourced && <span className="nt-property-hint" title="From a class">C</span>}</span>
          </>
        )}
        <PropertySelectCell
          client={client}
          valueRef={singleRef}
          ariaLabel={`Set ${label}`}
          isOpen={pickerFor !== null}
          onToggle={(anchor) => {
            anchorRef.current = anchor;
            setPickerFor((cur) =>
              cur === null ? (single !== undefined ? single.idx : "new") : null,
            );
          }}
          clearLabel={`Clear ${label}`}
          onClear={
            single !== undefined && single.source === "authored"
              ? () => void client.unsetProperty(nodeId, propertySchemaId, single.idx)
              : undefined
          }
          onNavigate={
            singleRef !== null
              ? () => {
                  // A date ref jumps to its day page (chain ensured, the
                  // table DateCell precedent); anything else opens as a node.
                  const iso = isoOfRef(singleRef);
                  if (iso !== null) {
                    void client.ensureDateChain(iso).then(({ day }) => onOpenPage?.(day));
                  } else {
                    onOpenPage?.(singleRef);
                  }
                }
              : undefined
          }
          navigateLabel={
            singleRef !== null
              ? `Open ${labelFromClient(client, singleRef) ?? "Untitled"}`
              : undefined
          }
          trailing={
            single !== undefined && single.source === "authored" && precision === "day" ? (
              <RepeatPicker
                value={typeof single.metadata?.repeat === "string" ? single.metadata.repeat : null}
                onChange={(rule) => void setRepeat(single, rule)}
                ariaLabel={`Repeat for ${label}`}
                iconOnly
              />
            ) : undefined
          }
        >
          {singleRef !== null
            ? parseDateNodeId(singleRef) !== null
              ? pillText(single!)
              : (labelFromClient(client, singleRef) ?? "Untitled")
            : null}
        </PropertySelectCell>
        {picker}
      </li>
    );
  }

  return (
    <li
      className={
        allDefault
          ? `nt-property nt-property-default nt-property-date node-metadata-row${rowClassName}`
          : `nt-property nt-property-date node-metadata-row${rowClassName}`
      }
    >
      {!bare && (
        <>
          <span className="section-label nt-property-name" data-property-schema-id={propertySchemaId}>{label}{classSourced && <span className="nt-property-hint" title="From a class">C</span>}</span>
        </>
      )}
      <span className="nt-property-chips node-metadata-pills">
        {ordered.map((row) =>
          readOnly ? (
            <span
              key={`${propertySchemaId}:${row.idx}`}
              className={row.source === "default" ? "pill pill--default" : "pill"}
            >
              <span className="pill__text nt-chip-label">{pillText(row)}</span>
            </span>
          ) : (
            <span
              key={`${propertySchemaId}:${row.idx}`}
              className={
                row.source === "default"
                  ? "pill pill--default"
                  : "pill pill--hover-reveal-right"
              }
            >
              <button
                type="button"
                className="pill__text nt-chip-label"
                aria-label={`Set ${label}`}
                aria-expanded={pickerFor === row.idx}
                onClick={(event) => {
                  anchorRef.current = event.currentTarget;
                  setPickerFor((cur) => (cur === row.idx ? null : row.idx));
                }}
              >
                {pillText(row)}
              </button>
              {row.source === "authored" && (
                <button
                  type="button"
                  className="pill__right-button nt-chip-remove"
                  aria-label={`Clear ${label}`}
                  onClick={() => void client.unsetProperty(nodeId, propertySchemaId, row.idx)}
                >
                  <Icon path="mdi-close" size={0.6} />
                </button>
              )}
              {row.source === "authored" && precision === "day" && (
                <RepeatPicker
                  value={
                    typeof row.metadata?.repeat === "string" ? row.metadata.repeat : null
                  }
                  onChange={(rule) => void setRepeat(row, rule)}
                  ariaLabel={`Repeat for ${label}`}
                  iconOnly
                />
              )}
            </span>
          ),
        )}
        {!readOnly && (
          <AddPill
            label="Add"
            aria-expanded={pickerFor === "new"}
            onClick={(element) => {
              anchorRef.current = element;
              setPickerFor((cur) => (cur === "new" ? null : "new"));
            }}
          />
        )}
      </span>
      {picker}
    </li>
  );
}
