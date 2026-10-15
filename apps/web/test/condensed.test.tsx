/**
 * Condensed layer tests (owner 2026-10-15): the excerpt derivation's web
 * seam (`hiddenLinksOf` — the honest hidden-link count over the shared
 * `proseSpans` projection) and the layer's DOM contract over PageView:
 * excerpt rows + the stretch/re-condense round trip, the links badge and
 * its popup (one dismissal convention, row click opens the node), the
 * page-body opt-in (untouched surfaces), and the companion ruling — prose
 * mode honors collapse. jsdom over the in-process WorkspaceClient +
 * MemoryRelay; the layer toggle rides the `condensed.<pageId>` device
 * preference, the folds the `notees.collapse.v1.<rootId>` localStorage key
 * (setup.ts clears localStorage between tests).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { DISPLAY_NAME_MAX, excerptOf } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import type { SyncStatusSnapshot } from "../src/core/workspace-client.js";
import { EMPTY_UNDO_STATE } from "../src/core/undo-journal.js";
import { hiddenLinksOf } from "../src/editor/condensed.js";
import { PageView } from "../src/ui/PageView.js";
import { TopBar } from "../src/ui/components/TopBar.js";
import { CommandPalette } from "../src/ui/components/CommandPalette.js";
import { writeViewModePref } from "../src/ui/viewPrefs.js";
import { writeDeviceSetting } from "../src/ui/components/modals/deviceSettings.js";
import type { ContentAst } from "@notees/protocol";

const SYNC: SyncStatusSnapshot = {
  status: "idle",
  error: null,
  pending: 0,
  failed: 0,
  quarantined: 0,
  parked: 0,
  realtime: false,
  cursorSeq: 0,
};

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
});

async function seedClient(): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(new MemoryRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

/** Flush the microtasks a fireEvent-triggered async write runs on. */
async function flushWrites(): Promise<void> {
  await act(async () => {});
}

const LONG =
  "A long opening line that carries the block well past the excerpt budget ".repeat(
    2,
  ) + "and then some more words to be sure";

describe("hiddenLinksOf", () => {
  const mention = (target: string, text: string) => ({
    type: "mention" as const,
    targetNodeId: target,
    text,
  });

  it("returns nothing without a cut", () => {
    const ast = [mention("a", "Alpha")];
    expect(hiddenLinksOf(ast, 0)).toEqual([]);
  });

  it("counts mentions at or after the cut, keeps earlier ones visible", () => {
    const ast: ContentAst = [
      { type: "text", text: "see " },
      mention("visible-target", "Alpha"),
      { type: "hard_break" },
      mention("hidden-target", "Beta"),
    ];
    const { cutOffset } = excerptOf(ast);
    expect(cutOffset).toBe("see Alpha".length);
    expect(hiddenLinksOf(ast, cutOffset).map((l) => l.targetNodeId)).toEqual([
      "hidden-target",
    ]);
  });

  it("a mention straddling the cut counts as visible (its start is before)", () => {
    const ast: ContentAst = [
      { type: "text", text: "ab" },
      mention("straddler", "cdefgh"),
      { type: "hard_break" },
      { type: "text", text: "rest" },
    ];
    // The cut fires inside the mention's span: start 2 < cutOffset 3.
    const { cutOffset } = excerptOf(ast);
    expect(hiddenLinksOf(ast, cutOffset)).toEqual([]);
  });

  it("typed links and class chips never count — the badge names mentions only", () => {
    const ast: ContentAst = [
      { type: "text", text: "x" },
      { type: "hard_break" },
      { type: "typed_link", verb: "supports", text: "claim" },
      { type: "class_link", classId: "cls-1", displayText: "the class" },
    ];
    const { cutOffset } = excerptOf(ast);
    expect(hiddenLinksOf(ast, cutOffset)).toEqual([]);
  });

  it("stays aligned with the excerpt when chips shift the offsets", () => {
    const ast: ContentAst = [
      { type: "text", text: "meet " },
      { type: "class_link", classId: "cls-1" },
      { type: "hard_break" },
      mention("after-chip", "Beta"),
    ];
    const resolve = () => "Correo";
    const { cutOffset } = excerptOf(ast, resolve);
    expect(cutOffset).toBe("meet Correo".length);
    expect(hiddenLinksOf(ast, cutOffset, resolve).map((l) => l.targetNodeId)).toEqual([
      "after-chip",
    ]);
  });
});

