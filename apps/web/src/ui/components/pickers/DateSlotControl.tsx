/**
 * DateSlotControl — one shared date-slot editor for every surface that
 * commits a single day-precision date (§34.32 PG17): the metadata panel's
 * date_range start/end slots and date-qualified link qualifiers, and the
 * table view's date cells. One implementation, one picker (the zoom
 * DatePickerPopup — no native date inputs), one clear contract.
 *
 * The control is deliberately dumb about the write: `onCommit` receives the
 * picked ISO day (or null when cleared) and the caller decides what the
 * value means — a date-chain node reference for property values
 * (ensureDateChain at the call site), a bare ISO qualifier for metadata.
 */

import { useMemo, useRef, useState, type RefObject } from "react";

import { parseDateNodeId, SYSTEM_CLASS_UUIDS, type DatePrecision } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { DatePickerPopup } from "./DatePickerPopup.js";
import "./DateSlotControl.css";

type AnyClient = WorkspaceClient | WorkerClient;

/**
 * Day keys (`y-m0-d`, 0-indexed month) backed by an existing day node — the
 * date picker's has-note marks. Shared by every DateSlotControl instance and
 * the panel's date row; computed per picker open, not per render.
 */
export function collectMarkedDates(client: AnyClient): Set<string> {
  const dates = new Set<string>();
  for (const node of client.listPages()) {
    if (!node.classIds.includes(SYSTEM_CLASS_UUIDS.day)) continue;
    const parsed = parseDateNodeId(node.id);
    if (parsed !== null) {
      dates.add(`${parsed.year}-${parsed.month - 1}-${parsed.day}`);
    }
  }
  return dates;
}

export interface DateSlotControlProps {
  client: AnyClient;
  /** The committed value as an ISO day ("2026-09-27"), null when unset. */
  value: string | null;
  /** Button text; defaults to the value itself ("…" when unset). */
  display?: string;
  ariaLabel: string;
  /** The schema's commit ceiling (day when unspecified). */
  precision?: DatePrecision;
  /** Clear affordance; off (or nothing to clear) renders no ×. */
  clearable?: boolean;
  clearLabel?: string;
  onCommit: (iso: string | null) => void;
}

export function DateSlotControl({
  client,
  value,
  display,
  ariaLabel,
  precision = "day",
  clearable = true,
  clearLabel,
  onCommit,
}: DateSlotControlProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const text = display ?? value ?? "…";

  return (
    <span className="nt-dateslot">
      <button
        type="button"
        ref={anchorRef}
        className="nt-dateslot__button"
        aria-label={ariaLabel}
        aria-expanded={open}
        onClick={() => setOpen((cur) => !cur)}
      >
        {text}
      </button>
      {clearable && value !== null && (
        <button
          type="button"
          className="nt-dateslot__clear"
          aria-label={clearLabel ?? `${ariaLabel} (clear)`}
          onClick={() => onCommit(null)}
        >
          ×
        </button>
      )}
      {open && (
        <DateSlotPicker
          client={client}
          value={value}
          precision={precision}
          anchorRef={anchorRef}
          onSelect={(iso) => {
            setOpen(false);
            onCommit(iso);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  );
}

function DateSlotPicker({
  client,
  value,
  precision,
  anchorRef,
  onSelect,
  onClose,
}: {
  client: AnyClient;
  value: string | null;
  precision: DatePrecision;
  anchorRef: RefObject<HTMLButtonElement | null>;
  onSelect: (iso: string) => void;
  onClose: () => void;
}) {
  const markedDates = useMemo(() => collectMarkedDates(client), [client]);
  return (
    <DatePickerPopup
      value={value ?? ""}
      onSelect={onSelect}
      onClose={onClose}
      anchorRef={anchorRef}
      initialMode={precision === "year" ? "years" : precision === "month" ? "months" : "days"}
      firstDayOfWeek={1}
      markedDates={markedDates}
    />
  );
}
