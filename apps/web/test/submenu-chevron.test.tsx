/**
 * Submenu chevron + hover seams (owner 2026-10-16, feedback pass): the
 * context menu's submenu chevron and the breadcrumb trail separator both
 * rode --md-sys-color-outline (a border token) and read as nearly
 * invisible — both now ride the icon role (on-surface-variant), and the
 * menu chevron is the mdi sprite's chevron-right instead of a thin text
 * glyph. Submenus also open on hover over their parent line (pointer-fine
 * devices only — the tap stays the explicit toggle on touch).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";

import { ContextMenu, type ContextMenuItem } from "../src/ui/components/ui/ContextMenu.js";

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

describe("ContextMenu submenu hover (owner 2026-10-16)", () => {
  it("hovering the parent line opens the submenu on pointer-fine devices", () => {
    stubHover(true);
    const { getByText, queryByText } = renderMenu();

    expect(queryByText("Markdown")).toBeNull();
    fireEvent.mouseEnter(getByText("Copy"));
    expect(queryByText("Markdown")).not.toBeNull();
    expect(queryByText("Link")).not.toBeNull();
  });

  it("hovering a plain item closes the open submenu", () => {
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

describe("chevron visibility (owner 2026-10-16 feedback)", () => {
  it("the submenu chevron renders the mdi sprite chevron-right", () => {
    stubHover(false);
    const { getByText } = renderMenu();
    const use = getByText("Copy").closest("button")!.querySelector(".context-menu-arrow use");
    expect(use?.getAttribute("href")).toContain("mdi-chevron-right");
  });

  it("the menu arrow and the breadcrumb separator ride the icon role, not outline", () => {
    // jsdom applies no layout — the visibility contract is asserted at the
    // source level (the css-token-drift / focus-mode pattern).
    const process_ = process as unknown as {
      getBuiltinModule(name: string): typeof import("node:fs");
    };
    const fs = process_.getBuiltinModule("node:fs");
    const path = process_.getBuiltinModule("node:path") as unknown as typeof import("node:path");
    const readCss = (segments: string[]) =>
      fs.readFileSync(path.join(process.cwd(), ...segments), "utf8");

    const menuCss = readCss(["src", "ui", "components", "ui", "ContextMenu.css"]);
    const arrowBlock = menuCss.split(".context-menu-arrow {")[1]!.split("}")[0]!;
    expect(arrowBlock).toContain("var(--md-sys-color-on-surface-variant)");
    expect(arrowBlock).not.toContain("--md-sys-color-outline");

    const crumbsCss = readCss(["src", "ui", "components", "Breadcrumbs.css"]);
    const separatorBlock = crumbsCss.split(".node-breadcrumb-separator {")[1]!.split("}")[0]!;
    expect(separatorBlock).toContain("var(--md-sys-color-on-surface-variant)");
    expect(separatorBlock).not.toContain("--md-sys-color-outline");
  });
});
