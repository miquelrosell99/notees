/**
 * ExportPageTrigger — the page-toolbar entry that opens the ExportPageModal.
 *
 * Rendered inside the page toolbar (`.nt-page-toolbar`) next to the view
 * toggles; reuses the toolbar's `nt-view-toggle` chrome so it matches the
 * surrounding controls. The modal hosts itself in a portal on open.
 */

import { useState } from "react";
import { Icon } from "../../Icon.js";
import { ExportPageModal } from "./ExportPageModal.js";
import type { ExportClient } from "./exportSubtree.js";

export function ExportPageTrigger({
  client,
  pageId,
  pageName,
}: {
  client: ExportClient;
  pageId: string;
  pageName?: string | undefined;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="nt-view-toggle"
        title="Export this page"
        aria-label="Export this page"
        onClick={() => setOpen(true)}
      >
        <Icon path="mdi-export" size={0.8} />
        <span>Export</span>
      </button>
      <ExportPageModal
        isOpen={open}
        onClose={() => setOpen(false)}
        client={client}
        nodeUuid={pageId}
        {...(pageName !== undefined ? { nodeName: pageName } : {})}
      />
    </>
  );
}
