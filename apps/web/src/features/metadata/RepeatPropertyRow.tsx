import { useMemo } from "react";

import type { EffectiveProperty } from "@/core/workspace-client/index.js";

import { RepeatControl } from "../../components/ui/kit/RepeatControl.js";
import { useClientVersion } from "../../components/ui/kit/useClientVersion.js";
import { Icon } from "../../ui/Icon.js";
import { drivingDateRow, repeatFactsOfNode, setRepeatRule } from "../calendar/repeatProperty.js";
import type { AnyClient } from "./shared.js";

/**
 * RepeatPropertyRow — the dedicated row renderer for the dedicated Repeat
 * property (schema id `SYSTEM_PROPERTY_UUIDS.repeat`): recurrence is
 * authored deliberately from the panel through the kit RepeatControl,
 * never through the generic text row (carrier blocks). The value cell is
 * the control: off-state toggle for the bound-empty virtual row, the full
 * authoring panel once a rule is committed. The row chrome (label, icon,
 * from-class hint, the li wrapper, the right-click property menu via the
 * host's event delegation on `data-property-schema-id`) rides the same
 * idiom as the sibling per-type rows.
 *
 * The anchor is never stored on the row — it is the driving datetime row's
 * day (`drivingDateRow`): with no resolvable date the toggle renders
 * disabled with the "Set a date first" hint (repeatFactsOfNode reads the
 * rule as absent without an anchor too — the off state is the honest
 * rendering). The parsed rule and the anchor ride ONE memo keyed on the
 * store version: the parse must not re-run per render, or the fresh
 * `RecurrenceRule` identity would re-sync RepeatControl's draft on every
 * render. A present-but-corrupt value throws (fail loud — corrupt never
 * reads as plain). Writes funnel through `setRepeatRule` (the row's
 * exception metadata rides through untouched).
 */
export function RepeatPropertyRow({
  client,
  nodeId,
  propertySchemaId,
  label,
  rows,
  /** Hide the label/hints (the host chrome carries them — the sidebar). */
  bare = false,
  /** Read-only projection: the control renders disabled. */
  readOnly = false,
  /** Extra li class (the R4 ineligible rendering — " nt-property-ineligible"). */
  rowClassName = "",
  /** The host knows the property is class-supplied even when rows carry no boundBy
   *  (the empty assigned/bound reduction) — the from-class badge rides this. */
  classBound = false,
  /** The property-header icon (effectivePropertyIcon). */
  icon,
}: {
  client: AnyClient;
  nodeId: string;
  propertySchemaId: string;
  label: string;
  rows: EffectiveProperty[];
  bare?: boolean;
  readOnly?: boolean | undefined;
  rowClassName?: string;
  classBound?: boolean;
  icon: string;
}) {
  // The store-synced subscription: every write (the control's commits, the
  // datetime re-pick, the menu's unset) funnels through a version bump.
  const storeVersion = useClientVersion(client);

  // One parse pass per store version — the stable rule identity is the
  // RepeatControl `value` (its draft re-syncs on identity change).
  const control = useMemo(() => {
    const facts = repeatFactsOfNode(client, nodeId);
    const driving = drivingDateRow(client, nodeId);
    return { rule: facts?.rule ?? null, anchorIso: driving?.anchorIso ?? null };
  }, [client, nodeId, storeVersion]);

  const classSourced = rows.some((row) => row.boundBy !== null) || classBound;
  const noAnchor = control.anchorIso === null;

  return (
    <li className={`nt-property nt-property-repeat node-metadata-row${rowClassName}`}>
      {!bare && (
        <span className="section-label nt-property-name" data-property-schema-id={propertySchemaId}>
          <Icon path={icon} size={0.8} className="nt-property-name__icon" />
          {label}
          {classSourced && <span className="nt-property-hint" title="From a class">C</span>}
        </span>
      )}
      <RepeatControl
        value={control.rule}
        anchorIso={control.anchorIso}
        disabled={readOnly || noAnchor}
        disabledHint={noAnchor ? "Set a date first" : undefined}
        onChange={(rule) => void setRepeatRule(client, nodeId, rule)}
      />
    </li>
  );
}
