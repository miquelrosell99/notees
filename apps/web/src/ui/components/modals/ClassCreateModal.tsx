/**
 * ClassCreateModal (#14) — the class-creation dialog, two modes under one
 * Modal:
 *
 *  - Blank: a name, an icon (IconPickerPopup), and a color (ColorButton's
 *    picker) — the ordinary client.createClass.
 *  - Deploy system class: the seeded classes the workspace does not have
 *    yet (offline-first devices, seeds added after the workspace existed),
 *    from the domain feature gate DEPLOYABLE_SYSTEM_CLASSES filtered
 *    through deployableSystemClasses. Deploying authors the class at its
 *    fixed seed uuid + its whole family through deploySystemClass — all
 *    existing ops, idempotent, convergent with the server seed.
 *
 * Triggers: the Classes hub header button (HubView), a command-palette
 * command, and the block-editor class picker's create row (NodePills
 * carries the typed query in as the initial name).
 */

import { useMemo, useRef, useState } from "react";

import { SYSTEM_CLASS_DISPLAY_NAMES, SYSTEM_CLASS_ICONS, type SystemClassName } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { Modal } from "../ui/Modal.js";
import { Button } from "../ui/Button.js";
import { TextField } from "../ui/TextField.js";
import { SearchField } from "../ui/SearchField.js";
import { ColorButton } from "../ui/ColorButton.js";
import { Tabs } from "../ui/Tabs.js";
import { IconPickerPopup } from "../IconPickerPopup.js";
import { deployableSystemClasses, deploySystemClass } from "../systemClassDeploy.js";

import "./ClassCreateModal.css";

export interface ClassCreateModalProps {
  isOpen: boolean;
  onClose: () => void;
  client: WorkspaceClient | WorkerClient;
  /** The picker's typed query, carried in as the blank mode's name. */
  initialName?: string | undefined;
  /** Called with the new class id once created/deployed (host opens it). */
  onCreated?: ((classId: string) => void) | undefined;
}

export function ClassCreateModal({
  isOpen,
  onClose,
  client,
  initialName = "",
  onCreated,
}: ClassCreateModalProps) {
  const [mode, setMode] = useState<"blank" | "deploy">("blank");
  const [name, setName] = useState(initialName);
  const [icon, setIcon] = useState<string | undefined>(undefined);
  const [color, setColor] = useState<string | null>(null);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const iconButtonRef = useRef<HTMLButtonElement | null>(null);
  const [filter, setFilter] = useState("");
  /** The deploy currently running — the row disables while it applies. */
  const [deploying, setDeploying] = useState<SystemClassName | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-read the catalog on every render: a deploy updates the client, the
  // view re-renders, and the row drops out of the "not yet deployed" list.
  const catalog = useMemo(() => deployableSystemClasses(client), [client, deploying]);
  const filteredCatalog = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (q === "") return catalog;
    return catalog.filter((key) => SYSTEM_CLASS_DISPLAY_NAMES[key].toLowerCase().includes(q));
  }, [catalog, filter]);

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
            <Tabs.Tab value="deploy">Deploy system class</Tabs.Tab>
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
          <div className="class-create__deploy">
            {catalog.length === 0 ? (
              <p className="class-create__all-deployed">
                Every seeded system class already exists in this workspace.
              </p>
            ) : (
              <>
                <SearchField
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Filter system classes…"
                  aria-label="Filter system classes"
                />
                <ul className="class-create__catalog">
                  {filteredCatalog.map((key) => (
                    <li key={key}>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={SYSTEM_CLASS_ICONS[key]}
                        fullWidth
                        disabled={deploying !== null}
                        onClick={() => void handleDeploy(key)}
                        className="class-create__catalog-row"
                      >
                        Deploy {SYSTEM_CLASS_DISPLAY_NAMES[key]}
                      </Button>
                    </li>
                  ))}
                </ul>
                {filteredCatalog.length === 0 && filter.trim() !== "" && (
                  <p className="class-create__all-deployed">No system class matches that filter.</p>
                )}
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
