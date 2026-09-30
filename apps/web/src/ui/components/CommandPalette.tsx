/**
 * CommandPalette — Ctrl/Cmd+K command surface (plus the topbar search
 * trigger, via the `open` prop). A fixed-position modal (~top 18vh, 560px)
 * with an autofocused input and a fuzzy subsequence filter over:
 *
 *  - Pages      (client.listPages, asset-classed pages excluded)
 *  - Classes    (client.listClasses)
 *  - Actions    (New page, Toggle theme, Sign out)
 *
 * Full keyboard navigation: ArrowUp/Down cycles, Enter selects, Esc closes;
 * the mouse hovers and clicks. Theme toggling dispatches the same
 * data-theme/localStorage flip as ThemeToggle. Rendered through the shared
 * modal chrome (Modal.css) with a palette skin on top.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { deriveDisplayName, SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { Icon } from "../Icon.js";
import "./Modal.css";
import "./CommandPalette.css";

type AnyClient = WorkspaceClient | WorkerClient;

const THEME_KEY = "notees.theme";

interface PaletteItem {
  key: string;
  group: "Pages" | "Classes" | "Actions";
  label: string;
  icon: string;
  keywords: string;
  run: () => void;
}

/**
 * Ordered-subsequence fuzzy score, or null when the query does not match.
 * Word-start and consecutive matches score higher; shorter targets win ties.
 */
function fuzzyScore(query: string, target: string): number | null {
  const q = query.trim().toLowerCase();
  const t = target.toLowerCase();
  if (q === "") return 0;
  let score = 0;
  let ti = 0;
  let lastMatch = -2;
  for (let qi = 0; qi < q.length; qi += 1) {
    const ch = q[qi]!;
    let found = -1;
    while (ti < t.length) {
      if (t[ti] === ch) {
        found = ti;
        break;
      }
      ti += 1;
    }
    if (found === -1) return null;
    score += 1;
    if (found === 0 || /[\s\-_/.@·]/.test(t[found - 1]!)) score += 3;
    if (found === lastMatch + 1) score += 2;
    lastMatch = found;
    ti = found + 1;
  }
  return score - t.length * 0.01;
}

function toggleTheme(): void {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // Storage unavailable (private mode); the flip just won't persist.
  }
}

export function CommandPalette({
  client,
  open,
  onRequestOpen,
  onClose,
  onOpenNode,
  onNewPage,
  onSignOut,
}: {
  client: AnyClient;
  open: boolean;
  /** Ctrl/Cmd+K when closed: the App lifts `open`, so ask it to open. */
  onRequestOpen: () => void;
  onClose: () => void;
  onOpenNode: (nodeId: string) => void;
  onNewPage: () => void;
  onSignOut: () => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Global Ctrl/Cmd+K toggle (capture so browser-default find-in-page loses).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (open) onClose();
        else onRequestOpen();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onRequestOpen, onClose]);

  const items = useMemo<PaletteItem[]>(() => {
    const classes = client.listClasses();
    const assetClassId =
      classes.find((cls) => cls.name === "asset")?.id ?? SYSTEM_CLASS_UUIDS.asset;
    const pages = client
      .listPages()
      .filter((page) => !page.classIds.includes(assetClassId))
      .map<PaletteItem>((page) => ({
        key: `page:${page.id}`,
        group: "Pages",
        label: deriveDisplayName(page) || page.id,
        icon: page.icon ?? "mdi-file-document-outline",
        keywords: `${page.name ?? ""}`,
        run: () => onOpenNode(page.id),
      }));
    const classItems = classes.map<PaletteItem>((cls) => ({
      key: `class:${cls.id}`,
      group: "Classes",
      label: deriveDisplayName(cls) || cls.id,
      icon: cls.icon ?? "mdi-shape-outline",
      keywords: `${cls.name ?? ""}`,
      run: () => onOpenNode(cls.id),
    }));
    const themeIsDark = document.documentElement.dataset.theme !== "light";
    const actions: PaletteItem[] = [
      {
        key: "action:new-page",
        group: "Actions",
        label: "New page",
        icon: "mdi-file-plus-outline",
        keywords: "new create page",
        run: () => onNewPage(),
      },
      {
        key: "action:toggle-theme",
        group: "Actions",
        label: themeIsDark ? "Toggle theme: switch to light" : "Toggle theme: switch to dark",
        icon: themeIsDark ? "mdi-white-balance-sunny" : "mdi-weather-night",
        keywords: "theme dark light appearance",
        run: () => toggleTheme(),
      },
      {
        key: "action:sign-out",
        group: "Actions",
        label: "Sign out",
        icon: "mdi-logout-variant",
        keywords: "sign out logout exit account",
        run: () => onSignOut(),
      },
    ];
    return [...pages, ...classItems, ...actions];
  }, [client, onOpenNode, onNewPage, onSignOut]);

  const filtered = useMemo(() => {
    const scored = items
      .map((item) => {
        const labelScore = fuzzyScore(query, item.label);
        const keywordScore = fuzzyScore(query, item.keywords);
        const best =
          labelScore !== null && keywordScore !== null
            ? Math.max(labelScore, keywordScore)
            : (labelScore ?? keywordScore);
        return { item, score: best };
      })
      .filter((entry): entry is { item: PaletteItem; score: number } => entry.score !== null);
    scored.sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label));
    return scored.map((entry) => entry.item);
  }, [items, query]);

  const clampedActive = Math.min(activeIndex, Math.max(0, filtered.length - 1));

  // Reset on open; keep the active row visible while arrowing.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
    }
  }, [open]);

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>("[data-active='true']");
    active?.scrollIntoView({ block: "nearest" });
  }, [clampedActive]);

  if (!open) return null;

  const select = (item: PaletteItem) => {
    onClose();
    item.run();
  };

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (filtered.length === 0 ? 0 : (index + 1) % filtered.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) =>
        filtered.length === 0 ? 0 : (index - 1 + filtered.length) % filtered.length,
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = filtered[clampedActive];
      if (item !== undefined) select(item);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  let lastGroup: PaletteItem["group"] | null = null;
  let flatIndex = -1;

  return (
    <div className="nt-modal-backdrop nt-palette-backdrop" onClick={onClose}>
      <div
        className="nt-modal nt-palette"
        role="dialog"
        aria-label="Command palette"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="nt-palette-input-row">
          <Icon path="mdi-magnify" size={0.9} className="nt-palette-input-icon" />
          <input
            autoFocus
            className="nt-palette-input"
            placeholder="Search pages, classes, actions…"
            aria-label="Command palette search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onInputKeyDown}
          />
        </div>
        <div className="nt-palette-results" ref={listRef}>
          {filtered.map((item) => {
            flatIndex += 1;
            const index = flatIndex;
            const groupLabel = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <div key={item.key} className="nt-palette-group">
                {groupLabel !== null && (
                  <div className="nt-palette-group-label">{groupLabel}</div>
                )}
                <button
                  type="button"
                  className="nt-palette-item"
                  data-active={index === clampedActive}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => select(item)}
                >
                  <Icon path={item.icon} size={0.9} className="nt-palette-item-icon" />
                  <span className="nt-palette-item-label">{item.label}</span>
                </button>
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div className="nt-palette-empty">No results. Try a different search.</div>
          )}
        </div>
        <div className="nt-palette-footer">
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
