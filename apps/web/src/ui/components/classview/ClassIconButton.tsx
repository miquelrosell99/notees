/**
 * ClassIconButton — the class header's icon picker. The popup IS the v1
 * full picker (IconPickerPopup: All/Emojis/Icons tabs, the entire emoji +
 * mdi sets, recents — the owner's directive 2026-10-04, "it was great");
 * the earlier curated 42-icon grid retired in its favor. Selection writes
 * the v1 value contract through object.update: an emoji character (the
 * Icon renderer's text passthrough) or a camelCase mdi key; "" clears.
 */

import { useRef, useState } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { Icon } from "../../Icon.js";
import { IconPickerPopup } from "../IconPickerPopup.js";
import "./ClassIconButton.css";

type AnyClient = WorkspaceClient | WorkerClient;

export function ClassIconButton({
  client,
  classId,
  icon,
}: {
  client: AnyClient;
  classId: string;
  icon: string | null;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  return (
    <span className="nt-class-iconpicker">
      <button
        type="button"
        ref={buttonRef}
        className="nt-class-iconbtn"
        title="Class icon"
        aria-label="Class icon"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {icon !== null && icon !== "" ? (
          <Icon path={icon} size={1.4} />
        ) : (
          <Icon path="mdi-dots-grid" size={1.2} />
        )}
      </button>
      {open && buttonRef.current !== null && (
        <IconPickerPopup
          value={icon ?? undefined}
          anchorEl={buttonRef.current}
          onSelect={(value) => {
            setOpen(false);
            void client.updateObject(classId, { icon: value });
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  );
}
