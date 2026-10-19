import { DateSlotControl } from "../pickers/DateSlotControl.js";
import type { AnyClient } from "./shared.js";

/**
 * Link qualifier range control (SCHEMA.md "Dates", dateQualified schemas):
 * start/end date slots next to a node-typed pill; values persist as
 * property.set metadata.startDate/endDate (PC6 canonical: date-node refs —
 * the stored legacy ISO strings read back through qualifierIsoOf until the
 * lockstep wave switches the write path). The slots ride the shared
 * DateSlotControl — the same zoom-picker control the table
 * cells use, no native date inputs.
 */
export function QualifierRange({
  client,
  start,
  end,
  ariaLabel,
  onCommit,
}: {
  client: AnyClient;
  start: string;
  end: string;
  ariaLabel: string;
  onCommit: (start: string, end: string) => void;
}) {
  return (
    <span className="nt-chip-qualifier">
      <DateSlotControl
        client={client}
        value={start === "" ? null : start}
        ariaLabel={`${ariaLabel} start date`}
        onCommit={(iso) => onCommit(iso ?? "", end)}
      />
      <span aria-hidden="true">–</span>
      <DateSlotControl
        client={client}
        value={end === "" ? null : end}
        ariaLabel={`${ariaLabel} end date`}
        onCommit={(iso) => onCommit(start, iso ?? "")}
      />
    </span>
  );
}
