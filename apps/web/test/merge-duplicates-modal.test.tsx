/**
 * MergeDuplicatesModal tests (task 13 — the duplicates merge modal):
 *
 * - The target picker is a DROPDOWN of the group's members (the owner
 *   requirement — NOT the free NodeSelector), defaulting to the first
 *   member; the dry-run summary (the MergePlanSummary counts, aggregated
 *   over the losers) renders before confirming.
 * - Confirm rides the STANDARD merge semantics (planMerge's legs — the
 *   losers' children/classes/properties move or copy into the target,
 *   LOSERS GO TO TRASH) through the danger ConfirmationModal naming the
 *   kept source.
 * - Guard failures surface as an error line and the modal stays open
 *   (the MergeNodesModal pattern).
 * - Wiring per client mode: the in-process WorkspaceClient plans + applies
 *   locally (client.mergeNodes, one undo batch per loser); the worker
 *   client rides the server route (POST /api/objects/:id/merge, the
 *   ?dryRun=true variant for the summary) through the pure
 *   worker's local planner RPC — no server route, no pull.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { MergeGuardError, type MergePlanSummary } from "@notees/store";

import {
  SYSTEM_CLASS_DISPLAY_NAMES,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_DISPLAY_NAMES,
  SYSTEM_PROPERTY_UUIDS,
} from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import type { WorkerClient } from "../src/core/worker-client.js";
import { runSourcesQuery, type SourceRow } from "../src/features/sources/sourcesQuery.js";
import { groupSourceDuplicates } from "../src/features/sources/duplicates.js";
import { MergeDuplicatesModal } from "../src/features/modals/MergeDuplicatesModal.js";

const WS = "0192a000-0000-7000-8000-0000000000d1";
const ACTOR = "0192a000-0000-7000-8000-0000000000d2";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

interface DupPair {
  a1: string;
  a2: string;
  child: string;
  extra: string;
}

/**
 * One DOI cluster. `a1` is the RICH duplicate: an extra user class with an
 * authored bound property + a child block — the dry-run summary's counts
 * and the merge legs read off it when a1 is the loser.
 */
async function seedPair(client: WorkspaceClient): Promise<DupPair> {
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

  // The rich legs on a1: a user class + authored bound property + a child.
  const extra = await client.createClass("Extra");
  const note = await client.createPropertySchema({ name: "Note", type: "text" });
  await client.setClassProperty(extra, note, {});
  await client.assignClass(a1, extra);
  await client.setProperty(a1, note, "authored note", 0);
  const child = await client.createObject({ parentId: a1, name: "Child note" });

  return { a1, a2, child, extra };
}

async function pairGroup(client: WorkspaceClient): Promise<{
  group: ReturnType<typeof groupSourceDuplicates>[number];
  a1: string;
  a2: string;
  child: string;
  extra: string;
}> {
  const { a1, a2, child, extra } = await seedPair(client);
  const rows = await runSourcesQuery(client, {}, null);
  const [group] = groupSourceDuplicates(rows);
  return { group: group!, a1, a2, child, extra };
}

/** Drive the kit Dropdown: open the trigger by aria-label, pick the
 *  portal-menu option by name (the query-node test idiom). */
function pickTarget(title: string): void {
  fireEvent.click(screen.getByLabelText("Merge target"));
  fireEvent.click(
    within(document.querySelector(".dropdown-menu--portal") as HTMLElement).getByRole(
      "option",
      { name: title },
    ),
  );
}

const EMPTY_SUMMARY: MergePlanSummary = {
  childrenMoved: 0,
  classesRemapped: 0,
  tagsRemapped: 0,
  propertiesCopied: 0,
  propertiesSkipped: 0,
  contentLinksRewritten: 0,
  propertyValuesRewritten: 0,
  standaloneChildrenRelocated: 0,
  aliasesRepointed: 0,
  collectionsRemapped: 0,
  fieldsCopied: 0,
};

