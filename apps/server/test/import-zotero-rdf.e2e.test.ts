/**
 * The Zotero RDF importer CLI (scripts/import-zotero-rdf.mts, Task 7 wiring) —
 * end-to-end in the migrate-pmid-property harness shape: a scratch relay whose
 * workspace carries a seeded source family (the `source` base + the book and
 * journal_article type-classes, the property schemas the items write, one
 * citekey-matched existing node, one doi-only node and two day/month-precision
 * date-ref nodes), then:
 *
 *  1. spawns the script WITHOUT --apply — the dry run prints the per-entry
 *     action summary, the conflict table, the skipped same-file duplicate and
 *     the attachment/collection counts, and the relay log is byte-unchanged;
 *  2. spawns the script WITH --apply — a fresh hydration (the shape every
 *     replica replays) shows the updated node, the adopted citekey, the
 *     created node with its class + properties (TWO authors landing as one
 *     row per name) and the minted year chain node — exactly ONE node per
 *     distinct citationKey (the duplicate never double-creates), and the
 *     day/month-precision nodes untouched (full-ISO RDF dates equal their
 *     chain refs — the datetime-equality pin);
 *  3. re-runs --apply — Review Focus 4: every planned value already
 *     converged, zero envelopes planned, no duplicate nodes;
 *  4. applies a SECOND file — the verify read-back counts only this run's
 *     envelopes and the changed value lands.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { newEnvelope, type Envelope } from "@notees/protocol";
import {
  dayNodeId,
  monthNodeId,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
  yearNodeId,
} from "@notees/domain";
import { Store } from "../../../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../../../packages/store/src/adapters/better-sqlite3.ts";

import { RelayStorage } from "../src/relay-storage.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TSX = join(REPO_ROOT, "apps", "server", "node_modules", ".bin", "tsx");
const SCRIPT = "../../scripts/import-zotero-rdf.mts";

const WORKSPACE = "4b7d1a00-2222-4000-8000-000000000003";
const ACTOR = "51000000-0000-4000-8000-000000000099";
const DEVICE = "zotero-import-test-device";

/** The pre-existing citekey-matched node (a book). */
const NODE_A = "01930000-0000-7000-8000-0000000000a1";
/** The pre-existing doi-only node (a journal article). */
const NODE_B = "01930000-0000-7000-8000-0000000000b2";
/** Day-precision publicationDate node — the RDF item carries the full ISO
 *  date "2022-03-15", which must compare EQUAL to the stored day ref. */
const NODE_C = "01930000-0000-7000-8000-0000000000c3";
/** Month-precision publicationDate node — the RDF item carries "2022-03",
 *  which must compare EQUAL to the stored month ref. */
const NODE_D = "01930000-0000-7000-8000-0000000000d4";

const SOURCE = SYSTEM_CLASS_UUIDS.source;
const BOOK = SYSTEM_CLASS_UUIDS.book;
const JOURNAL_ARTICLE = SYSTEM_CLASS_UUIDS.journal_article;
const YEAR_2022 = yearNodeId("2022-01-01");
const MONTH_2022_03 = monthNodeId("2022-03-01");
const DAY_2022_03_15 = dayNodeId("2022-03-15");

/** The seed: source family classes + schemas, node A (citekey match) and
 *  node B (doi only, no citekey), nodes C/D (day/month-precision date refs
 *  the full-ISO RDF items must equal). The 2019 year node is NOT seeded —
 *  the importer must mint it for the created item's publicationDate. */
