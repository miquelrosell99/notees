/**
 * Queries hub tests (§34.31 V1/V2/V4/V13) — the shell's saved-views surface:
 *
 *  - the FilterBuilderModal ad-hoc composer: Run executes session-only;
 *    "Save as view" persists a query token (view record per V3) on a
 *    lazily-created host page, and the new view appears as a tab (V1);
 *  - the token round-trip: the persisted queryAst is exactly what the shared
 *    builder composes, including `{today}` placeholders (V2 — resolved at
 *    compile time, so the live view matches nodes created today);
 *  - ViewTabs ops: rename / duplicate / set-default / delete (V1), with the
 *    default tab driving the initial selection (V13 — the default is config
 *    in the record, not code);
 *  - the results area renders through NodeCollection and the view-mode
 *    switcher persists into the token's view record (synced state).
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import type { ContentAst } from "@notees/protocol";
import type { QueryAst } from "@notees/query";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { QueriesHub } from "../src/ui/components/QueriesHub.js";
import { parseQueryViewRecord } from "../src/ui/queryViewRecord.js";
import { listQueryTokens } from "../src/ui/queryTokens.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  localStorage.clear();
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

async function seedWorld(client: WorkspaceClient) {
  const city = await client.createClass("City");
  await client.createObject({ presentAsMain: true, name: "Paris", classIds: [city] });
  await client.createObject({ presentAsMain: true, name: "London", classIds: [city] });
  return { city };
}

function hostPageOf(client: WorkspaceClient): { id: string; contentAst: ContentAst } | undefined {
  const stored = localStorage.getItem("notees.settings.queriesHostPageId");
  if (stored === null) return undefined;
  const id = JSON.parse(stored) as string;
  return client.getNode(id) as { id: string; contentAst: ContentAst } | undefined;
}

async function saveViewViaModal(name: string, configure?: (dialog: HTMLElement) => void) {
  fireEvent.click(screen.getByRole("button", { name: "New query" }));
  const dialog = await screen.findByRole("dialog", { name: "Query builder" });
  configure?.(dialog);
  fireEvent.change(within(dialog).getByLabelText("View name"), { target: { value: name } });
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: "Save as view" }));
  });
}

describe("Queries hub (§34.31 V1/V2/V4/V13)", () => {
  it("saves an ad-hoc query as a view: token on the lazily-created host page, tab appears, results render", async () => {
    const client = await seedClient();
    const { city } = await seedWorld(client);

    render(<QueriesHub client={client} onOpenNode={() => {}} />);
    expect(screen.getByText("No saved views yet")).not.toBeNull();

    await saveViewViaModal("Cities", (dialog) => {
      fireEvent.change(within(dialog).getByLabelText("Class"), { target: { value: city } });
    });

    // The host page was created lazily and carries the token (V3 record).
    const host = hostPageOf(client);
    expect(host).not.toBeUndefined();
    const tokens = listQueryTokens(host!.contentAst as readonly unknown[]);
    expect(tokens.length).toBe(1);
    expect(tokens[0]!.queryAst).toEqual({
      version: 1,
      scope: { type: "entire_workspace" },
      root: { type: "group", logic: "and", children: [{ type: "class", classId: city }] },
    });
    expect(parseQueryViewRecord(tokens[0]!.view)).toEqual({ mode: "list", title: "Cities", isDefault: false });

    // The tab renders with its title and the results show both cities.
    expect(await screen.findByRole("tab", { name: /Cities/ })).not.toBeNull();
    expect(await screen.findByText("Paris")).not.toBeNull();
    expect(screen.getByText("London")).not.toBeNull();
  });

  it("{today} placeholders persist in the saved AST and resolve at run time", async () => {
    const client = await seedClient();
    const { city } = await seedWorld(client);

    render(<QueriesHub client={client} onOpenNode={() => {}} />);
    await saveViewViaModal("Today's cities", (dialog) => {
      fireEvent.change(within(dialog).getByLabelText("Class"), { target: { value: city } });
      fireEvent.change(within(dialog).getByLabelText("Created after"), { target: { value: "{today}" } });
    });

    // The placeholder rides the saved AST verbatim (compile-time resolution).
    const host = hostPageOf(client)!;
    const token = listQueryTokens(host.contentAst as readonly unknown[])[0]!;
    const children = (token.queryAst as QueryAst).root.children;
    expect(children).toContainEqual({ type: "createdAfter", timestamp: "{today}" });

    // Both cities were created today → the live view resolves the
    // placeholder and matches them.
    expect(await screen.findByText("Paris")).not.toBeNull();
    expect(screen.getByText("London")).not.toBeNull();

    // A fixed far-future date matches nothing — the window is real.
    fireEvent.click(screen.getByRole("button", { name: "Edit query" }));
    const dialog = await screen.findByRole("dialog", { name: "Query builder" });
    fireEvent.change(within(dialog).getByLabelText("Created after"), {
      target: { value: "2999-01-01" },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Save as view" }));
    });
    expect(await screen.findByText("No results.")).not.toBeNull();
  });

  it("ad-hoc Run is session-only: results render, nothing persists", async () => {
    const client = await seedClient();
    const { city } = await seedWorld(client);

    render(<QueriesHub client={client} onOpenNode={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "New query" }));
    const dialog = await screen.findByRole("dialog", { name: "Query builder" });
    fireEvent.change(within(dialog).getByLabelText("Class"), { target: { value: city } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Run" }));
    });

    expect(await screen.findByText("Paris")).not.toBeNull();
    // No host page, no tokens — the ad-hoc run lived in the session only.
    expect(hostPageOf(client)).toBeUndefined();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("ViewTabs: rename, duplicate, set-default (drives the selection), delete", async () => {
    const client = await seedClient();
    const { city } = await seedWorld(client);

    const { unmount } = render(<QueriesHub client={client} onOpenNode={() => {}} />);
    await saveViewViaModal("One", (dialog) => {
      fireEvent.change(within(dialog).getByLabelText("Class"), { target: { value: city } });
    });
    await saveViewViaModal("Two");

    const host = () => hostPageOf(client)!;
    const tokens = () => listQueryTokens(host().contentAst as readonly unknown[]);
    expect(tokens().length).toBe(2);

    // Rename via the tab menu.
    fireEvent.click(screen.getByRole("button", { name: /Two options/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    const renameField = screen.getByDisplayValue("Two");
    fireEvent.change(renameField, { target: { value: "Renamed" } });
    await act(async () => {
      fireEvent.keyDown(renameField, { key: "Enter" });
    });
    expect(parseQueryViewRecord(tokens()[1]!.view).title).toBe("Renamed");

    // Duplicate: a copy lands right after with a " copy" title.
    fireEvent.click(screen.getByRole("button", { name: /Renamed options/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Duplicate" }));
    expect(tokens().length).toBe(3);
    expect(parseQueryViewRecord(tokens()[2]!.view).title).toBe("Renamed copy");

    // Set as default on the FIRST tab → the record carries the flag and the
    // hub selects it on reload (V13).
    fireEvent.click(screen.getByRole("button", { name: /One options/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Set as default" }));
    expect(parseQueryViewRecord(tokens()[0]!.view).isDefault).toBe(true);
    expect(parseQueryViewRecord(tokens()[1]!.view).isDefault).toBe(false);

    // Re-mount: the default tab is the effective selection.
    unmount();
    render(<QueriesHub client={client} onOpenNode={() => {}} />);
    const oneTab = await screen.findByRole("tab", { name: /^One/ });
    expect(oneTab.getAttribute("aria-selected")).toBe("true");
    const twoTab = screen.getByRole("tab", { name: /^Renamed(?! copy)/ });
    expect(twoTab.getAttribute("aria-selected")).toBe("false");

    // Delete removes the token (confirmation).
    fireEvent.click(screen.getByRole("button", { name: /Renamed options/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    });
    expect(tokens().length).toBe(2);
    expect(tokens().map((t) => parseQueryViewRecord(t.view).title)).toEqual(["One", "Renamed copy"]);
  });

  it("the view-mode switcher persists into the token's view record", async () => {
    const client = await seedClient();
    const { city } = await seedWorld(client);

    render(<QueriesHub client={client} onOpenNode={() => {}} />);
    await saveViewViaModal("Cities", (dialog) => {
      fireEvent.change(within(dialog).getByLabelText("Class"), { target: { value: city } });
    });
    await screen.findByText("Paris");

    fireEvent.click(screen.getByRole("radio", { name: "Table" }));
    const host = hostPageOf(client)!;
    const token = listQueryTokens(host.contentAst as readonly unknown[])[0]!;
    expect(parseQueryViewRecord(token.view).mode).toBe("table");
    expect((await screen.findAllByRole("columnheader")).length).toBeGreaterThan(0);
  });
});