describe("condensed layer over PageView", () => {
  it("renders the excerpt with a permanent … mark and the chrome in the row; click enters edit, blur re-condenses", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Condensed" });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: LONG }],
    });
    writeDeviceSetting(`condensed.${pageId}`, true);

    const { container } = render(<PageView client={client} pageId={pageId} />);
    const tree = container.querySelector(".nt-block-tree") as HTMLElement;
    expect(tree).not.toBeNull();

    // The excerpt is the head of the prose; the tail is not rendered. The
    // "…" IS the toggle (owner ruling): the mark button sits in the row; the
    // badge rides beside it (CSS hover/focus-reveal — asserted source-level
    // in the CSS spec below; here we assert the chrome exists and stays
    // reachable). The retired controls are gone.
    const excerpt = excerptOf([{ type: "text", text: LONG }]);
    expect(within(tree).getByText(excerpt.text)).not.toBeNull();
    expect(within(tree).queryByText(LONG)).toBeNull();
    expect(tree.querySelector(".nt-block-excerpt__ellipsis")).not.toBeNull();
    expect(within(tree).getByRole("button", { name: "Show full content" })).not.toBeNull();
    // The retired lens pin button and back-arrow: no element, no CSS hook.
    expect(tree.querySelector(".nt-block-excerpt__stretch")).toBeNull();
    expect(tree.querySelector(".nt-block-condense")).toBeNull();

    // Click anywhere on the row (the text body) → EDIT mode on the full
    // content (the standard click-to-edit contract; the excerpt is display
    // chrome).
    fireEvent.click(within(tree).getByText(excerpt.text));
    const editor = tree.querySelector(".nt-block-text") as HTMLElement;
    expect(editor).not.toBeNull();
    // Editing never pins: the stretched set stays empty…
    expect(localStorage.getItem(`notees.stretched.v1.${pageId}`)).toBeNull();

    // Blur → the row renders condensed again (blur never pins either).
    fireEvent.blur(editor);
    expect(tree.querySelector(".nt-block-text")).toBeNull();
    expect(within(tree).getByText(excerpt.text)).not.toBeNull();
    expect(within(tree).queryByText(LONG)).toBeNull();
  });

  it("the … pins in place and un-pins at the text's end; the pin survives edit cycles", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Pinned" });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: LONG }],
    });
    writeDeviceSetting(`condensed.${pageId}`, true);

    const { container } = render(<PageView client={client} pageId={pageId} />);
    const tree = container.querySelector(".nt-block-tree") as HTMLElement;
    const excerpt = excerptOf([{ type: "text", text: LONG }]);

    // The "…" (not the row click) is the only way into the pinned read-mode
    // row: tap → pin.
    fireEvent.click(within(tree).getByRole("button", { name: "Show full content" }));
    expect(within(tree).getByText(LONG)).not.toBeNull();
    expect(tree.querySelector(".nt-block-text")).toBeNull();
    expect(JSON.parse(localStorage.getItem(`notees.stretched.v1.${pageId}`) ?? "[]")).toEqual([
      expect.any(String),
    ]);
    // The mark returned at the END OF THE TEXT, permanent and tappable (the
    // back-arrow is gone; the condensed row's pin label is gone too).
    expect(within(tree).getByRole("button", { name: "Condense" })).not.toBeNull();
    expect(within(tree).queryByRole("button", { name: "Show full content" })).toBeNull();

    // Pinned reads at a glance (owner ruling): the pinned "…" is a
    // FILLED CHIP in the app's active-toggle register, and the bullet-ring
    // hook is gone entirely (the chip is the single cue in every mode).
    const pinnedMark = within(tree).getByRole("button", { name: "Condense" });
    expect(pinnedMark.classList.contains("nt-block-excerpt__ellipsis--pinned")).toBe(true);
    expect(tree.querySelector(".nt-block--pinned")).toBeNull();

    // A pinned row clicks into edit like any block; blur returns it to
    // PINNED read (still stretched — blur never unpins).
    fireEvent.click(within(tree).getByText(LONG));
    const editor = tree.querySelector(".nt-block-text") as HTMLElement;
    expect(editor).not.toBeNull();
    fireEvent.blur(editor);
    expect(within(tree).getByText(LONG)).not.toBeNull();

    // Tap the trailing "…" → un-pin: the excerpt returns.
    fireEvent.click(within(tree).getByRole("button", { name: "Condense" }));
    expect(within(tree).queryByText(LONG)).toBeNull();
    expect(within(tree).getByText(excerpt.text)).not.toBeNull();
    expect(localStorage.getItem(`notees.stretched.v1.${pageId}`)).toBe("[]");
    // The condensed row's mark is the muted one — no accent modifier.
    const condensedMark = within(tree).getByRole("button", { name: "Show full content" });
    expect(condensedMark.classList.contains("nt-block-excerpt__ellipsis--pinned")).toBe(false);
  });

  it("one-line blocks render the ordinary row — no toggle", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Short" });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "fits one line" }],
    });
    writeDeviceSetting(`condensed.${pageId}`, true);

    const { container } = render(<PageView client={client} pageId={pageId} />);
    const tree = container.querySelector(".nt-block-tree") as HTMLElement;
    expect(within(tree).getByText("fits one line")).not.toBeNull();
    expect(within(tree).queryByRole("button", { name: "Show full content" })).toBeNull();
  });

  it("the links badge counts hidden mentions and its popup opens the node", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Links" });
    const targetId = await client.createObject({ presentAsMain: true, name: "Target Page" });
    const ast: ContentAst = [
      { type: "text", text: "see " },
      { type: "mention", targetNodeId: targetId, text: "Target Page" },
      { type: "hard_break" },
      { type: "text", text: "and the rest of this block lives past the cut entirely" },
    ];
    await client.createObject({ parentId: pageId, contentAst: ast });
    writeDeviceSetting(`condensed.${pageId}`, true);

    const onOpenPage = vi.fn();
    const { container } = render(
      <PageView client={client} pageId={pageId} onOpenPage={onOpenPage} />,
    );
    const tree = container.querySelector(".nt-block-tree") as HTMLElement;
    // The mention straddles nothing here: its span starts before the cut, so
    // the badge names zero — assert that honestly first…
    expect(within(tree).queryByRole("button", { name: /hidden links/ })).toBeNull();

    // …then re-derive the honest case: a second block with the mention past
    // the cut.
    const block2: ContentAst = [
      { type: "text", text: "x".repeat(DISPLAY_NAME_MAX + 5) },
      { type: "mention", targetNodeId: targetId, text: "Target Page" },
    ];
    await client.createObject({ parentId: pageId, contentAst: block2 });
    await flushWrites();

    const badge = within(tree).getByRole("button", { name: "1 hidden links" });
    expect(badge).not.toBeNull();
    fireEvent.click(badge);
    const popup = screen.getByRole("dialog", { name: "Hidden links" });
    expect(within(popup).getByText("1 hidden link")).not.toBeNull();
    expect(within(popup).getByText("Target Page")).not.toBeNull();

    // Click a row: the ordinary open gesture (opening does not stretch).
    fireEvent.click(within(popup).getByText("Target Page"));
    expect(onOpenPage).toHaveBeenCalledWith(targetId);
    expect(screen.queryByRole("dialog", { name: "Hidden links" })).toBeNull();
  });

  it("Esc dismisses the popup (the one dismissal convention)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Esc" });
    const targetId = await client.createObject({ presentAsMain: true, name: "Esc Target" });
    await client.createObject({
      parentId: pageId,
      contentAst: [
        { type: "text", text: "x".repeat(DISPLAY_NAME_MAX + 5) },
        { type: "mention", targetNodeId: targetId, text: "Esc Target" },
      ],
    });
    writeDeviceSetting(`condensed.${pageId}`, true);

    const { container } = render(<PageView client={client} pageId={pageId} />);
    const tree = container.querySelector(".nt-block-tree") as HTMLElement;
    fireEvent.click(within(tree).getByRole("button", { name: "1 hidden links" }));
    expect(screen.getByRole("dialog", { name: "Hidden links" })).not.toBeNull();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Hidden links" })).toBeNull();
  });

  it("off by default: the body renders full content without the pref", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Off" });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: LONG }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);
    const tree = container.querySelector(".nt-block-tree") as HTMLElement;
    expect(within(tree).getByText(LONG)).not.toBeNull();
    expect(within(tree).queryByRole("button", { name: "Show full content" })).toBeNull();
  });
});

