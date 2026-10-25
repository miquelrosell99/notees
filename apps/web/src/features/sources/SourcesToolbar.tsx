/**
 * SourcesToolbar — the Sources hub's toolbar, composed into the surface
 * top bar's actions cluster ("move the searchbar, the
 * button etc to the surface top bar"): the search box (live filter over
 * the loaded set by title/authorsText/citekey), the item count ("N
 * sources"), the filtered-set bibliography exports (.bib + CSL-JSON over
 * exactly the displayed row ids — Review Focus 5), the Add-source door
 * (the shipped requestAddSource seam), and the settings shortcut opening
 * the workspace settings on the Sources section (the WorkspaceSettingsHost
 * seam). The middle column shows only the table; the toolbar's state
 * (the query input, the loaded set) lives in the hub and arrives as
 * props. The Add-source + settings doors are self-contained module-level
 * requests — no props needed.
 */

import { Button, SearchField } from "../../components/ui/fleet/index.js";
import { requestAddSource } from "./AddSourceHost.js";
import { requestWorkspaceSettings } from "../workspaces/WorkspaceSettingsHost.js";

import "./SourcesToolbar.css";

export function SourcesToolbar({
  qInput,
  onQInput,
  count,
  onExport,
}: {
  /** The live search input (the URL follows debounced — the hub owns it). */
  qInput: string;
  onQInput: (value: string) => void;
  /** The filtered row count ("N sources"). */
  count: number;
  /** The filtered-set export (the hub owns the loaded rows). */
  onExport: (format: "bib" | "csl-json") => void;
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
      <span className="nt-sources-toolbar__count" aria-live="polite">
        {count} {count === 1 ? "source" : "sources"}
      </span>
      <span className="nt-sources-toolbar__spacer" aria-hidden="true" />
      <Button
        variant="ghost"
        size="sm"
        icon="mdi-file-export-outline"
        disabled={count === 0}
        onClick={() => onExport("bib")}
      >
        BibTeX
      </Button>
      <Button
        variant="ghost"
        size="sm"
        icon="mdi-code-braces"
        disabled={count === 0}
        onClick={() => onExport("csl-json")}
      >
        CSL JSON
      </Button>
      <Button variant="primary" size="sm" icon="mdi-plus" onClick={() => requestAddSource({})}>
        Add source
      </Button>
      <Button
        variant="ghost"
        size="sm"
        icon="mdi-cog-outline"
        aria-label="Sources settings"
        title="Sources settings"
        onClick={() => requestWorkspaceSettings()}
      />
    </div>
  );
}
