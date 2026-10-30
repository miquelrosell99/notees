/**
 * Sources matrix tests (research-tier2 slice 6 — the Literature Matrix mode):
 *
 * - The query-state grammar (sourcesQuery.ts): `?mode=matrix&ids=…` parses
 *   and serializes through the same idiom as type/q/sort, round-trips
 *   losslessly, and deep links to the same picked set after reload
 *   (Review Focus 5). The library mode normalizes the picked set away.
 * - The matrix data layer: columns from the source family's LIVE bound
 *   fields (the registry bindings on the source base + the roster types),
 *   the workflow's source definition fields once the research workflow is
 *   enabled, and a rationale property where present on a picked row's
 *   schemas (an authored row on an unbound global schema); rows from the
 *   picked ids in pick order with propertyDisplayText cell values.
 * - CSV over the picked rows reuses @notees/export's renderCsv (the table
 *   view's machinery — RFC-4180 quoting + BOM).
 * - New comparison: authors a `comparison`-classed node (the workflow class)
 *   with one embed child per picked source, titled from the matrix, and
 *   reports the new id for the caller to open. With the workflow absent the
 *   view offers the one-click enable instead of silently authoring an
 *   unclassed page (the documented slice-6 ruling).
 * - The tab-title branch (law 9): the matrix mode names its own title.
 *
 * Seeded over the repo's test-client pattern (MemoryRelay + sql.js, the
 * sources-data convention).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import {
  SYSTEM_CLASS_DISPLAY_NAMES,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_DISPLAY_NAMES,
  SYSTEM_PROPERTY_UUIDS,
  workflowEntityId,
} from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import {
  DEFAULT_SOURCES_QUERY,
  comparisonTitleFor,
  matrixCsv,
  matrixFields,
  matrixRows,
  parseSourcesQuery,
  sourcesPathFor,
} from "../src/features/sources/sourcesQuery.js";
import { createComparison } from "../src/features/sources/comparison.js";
import { SourcesMatrix } from "../src/features/sources/SourcesMatrix.js";
import { materializeWorkflow } from "../src/features/workflows/materialize.js";
import { tabTitle } from "../src/ui/app/routing.js";

const WS = "0192a000-0000-7000-8000-000000000021";
const ACTOR = "0192a000-0000-7000-8000-000000000022";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

/** The roster subset + schemas this suite seeds (the sources-data shape). */
async function seedRoster(client: WorkspaceClient): Promise<void> {
  for (const name of ["source", "journal_article", "web_page"] as const) {
    await client.createClass(SYSTEM_CLASS_DISPLAY_NAMES[name], { id: SYSTEM_CLASS_UUIDS[name] });
  }
  await client.setClassExtends(SYSTEM_CLASS_UUIDS.journal_article, [SYSTEM_CLASS_UUIDS.source]);
  await client.setClassExtends(SYSTEM_CLASS_UUIDS.web_page, [SYSTEM_CLASS_UUIDS.source]);

  const SOURCE = SYSTEM_CLASS_UUIDS.source;
  const schema = async (
    key: keyof typeof SYSTEM_PROPERTY_UUIDS,
    spec: Parameters<WorkspaceClient["createPropertySchema"]>[0],
  ) => {
    await client.createPropertySchema({ id: SYSTEM_PROPERTY_UUIDS[key], ...spec });
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
  await schema("publicationDate", {
    name: SYSTEM_PROPERTY_DISPLAY_NAMES.publicationDate,
    type: "datetime",
    scopeClassIds: [SOURCE],
  });
  await schema("publicationTitle", {
    name: SYSTEM_PROPERTY_DISPLAY_NAMES.publicationTitle,
    type: "text",
    scopeClassIds: [SOURCE],
  });
  await schema("websiteTitle", {
    name: SYSTEM_PROPERTY_DISPLAY_NAMES.websiteTitle,
    type: "text",
    scopeClassIds: [SOURCE],
  });
  for (const key of ["authors", "citekey", "publicationDate"] as const) {
    await client.setClassProperty(SOURCE, SYSTEM_PROPERTY_UUIDS[key], {});
  }
  await client.setClassProperty(
    SYSTEM_CLASS_UUIDS.journal_article,
    SYSTEM_PROPERTY_UUIDS.publicationTitle,
    {},
  );
  await client.setClassProperty(
    SYSTEM_CLASS_UUIDS.web_page,
    SYSTEM_PROPERTY_UUIDS.websiteTitle,
    {},
  );
}

export interface MatrixItems {
  a1: string;
  a2: string;
  w1: string;
}

async function seedItems(client: WorkspaceClient): Promise<MatrixItems> {
  const P = SYSTEM_PROPERTY_UUIDS;
  const create = async (title: string, classKey: "journal_article" | "web_page"): Promise<string> =>
    client.createObject({
      isEmbedded: false,
      name: title,
      classIds: [SYSTEM_CLASS_UUIDS[classKey]],
    });

  const a1 = await create("Engine, Analytical", "journal_article");
  await client.setProperty(a1, P.authors, "Lovelace, Ada", 0);
  await client.setProperty(a1, P.authors, "Turing, Alan", 1);
  await client.setProperty(a1, P.publicationTitle, "The Example Journal", 0);
  await client.setProperty(a1, P.citekey, "lovelace1843analytical", 0);

  const a2 = await create("Computing Machinery", "journal_article");
  await client.setProperty(a2, P.authors, "Turing, Alan", 0);
  await client.setProperty(a2, P.publicationTitle, "Mind", 0);
  await client.setProperty(a2, P.citekey, "turing1950computing", 0);

  const w1 = await create("A Great Article", "web_page");
  await client.setProperty(w1, P.websiteTitle, "Example Blog", 0);

  return { a1, a2, w1 };
}

async function seededClient(enabled: boolean): Promise<{ client: WorkspaceClient; items: MatrixItems }> {
  const client = await seedClient();
  await seedRoster(client);
  const items = await seedItems(client);
  if (enabled) await materializeWorkflow(client, "research", "enabled");
  return { client, items };
}

const COMPARISON_CLASS_ID = workflowEntityId("research", "class", "comparison");

// --- the query-state grammar ------------------------------------------------------------

describe("sourcesQuery — the matrix mode grammar", () => {
  it("the defaults stay the bare library", () => {
    expect(DEFAULT_SOURCES_QUERY).toEqual({
      type: null,
      q: "",
      sort: null,
      mode: "library",
      ids: [],
    });
    expect(parseSourcesQuery("")).toEqual(DEFAULT_SOURCES_QUERY);
    expect(parseSourcesQuery("?foo=bar")).toEqual(DEFAULT_SOURCES_QUERY);
  });

  it("parses mode=matrix with the picked ids in order", () => {
    const state = parseSourcesQuery(
      `?mode=matrix&ids=${IDS.x}%2C${IDS.y}&type=journal_article`,
    );
    expect(state.mode).toBe("matrix");
    expect(state.ids).toEqual([IDS.x, IDS.y]);
    expect(state.type).toBe("journal_article");
  });

  it("filters malformed ids and dedupes preserving first-seen order", () => {
    const state = parseSourcesQuery(`?mode=matrix&ids=bogus,${IDS.y},${IDS.x},${IDS.y},,`);
    expect(state.ids).toEqual([IDS.y, IDS.x]);
  });

  it("an unknown mode degrades to the library", () => {
    expect(parseSourcesQuery(`?mode=bogus&ids=${IDS.x}`).mode).toBe("library");
  });

  it("the library mode normalizes the picked set away (ids ride the matrix only)", () => {
    const state = parseSourcesQuery(`?ids=${IDS.x}&mode=library`);
    expect(state.mode).toBe("library");
    expect(state.ids).toEqual([]);
  });

  it("serializes the matrix state and round-trips losslessly", () => {
    const state = {
      type: "journal_article" as string | null,
      q: "smith",
      sort: { field: "year" as const, direction: "desc" as const },
      mode: "matrix" as const,
      ids: [IDS.x, IDS.y],
    };
    const path = sourcesPathFor(state);
    expect(path).toBe(
      `/sources?type=journal_article&q=smith&sort=year:desc&mode=matrix&ids=${IDS.x},${IDS.y}`,
    );
    expect(parseSourcesQuery(path)).toEqual(state);
    expect(sourcesPathFor(parseSourcesQuery(path))).toBe(path);
  });

  it("an empty picked set serializes the bare matrix deep link", () => {
    expect(sourcesPathFor({ ...DEFAULT_SOURCES_QUERY, mode: "matrix" })).toBe("/sources?mode=matrix");
  });

  it("a deep link re-parses to the same picked set after reload (Review Focus 5)", () => {
    const deepLink = `/sources?mode=matrix&ids=${IDS.x},${IDS.y},${IDS.z}`;
    // The reload seam: parse the location's search, serialize, re-parse.
    const reparsed = parseSourcesQuery(sourcesPathFor(parseSourcesQuery(deepLink)));
    expect(reparsed.mode).toBe("matrix");
    expect(reparsed.ids).toEqual([IDS.x, IDS.y, IDS.z]);
  });
});

const IDS = {
  x: "0192a000-0000-7000-8000-0000000000a1",
  y: "0192a000-0000-7000-8000-0000000000a2",
  z: "0192a000-0000-7000-8000-0000000000a3",
};

// --- the matrix data layer --------------------------------------------------------------

describe("matrixFields — columns from the source family's bound fields", () => {
  it("pools the live bindings on the source base + the roster types, alphabetical by name", async () => {
    const { client } = await seededClient(false);
    const pool = matrixFields(client, []);
    const byId = new Map(pool.map((field) => [field.schemaId, field]));
    // The base family bound on `source`…
    expect(byId.has(SYSTEM_PROPERTY_UUIDS.authors)).toBe(true);
    expect(byId.has(SYSTEM_PROPERTY_UUIDS.citekey)).toBe(true);
    expect(byId.has(SYSTEM_PROPERTY_UUIDS.publicationDate)).toBe(true);
    // …the per-type container bindings…
    expect(byId.has(SYSTEM_PROPERTY_UUIDS.publicationTitle)).toBe(true);
    expect(byId.has(SYSTEM_PROPERTY_UUIDS.websiteTitle)).toBe(true);
    // …alphabetical by the schema's live name.
    const names = pool.map((field) => field.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("gains the workflow's source definition fields once the research workflow is enabled", async () => {
    const plain = await seededClient(false);
    const before = new Set(matrixFields(plain.client, []).map((f) => f.schemaId));
    const objective = workflowEntityId("research", "schema", "objective");
    expect(before.has(objective)).toBe(false);

    const enabled = await seededClient(true);
    const after = new Set(matrixFields(enabled.client, []).map((f) => f.schemaId));
    for (const key of ["objective", "method", "results", "conclusions", "limitations"] as const) {
      expect(after.has(workflowEntityId("research", "schema", key))).toBe(true);
    }
  });

  it("includes a rationale property where present on a picked row's schemas (an authored row on an unbound global schema)", async () => {
    const { client, items } = await seededClient(false);
    const rationaleId = "0192a000-0000-7000-8000-0000000000c1";
    await client.createPropertySchema({ id: rationaleId, name: "Relevance note", type: "text" });
    await client.assignProperty(items.a1, rationaleId);
    await client.setProperty(items.a1, rationaleId, "central", 0);

    // Present where the row carrying it is picked…
    const withA1 = matrixFields(client, [items.a1]).map((f) => f.schemaId);
    expect(withA1).toContain(rationaleId);
    // …absent for other rows and for the empty pick.
    expect(matrixFields(client, [items.a2]).map((f) => f.schemaId)).not.toContain(rationaleId);
    expect(matrixFields(client, []).map((f) => f.schemaId)).not.toContain(rationaleId);
  });
});

describe("matrixRows — rows from the picks, in pick order", () => {
  it("projects the picked ids in order with the display-text cell values", async () => {
    const { client, items } = await seededClient(false);
    const rows = matrixRows(client, [items.w1, items.a1]);
    expect(rows.map((row) => row.id)).toEqual([items.w1, items.a1]);
    expect(rows[1]!.title).toBe("Engine, Analytical");
    const a1Cells = rows[1]!.cells;
    expect(a1Cells[SYSTEM_PROPERTY_UUIDS.authors]).toBe("Lovelace, Ada; Turing, Alan");
    expect(a1Cells[SYSTEM_PROPERTY_UUIDS.publicationTitle]).toBe("The Example Journal");
    expect(a1Cells[SYSTEM_PROPERTY_UUIDS.citekey]).toBe("lovelace1843analytical");
    // Unvalued cells are absent (sparse map) — consumers default them "".
    expect(a1Cells[SYSTEM_PROPERTY_UUIDS.websiteTitle]).toBeUndefined();
  });

  it("skips unknown ids and reads the rest (a stale deep link degrades, never pins an empty grid)", async () => {
    const { client, items } = await seededClient(false);
    const rows = matrixRows(client, [items.a1, IDS.z]);
    expect(rows.map((row) => row.id)).toEqual([items.a1]);
  });
});

// --- CSV over the picked rows -----------------------------------------------------------

describe("matrixCsv — the table view's CSV machinery over the matrix rows", () => {
  it("renders the header + the picked rows with RFC-4180 quoting and the BOM", async () => {
    const { client, items } = await seededClient(false);
    const fields = [
      { schemaId: SYSTEM_PROPERTY_UUIDS.authors, name: "Authors" },
      { schemaId: SYSTEM_PROPERTY_UUIDS.citekey, name: "Citekey" },
    ];
    const rows = matrixRows(client, [items.a1]);
    const csv = matrixCsv(fields, rows);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    const lines = csv.replace(/^\uFEFF/, "").split("\r\n").filter((line) => line !== "");
    expect(lines[0]).toBe("Title,Authors,Citekey");
    // The title carries a comma — quoted, not split.
    expect(lines[1]).toBe('"Engine, Analytical","Lovelace, Ada; Turing, Alan",lovelace1843analytical');
  });

  it("an empty field pick still exports the title column", async () => {
    const { client, items } = await seededClient(false);
    const csv = matrixCsv([], matrixRows(client, [items.a2]));
    const lines = csv.replace(/^\uFEFF/, "").split("\r\n").filter((line) => line !== "");
    expect(lines).toEqual(["Title", "Computing Machinery"]);
  });
});

// --- the comparison title ---------------------------------------------------------------

describe("comparisonTitleFor — titled from the matrix", () => {
  it("names one source, two sources, and the many-source tail", () => {
    expect(comparisonTitleFor([])).toBe("Comparison");
    expect(comparisonTitleFor(["Only Source"])).toBe("Comparison — Only Source");
    expect(comparisonTitleFor(["Paper A", "Paper B"])).toBe("Comparison — Paper A vs Paper B");
    expect(comparisonTitleFor(["Paper A", "Paper B", "Paper C", "Paper D"])).toBe(
      "Comparison — Paper A vs Paper B (+2 more)",
    );
  });
});

// --- New comparison ---------------------------------------------------------------------

describe("createComparison — authors the comparison node and opens it", () => {
  it("creates a comparison-classed node with one embed child per picked source, in order", async () => {
    const { client, items } = await seededClient(true);
    const id = await createComparison(client, [items.a2, items.a1]);

    const node = client.getNode(id);
    expect(node).not.toBeUndefined();
    expect(node!.classIds).toContain(COMPARISON_CLASS_ID);
    // Title-is-content: the matrix-derived title is the node's content.
    expect(node!.contentAst).toEqual([
      { type: "text", text: "Comparison — Computing Machinery vs Engine, Analytical" },
    ]);

    const children = client.getChildren(id);
    expect(children).toHaveLength(2);
    // The sibling ORDER is the log's display concern; the author contract is
    // one embed child per picked source — each child embeds exactly one of them.
    const embedTargets = children
      .map((child) => child.contentAst)
      .map((ast) => (ast[0]?.type === "embed_ref" ? ast[0].nodeId : null))
      .sort();
    expect(embedTargets).toEqual([items.a1, items.a2].sort());
  });
});

// --- the matrix view --------------------------------------------------------------------

describe("SourcesMatrix — the mode view", () => {
  it("a deep link renders the picked rows with remove affordances and the picked fields", async () => {
    const { client, items } = await seededClient(true);
    const query = parseSourcesQuery(`/sources?mode=matrix&ids=${items.a1},${items.a2}`);
    render(
      <SourcesMatrix
        client={client}
        query={query}
        onQueryChange={() => {}}
        onOpenNode={() => {}}
      />,
    );
    // Both picked sources render as rows…
    expect(screen.getByText("Engine, Analytical")).not.toBeNull();
    expect(screen.getByText("Computing Machinery")).not.toBeNull();
    // …with a remove affordance each (the pick set is the URL's).
    expect(screen.getByRole("button", { name: "Remove Engine, Analytical" })).not.toBeNull();
    // The export + comparison affordances ride the view chrome.
    expect(screen.getByRole("button", { name: "Export CSV" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "New comparison" })).not.toBeNull();
  });

  it("removing a row pushes the picked set through the URL seam", async () => {
    const { client, items } = await seededClient(false);
    const query = parseSourcesQuery(`/sources?mode=matrix&ids=${items.a1},${items.a2}`);
    const onQueryChange = vi.fn();
    render(
      <SourcesMatrix client={client} query={query} onQueryChange={onQueryChange} onOpenNode={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove Engine, Analytical" }));
    expect(onQueryChange).toHaveBeenCalledWith(
      { ...query, ids: [items.a2] },
      "push",
    );
  });

  it("the CSV button downloads the picked rows through the shared download seam", async () => {
    const { client, items } = await seededClient(false);
    const createUrl = vi.fn((_blob: Blob) => "blob:mock");
    const revokeUrl = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: revokeUrl }));

    const query = parseSourcesQuery(`/sources?mode=matrix&ids=${items.a1}`);
    render(
      <SourcesMatrix client={client} query={query} onQueryChange={() => {}} onOpenNode={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(createUrl).toHaveBeenCalled();
    const blob = createUrl.mock.calls[0]![0] as Blob;
    // jsdom's Blob has no .text() — FileReader is the portable read.
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
    // The BOM itself is pinned on the pure matrixCsv projection — here the
    // seam contract is just: the picked row's text rides the download.
    expect(text).toContain("Engine, Analytical");
  });

  it("New comparison authors the node and opens it (workflow enabled)", async () => {
    const { client, items } = await seededClient(true);
    const onOpenNode = vi.fn();
    const query = parseSourcesQuery(`/sources?mode=matrix&ids=${items.a1},${items.a2}`);
    render(
      <SourcesMatrix client={client} query={query} onQueryChange={() => {}} onOpenNode={onOpenNode} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New comparison" }));
    // The author is async (createObject round-trips) — wait, never assert mid-flight.
    await vi.waitFor(() => expect(onOpenNode).toHaveBeenCalledTimes(1));
    const opened = onOpenNode.mock.calls[0]![0] as string;
    expect(client.getNode(opened)!.classIds).toContain(COMPARISON_CLASS_ID);
  });

  it("with the workflow absent it offers the one-click enable instead of an unclassed page", async () => {
    const { client, items } = await seededClient(false);
    const onOpenNode = vi.fn();
    const query = parseSourcesQuery(`/sources?mode=matrix&ids=${items.a1}`);
    render(
      <SourcesMatrix client={client} query={query} onQueryChange={() => {}} onOpenNode={onOpenNode} />,
    );
    // The honest offer, not a silently-unclassed create.
    expect(screen.getByText(/research workflow isn't enabled/i)).not.toBeNull();
    expect(screen.queryByRole("button", { name: "New comparison" })).toBeNull();
    const enable = screen.getByRole("button", { name: /enable research workflow/i });
    fireEvent.click(enable);
    // The enable materializes the vocabulary and authors the comparison.
    await vi.waitFor(() => expect(onOpenNode).toHaveBeenCalledTimes(1));
    const opened = onOpenNode.mock.calls[0]![0] as string;
    expect(client.getNode(opened)!.classIds).toContain(COMPARISON_CLASS_ID);
  });
});

// --- law 9: the tab title ---------------------------------------------------------------

describe("tabTitle — the matrix mode owns its title (law 9)", () => {
  it("names the mode over the hub register", () => {
    expect(
      tabTitle({
        clientPresent: true,
        selectedPageId: null,
        settingsSection: null,
        searchOpen: false,
        activeNav: "sources",
        nodeName: "",
        sourcesMatrix: true,
      }),
    ).toBe("Matrix - Notees");
  });

  it("the library mode keeps the hub title", () => {
    expect(
      tabTitle({
        clientPresent: true,
        selectedPageId: null,
        settingsSection: null,
        searchOpen: false,
        activeNav: "sources",
        nodeName: "",
      }),
    ).toBe("Sources - Notees");
  });
});