function fixtureEnvelopes(): Envelope[] {
  const envelopes: Envelope[] = [];
  let t = 1727300000000;
  const step = () => (t += 1000);
  const text = (s: string) => [{ type: "text", text: s }];
  const push = (opType: string, payload: Record<string, unknown>, affected: string[] = []) =>
    envelopes.push(
      newEnvelope({
        workspaceId: WORKSPACE,
        actorId: ACTOR,
        deviceId: DEVICE,
        hlc: { physical: step(), logical: 0 },
        affectedNodeIds: affected,
        opType,
        payload,
      }),
    );

  push("class.create", { classId: SOURCE, contentAst: text("Source") }, [SOURCE]);
  push("class.create", { classId: BOOK, contentAst: text("Book") }, [BOOK]);
  push("class.setExtends", { classId: BOOK, parentClassIds: [SOURCE] }, [BOOK]);
  push("class.create", { classId: JOURNAL_ARTICLE, contentAst: text("Journal article") }, [
    JOURNAL_ARTICLE,
  ]);
  push("class.setExtends", { classId: JOURNAL_ARTICLE, parentClassIds: [SOURCE] }, [
    JOURNAL_ARTICLE,
  ]);

  const schemas: Array<[keyof typeof SYSTEM_PROPERTY_UUIDS, string, boolean]> = [
    ["citekey", "Citekey", false],
    ["doi", "DOI", false],
    ["authors", "Authors", true],
    ["publicationDate", "Publication date", false],
    ["language", "Language", false],
    ["isbn", "ISBN", false],
    ["publisher", "Publisher", false],
  ];
  for (const [key, name, multi] of schemas) {
    const schemaId = SYSTEM_PROPERTY_UUIDS[key];
    push(
      "propertySchema.create",
      { propertySchemaId: schemaId, name, type: key === "publicationDate" ? "datetime" : "text", multi, scopeClassIds: [SOURCE] },
      [],
    );
    push("class.property.set", { classId: SOURCE, propertySchemaId: schemaId }, [SOURCE]);
  }

  // The 2022 chain through March (the date-precision equality pins): year →
  // month → day, compact labels, locked parents.
  push(
    "object.create",
    {
      objectId: YEAR_2022,
      isEmbedded: false,
      parentId: null,
      classIds: [SYSTEM_CLASS_UUIDS.year],
      contentAst: text("20220000"),
    },
    [YEAR_2022],
  );
  push(
    "object.create",
    {
      objectId: MONTH_2022_03,
      isEmbedded: false,
      parentId: YEAR_2022,
      classIds: [SYSTEM_CLASS_UUIDS.month],
      contentAst: text("20220300"),
    },
    [MONTH_2022_03],
  );
  push(
    "object.create",
    {
      objectId: DAY_2022_03_15,
      isEmbedded: false,
      parentId: MONTH_2022_03,
      classIds: [SYSTEM_CLASS_UUIDS.day],
      contentAst: text("20220315"),
    },
    [DAY_2022_03_15],
  );

  // Node A — the citekey-matched book.
  push(
    "object.create",
    {
      objectId: NODE_A,
      isEmbedded: false,
      parentId: null,
      classIds: [BOOK],
      contentAst: text("Safety risk management for medical devices"),
    },
    [NODE_A],
  );
  push("property.set", { objectId: NODE_A, propertySchemaId: SYSTEM_PROPERTY_UUIDS.citekey, value: "elahi2022", idx: 0 }, [NODE_A]);
  push("property.set", { objectId: NODE_A, propertySchemaId: SYSTEM_PROPERTY_UUIDS.doi, value: "10.1016/c2020-0-1234-5", idx: 0 }, [NODE_A]);
  push("property.set", { objectId: NODE_A, propertySchemaId: SYSTEM_PROPERTY_UUIDS.authors, value: "Elahi, Bijan", idx: 0 }, [NODE_A]);
  push("property.set", { objectId: NODE_A, propertySchemaId: SYSTEM_PROPERTY_UUIDS.publicationDate, value: { nodeId: YEAR_2022 }, idx: 0 }, [NODE_A]);

  // Node B — the doi-only journal article (no citekey yet).
  push(
    "object.create",
    {
      objectId: NODE_B,
      isEmbedded: false,
      parentId: null,
      classIds: [JOURNAL_ARTICLE],
      contentAst: text("Some article"),
    },
    [NODE_B],
  );
  push("property.set", { objectId: NODE_B, propertySchemaId: SYSTEM_PROPERTY_UUIDS.doi, value: "10.1000/smith2020", idx: 0 }, [NODE_B]);

  // Node C — day-precision publicationDate (2022-03-15); the RDF item carries
  // the full ISO date and must compare EQUAL (no conflict, no set).
  push(
    "object.create",
    {
      objectId: NODE_C,
      isEmbedded: false,
      parentId: null,
      classIds: [JOURNAL_ARTICLE],
      contentAst: text("Day precision article"),
    },
    [NODE_C],
  );
  push("property.set", { objectId: NODE_C, propertySchemaId: SYSTEM_PROPERTY_UUIDS.citekey, value: "day2022", idx: 0 }, [NODE_C]);
  push("property.set", { objectId: NODE_C, propertySchemaId: SYSTEM_PROPERTY_UUIDS.publicationDate, value: { nodeId: DAY_2022_03_15 }, idx: 0 }, [NODE_C]);

  // Node D — month-precision publicationDate (2022-03); same equality pin.
  push(
    "object.create",
    {
      objectId: NODE_D,
      isEmbedded: false,
      parentId: null,
      classIds: [JOURNAL_ARTICLE],
      contentAst: text("Month precision article"),
    },
    [NODE_D],
  );
  push("property.set", { objectId: NODE_D, propertySchemaId: SYSTEM_PROPERTY_UUIDS.citekey, value: "month2022", idx: 0 }, [NODE_D]);
  push("property.set", { objectId: NODE_D, propertySchemaId: SYSTEM_PROPERTY_UUIDS.publicationDate, value: { nodeId: MONTH_2022_03 }, idx: 0 }, [NODE_D]);

  return envelopes;
}

