/**
 * ClassIconButton — the class header's icon picker: curated mdi grid +
 * clear, popover anchored under the icon slot (PageView `iconButton` slot).
 * Classes keep the curated set (class glyphs double as pill icons); pages
 * keep the full IconPickerPopup.
 */

import { useState } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { Icon } from "../../Icon.js";
import "./ClassIconButton.css";

type AnyClient = WorkspaceClient | WorkerClient;

/** Curated icon set for the class icon picker (mdi names, sprite-served). */
const CLASS_ICONS = [
  "mdiAccount", "mdiAccountGroup", "mdiArchive", "mdiBook", "BookOpenVariant",
  "mdiBookmark", "mdiBriefcase", "mdiCalendar", "mdiCalendarClock", "mdiCardText",
  "mdiCheckboxMarkedCircleOutline", "mdiClipboardText", "mdiClockOutline", "mdiCog",
  "mdiEmail", "mdiFileDocument", "mdiFlag", "mdiFolder", "mdiFormatListBulleted",
  "mdiFormatListChecks", "mdiHeart", "mdiHome", "mdiImage", "mdiLabel", "mdiLightbulb",
  "mdiLink", "mdiMapMarker", "mdiMicroscope", "mdiMovie", "mdiMusicNote", "mdiNotebook",
  "mdiPackage", "mdiPhone", "mdiPound", "mdiPresentation", "mdiScriptText", "mdiShape",
  "mdiStar", "mdiTag", "mdiTestTube", "mdiTooth", "mdiTrayArrowDown", "mdiWeb",
].map((name) => (name.startsWith("mdi") ? name : `mdi${name}`));

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
  const [query, setQuery] = useState("");

  const filtered =
    query.trim() === ""
      ? CLASS_ICONS
      : CLASS_ICONS.filter((name) => name.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <span className="nt-class-iconpicker">
      <button
        type="button"
        className="nt-class-iconbtn"
        title="Class icon"
        aria-label="Class icon"
        onClick={() => setOpen((value) => !value)}
      >
        {icon !== null && icon !== "" ? (
          <Icon path={icon} size={1.4} />
        ) : (
          <Icon path="mdi-dots-grid" size={1.2} />
        )}
      </button>
      {open && (
        <span className="nt-class-iconpop" role="dialog" aria-label="Choose class icon">
          <input
            autoFocus
            value={query}
            placeholder="Search icons…"
            onChange={(event) => setQuery(event.target.value)}
          />
          <span className="nt-class-icons">
            {filtered.map((name) => (
              <button
                key={name}
                type="button"
                className={name === icon ? "nt-class-iconopt nt-class-iconopt-active" : "nt-class-iconopt"}
                title={name}
                onClick={() => {
                  setOpen(false);
                  setQuery("");
                  void client.updateObject(classId, { icon: name });
                }}
              >
                <Icon path={name} size={1} />
              </button>
            ))}
          </span>
          <button
            type="button"
            className="nt-class-iconclear"
            onClick={() => {
              setOpen(false);
              void client.updateObject(classId, { icon: "" });
            }}
          >
            No icon
          </button>
        </span>
      )}
    </span>
  );
}
