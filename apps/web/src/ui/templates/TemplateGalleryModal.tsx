/**
 * TemplateGalleryModal — the main-view template surface: a
 * gallery over every template-class node in the workspace. The gallery's
 * candidate set IS the template class's members (flat; no binding
 * class filter anywhere).
 *
 * Surfaces per template: Open (the row click — templates are ordinary pages,
 * edited with the real outliner) and Use template (create-with-template:
 * a fresh page instantiated through the clone engine, then opened).
 * Keyboard create-with-template: type to filter, ArrowUp/Down move the
 * highlight, Enter uses the highlighted template. The "New template" row
 * creates a classed page and opens it for editing.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { deriveDisplayName, SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client.js";

import { displayNameForSettings } from "../dateDisplay.js";
import { Icon } from "../Icon.js";
import { Button } from "../components/ui/Button.js";
import { Modal } from "../components/ui/Modal.js";
import { SearchField } from "../components/ui/SearchField.js";
import { ensureTemplateFamily } from "../components/templateFamily.js";
import { useTemplateInstantiator } from "./useTemplateInstantiator.js";
import "./TemplateGalleryModal.css";

type AnyClient = WorkspaceClient | WorkerClient;

export interface TemplateGalleryModalProps {
  isOpen: boolean;
  onClose: () => void;
  client: AnyClient;
  /** Render-cascade navigation — opens the template / the instantiated page. */
  onOpenPage: (nodeId: string) => void;
}

export function TemplateGalleryModal({
  isOpen,
  onClose,
  client,
  onOpenPage,
}: TemplateGalleryModalProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  /** Live re-read on every client notification. */
  const [version, setVersion] = useState(0);

  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  // Reset per open + self-heal the template family before the first read.
  useEffect(() => {
    if (!isOpen) return;
    setQuery("");
    setSelectedIndex(0);
    void ensureTemplateFamily(client).catch(() => {});
  }, [isOpen, client]);

  const { begin, dialog } = useTemplateInstantiator({
    client,
    ensure: () => ensureTemplateFamily(client),
    onInstantiated: (nodeId) => {
      onClose();
      onOpenPage(nodeId);
    },
  });

  const templates = useMemo<ClientNode[]>(() => {
    void version;
    return client
      .getClassMembers(SYSTEM_CLASS_UUIDS.template)
      .filter((node) => node.isActive)
      .sort((a, b) => {
        const nameA = displayNameForSettings(a) ?? a.id;
        const nameB = displayNameForSettings(b) ?? b.id;
        return nameA.localeCompare(nameB) || a.id.localeCompare(b.id);
      });
  }, [client, version]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return templates;
    return templates.filter((node) =>
      (displayNameForSettings(node) ?? node.id).toLowerCase().includes(q),
    );
  }, [templates, query]);

  const itemCount = filtered.length;
  const effectiveSelectedIndex = Math.min(selectedIndex, Math.max(0, itemCount - 1));

  // Keep the highlighted row visible (arrow navigation).
  useEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const selected = list.querySelector(".template-gallery__row--selected") as HTMLElement | null;
    if (selected && typeof selected.scrollIntoView === "function") {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [effectiveSelectedIndex]);

  const createTemplate = async () => {
    await ensureTemplateFamily(client);
    const id = await client.createObject({
      presentAsMain: true,
      name: "New template",
      classIds: [SYSTEM_CLASS_UUIDS.template],
    });
    onClose();
    onOpenPage(id);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, Math.max(0, itemCount - 1)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const picked = filtered[effectiveSelectedIndex];
      if (picked !== undefined) begin(picked.id);
    }
  };

  return (
    <>
      <Modal isOpen={isOpen} onClose={onClose} title="Templates" size="md">
        <div className="template-gallery">
          <div className="template-gallery__search">
            <SearchField
              aria-label="Search templates"
              placeholder="Search templates…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setSelectedIndex(0);
              }}
              onKeyDown={handleKeyDown}
              autoFocus
            />
          </div>
          <div ref={listRef} className="template-gallery__list" role="listbox" aria-label="Templates">
            {filtered.length === 0 ? (
              <div className="template-gallery__empty">
                {templates.length === 0
                  ? "No templates yet. Templates are ordinary pages classed \"template\" — create one to get started."
                  : "No matches"}
              </div>
            ) : (
              filtered.map((template, index) => {
                const isSelected = index === effectiveSelectedIndex;
                const label = deriveDisplayName(template) || "Untitled template";
                return (
                  <div
                    key={template.id}
                    role="option"
                    aria-selected={isSelected}
                    className={`template-gallery__row ${
                      isSelected ? "template-gallery__row--selected" : ""
                    }`}
                    onMouseEnter={() => setSelectedIndex(index)}
                  >
                    <button
                      type="button"
                      className="template-gallery__row-open"
                      title="Open template"
                      onClick={() => {
                        onClose();
                        onOpenPage(template.id);
                      }}
                    >
                      <Icon path="mdi-clipboard-text" size={0.9} />
                      <span className="template-gallery__row-name">{label}</span>
                    </button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="template-gallery__row-use"
                      onClick={() => begin(template.id)}
                    >
                      Use template
                    </Button>
                  </div>
                );
              })
            )}
          </div>
          <div className="template-gallery__footer">
            <Button variant="ghost" size="sm" onClick={() => void createTemplate()}>
              ＋ New template
            </Button>
            <span className="template-gallery__hint">↵ Use template · Esc Close</span>
          </div>
        </div>
      </Modal>
      {dialog}
    </>
  );
}
