/**
 * The Read later feature toggle — a SURFACES gate like journal, not a class
 * family: it gates the connector's read-later captures + the "Read later"
 * inbox convention while the `web_page`/`collection` classes stay always-on.
 * The feature id arrives via a vendor bump; until the vendored
 * WORKSPACE_FEATURES tuple knows `readItLater` this row renders NOTHING
 * (the runtime guard, not a type assertion, is the law).
 */

import type { JSX } from "react";

import type { WorkspaceFeature } from "@notees/protocol";
import { WORKSPACE_FEATURES } from "@notees/protocol";

import type { AnyClient } from "../../features/sidebar/FavoritesRecents.js";
import { Icon } from "../../ui/Icon.js";
import { ToggleSwitch } from "../../components/ui/kit/ToggleSwitch.js";

export const READ_IT_LATER_FEATURE = "readItLater" as WorkspaceFeature;

/** True only when the vendored protocol knows the id (post vendor-bump). */
export const READ_IT_LATER_KNOWN: boolean = (WORKSPACE_FEATURES as readonly string[]).includes(
  "readItLater",
);

export function ReadItLaterFeatureRow(props: { client: AnyClient }): JSX.Element | null {
  if (!READ_IT_LATER_KNOWN) return null;
  const { client } = props;
  const enabled = client.isFeatureEnabled(READ_IT_LATER_FEATURE);
  return (
    <div className="settings-item settings-feature-row" data-feature="readItLater">
      <span className="settings-feature-row__icon">
        <Icon path="mdi-inbox" size={1} />
      </span>
      <span className="settings-feature-row__text">
        <span className="settings-feature-row__title">Read later</span>
        <span className="settings-feature-row__powers">
          The Notees Connector's read-later captures land in a "Read later" collection —
          the classes stay always-on.
        </span>
      </span>
      <ToggleSwitch
        leftLabel="Off"
        rightLabel="On"
        checked={enabled}
        onChange={(next) => {
          void client.setFeatureEnabled(READ_IT_LATER_FEATURE, next).catch((error: unknown) => {
            console.warn(`[features] setFeatureEnabled (readItLater) failed:`, error);
          });
        }}
        size="sm"
        aria-label="Read later feature"
      />
    </div>
  );
}
