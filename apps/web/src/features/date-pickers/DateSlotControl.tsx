/**
 * DateSlotControl — one shared date-slot trigger for every surface that
 * commits a single day-precision date: date-qualified link qualifiers
 * (the remaining consumer after the datetime picker redesign — the panel
 * row and the table cells open the canonical DatePickerPopup directly).
 * One implementation, one picker (the canonical DatePickerPopup — no native
 * date inputs), one clear contract.
 *
 * The control is deliberately dumb about the write: `onCommit` receives the
 * picked ISO day (or null when cleared) and the caller decides what the
 * value means — a bare ISO qualifier for metadata (the applier normalizes
 * on write), a date-chain node reference elsewhere.
 *
 * The popup rides reduced chrome (no range, no time, no Remove — the ×
 * affordance owns clearing), so the qualifier write path keeps its bare-ISO
 * semantics.
 */

import { useMemo, useRef, useState } from "react";

import { parseDateNodeId, SYSTEM_CLASS_UUIDS, type DatePrecision } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client/index.js";

import { Icon } from "../../ui/Icon.js";
import { DatePickerPopup } from "./DatePickerPopup.js";
import "./DateSlotControl.css";

type AnyClient = WorkspaceClient | WorkerClient;

/**
 * Day keys (`y-m0-d`, 0-indexed month) backed by an existing day node — the
 * date picker's has-note marks. Shared by every picker instance; computed
 * per picker open, not per render.
 */
export function collectMarkedDates(client: AnyClient): Set<string> {
  const dates = new Set<string>();
  for (const node of client.listPageSummaries()) {
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
  const markedDates = useMemo(() => (open ? collectMarkedDates(client) : new Set<string>()), [client, open]);

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
          <Icon path="mdi-close" size={0.7} />
        </button>
      )}
      {open && (
        <DatePickerPopup
          value={{ isRange: false, start: value !== null ? { iso: value } : null, end: null }}
          precision={precision}
          allowRange={false}
          allowTime={false}
          onCommit={(commit) => {
            setOpen(false);
            onCommit("iso" in commit ? commit.iso : commit.start !== null ? commit.start.iso : null);
          }}
          onClose={() => setOpen(false)}
          anchorRef={anchorRef}
          firstDayOfWeek={1}
          markedDates={markedDates}
        />
      )}
    </span>
  );
}