/**
 * The RDF export: item 1 citekey-matches node A (doi differs only by case,
 * everything else equal — only `language` fills); item 2 doi-matches node B
 * (adopt — the citationKey lands); item 3 is new (create — TWO authors
 * landing as one row per name, publisher/isbn/publicationDate, the date
 * minting the 2019 year node); items 4a/4b repeat one citationKey in-file
 * (the second is flagged and skipped on apply); items 5/6 citekey-match
 * nodes C/D whose stored day/month-precision date refs must compare EQUAL
 * to the items' full-ISO dc:date (zero writes — the datetime-equality pin).
 * One attachment + one collection ride along, counted only.
 */
const RDF_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF
 xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
 xmlns:z="http://www.zotero.org/namespaces/export#"
 xmlns:dc="http://purl.org/dc/elements/1.1/"
 xmlns:dcterms="http://purl.org/dc/terms/"
 xmlns:bib="http://purl.org/net/biblio#"
 xmlns:foaf="http://xmlns.com/foaf/0.1/"
 xmlns:link="http://purl.org/rss/1.0/modules/link/">
 <z:Collection rdf:about="#collection_1">
  <dc:title>Reading</dc:title>
 </z:Collection>
 <z:Attachment rdf:about="http://zotero.org/users/1/items/ATT1">
  <z:itemType>attachment</z:itemType>
  <dc:title>scan.pdf</dc:title>
 </z:Attachment>
 <bib:Article rdf:about="http://zotero.org/users/1/items/AAAA">
  <z:itemType>journalArticle</z:itemType>
  <dc:title>Safety risk management for medical devices</dc:title>
  <z:citationKey>elahi2022</z:citationKey>
  <dc:identifier>DOI 10.1016/C2020-0-1234-5</dc:identifier>
  <dc:date>2022</dc:date>
  <z:language>en</z:language>
  <bib:authors>
   <rdf:Seq>
    <rdf:li>
     <foaf:Person>
      <foaf:surname>Elahi</foaf:surname>
      <foaf:givenName>Bijan</foaf:givenName>
     </foaf:Person>
    </rdf:li>
   </rdf:Seq>
  </bib:authors>
 </bib:Article>
 <bib:Article rdf:about="http://zotero.org/users/1/items/BBBB">
  <z:itemType>journalArticle</z:itemType>
  <dc:title>Some article</dc:title>
  <z:citationKey>smith2020</z:citationKey>
  <dc:identifier>DOI 10.1000/smith2020</dc:identifier>
 </bib:Article>
 <bib:Book rdf:about="http://zotero.org/users/1/items/CCCC">
  <z:itemType>book</z:itemType>
  <dc:title>A new book</dc:title>
  <z:citationKey>doe2023</z:citationKey>
  <dc:identifier>ISBN 978-1-4028-9462-6</dc:identifier>
  <dc:date>2019</dc:date>
  <dc:publisher>
   <foaf:Organization>
    <foaf:name>Some Press</foaf:name>
   </foaf:Organization>
  </dc:publisher>
  <bib:authors>
   <rdf:Seq>
    <rdf:li>
     <foaf:Person>
      <foaf:surname>Doe</foaf:surname>
      <foaf:givenName>Jane</foaf:givenName>
     </foaf:Person>
    </rdf:li>
    <rdf:li>
     <foaf:Person>
      <foaf:surname>Roe</foaf:surname>
      <foaf:givenName>Richard</foaf:givenName>
     </foaf:Person>
    </rdf:li>
   </rdf:Seq>
  </bib:authors>
 </bib:Book>
 <bib:Article rdf:about="http://zotero.org/users/1/items/DAY1">
  <z:itemType>journalArticle</z:itemType>
  <dc:title>Day precision article</dc:title>
  <z:citationKey>day2022</z:citationKey>
  <dc:date>2022-03-15</dc:date>
 </bib:Article>
 <bib:Article rdf:about="http://zotero.org/users/1/items/MON1">
  <z:itemType>journalArticle</z:itemType>
  <dc:title>Month precision article</dc:title>
  <z:citationKey>month2022</z:citationKey>
  <dc:date>2022-03</dc:date>
 </bib:Article>
 <bib:Book rdf:about="http://zotero.org/users/1/items/DDDD">
  <z:itemType>book</z:itemType>
  <dc:title>First copy</dc:title>
  <z:citationKey>dup2021</z:citationKey>
  <dc:publisher>
   <foaf:Organization>
    <foaf:name>Press A</foaf:name>
   </foaf:Organization>
  </dc:publisher>
 </bib:Book>
 <bib:Book rdf:about="http://zotero.org/users/1/items/EEEE">
  <z:itemType>book</z:itemType>
  <dc:title>Second copy</dc:title>
  <z:citationKey>dup2021</z:citationKey>
  <dc:publisher>
   <foaf:Organization>
    <foaf:name>Press B</foaf:name>
   </foaf:Organization>
  </dc:publisher>
 </bib:Book>
