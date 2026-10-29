/**
 * Sources duplicates VIEW tests (task 13 — the visible half of the
 * duplicates feature, on top of task 12's pure grouping layer):
 *
 * - The hub's Duplicates mode (the toolbar switch): grouped lists of
 *   groupSourceDuplicates clusters — the header names the match basis
 *   (the shared DOI), the member rows render the row projection's
 *   title/authors/citekey, ONE Merge button per group, and the honest
 *   "No duplicates" empty state when nothing clusters.
 * - The merge flow end to end: Merge opens the modal, confirming merges
 *   the losers into the picked target through the standard semantics
 *   (the losers trash), and the view refreshes — the merged group
 *   disappears.
 *
 * Seeded over the repo's test-client pattern (MemoryRelay + sql.js, the
 * sources-duplicates convention) so the rows are produced end to end by
 * runSourcesQuery.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import {
  SYSTEM_CLASS_DISPLAY_NAMES,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_DISPLAY_NAMES,
  SYSTEM_PROPERTY_UUIDS,
} from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { runSourcesQuery } from "../src/features/sources/sourcesQuery.js";
import { groupSourceDuplicates } from "../src/features/sources/duplicates.js";
import { SourcesHub } from "../src/features/sources/SourcesHub.js";

const WS = "0192a000-0000-7000-8000-0000000000f1";
const ACTOR = "0192a000-0000-7000-8000-0000000000f2";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
  window.history.pushState({}, "", "/");
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

/** The minimal source family the projection reads (the sources-duplicates seed). */
async function seedSchema(client: WorkspaceClient): Promise<void> {
  const P = SYSTEM_PROPERTY_UUIDS;
  const SOURCE = SYSTEM_CLASS_UUIDS.source;
  for (const name of ["source", "journal_article"] as const) {
    await client.createClass(SYSTEM_CLASS_DISPLAY_NAMES[name], { id: SYSTEM_CLASS_UUIDS[name] });
  }
  await client.setClassExtends(SYSTEM_CLASS_UUIDS.journal_article, [SOURCE]);
  const schema = async (
    key: keyof typeof SYSTEM_PROPERTY_UUIDS,
    spec: Parameters<WorkspaceClient["createPropertySchema"]>[0],
  ) => {
    await client.createPropertySchema({ id: P[key], ...spec });
  };
  await schema("authors", {
    name: SYSTEM_PROPERTY_DISPLAY_NAMES.authors,
    type: "text",
    multi: true,
    scopeClassIds: [SOURCE],
  });
  await schema("citekey", {
    name: SYSTEM_PROPERTY_DISPLAY_NAMES.citekey,
    type: "text",
    scopeClassIds: [SOURCE],
  });
  await schema("doi", {
    name: SYSTEM_PROPERTY_DISPLAY_NAMES.doi,
    type: "text",
    scopeClassIds: [SOURCE],
  });
  for (const key of ["authors", "citekey", "doi"] as const) {
    await client.setClassProperty(SOURCE, P[key], {});
  }
}

interface Library {
  a1: string;
  a2: string;
  s1: string;
}

/** One DOI cluster (a1/a2) + one singleton (s1). */
async function seedItems(client: WorkspaceClient): Promise<Library> {
  const P = SYSTEM_PROPERTY_UUIDS;
  const create = (title: string): Promise<string> =>
    client.createObject({
      isEmbedded: false,
      name: title,
      classIds: [SYSTEM_CLASS_UUIDS.journal_article],
    });

  const a1 = await create("The Rust Programming Language");
  await client.setProperty(a1, P.authors, "Klabnik, Steve", 0);
  await client.setProperty(a1, P.doi, "10.1000/rust.1", 0);
  await client.setProperty(a1, P.citekey, "klabnik2018rust", 0);

  const a2 = await create("Rust Programming Language, 2nd ed.");
  await client.setProperty(a2, P.authors, "Klabnik, Steve", 0);
  await client.setProperty(a2, P.doi, " 10.1000/RUST.1 ", 0);

  const s1 = await create("Category Theory for Programmers");
  await client.setProperty(s1, P.authors, "Milewski, Bartosz", 0);

  return { a1, a2, s1 };
}

