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
import { hiddenLinksOf } from "../src/editor/condensed.js";
import { PageView } from "../src/ui/PageView.js";
import { writeViewModePref } from "../src/ui/viewPrefs.js";
import { writeDeviceSetting } from "../src/ui/components/modals/deviceSettings.js";
import type { ContentAst } from "@notees/protocol";

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
  it("renders the excerpt, stretches on click, re-condenses via the back-arrow", async () => {
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

    // The excerpt is the head of the prose; the tail is not rendered.
    const excerpt = excerptOf([{ type: "text", text: LONG }]);
    expect(within(tree).getByText(excerpt.text)).not.toBeNull();
    expect(within(tree).queryByText(LONG)).toBeNull();
    // A block that fits one line is its own excerpt: the second seeded
    // block below asserts the untruncated branch by absence of chrome on
    // one-line rows in the badge specs.

    // One click anywhere on the excerpt stretches the block in place.
    fireEvent.click(within(tree).getByText(excerpt.text));
    expect(within(tree).getByText(LONG)).not.toBeNull();

    // The back-arrow re-condenses (owner ruling: it sits at the row's end).
    fireEvent.click(within(tree).getByRole("button", { name: "Condense block" }));
    expect(within(tree).queryByText(LONG)).toBeNull();
    expect(within(tree).getByText(excerpt.text)).not.toBeNull();
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