describe("prose mode honors collapse (companion ruling)", () => {
  it("a folded subtree hides in prose and the chevron persists as the indicator", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Prose Fold" });
    const parent = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "foldable parent" }],
    });
    await client.createObject({
      parentId: parent,
      contentAst: [{ type: "text", text: "hidden nested child" }],
    });
    // The fold set is device-local per page (the collapse-set contract).
    localStorage.setItem(`notees.collapse.v1.${pageId}`, JSON.stringify([parent]));
    writeViewModePref(`nodeBlocks.${pageId}`, "prose");

    const { container } = render(<PageView client={client} pageId={pageId} />);
    const tree = container.querySelector(".nt-block-tree") as HTMLElement;
    expect(tree.classList.contains("nt-prose")).toBe(true);
    // The collapsed subtree hides exactly as in outline…
    expect(within(tree).queryByText("hidden nested child")).toBeNull();
    expect(within(tree).getByText("foldable parent")).not.toBeNull();
    // …and the chevron mounts, persistent at rest while collapsed.
    const chevron = within(tree).getByRole("button", { name: "Expand block" });
    expect(chevron).not.toBeNull();
    expect(chevron.getAttribute("aria-expanded")).toBe("false");
    const row = chevron.closest(".nt-block") as HTMLElement;
    expect(row.classList.contains("nt-block--collapsed")).toBe(true);
    // No indent-line rail in prose (the gesture stays outline-only).
    expect(tree.querySelector(".nt-block-children__rail")).toBeNull();

    // Clicking the chevron unfolds, prose included.
    fireEvent.click(chevron);
    expect(within(tree).getByText("hidden nested child")).not.toBeNull();
  });
});

