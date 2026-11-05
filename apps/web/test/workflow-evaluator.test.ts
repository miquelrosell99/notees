// @vitest-environment node
/**
 * WorkflowEvaluator — PARITY with the retired server probe (plan-07,
 * git 7ca44bed2^ apps/server/test/workflows.test.ts). The same fixture
 * scenarios, the same observable expectations:
 *
 * 1. a node created matching the criteria gets ONE property.set action
 *    envelope (client claim "rules-engine") + one actions_written run;
 * 2. a criteria non-match writes nothing and records no run;
 * 3. the class.assign trigger fires on the class-add carrier, and the
 *    ACTION's own echo trips the same rule again → skipped_loop (never
 *    re-executed); a create WITHOUT classIds does not trip the trigger;
 * 4. a rule whose action re-matches its own criteria: the echo records
 *    skipped_loop — exactly one action envelope ever;
 * 5. depth cap: rule B (matched only by rule A's action echo) records
 *    skipped_depth_cap and writes nothing;
 * 6. a failing action write is audited actions_failed and never throws;
 * 7. a disabled rule no-ops.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { newEnvelope, type Envelope } from "@notees/protocol";
import { Store } from "@notees/store";
import { sqljsBackend } from "@notees/store/sqljs";

import {
  RULES_ENGINE_CLIENT,
  WorkflowEvaluator,
  type WorkflowRuleView,
  type WorkflowRunRecord,
} from "../src/core/workflow-evaluator.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
const PAPER = "0192a000-0000-7000-8000-0000000000c1";
const BOOK = "0192a000-0000-7000-8000-0000000000c2";
const FLAG_SCHEMA = "0192a000-0000-7000-8000-0000000000d1";
const SEED_SCHEMA = "0192a000-0000-7000-8000-0000000000d2";
const HOP1_SCHEMA = "0192a000-0000-7000-8000-0000000000d3";
const HOP2_SCHEMA = "0192a000-0000-7000-8000-0000000000d4";
const T0 = 1_727_200_000_000;

let sqlModule: SqlJsStatic;
beforeAll(async () => {
  sqlModule = await initSqlJs();
});

let physical = 0;
function clockNext(): { physical: number; logical: number } {
  physical += 1;
  return { physical: T0 + physical, logical: 0 };
}

function makeEnv(
  opType: string,
  payload: Record<string, unknown>,
  options: { affectedNodeIds?: string[]; client?: string } = {},
): Envelope {
  return newEnvelope({
    workspaceId: WS,
    actorId: ACTOR,
    deviceId: "wf-test",
    hlc: clockNext(),
    opType,
    payload,
    affectedNodeIds: options.affectedNodeIds ?? [],
    ...(options.client !== undefined ? { client: options.client } : {}),
  });
}

/** The v2 criteria wrapper (the retired suite's ast() helper). */
function ast(children: unknown[]): unknown {
  return {
    version: 2,
    scope: { type: "entire_workspace" },
    root: { type: "group", logic: "and", children },
  };
}

interface Harness {
  store: Store;
  evaluator: WorkflowEvaluator;
  rules: WorkflowRuleView[];
  written: Envelope[];
  runs: WorkflowRunRecord[];
  failWrites: boolean;
  apply: (...envelopes: Envelope[]) => void;
  /** Apply an envelope, then evaluate the batch with it (the remote-apply hook shape). */
  applyAndEvaluate: (...envelopes: Envelope[]) => Promise<void>;
}

function makeHarness(): Harness {
  const store = Store.open(sqljsBackend(sqlModule));
  const harness = {
    store,
    evaluator: null as unknown as WorkflowEvaluator,
    rules: [] as WorkflowRuleView[],
    written: [] as Envelope[],
    runs: [] as WorkflowRunRecord[],
    failWrites: false,
    apply(...envelopes: Envelope[]) {
      store.applyMany(envelopes);
    },
    async applyAndEvaluate(...envelopes: Envelope[]) {
      store.applyMany(envelopes);
      await harness.evaluator.evaluate(envelopes);
    },
  };
  harness.evaluator = new WorkflowEvaluator({
    workspaceId: WS,
    database: store.database,
    rules: async () => harness.rules,
    writeActions: async (envelopes) => {
      if (harness.failWrites) throw new Error("ingest exploded");
      harness.written.push(...envelopes);
      return { savedIds: envelopes.map((envelope) => envelope.id) };
    },
    makeEnvelope: (input) =>
      makeEnv(input.opType, input.payload, {
        affectedNodeIds: input.affectedNodeIds,
        client: RULES_ENGINE_CLIENT,
      }),
    recordRun: (run) => {
      harness.runs.push(run);
    },
  });
  return harness;
}

