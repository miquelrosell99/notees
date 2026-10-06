/**
 * QuickCreateFab — the mobile quick-create floating action button: a
 * fixed-position FAB, visible only at
 * narrow widths (the app.css responsive pass shows it inside the tablet
 * breakpoint and hides it on desktop, where Ctrl/Cmd+Shift+N and the shell
 * chrome own quick capture). Tapping it opens the existing QuickAddModal —
 * the component hosts its own modal state, so the mount is a single
 * app-level line (App.tsx renders it beside the chord-opened QuickAddModal;
 * both write through the same quick-add flow).
 */

import { useState } from "react";

import type { WorkspaceClient } from "@/core/workspace-client.js";
import type { WorkerClient } from "@/core/worker-client.js";

import { Icon } from "../Icon.js";
import { QuickAddModal } from "./modals/QuickAddModal.js";

type AnyClient = WorkspaceClient | WorkerClient;

export function QuickCreateFab({
  client,
}: {
  client: Pick<AnyClient, "createObject" | "listPages" | "ensureDateChain">;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="nt-quick-fab"
        aria-label="Quick add"
        title="Quick add (Ctrl/Cmd+Shift+N)"
        onClick={() => setOpen(true)}
      >
        <Icon path="mdi-plus" size={1.4} />
      </button>
      {open && (
        <QuickAddModal isOpen={open} onClose={() => setOpen(false)} client={client} />
      )}
    </>
  );
}
