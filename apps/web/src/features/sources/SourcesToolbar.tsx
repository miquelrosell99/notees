/**
 * SourcesToolbar — the Sources hub's toolbar, composed into the surface
 * top bar's actions cluster ("move the searchbar, the
 * button etc to the surface top bar").
 * slimmed it to SEARCH ONLY: the "N sources" count moved into a Badge next
 * to the title (the hub renders it through the bar's `titleExtra` slot),
 * the .bib + CSL-JSON exports and the Add-source button retired (creation
 * rides the global New flow — a picked source-family class opens the
 * add-source dialog, an asset class the upload modal), and the settings
 * shortcut went with the centralized settings entry. The toolbar's state
 * (the query input) lives in the hub and arrives as a prop.
 */

import { SearchField } from "../../components/ui/fleet/index.js";

import "./SourcesToolbar.css";

export function SourcesToolbar({
  qInput,
  onQInput,
}: {
  /** The live search input (the URL follows debounced — the hub owns it). */
  qInput: string;
  onQInput: (value: string) => void;
}) {
  return (
    <div className="nt-sources-toolbar">
      <SearchField
        size="sm"
        aria-label="Search sources"
        placeholder="Search title, author, or citekey"
        value={qInput}
        onChange={(event) => onQInput(event.target.value)}
        onClear={() => onQInput("")}
      />
    </div>
  );
}