describe("MergeDuplicatesModal (in-process client)", () => {
  it("opens with the members in the target dropdown (default first), the dry-run summary, and merges through the standard semantics", async () => {
    const client = await seedClient();
    await seedSchema(client);
    const { group, a1, a2, child, extra } = await pairGroup(client);
    const a2Title = "Rust Programming Language, 2nd ed.";

    const onMerged = vi.fn();
    const onClose = vi.fn();
    render(
      <MergeDuplicatesModal
        isOpen
        client={client}
        group={group}
        onClose={onClose}
        onMerged={onMerged}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Merge 2 duplicates" });
    // The copy says the losers go to trash.
    expect(within(dialog).getByText(/trash/i)).not.toBeNull();

    // The dropdown defaults to the FIRST member.
    const trigger = within(dialog).getByLabelText("Merge target");
    expect(trigger.textContent).toContain(group.members[0]!.title);

    // The dry-run summary of the merge INTO the picked target: pick a2 so
    // the rich node (a1) is the loser regardless of id order. a1 carries
    // the family class + the Extra class, one authored property, one
    // child — every count reads off the standard plan legs.
    pickTarget(a2Title);
    await within(dialog).findByText(/1 child moved/);
    expect(within(dialog).getByText(/2 classes remapped/)).not.toBeNull();
    expect(within(dialog).getByText(/3 properties copied/)).not.toBeNull();

    // Confirm rides the danger ConfirmationModal naming the kept source.
    fireEvent.click(within(dialog).getByRole("button", { name: "Merge" }));
    const confirm = screen.getByRole("dialog", { name: "Merge duplicates?" });
    expect(within(confirm).getByText(new RegExp(a2Title))).not.toBeNull();
    expect(within(confirm).getByText(/trash/i)).not.toBeNull();
    fireEvent.click(within(confirm).getByRole("button", { name: "Merge" }));

    await waitFor(() => expect(onMerged).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

    // The standard merge legs: a1 (the loser) trashes, its child moves
    // under a2, the Extra class + authored property remap onto a2.
    expect(client.getNodeRaw(a1)?.isActive).toBe(false);
    expect(client.getNodeRaw(a2)?.isActive).toBe(true);
    expect(client.getNode(child)?.parentId).toBe(a2);
    expect(client.getNode(a2)?.classIds).toContain(extra);
  });

  it("a guard error surfaces as an error line and the modal stays open", async () => {
    const client = await seedClient();
    await seedSchema(client);
    const { group } = await pairGroup(client);

    vi.spyOn(client, "mergeNodes").mockRejectedValue(
      new MergeGuardError("merge target is inside the source's subtree"),
    );
    const onMerged = vi.fn();
    render(
      <MergeDuplicatesModal
        isOpen
        client={client}
        group={group}
        onClose={() => {}}
        onMerged={onMerged}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Merge 2 duplicates" });
    // Pick the rich node's counterpart so the dry-run summary (and the
    // merge) read off the rich legs.
    pickTarget("Rust Programming Language, 2nd ed.");
    await within(dialog).findByText(/1 child moved/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Merge" }));
    const confirm = await screen.findByRole("dialog", { name: "Merge duplicates?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Merge" }));

    // Back at the merge dialog with the guard message; not merged, open.
    await within(dialog).findByRole("alert");
    expect(within(dialog).getByRole("alert").textContent).toContain(
      "merge target is inside the source's subtree",
    );
    expect(onMerged).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Merge 2 duplicates" })).not.toBeNull();
  });
});

describe("MergeDuplicatesModal (worker client — the local worker merge)", () => {
  /** A minimal SourceRow for pure modal tests (no store reads). */
  const row = (id: string, title: string): SourceRow => ({
    id,
    classKey: "journal_article",
    title,
    authorsText: "Klabnik, Steve",
    year: null,
    venue: "",
    citekey: "",
    doi: "10.1000/rust.1",
    isbn: "",
    attachmentCount: 0,
    isActive: true,
  });
  const L = "0192a000-0000-7000-8000-0000000000a1";
  const R = "0192a000-0000-7000-8000-0000000000a2";

  function workerStub(): {
    client: WorkerClient;
    plan: ReturnType<typeof vi.fn>;
    apply: ReturnType<typeof vi.fn>;
  } {
    // Plan-07: both legs run locally in the worker (the server merge route
    // is retired) — the stub speaks the worker RPC shape.
    const plan = vi.fn(async (_source: string, _target: string) => ({
      ...EMPTY_SUMMARY,
      childrenMoved: 1,
    }));
    const apply = vi.fn(async (_source: string, _target: string) => EMPTY_SUMMARY);
    const client = { planMergeSummary: plan, mergeNodes: apply } as unknown as WorkerClient;
    return { client, plan, apply };
  }

  it("plans per loser for the summary and applies through the worker RPC — no server, no pull", async () => {
    const { client, plan, apply } = workerStub();
    const onMerged = vi.fn();
    render(
      <MergeDuplicatesModal
        isOpen
        client={client}
        group={{ members: [row(L, "Left"), row(R, "Right")] }}
        onClose={() => {}}
        onMerged={onMerged}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Merge 2 duplicates" });
    // The default target is members[0] (Left) — the summary dry-runs the
    // OTHER member (Right) against it through the local planner.
    await waitFor(() => expect(plan).toHaveBeenCalledWith(R, L));

    fireEvent.click(within(dialog).getByRole("button", { name: "Merge" }));
    const confirm = await screen.findByRole("dialog", { name: "Merge duplicates?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Merge" }));

    await waitFor(() => expect(onMerged).toHaveBeenCalledTimes(1));
    // The real merge rides the worker RPC; the worker holds the store, so
    // nothing pulls afterwards.
    expect(apply).toHaveBeenCalledWith(R, L);
  });

  it("a rejected merge (the planner's guard) answers the error line and the modal stays open", async () => {
    const plan = vi.fn(async (_source: string, _target: string) => EMPTY_SUMMARY);
    const apply = vi.fn(async (_source: string, _target: string) => {
      throw new Error("merge failed: merge target is inside the source's subtree");
    });
    const client = { planMergeSummary: plan, mergeNodes: apply } as unknown as WorkerClient;

    render(
      <MergeDuplicatesModal
        isOpen
        client={client}
        group={{ members: [row(L, "Left"), row(R, "Right")] }}
        onClose={() => {}}
        onMerged={() => {}}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Merge 2 duplicates" });
    // The dry-run summary lands before the Merge button enables.
    await within(dialog).findByText(/Nothing to move|moved/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Merge" }));
    const confirm = await screen.findByRole("dialog", { name: "Merge duplicates?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Merge" }));

    await within(dialog).findByRole("alert");
    expect(within(dialog).getByRole("alert").textContent).toContain(
      "merge target is inside the source's subtree",
    );
    expect(apply).toHaveBeenCalledWith(R, L);
    expect(screen.getByRole("dialog", { name: "Merge 2 duplicates" })).not.toBeNull();
  });
});