</rdf:RDF>
`;

interface CliResult {
  stdout: string;
  status: number;
}

/** Spawn the importer exactly as the runbook documents. */
function runScript(args: string[]): CliResult {
  try {
    const stdout = execFileSync(TSX, [SCRIPT, ...args], {
      cwd: join(REPO_ROOT, "apps", "server"),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, status: 0 };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    return {
      stdout: `${failed.stdout ?? ""}${failed.stderr ?? ""}`,
      status: failed.status ?? 1,
    };
  }
}

/** The sync server's hydration shape: snapshot (none here) + full tail. */
function hydrate(relay: RelayStorage, store: Store): void {
  let cursor = 0;
  for (;;) {
    const page = relay.catchUp(WORKSPACE, cursor, 10_000);
    for (const envelope of page.envelopes) store.apply(envelope);
    if (!page.hasMore || page.nextAfterSeq === null) break;
    cursor = page.nextAfterSeq;
  }
}

/** Every text value a node carries for a pool key (multi rows in idx order). */
function textsOf(store: Store, nodeId: string, key: keyof typeof SYSTEM_PROPERTY_UUIDS): string[] {
  const rows = store.database
    .prepare(
      "SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ? ORDER BY idx, id",
    )
    .all(nodeId, SYSTEM_PROPERTY_UUIDS[key]) as Array<{ value: string }>;
  return rows.map((row) => {
    const parsed = JSON.parse(row.value) as unknown;
    return typeof parsed === "string" ? parsed : JSON.stringify(parsed);
  });
}

/** The node ids carrying a pool-key value (the duplicate checks ride this). */
function nodesWithValue(
  store: Store,
  key: keyof typeof SYSTEM_PROPERTY_UUIDS,
  value: string,
): string[] {
  const rows = store.database
    .prepare("SELECT node_id, value FROM property_value WHERE property_schema_id = ?")
    .all(SYSTEM_PROPERTY_UUIDS[key]) as Array<{ node_id: string; value: string }>;
  return rows.filter((row) => JSON.parse(row.value) === value).map((row) => row.node_id);
}

function sourceMemberCount(store: Store): number {
  return store.classMembers(SOURCE).filter((row) => row.is_class === 0).length;
}

describe("import-zotero-rdf.mts (CLI end-to-end)", () => {
  let dataDir: string;
  let rdfFile: string;
  let relay: RelayStorage;
  let store: Store;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "notees-zotero-import-test-"));
    relay = new RelayStorage(join(dataDir, "relay.db"), join(dataDir, "snapshots"));
    relay.ingest(fixtureEnvelopes());
    store = Store.open(betterSqlite3Backend(":memory:"));
    hydrate(relay, store);
    rdfFile = join(dataDir, "library.rdf");
    writeFileSync(rdfFile, RDF_XML, "utf8");
  });

  afterEach(() => {
    store.close();
    relay.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("dry run prints the report and writes nothing", () => {
    const seqBefore = relay.latestSeq(WORKSPACE);
    const result = runScript([
      "--data-dir", dataDir,
      "--workspace", WORKSPACE,
      "--file", rdfFile,
    ]);
    expect(result.status).toBe(0);
    // The per-entry action summary: one update, one adopt, two creates
    // (the second same-file duplicate rides as a skip).
    expect(result.stdout).toContain("[update]");
    expect(result.stdout).toContain("[adopt]");
    expect(result.stdout).toContain("[create]");
    expect(result.stdout).toContain("[skip]");
    expect(result.stdout).toContain("duplicate");
    // The counts: seven items, one attachment, one collection.
    expect(result.stdout).toContain("7 item(s)");
    expect(result.stdout).toContain("1 attachment(s)");
    expect(result.stdout).toContain("1 collection(s)");
    // The conflict table header (this fixture plans no field conflicts —
    // equal values are dropped before sets).
    expect(result.stdout).toContain("conflicts");
    // Datetime equality at day/month precision: nodes C/D match their
    // full-ISO RDF dates with ZERO field writes (exactly the two of them —
    // any other entry writing nothing would show here too).
    expect(result.stdout.match(/0 field write\(s\)/g)).toHaveLength(2);
    // Dry run writes nothing.
    expect(result.stdout).toContain("dry run");
    expect(relay.latestSeq(WORKSPACE)).toBe(seqBefore);
  });

  it("--apply updates, adopts and creates; a fresh hydration shows class + properties; no double-create", () => {
    const apply = runScript([
      "--data-dir", dataDir,
      "--workspace", WORKSPACE,
      "--file", rdfFile,
      "--apply",
    ]);
    expect(apply.status).toBe(0);
    // 1 language set (update) + 1 citekey set (adopt) + the create
    // (object.create + 6 property sets — the two authors land as ONE ROW
    // PER NAME — + the 2019 year-node create). The day/month-precision
    // matches plan nothing.
    expect(apply.stdout).toContain("ingested 13 envelope(s)");
    expect(apply.stdout).toContain("verify");

    const fresh = Store.open(betterSqlite3Backend(":memory:"));
    try {
      hydrate(relay, fresh);

      // The update: node A gained only `language`.
      expect(textsOf(fresh, NODE_A, "language")).toEqual(["en"]);
      expect(textsOf(fresh, NODE_A, "citekey")).toEqual(["elahi2022"]);
      expect(textsOf(fresh, NODE_A, "authors")).toEqual(["Elahi, Bijan"]);

      // The adopt: node B gained the Zotero citationKey.
      expect(textsOf(fresh, NODE_B, "citekey")).toEqual(["smith2020"]);
      expect(textsOf(fresh, NODE_B, "doi")).toEqual(["10.1000/smith2020"]);

      // The create: exactly one node carries doe2023, classed book, with
      // every planned property; the publicationDate points at the minted
      // 2019 year node.
      const created = nodesWithValue(fresh, "citekey", "doe2023");
      expect(created).toHaveLength(1);
      const createdId = created[0]!;
      const nodeRow = fresh.database
        .prepare("SELECT content, class_ids, is_class FROM node WHERE id = ?")
        .get(createdId) as { content: string; class_ids: string; is_class: number };
      expect(nodeRow.is_class).toBe(0);
      expect(JSON.parse(nodeRow.content)).toEqual([{ type: "text", text: "A new book" }]);
      expect(JSON.parse(nodeRow.class_ids)).toContain(BOOK);
      // The two authors land as ONE ROW PER NAME (the sources contract),
      // readable in idx order as the same "; "-joined form the planner
      // compares — the second apply's idempotency rides on it.
      expect(textsOf(fresh, createdId, "authors")).toEqual(["Doe, Jane", "Roe, Richard"]);
      expect(textsOf(fresh, createdId, "publisher")).toEqual(["Some Press"]);
      expect(textsOf(fresh, createdId, "isbn")).toEqual(["978-1-4028-9462-6"]);
      expect(textsOf(fresh, createdId, "publicationDate")).toEqual([
        JSON.stringify({ nodeId: yearNodeId("2019-01-01") }),
      ]);

      // The year chain node the date minted.
      const yearRow = fresh.database
        .prepare("SELECT class_ids FROM node WHERE id = ?")
        .get(yearNodeId("2019-01-01")) as { class_ids: string } | undefined;
      expect(yearRow).toBeDefined();
      expect(JSON.parse(yearRow!.class_ids)).toContain(SYSTEM_CLASS_UUIDS.year);

      // The duplicate: the first copy was created, the second skipped.
      expect(nodesWithValue(fresh, "citekey", "dup2021")).toHaveLength(1);
      const dupId = nodesWithValue(fresh, "citekey", "dup2021")[0]!;
      expect(textsOf(fresh, dupId, "publisher")).toEqual(["Press A"]);

      // Datetime equality at day/month precision: nodes C/D kept their
      // stored chain refs — the full-ISO RDF dates planned NO write.
      expect(textsOf(fresh, NODE_C, "publicationDate")).toEqual([
        JSON.stringify({ nodeId: DAY_2022_03_15 }),
      ]);
      expect(textsOf(fresh, NODE_D, "publicationDate")).toEqual([
        JSON.stringify({ nodeId: MONTH_2022_03 }),
      ]);
    } finally {
      fresh.close();
    }
  });

  it("a second --apply plans no envelopes and creates no duplicate nodes (Review Focus 4)", () => {
    const first = runScript([
      "--data-dir", dataDir,
      "--workspace", WORKSPACE,
      "--file", rdfFile,
      "--apply",
    ]);
    expect(first.status).toBe(0);

    const countFresh = (): number => {
      const fresh = Store.open(betterSqlite3Backend(":memory:"));
      try {
        hydrate(relay, fresh);
        return sourceMemberCount(fresh);
      } finally {
        fresh.close();
      }
    };
    const before = countFresh();
    expect(before).toBeGreaterThan(2); // the two seeded + the import's creates.

    const second = runScript([
      "--data-dir", dataDir,
      "--workspace", WORKSPACE,
      "--file", rdfFile,
      "--apply",
    ]);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("nothing to apply");
    expect(countFresh()).toBe(before);
  });

  it("importing a SECOND file verifies against only the new envelopes and lands the changed value", () => {
    const first = runScript([
      "--data-dir", dataDir,
      "--workspace", WORKSPACE,
      "--file", rdfFile,
      "--apply",
    ]);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("ingested 13 envelope(s)");

    // A follow-up export where node A's language flipped en → es: one
    // conflict, RDF wins — exactly one envelope on the second import. The
    // verify read-back must count ONLY this run's envelopes (a cumulative
    // device count would mismatch 1 against 13 + 1 and fail after a
    // successful ingest).
    const secondFile = join(dataDir, "followup.rdf");
    writeFileSync(
      secondFile,
      `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF
 xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
 xmlns:z="http://www.zotero.org/namespaces/export#"
 xmlns:dc="http://purl.org/dc/elements/1.1/"
 xmlns:bib="http://purl.org/net/biblio#">
 <bib:Article rdf:about="http://zotero.org/users/1/items/AAAA">
  <z:itemType>journalArticle</z:itemType>
  <dc:title>Safety risk management for medical devices</dc:title>
  <z:citationKey>elahi2022</z:citationKey>
  <z:language>es</z:language>
 </bib:Article>
</rdf:RDF>
`,
      "utf8",
    );

    const second = runScript([
      "--data-dir", dataDir,
      "--workspace", WORKSPACE,
      "--file", secondFile,
      "--apply",
    ]);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("ingested 1 envelope(s)");
    expect(second.stdout).toContain("verify:");

    const fresh = Store.open(betterSqlite3Backend(":memory:"));
    try {
      hydrate(relay, fresh);
      expect(textsOf(fresh, NODE_A, "language")).toEqual(["es"]);
    } finally {
      fresh.close();
    }
  });
});
