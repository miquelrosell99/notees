/**
 * ClassCreateModal (#14, upgraded 2026-10-22 — the classes gallery) — the
 * class-creation dialog, two modes under one Modal:
 *
 *  - Blank: a name, an icon (IconPickerPopup), and a color (ColorButton's
 *    picker) — the ordinary client.createClass.
 *  - Gallery (the deploy tab): a Capacities-style card grid of the seeded
 *    system classes the workspace does not have ENABLED — icon chip,
 *    display name, one-line description, grouped in sections. Picking a
 *    card enables the class (deploySystemClass — the F4 inverse for family
 *    bases, un-archive for archived seeds); a "Create your own" card
 *    switches to the blank mode. Locked classes never appear; enabled
 *    classes are managed on their class pages.
 *
 * Triggers: the Classes hub header button (HubView), a command-palette
 * command, and the block-editor class picker's create/browse rows
 * (NodePills carries the typed query in as the initial name).
 */

import { useMemo, useRef, useState } from "react";

import { SYSTEM_CLASS_ICONS, type SystemClassName } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client/index.js";

import { Modal } from "../../components/ui/fleet/Modal.js";
import { Button } from "../../components/ui/fleet/Button.js";
import { TextField } from "../../components/ui/fleet/TextField.js";
import { SearchField } from "../../components/ui/fleet/SearchField.js";
import { ColorButton } from "../../components/ui/fleet/ColorButton.js";
import { Tabs } from "../../components/ui/fleet/Tabs.js";
import { GridMenu } from "../../components/ui/fleet/GridMenu.js";
import { IconPickerPopup } from "../icon-picker/IconPickerPopup.js";
import {
  deploySystemClass,
  galleryCardText,
  gallerySections,
} from "../classview/systemClassDeploy.js";

import "./ClassCreateModal.css";

export interface ClassCreateModalProps {
  isOpen: boolean;
  onClose: () => void;
  client: WorkspaceClient | WorkerClient;
  /** The picker's typed query, carried in as the blank mode's name. */
  initialName?: string | undefined;
  /** Open the gallery tab instead of the blank form (the picker's "Browse all types…"). */
  initialMode?: "blank" | "gallery" | undefined;
  /** Called with the new class id once created/deployed (host opens it). */
  onCreated?: ((classId: string) => void) | undefined;
}

