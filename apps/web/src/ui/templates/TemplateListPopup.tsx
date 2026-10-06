/**
 * TemplateListPopup — the `/template` slash flow's second stage: a
 * flat, UNFILTERED-by-class list of every template in the
 * workspace, instantiated at the caret on pick. (The class-filtered picker
 * remains only for the Class View binding gesture; the class-filtered
 * picker-reopen pattern is deliberately not ported here.)
 *
 * The slash trigger is already consumed when this opens — the popup owns a
 * small search field pre-filled with the typed remainder (`/template meet`
 * filters by "meet"). Keyboard: ArrowUp/ArrowDown move the highlight, Enter
 * picks, Escape closes (the block keeps its plain text).
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import { clampOverlayLeft, flipOverlayTop } from "../editor-popups/overlay-position.js";
import { Icon } from "../Icon.js";
import { displayNameForSettings } from "../dateDisplay.js";
import { SearchField } from "../components/ui/SearchField.js";
import { usePopupDismissal } from "../components/ui/usePopupDismissal.js";
import type { ClientNode } from "@/core/workspace-client.js";

import "./TemplateListPopup.css";

/** Structural read surface (the outliner seam satisfies it). */
export interface TemplateListClient {
  /** Template-class members — the flat, unfiltered candidate set. */
  getClassMembers(classId: string): ClientNode[];
  subscribe(listener: () => void): () => void;
}

export interface TemplateListPopupProps {
  /** Viewport anchor for the caret line (same contract as the slash popup). */
  position: { top: number; left: number; caretTop: number };
  client: TemplateListClient;
  /** The template family self-heal (the outliner seam or the raw client ensure). */
  ensure: () => Promise<void>;
  /** The typed remainder after "template" — the initial filter. */
  initialQuery: string;
  onPick: (templateId: string) => void;
  onClose: () => void;
}

export function TemplateListPopup({
  position,
  client,
  ensure,
  initialQuery,
  onPick,
  onClose,
}: TemplateListPopupProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState(initialQuery);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [placement, setPlacement] = useState<"below" | "above">("below");
  const [isPositioned, setIsPositioned] = useState(false);
  /** Live re-read on every client notification (templates created elsewhere appear). */
  const [version, setVersion] = useState(0);

  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  // Self-heal the template family before the first read (offline-first
  // workspaces may never have been seeded).
  const [familyReady, setFamilyReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void ensure()
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setFamilyReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [ensure]);

  const templates = useMemo<ClientNode[]>(() => {
    void version;
    void familyReady;
    return client
      .getClassMembers(SYSTEM_CLASS_UUIDS.template)
      .filter((node) => node.isActive)
      .sort((a, b) => {
        const nameA = displayNameForSettings(a) ?? a.id;
        const nameB = displayNameForSettings(b) ?? b.id;
        return nameA.localeCompare(nameB) || a.id.localeCompare(b.id);
      });
  }, [client, version, familyReady]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return templates;
    return templates.filter((node) =>
      (displayNameForSettings(node) ?? node.id).toLowerCase().includes(q),
    );
  }, [templates, query]);

  const itemCount = filtered.length;
  const effectiveSelectedIndex = Math.min(selectedIndex, Math.max(0, itemCount - 1));

  // Focus the filter on open (the slash trigger is already consumed).
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Keep the highlighted row visible (arrow navigation).
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const selected = list.querySelector(".template-list-popup__row--selected") as HTMLElement | null;
    if (selected && typeof selected.scrollIntoView === "function") {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [effectiveSelectedIndex]);

  // Close on click outside (same contract as the slash popup).
  useEffect(() => {
    const handler = (e: globalThis.MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as globalThis.Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  // Dismissal: document-level Escape — the filter input and the
  // popup root below own Escape while focus is inside; the hook closes when
  // focus is elsewhere (e.g. back on the edited block).
  usePopupDismissal({ popupRef: containerRef, isOpen: true, onClose });

  // Caret-line placement, identical to the slash popup's.
  useLayoutEffect(() => {
    const floating = containerRef.current;
    if (!floating) return;
    const update = () => {
      const { top, placement: resolved } = flipOverlayTop(
        { top: position.caretTop, bottom: position.top, left: position.left },
        floating.offsetHeight,
        4,
        8,
      );
      floating.style.left = `${clampOverlayLeft(position.left, floating.offsetWidth, 8)}px`;
      floating.style.top = `${top}px`;
      setPlacement(resolved);
      setIsPositioned(true);
    };
    update();
    window.addEventListener("resize", update);
    document.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      document.removeEventListener("scroll", update, true);
    };
  }, [position]);

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
      if (picked !== undefined) onPick(picked.id);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return createPortal(
    <div
      ref={containerRef}
      data-editor-companion
      className={`template-list-popup ${
        placement === "above" ? "template-list-popup--above" : ""
      }`}
      style={{
        position: "fixed",
        zIndex: "var(--z-1000)",
        visibility: isPositioned ? "visible" : "hidden",
        maxHeight: placement === "above" ? position.caretTop - 4 : undefined,
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="template-list-popup__header">Use a template</div>
      <div className="template-list-popup__search">
        <SearchField
          ref={inputRef}
          aria-label="Filter templates"
          placeholder="Filter templates…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedIndex(0);
          }}
          onKeyDown={handleKeyDown}
        />
      </div>
      <div ref={listRef} className="template-list-popup__list" role="listbox" aria-label="Templates">
        {filtered.length === 0 ? (
          <div className="template-list-popup__empty">
            {templates.length === 0
              ? "No templates yet — templates are pages classed \"template\"."
              : "No matches"}
          </div>
        ) : (
          filtered.map((template, index) => {
            const isSelected = index === effectiveSelectedIndex;
            const label = displayNameForSettings(template) ?? "Untitled template";
            return (
              <button
                key={template.id}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`template-list-popup__row ${
                  isSelected ? "template-list-popup__row--selected" : ""
                }`}
                onClick={() => onPick(template.id)}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <Icon path="mdi-clipboard-text" size={0.9} />
                <span className="template-list-popup__row-name">{label}</span>
              </button>
            );
          })
        )}
      </div>
      <div className="template-list-popup__footer">
        <span className="template-list-popup__hint">↵ Use template · Esc Cancel</span>
      </div>
    </div>,
    document.body,
  );
}