async function seededLibrary(): Promise<{ client: WorkspaceClient; items: Library }> {
  const client = await seedClient();
  await seedSchema(client);
  const items = await seedItems(client);
  return { client, items };
}

function enterDuplicatesMode(): void {
  fireEvent.click(screen.getByRole("button", { name: "Show duplicates" }));
}

describe("SourcesHub — Duplicates mode", () => {
  it("renders the groups: header names the match basis, member rows, ONE Merge per group", async () => {
    const { client } = await seededLibrary();
    render(<SourcesHub client={client} />);
    // The library loads first (the default mode).
    await screen.findByText("The Rust Programming Language");

    enterDuplicatesMode();
    const region = await screen.findByRole("region", { name: "Source duplicates" });

    // The group header names the match basis and the shared identifier
    // (the header detail repeats on the member row's DOI lane — the
    // header's own detail span carries it once).
    expect(within(region).getByText("Matching DOI")).not.toBeNull();
    expect(
      region.querySelector(".nt-sources-dup__group-detail")?.textContent,
    ).toBe("10.1000/rust.1");
    // The member rows render the row projection (title + citekey lane).
    expect(within(region).getByText("The Rust Programming Language")).not.toBeNull();
    expect(within(region).getByText("Rust Programming Language, 2nd ed.")).not.toBeNull();
    expect(within(region).getByText("klabnik2018rust")).not.toBeNull();
    // The singleton is not a duplicate — never listed.
    expect(within(region).queryByText("Category Theory for Programmers")).toBeNull();
    // Exactly ONE Merge button for the single group.
    expect(within(region).getAllByRole("button", { name: /^merge/i })).toHaveLength(1);
  });

  it("renders the honest 'No duplicates' empty state when nothing clusters", async () => {
    const client = await seedClient();
    await seedSchema(client);
    // One singleton only.
    await client.createObject({
      isEmbedded: false,
      name: "Lone Source",
      classIds: [SYSTEM_CLASS_UUIDS.journal_article],
    });
    render(<SourcesHub client={client} />);

    enterDuplicatesMode();
    expect(await screen.findByText("No duplicates")).not.toBeNull();
    expect(screen.queryAllByRole("button", { name: /^merge/i })).toHaveLength(0);
  });

  it("merging from the view trashes the losers and the group disappears", async () => {
    const { client } = await seededLibrary();
    // The deterministic grouping: members sorted by node id — the target
    // defaults to members[0], the loser is members[1].
    const rows = await runSourcesQuery(client, {}, null);
    const [group] = groupSourceDuplicates(rows);
    const target = group!.members[0]!;
    const loser = group!.members[1]!;

    render(<SourcesHub client={client} />);
    await screen.findByText("The Rust Programming Language");
    enterDuplicatesMode();
    const region = await screen.findByRole("region", { name: "Source duplicates" });
    fireEvent.click(within(region).getByRole("button", { name: /^merge/i }));

    // The modal opens over the view; confirm through the danger dialog.
    const dialog = await screen.findByRole("dialog", { name: "Merge 2 duplicates" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Merge" }));
    const confirm = await screen.findByRole("dialog", { name: "Merge duplicates?" });
    expect(within(confirm).getByText(new RegExp(target.title))).not.toBeNull();
    fireEvent.click(within(confirm).getByRole("button", { name: "Merge" }));

    // The standard semantics: the loser trashes, the target survives…
    await waitFor(() => expect(client.getNodeRaw(loser.id)?.isActive).toBe(false));
    expect(client.getNodeRaw(target.id)?.isActive).toBe(true);
    // …and the view refreshed — the merged group is gone.
    await waitFor(() => expect(screen.getByText("No duplicates")).not.toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