export function ClassCreateModal({
  isOpen,
  onClose,
  client,
  initialName = "",
  initialMode = "blank",
  onCreated,
}: ClassCreateModalProps) {
  const [mode, setMode] = useState<"blank" | "gallery">(initialMode);
  const [name, setName] = useState(initialName);
  const [icon, setIcon] = useState<string | undefined>(undefined);
  const [color, setColor] = useState<string | null>(null);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const iconButtonRef = useRef<HTMLButtonElement | null>(null);
  const [filter, setFilter] = useState("");
  /** The deploy currently running — the card disables while it applies. */
  const [deploying, setDeploying] = useState<SystemClassName | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-read the catalog on every render: a deploy updates the client, the
  // view re-renders, and the card drops out of the "not yet enabled" grid.
  const sections = useMemo(() => gallerySections(client), [client, deploying]);
  const filteredSections = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (q === "") return sections;
    return sections
      .map((section) => ({
        ...section,
        entries: section.entries.filter(({ key }) => {
          const { label, description } = galleryCardText(key);
          return label.toLowerCase().includes(q) || description.toLowerCase().includes(q);
        }),
      }))
      .filter((section) => section.entries.length > 0);
  }, [sections, filter]);
  const totalCards = filteredSections.reduce((n, section) => n + section.entries.length, 0);

  if (!isOpen) return null;

  const trimmedName = name.trim();
  const canCreate = trimmedName !== "";

  const handleCreate = async () => {
    if (!canCreate) return;
    setError(null);
    try {
      const id = await client.createClass(trimmedName, {
        ...(icon !== undefined ? { icon } : {}),
        ...(color !== null ? { color } : {}),
      });
      onCreated?.(id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDeploy = async (key: SystemClassName) => {
    if (deploying !== null) return;
    setError(null);
    setDeploying(key);
    try {
      const id = await deploySystemClass(client, key);
      onCreated?.(id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeploying(null);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="New class"
      size="md"
      contentClassName="class-create__body"
    >
      <div className="class-create">
        <Tabs value={mode} onChange={setMode}>
          <Tabs.List aria-label="Creation mode">
            <Tabs.Tab value="blank">Blank class</Tabs.Tab>
            <Tabs.Tab value="gallery">Gallery</Tabs.Tab>
          </Tabs.List>
        </Tabs>

        {mode === "blank" ? (
          <div className="class-create__blank">
            <TextField
              label="Name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Character"
              autoFocus
            />
            <div className="class-create__blank-options">
              <Button
                ref={iconButtonRef}
                size="sm"
                variant="outline"
                icon={icon ?? "mdiShapeOutline"}
                onClick={() => setIconPickerOpen((open) => !open)}
                aria-label="Choose icon"
              >
                {icon === undefined ? "Choose icon" : "Icon chosen"}
              </Button>
              <ColorButton
                color={color ?? "gray"}
                showPicker
                showNoneOption
                onColorChange={(next) => setColor(next)}
                aria-label="Class color"
              />
            </div>
            {iconPickerOpen && (
              <IconPickerPopup
                value={icon}
                anchorEl={iconButtonRef.current}
                onSelect={(value) => {
                  setIcon(value === "" ? undefined : value);
                  setIconPickerOpen(false);
                }}
                onClose={() => setIconPickerOpen(false)}
              />
            )}
            <div className="class-create__actions">
              <Button
                variant="primary"
                size="sm"
                disabled={!canCreate}
                onClick={() => void handleCreate()}
              >
                Create class
              </Button>
            </div>
          </div>
        ) : (
          <div className="class-create__gallery">
            {sections.length === 0 ? (
              <p className="class-create__all-deployed">
                Every gallery class is already enabled in this workspace.
              </p>
            ) : (
              <>
                <SearchField
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Filter types…"
                  aria-label="Filter types"
                />
                <div className="class-create__sections">
                  {filteredSections.map((section) => (
                    <section key={section.id} className="class-create__section">
                      <h3 className="class-create__section-title">{section.title}</h3>
                      <GridMenu
                        className="class-create__grid"
                        columns="auto"
                        aria-label={section.title}
                        items={section.entries.map(({ key, missing }) => {
                          const { label, description } = galleryCardText(key);
                          return {
                            id: key,
                            icon: SYSTEM_CLASS_ICONS[key],
                            label,
                            // An archived (not missing) seed is the
                            // gallery's disabled state — the card says so.
                            description: missing
                              ? description
                              : `${description} Currently disabled.`,
                            disabled: deploying !== null,
                          };
                        })}
                        onSelect={(id) => void handleDeploy(id as SystemClassName)}
                      />
                    </section>
                  ))}
                  {totalCards === 0 && filter.trim() !== "" && (
                    <p className="class-create__all-deployed">No type matches that filter.</p>
                  )}
                  {/* The Capacities "Create your own" card — once, after the
                      sections — switches to the blank mode, carrying the
                      typed filter as the name. */}
                  <GridMenu
                    className="class-create__grid"
                    columns="auto"
                    aria-label="Create your own"
                    items={[
                      {
                        id: "__blank",
                        icon: "mdi-plus",
                        label: "Create your own",
                        description: "Start from a blank class.",
                      },
                    ]}
                    onSelect={() => {
                      setName(filter.trim());
                      setMode("blank");
                    }}
                  />
                </div>
              </>
            )}
          </div>
        )}

        {error !== null && (
          <p className="class-create__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
