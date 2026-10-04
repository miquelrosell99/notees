/**
 * ShowMoreButton — the §34.70 window affordance: ONE consistent control at
 * the END of a windowed list. Composes the kit Button (ghost, sm); the
 * hidden count is part of the label AND the accessible name, so the window
 * never drops data silently. Keyboard-accessible by construction (a real
 * button); renders nothing at zero remaining.
 */

import { Button } from "../components/ui/index.js";
import "./ShowMoreButton.css";

export function ShowMoreButton({
  remaining,
  onShowMore,
}: {
  /** Hidden row count — rendered as "Show more (N remaining)". */
  remaining: number;
  onShowMore: () => void;
}) {
  if (remaining <= 0) return null;
  const label = `Show more (${remaining} remaining)`;
  return (
    <div className="nt-window-more">
      <Button variant="ghost" size="sm" onClick={onShowMore} aria-label={label}>
        {label}
      </Button>
    </div>
  );
}