describe("condensed layer switch surfaces (owner directive 2026-10-15)", () => {
  it("TopBar: hidden without a handler (no eligible page), pressed chrome otherwise", () => {
    const { unmount } = render(
      <TopBar
        syncStatus={SYNC}
        sidebarOpen
        rightPanelOpen={false}
        onToggleSidebar={() => {}}
        onToggleRightPanel={() => {}}
      />,
    );
    // The App passes no handler where there is no eligible main-surface
    // page — the button simply doesn't render (the onToggleLayout idiom).
    expect(screen.queryByRole("button", { name: "Condensed mode" })).toBeNull();
    unmount();

    const onToggleCondensed = vi.fn();
    render(
      <TopBar
        syncStatus={SYNC}
        sidebarOpen
        rightPanelOpen={false}
        onToggleSidebar={() => {}}
        onToggleRightPanel={() => {}}
        condensedActive={false}
        onToggleCondensed={onToggleCondensed}
      />,
    );
    const button = screen.getByRole("button", { name: "Condensed mode" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button.title).toBe("Condensed: enter");
    fireEvent.click(button);
    expect(onToggleCondensed).toHaveBeenCalledTimes(1);
    unmount();

    render(
      <TopBar
        syncStatus={SYNC}
        sidebarOpen
        rightPanelOpen={false}
        onToggleSidebar={() => {}}
        onToggleRightPanel={() => {}}
        condensedActive
        onToggleCondensed={() => {}}
      />,
    );
    // The engaged state wears the pressed chrome and names the exit.
    const active = screen.getByRole("button", { name: "Exit condensed mode" });
    expect(active).toHaveAttribute("aria-pressed", "true");
    expect(active.classList.contains("nt-icon-btn-active")).toBe(true);
  });

  it("command palette: the Condensed row mirrors the focus row and is absent without a handler", async () => {
    const client = await seedClient();
    const renderPalette = (props: { condensedActive?: boolean; onToggleCondensed?: () => void }) => {
      return render(
        <CommandPalette
          client={client}
          open
          onRequestOpen={() => {}}
          onClose={() => {}}
          onOpenNode={() => {}}
          onNewPage={() => {}}
          onSignOut={() => {}}
          undoState={EMPTY_UNDO_STATE}
          onUndo={() => {}}
          onRedo={() => {}}
          cacheVersion={0}
          {...props}
        />,
      );
    };

    // No eligible page: the App passes no callback — the row is absent
    // (the merge action's conditional-row pattern).
    const first = renderPalette({});
    expect(screen.queryByText("Condensed: enter")).toBeNull();
    expect(screen.queryByText("Condensed: exit")).toBeNull();
    first.unmount();

    const onToggleCondensed = vi.fn();
    const second = renderPalette({ condensedActive: false, onToggleCondensed });
    const enter = await screen.findByText("Condensed: enter");
    fireEvent.click(enter);
    expect(onToggleCondensed).toHaveBeenCalledTimes(1);
    second.unmount();

    renderPalette({ condensedActive: true, onToggleCondensed });
    expect(await screen.findByText("Condensed: exit")).not.toBeNull();
    expect(screen.queryByText("Condensed: enter")).toBeNull();
  });
});

describe("condensed chrome reveal mechanism (CSS source)", () => {
  // jsdom applies no :hover/:focus-within — the reveal contract is asserted
  // at the source level (the css-token-drift pattern).
  const process_ = process as unknown as {
    getBuiltinModule(name: string): typeof import("node:fs");
  };
  const fs = process_.getBuiltinModule("node:fs");
  const path = process_.getBuiltinModule("node:path") as unknown as typeof import("node:path");
  const css = fs.readFileSync(path.join(process.cwd(), "src", "ui", "app.css"), "utf8");

  it("the badge chrome hides at rest and reveals on row hover AND focus-within", () => {
    const base = /\.nt-block-excerpt__chrome \{[^}]*\}/.exec(css);
    expect(base).not.toBeNull();
    expect(base![0]).toContain("opacity: 0");
    expect(css).toContain(".nt-block-row:hover .nt-block-excerpt__chrome");
    expect(css).toContain(".nt-block:focus-within .nt-block-excerpt__chrome");
  });

  it("the … mark is the toggle: permanent, tap-floored, never opacity-gated", () => {
    const mark = /\.nt-block-excerpt__ellipsis \{[^}]*\}/.exec(css);
    expect(mark).not.toBeNull();
    expect(mark![0]).not.toContain("opacity: 0");
    // Generous hit padding around the small glyph — the tap-target floor.
    expect(mark![0]).toContain("min-width: 22px");
    expect(mark![0]).toContain("min-height: 22px");
  });

  it("the retired controls leave no CSS hooks behind", () => {
    expect(css).not.toContain(".nt-block-excerpt__stretch");
    expect(css).not.toContain(".nt-block-condense");
    expect(css).not.toContain("mdi-magnify-plus-outline");
  });

  it("the pinned … is a filled chip in the app's active-toggle register", () => {
    const chip = /\.nt-block-excerpt__ellipsis--pinned \{[^}]*\}/.exec(css);
    expect(chip).not.toBeNull();
    // The exact fill the focus-mode TopBar button's nt-icon-btn-active
    // wears (primary-container / on-primary-container) + its radius idiom.
    expect(chip![0]).toContain("var(--md-sys-color-primary-container)");
    expect(chip![0]).toContain("var(--md-sys-color-on-primary-container)");
    expect(chip![0]).toContain("var(--shape-medium)");
    // The rest state reads filled — not opacity-gated to a hover reveal,
    // and not the retired accent-text treatment.
    expect(chip![0]).not.toContain("opacity: 0");
    expect(chip![0]).not.toContain("color: var(--md-sys-color-primary);");
  });

  it("the bullet ring retires — no ring hooks anywhere", () => {
    expect(css).not.toContain(".nt-block--pinned");
    expect(css).not.toContain(".nt-bullet::after");
  });
});
