/**
 * Submenu chevron + hover seams: the
 * context menu's submenu chevron and the breadcrumb trail separator both
 * rode --md-sys-color-outline (a border token) and read as nearly
 * invisible — both now ride the icon role (on-surface-variant), and the
 * menu chevron is the mdi sprite's chevron-right instead of a thin text
 * glyph. Submenus also open on hover over their parent line (pointer-fine
 * devices only — the tap stays the explicit toggle on touch).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";

import { ContextMenu, type ContextMenuItem } from "../src/components/ui/fleet/ContextMenu.js";

/** hover-capability stub: "(hover: hover)" matches when `hover` is true. */
function stubHover(hover: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: hover && query === "(hover: hover)",
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })),
  );
}

const items: ContextMenuItem[] = [
  { id: "open", label: "Open", onClick: () => {} },
  {
    id: "copy",
    label: "Copy",
    submenuItems: [
      { id: "markdown", label: "Markdown", onClick: () => {} },
      { id: "link", label: "Link", onClick: () => {} },
    ],
  },
  { id: "delete", label: "Delete", danger: true, onClick: () => {} },
];

function renderMenu() {
  return render(<ContextMenu items={items} position={{ x: 0, y: 0 }} onClose={() => {}} />);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ContextMenu submenu hover", () => {
  it("hovering the parent line opens the flyout on pointer-fine devices", () => {
    stubHover(true);
    const { getByText, queryByText } = renderMenu();

    expect(queryByText("Markdown")).toBeNull();
    fireEvent.mouseEnter(getByText("Copy"));
    expect(queryByText("Markdown")).not.toBeNull();
    expect(queryByText("Link")).not.toBeNull();
    // The submenu flies out to the SIDE of the parent row — a second card
    // outside the menu's item flow, never a row inside the list. Radix
    // wraps the flyout in its popper wrapper (position:fixed, so opening
    // it can never re-fit the menu's box the way the old inline expansion
    // did) — the contract asserted here is the flyout surface itself.
    const flyout = document.querySelector(".context-menu-submenu-flyout");
    expect(flyout).not.toBeNull();
    expect(flyout!.classList.contains("context-menu-submenu-flyout")).toBe(true);
  });

  it("hovering a plain item closes the open flyout", () => {
    stubHover(true);
    const { getByText, queryByText } = renderMenu();

    fireEvent.mouseEnter(getByText("Copy"));
    expect(queryByText("Markdown")).not.toBeNull();
    fireEvent.mouseEnter(getByText("Open"));
    expect(queryByText("Markdown")).toBeNull();
  });

  it("hover does not open on touch devices — the tap stays the toggle", () => {
    stubHover(false);
    const { getByText, queryByText } = renderMenu();

    fireEvent.mouseEnter(getByText("Copy"));
    expect(queryByText("Markdown")).toBeNull();
    // The click toggle still works.
    fireEvent.click(getByText("Copy"));
    expect(queryByText("Markdown")).not.toBeNull();
  });
});

describe("chevron visibility", () => {
  it("the submenu chevron renders the mdi sprite chevron-right", () => {
    stubHover(false);
    const { getByText } = renderMenu();
    // Radix renders the sub trigger as a menuitem row (div), not a button.
    const use = getByText("Copy").closest("[role='menuitem']")!.querySelector(".context-menu-arrow use");
    expect(use?.getAttribute("href")).toContain("mdi-chevron-right");
  });

  it("the menu arrow and the breadcrumb separator ride the icon role, not outline; the submenu flies out absolutely", () => {
    // jsdom applies no layout — the visibility contract is asserted at the
    // source level (the css-token-drift / focus-mode pattern).
    const process_ = process as unknown as {
      getBuiltinModule(name: string): typeof import("node:fs");
    };
    const fs = process_.getBuiltinModule("node:fs");
    const path = process_.getBuiltinModule("node:path") as unknown as typeof import("node:path");
    const readCss = (segments: string[]) =>
      fs.readFileSync(path.join(process.cwd(), ...segments), "utf8");

    const menuCss = readCss(["src", "components", "ui", "fleet", "ContextMenu.css"]);
    const arrowBlock = menuCss.split(".context-menu-arrow {")[1]!.split("}")[0]!;
    expect(arrowBlock).toContain("var(--md-sys-color-on-surface-variant)");
    expect(arrowBlock).not.toContain("--md-sys-color-outline");

    // The flyout rides outside the menu's flow — Radix's popper wrapper
    // owns its position (a position rule on the flyout would break
    // floating-ui's align math, same as the menu root), so opening/closing
    // it can never change the menu's box and re-fit it (the inline
    // expansion used to grow the menu near the bottom edge and make the
    // whole thing dance on hover). And the menu card must NOT clip: the
    // card radius class hides overflow, which made the flyout invisible —
    // the menu overrides it back to visible.
    const flyoutBlock = menuCss.split(".context-menu-submenu-flyout {")[1]!.split("}")[0]!;
    expect(flyoutBlock).not.toContain("position:");
    expect(menuCss).not.toContain("context-menu-submenu-inline");
    const menuRootBlock = menuCss.split(".card.context-menu {")[1]!.split("}")[0]!;
    expect(menuRootBlock).toContain("overflow: visible");
    // The menu and its flyout ride surface-container-low per the M3 menu
    // spec (menus sit at elevation level 2 on
    // surfaceContainerLow — m3.material.io menus) and cite the Material role
    // directly (the md-sys namespace is Material-only; the css-token-drift
    // gate's check 7 rejects surface aliases like --md-sys-color-sidebar-card
    // outside their own surface).
    expect(menuRootBlock).toContain("var(--md-sys-color-surface-container-low)");
    expect(menuRootBlock).not.toContain("sidebar-card");
    // …with the M3 menu-spec 4dp container shape (the --radius-menu token,
    // overriding the Card radius class).
    expect(menuRootBlock).toContain("border-radius: var(--radius-menu)");
    const flyoutSurface = menuCss.split(".context-menu-submenu-flyout {")[1]!.split("}")[0]!;
    expect(flyoutSurface).toContain("var(--md-sys-color-surface-container-low)");
    expect(flyoutSurface).toContain("border-radius: var(--radius-menu)");

    // Card's levels map to the M3 elevation table (// static cards carry level 1, menus/popovers level 2, dialogs level 3).
    // The mapping rides the Tailwind config + Card wrapper classes since
    // the shadcn-catalog migration (Card.css retired 2026-10-19).
    const cardSrc = fs.readFileSync(
      path.join(process.cwd(), "src", "components", "ui", "fleet", "Card.tsx"),
      "utf8",
    );
    expect(cardSrc).toContain('medium: "shadow-level2"');
    expect(cardSrc).toContain('high: "shadow-level3"');
    expect(cardSrc).toContain('low: "shadow-level1"');
    const tailwindConfig = fs.readFileSync(
      path.join(process.cwd(), "tailwind.config.ts"),
      "utf8",
    );
    expect(tailwindConfig).toContain('level2: "var(--elevation-2)"');
    expect(tailwindConfig).toContain('level3: "var(--elevation-3)"');
    expect(tailwindConfig).toContain('level1: "var(--elevation-1)"');

    const crumbsCss = readCss(["src", "features", "node-menu", "Breadcrumbs.css"]);
    const separatorBlock = crumbsCss.split(".node-breadcrumb-separator {")[1]!.split("}")[0]!;
    expect(separatorBlock).toContain("var(--md-sys-color-on-surface-variant)");
    expect(separatorBlock).not.toContain("--md-sys-color-outline");
  });
});
