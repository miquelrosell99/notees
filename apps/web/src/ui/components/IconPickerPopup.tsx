/**
 * IconPickerPopup — the v1 EmojiPicker, ported: three tabs (All / Emojis /
 * Icons), a search across both vocabularies, a device-local recents row, a
 * clear action, and lazy-rendered category grids. Emitted values are the
 * v1 contract: the emoji character or a camelCase MDI key ("mdiCalendar") —
 * Icon's resolver normalizes both (plus legacy kebab/JSON forms) at render.
 *
 * Anchoring: fixed-position popup at the anchor element (flip above when
 * there is no room below, clamped horizontally), positioned imperatively
 * like the other editor popups. Outside click / Escape close.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Icon } from "../Icon.js";
import { Button } from "./ui/Button.js";
import { Tabs } from "./ui/Tabs.js";
import { usePopupDismissal } from "./ui/usePopupDismissal.js";
import { clampOverlayLeft, flipOverlayTop } from "../editor-popups/overlay-position.js";
import { EMOJI_CATEGORIES } from "./emojiData.js";
import { MDI_CATEGORIES } from "./mdiCategories.js";
import { MDI_ICON_LIST } from "./mdiIconList.js";
import "./IconPickerPopup.css";

const TYPICAL_EMOJIS = EMOJI_CATEGORIES["Smileys"]!.slice(0, 32);
const TYPICAL_ICONS = MDI_CATEGORIES["Popular"]!.slice(0, 24);

/** Gap between the anchor element and the popup. */
const POPUP_GAP = 4;
/** Viewport clearance for placement. */
const VIEWPORT_PADDING = 8;
const RECENTS_KEY = "notees.icon-recents";
const MAX_RECENTS = 20;
const MAX_SEARCH_RESULTS = 100;

function getRecents(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function addRecent(item: string): void {
  const next = [item, ...getRecents().filter((entry) => entry !== item)].slice(0, MAX_RECENTS);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable; recents just won't persist.
  }
}

const isIconValue = (value: string): boolean => /^mdi[A-Z]/.test(value);

function SectionHeader({ children }: { children: ReactNode }) {
  return <div className="ep-section-header">{children}</div>;
}

/** One grid cell: an MDI icon button or an emoji button. */
function GridButton({
  item,
  isIcon,
  selected,
  onSelect,
}: {
  item: string;
  isIcon: boolean;
  selected: boolean;
  onSelect: (item: string) => void;
}) {
  if (isIcon) {
    return (
      <Button
        variant="ghost"
        size="xs"
        title={item}
        aria-label={item}
        active={selected}
        className="ep-item"
        onClick={() => onSelect(item)}
      >
        <Icon path={item} size={0.85} />
      </Button>
    );
  }
  return (
    <Button
      variant="ghost"
      size="xs"
      title={item}
      aria-label={item}
      active={selected}
      className="ep-item ep-emoji-item"
      onClick={() => onSelect(item)}
    >
      {item}
    </Button>
  );
}