/** Seed the store: the paper/book classes + the property schemas the rules write. */
function seedSchemas(h: Harness): void {
  h.apply(
    makeEnv("class.create", {
      classId: PAPER,
      contentAst: [{ type: "text", text: "Paper" }],
    }),
    makeEnv("class.create", {
      classId: BOOK,
      contentAst: [{ type: "text", text: "Book" }],
    }),
    ...[FLAG_SCHEMA, SEED_SCHEMA, HOP1_SCHEMA, HOP2_SCHEMA].map((id) =>
      makeEnv("propertySchema.create", { propertySchemaId: id, name: `wf-${id.slice(-2)}`, type: "text" }),
    ),
  );
}

function paperRule(overrides: Partial<WorkflowRuleView> = {}): WorkflowRuleView {
  return {
    id: "11111111-0000-7000-8000-0000000000r1",
    name: "flag papers",
    enabled: true,
    triggerOpType: "object.create",
    criteria: ast([
      { type: "member", family: "class", op: "in", target: { mode: "ids", ids: [PAPER] } },
    ]),
    actions: [{ type: "property.set", propertySchemaId: FLAG_SCHEMA, value: "review", idx: 0 }],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("workflow evaluator (client port) — parity with the retired server probe", () => {
  it("a created node matching the criteria gets ONE property.set action (rules-engine claim) + an actions_written run", async () => {
    const h = makeHarness();
    seedSchemas(h);
    h.rules = [paperRule()];

    const nodeId = "0192a000-0000-7000-8000-0000000000e1";
    const create = makeEnv("object.create", {
      objectId: nodeId,
      isEmbedded: false,
      contentAst: [{ type: "text", text: "A paper" }],
      classIds: [PAPER],
    });
    await h.applyAndEvaluate(create);

    // The effect envelope: exactly one, wired like any other op.
    expect(h.written).toHaveLength(1);
    expect(h.written[0]!.opType).toBe("property.set");
    expect(h.written[0]!.client).toBe(RULES_ENGINE_CLIENT);
    expect(h.written[0]!.payload).toMatchObject({
      objectId: nodeId,
      propertySchemaId: FLAG_SCHEMA,
      value: "review",
    });

    // The audit: one actions_written run pointing at both envelope and node.
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]).toMatchObject({
      outcome: "actions_written",
      nodeId,
      triggerEnvelopeId: create.id,
      actionsWritten: [{ opType: "property.set", envelopeId: h.written[0]!.id }],
    });
  });

  it("criteria non-match → nothing written and no run row", async () => {
    const h = makeHarness();
    seedSchemas(h);
    h.rules = [paperRule()];

    const create = makeEnv("object.create", {
      objectId: "0192a000-0000-7000-8000-0000000000e2",
      isEmbedded: false,
      contentAst: [{ type: "text", text: "Plain" }],
    });
    await h.applyAndEvaluate(create);

    expect(h.written).toHaveLength(0);
    expect(h.runs).toEqual([]);
  });

  it("class.assign trigger fires on the carrier; the action's echo records skipped_loop; a classIds-less create does not trip", async () => {
    const h = makeHarness();
    seedSchemas(h);
    h.rules = [
      paperRule({
        id: "11111111-0000-7000-8000-0000000000r2",
        name: "paper means book",
        triggerOpType: "class.assign",
        actions: [{ type: "class.assign", classId: BOOK }],
      }),
    ];

    const nodeId = "0192a000-0000-7000-8000-0000000000e3";
    const create = makeEnv("object.create", {
      objectId: nodeId,
      isEmbedded: false,
      contentAst: [{ type: "text", text: "Academic" }],
      classIds: [PAPER],
    });
    await h.applyAndEvaluate(create);

    // The carrier action: a re-issued object.create — the OR-Set add op.
    expect(h.written).toHaveLength(1);
    expect(h.written[0]!.opType).toBe("object.create");
    expect(h.written[0]!.payload).toMatchObject({ objectId: nodeId, classIds: [BOOK] });

    // The action's echo (the sync round-trip) trips the SAME rule — the loop
    // breaker records skipped_loop and writes nothing.
    await h.applyAndEvaluate(h.written[0]!);
    expect(h.written).toHaveLength(1);
    expect(h.runs.map((run) => run.outcome).sort()).toEqual(["actions_written", "skipped_loop"]);

    // A create WITHOUT classIds does not trip the class.assign trigger.
    const plain = makeEnv("object.create", {
      objectId: "0192a000-0000-7000-8000-0000000000e4",
      isEmbedded: false,
      contentAst: [{ type: "text", text: "Plain" }],
    });
    await h.applyAndEvaluate(plain);
    expect(h.written).toHaveLength(1);
    expect(h.runs).toHaveLength(2);
  });

  it("loop cap: a rule whose action re-matches its own criteria never re-fires (skipped_loop, one envelope)", async () => {
    const h = makeHarness();
    seedSchemas(h);
    h.rules = [
      paperRule({
        id: "11111111-0000-7000-8000-0000000000r3",
        name: "seed means flag",
        triggerOpType: "property.set",
        criteria: ast([{ type: "property", schemaId: SEED_SCHEMA, op: "exists" }]),
      }),
    ];

    const nodeId = "0192a000-0000-7000-8000-0000000000e5";
    h.apply(
      makeEnv("object.create", {
        objectId: nodeId,
        isEmbedded: false,
        contentAst: [{ type: "text", text: "Loop" }],
      }),
    );
    const seed = makeEnv("property.set", {
      objectId: nodeId,
      propertySchemaId: SEED_SCHEMA,
      value: "seeded",
      idx: 0,
    });
    await h.applyAndEvaluate(seed);

    expect(h.written).toHaveLength(1);
    expect(h.written[0]!.payload).toMatchObject({ propertySchemaId: FLAG_SCHEMA });
    // The echo is audited (skipped_loop), not executed.
    await h.applyAndEvaluate(h.written[0]!);
    expect(h.written).toHaveLength(1);
    expect(h.runs.map((run) => run.outcome).sort()).toEqual(["actions_written", "skipped_loop"]);
  });

  it("depth cap: a rule matched ONLY by another rule's action echo records skipped_depth_cap and writes nothing", async () => {
    const h = makeHarness();
    seedSchemas(h);
    h.rules = [
      // Rule B FIRST (evaluation order): matched only by A's depth-1 action.
      {
        id: "11111111-0000-7000-8000-0000000000rB",
        name: "B",
        enabled: true,
        triggerOpType: "property.set",
        criteria: ast([{ type: "property", schemaId: HOP1_SCHEMA, op: "exists" }]),
        actions: [{ type: "property.set", propertySchemaId: HOP2_SCHEMA, value: "chained", idx: 0 }],
      },
      {
        id: "11111111-0000-7000-8000-0000000000rA",
        name: "A",
        enabled: true,
        triggerOpType: "property.set",
        criteria: ast([{ type: "property", schemaId: SEED_SCHEMA, op: "exists" }]),
        actions: [{ type: "property.set", propertySchemaId: HOP1_SCHEMA, value: "review", idx: 0 }],
      },
    ];

    const nodeId = "0192a000-0000-7000-8000-0000000000e6";
    h.apply(
      makeEnv("object.create", {
        objectId: nodeId,
        isEmbedded: false,
        contentAst: [{ type: "text", text: "Chain" }],
      }),
    );
    const seed = makeEnv("property.set", {
      objectId: nodeId,
      propertySchemaId: SEED_SCHEMA,
      value: "seeded",
      idx: 0,
    });
    await h.applyAndEvaluate(seed);

    // A fired once; B's match at depth 1 wrote nothing.
    expect(h.written).toHaveLength(1);
    const runsB = h.runs.filter((run) => run.ruleId.endsWith("rB"));
    expect(runsB).toHaveLength(0); // B did not match the depth-0 envelope
    await h.applyAndEvaluate(h.written[0]!);
    const runsBEcho = h.runs.filter((run) => run.ruleId.endsWith("rB"));
    expect(runsBEcho).toHaveLength(1);
    expect(runsBEcho[0]).toMatchObject({ outcome: "skipped_depth_cap", actionsWritten: [] });
    expect(h.written).toHaveLength(1); // hop2 never written
  });

  it("a failing action write is audited actions_failed and never throws", async () => {
    const h = makeHarness();
    seedSchemas(h);
    h.rules = [paperRule()];
    h.failWrites = true;

    const create = makeEnv("object.create", {
      objectId: "0192a000-0000-7000-8000-0000000000e7",
      isEmbedded: false,
      contentAst: [{ type: "text", text: "Boom" }],
      classIds: [PAPER],
    });
    await expect(h.applyAndEvaluate(create)).resolves.toBeUndefined();
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]).toMatchObject({ outcome: "actions_failed", detail: "ingest exploded" });
  });

  it("a disabled rule no-ops", async () => {
    const h = makeHarness();
    seedSchemas(h);
    h.rules = [paperRule({ enabled: false })];

    const create = makeEnv("object.create", {
      objectId: "0192a000-0000-7000-8000-0000000000e8",
      isEmbedded: false,
      contentAst: [{ type: "text", text: "Off" }],
      classIds: [PAPER],
    });
    await h.applyAndEvaluate(create);
    expect(h.written).toHaveLength(0);
    expect(h.runs).toEqual([]);
  });
});