function ItemGrid({
  items,
  isIcon,
  selectedValue,
  onSelect,
}: {
  items: string[];
  isIcon: boolean;
  selectedValue?: string | undefined;
  onSelect: (item: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className={`ep-grid ${isIcon ? "ep-icon-grid" : "ep-emoji-grid"}`}>
      {items.map((item, index) => (
        <GridButton
          key={`${item}-${index}`}
          item={item}
          isIcon={isIcon}
          selected={selectedValue === item}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

/** Category section that renders a height placeholder until scrolled into
 *  view (v1's lazy rendering — the full emoji/icon vocab is thousands of
 *  cells; only the visible categories mount). */
function LazyCategory({
  label,
  items,
  isIcon,
  selectedValue,
  onSelect,
}: {
  label: string;
  items: string[];
  isIcon: boolean;
  selectedValue?: string | undefined;
  onSelect: (item: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const rowSize = isIcon ? 34 : 36;
  const cols = 8;
  const placeholderHeight = Math.ceil(items.length / cols) * rowSize + 28;

  return (
    <div ref={ref} className="ep-category-section">
      <div className="ep-category-label">{label}</div>
      {visible ? (
        <ItemGrid items={items} isIcon={isIcon} selectedValue={selectedValue} onSelect={onSelect} />
      ) : (
        <div style={{ height: placeholderHeight }} />
      )}
    </div>
  );
}

type TabType = "all" | "emojis" | "icons";

export interface IconPickerPopupProps {
  /** Currently selected value (emoji char or camelCase MDI key). */
  value?: string | undefined;
  onSelect: (value: string) => void;
  onClose: () => void;
  /** Element the popup anchors to (bottom-start, flips above). */
  anchorEl: HTMLElement | null;
}

export function IconPickerPopup({ value, onSelect, onClose, anchorEl }: IconPickerPopupProps) {
  const [activeTab, setActiveTab] = useState<TabType>("all");
  const [search, setSearch] = useState("");
  const [recents, setRecents] = useState<string[]>(() => getRecents());
  const pickerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Dismissal (§34.67): pointer-down outside closes; Escape from outside
  // closes via the hook, Escape from inside (the search field holds focus)
  // closes at the popup root below.
  usePopupDismissal({ popupRef: pickerRef, isOpen: true, onClose });

  // Position: fixed at the anchor, flip above when no room, clamped.
  useLayoutEffect(() => {
    const floating = pickerRef.current;
    if (floating === null) return;
    const rect = anchorEl?.getBoundingClientRect();
    const update = () => {
      if (rect === undefined || rect === null) {
        floating.style.visibility = "visible";
        return;
      }
      const { top, placement } = flipOverlayTop(
        { top: rect.bottom, bottom: rect.bottom, left: rect.left },
        floating.offsetHeight,
        POPUP_GAP,
        VIEWPORT_PADDING,
      );
      floating.style.left = `${clampOverlayLeft(rect.left, floating.offsetWidth, VIEWPORT_PADDING)}px`;
      floating.style.top = `${placement === "above" ? rect.top - floating.offsetHeight - POPUP_GAP : top}px`;
      floating.style.visibility = "visible";
    };
    update();
    window.addEventListener("resize", update);
    document.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      document.removeEventListener("scroll", update, true);
    };
  }, [anchorEl]);

  const searchResults = useMemo(() => {
    if (search.trim() === "") return null;
    const q = search.toLowerCase();
    const emojis: string[] = [];
    for (const list of Object.values(EMOJI_CATEGORIES)) {
      for (const emoji of list) {
        if (emoji.toLowerCase().includes(q)) emojis.push(emoji);
      }
    }
    const icons = MDI_ICON_LIST.filter((name) => name.toLowerCase().includes(q));
    return {
      emojis: Array.from(new Set(emojis)).slice(0, MAX_SEARCH_RESULTS),
      icons: icons.slice(0, MAX_SEARCH_RESULTS),
      hasMoreEmojis: emojis.length > MAX_SEARCH_RESULTS,
      hasMoreIcons: icons.length > MAX_SEARCH_RESULTS,
    };
  }, [search]);

  const handleSelect = (raw: string) => {
    addRecent(raw);
    setRecents(getRecents());
    onSelect(raw);
    onClose();
  };

  const handleTabChange = (tab: TabType) => {
    setActiveTab(tab);
    setSearch("");
    // jsdom lacks element.scrollTo — guard for the test environment.
    if (typeof contentRef.current?.scrollTo === "function") {
      contentRef.current.scrollTo({ top: 0 });
    }
  };

  return createPortal(
    <div
      ref={pickerRef}
      className="ep ep--popup"
      role="dialog"
      aria-label="Icon picker"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      {/* Header: tabs + actions */}
      <div className="ep-header">
        <Tabs value={activeTab} onChange={handleTabChange}>
          <Tabs.List>
            <Tabs.Tab value="all">All</Tabs.Tab>
            <Tabs.Tab value="emojis">Emojis</Tabs.Tab>
            <Tabs.Tab value="icons">Icons</Tabs.Tab>
          </Tabs.List>
        </Tabs>
        <div className="ep-header-actions">
          <Button
            aria-label="Remove icon"
            variant="ghost"
            size="sm"
            icon="mdi mdi-trash-can-outline"
            title="Remove icon"
            onClick={() => {
              onSelect("");
              onClose();
            }}
          />
        </div>
      </div>

      {/* Search */}
      <div className="ep-search">
        <input
          ref={searchRef}
          type="text"
          className="ep-search-input"
          placeholder="Search icons and emojis…"
          aria-label="Search icons and emojis"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      {/* Content */}
      <div ref={contentRef} className="ep-content">
        {searchResults !== null && (
          <>
            {searchResults.emojis.length > 0 && (
              <div className="ep-category-section">
                <SectionHeader>Emojis</SectionHeader>
                <ItemGrid items={searchResults.emojis} isIcon={false} selectedValue={value} onSelect={handleSelect} />
              </div>
            )}
            {searchResults.icons.length > 0 && (
              <div className="ep-category-section">
                <SectionHeader>Icons</SectionHeader>
                <ItemGrid items={searchResults.icons} isIcon selectedValue={value} onSelect={handleSelect} />
              </div>
            )}
            {searchResults.hasMoreEmojis && (
              <div className="ep-more-hint">100+ emojis match — type a more specific query</div>
            )}
            {searchResults.hasMoreIcons && (
              <div className="ep-more-hint">100+ icons match — type a more specific query</div>
            )}
            {searchResults.emojis.length === 0 && searchResults.icons.length === 0 && (
              <div className="ep-empty">No results for “{search}”</div>
            )}
          </>
        )}

        {!searchResults && activeTab === "all" && (
          <>
            {recents.length > 0 && (
              <div className="ep-category-section">
                <SectionHeader>Recents</SectionHeader>
                <div className="ep-grid ep-mixed-grid">
                  {recents.map((item) => (
                    <GridButton
                      key={item}
                      item={item}
                      isIcon={isIconValue(item)}
                      selected={value === item}
                      onSelect={handleSelect}
                    />
                  ))}
                </div>
              </div>
            )}
            <div className="ep-category-section">
              <SectionHeader>Emojis</SectionHeader>
              <ItemGrid items={TYPICAL_EMOJIS} isIcon={false} selectedValue={value} onSelect={handleSelect} />
            </div>
            <div className="ep-category-section">
              <SectionHeader>Icons</SectionHeader>
              <ItemGrid items={TYPICAL_ICONS} isIcon selectedValue={value} onSelect={handleSelect} />
            </div>
          </>
        )}

        {!searchResults &&
          activeTab === "emojis" &&
          Object.entries(EMOJI_CATEGORIES).map(([category, items]) => (
            <LazyCategory
              key={category}
              label={category}
              items={items}
              isIcon={false}
              selectedValue={value}
              onSelect={handleSelect}
            />
          ))}

        {!searchResults &&
          activeTab === "icons" &&
          Object.entries(MDI_CATEGORIES).map(([category, items]) => (
            <LazyCategory
              key={category}
              label={category}
              items={items}
              isIcon
              selectedValue={value}
              onSelect={handleSelect}
            />
          ))}
      </div>
    </div>,
    document.body,
  );
}
