/**
 * The workflow op plan applies end-to-end (research-tier2 slice 2b
 * bring-up): `planWorkflowToggle`'s enable AND disable plans replay against
 * a real store with zero failures — the executor bring-up caught that the
 * graft steps (property.set of `[plan]`-scoped schemas onto the writing-plan
 * template) fail the write-time scope-eligibility check unless the template
 * root carries its bound class; the plan now classes each template root
 * `[template, <bindTo>]` and this test pins the applicable shape forever.
 */

import { beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { newEnvelope, type Envelope } from "@notees/protocol";
import {
  planWorkflowToggle,
  workflowAnchorId,
  SYSTEM_CLASS_DISPLAY_NAMES,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
} from "@notees/domain";
import { Store } from "../src/index.js";
import { sqljsBackend } from "../src/adapters/sqljs.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sql: SqlJsStatic;
beforeAll(async () => {
  sql = await initSqlJs();
});

function env(opType: string, payload: Record<string, unknown>, physical: number): Envelope {
  return newEnvelope({
    workspaceId: WS,
    actorId: ACTOR,
    deviceId: "workflow-plan-apply",
    hlc: { physical, logical: 0 },
    opType,
    payload,
    affectedNodeIds: [],
  });
}

const text = (s: string) => [{ type: "text", text: s }];

function seededStore(): Store {
  const store = Store.open(sqljsBackend(sql));
  let t = 1727200000000;
  const step = () => (t += 1000);
  // Minimal workspace: the system classes the plan binds/scopes against +
  // the has-template schema (global, node-typed, template-class filter).
  for (const name of ["question", "plan", "project", "source", "template"] as const) {
    store.apply(
      env(
        "class.create",
        { classId: SYSTEM_CLASS_UUIDS[name], contentAst: text(SYSTEM_CLASS_DISPLAY_NAMES[name]) },
        step(),
      ),
    );
  }
  store.apply(
    env(
      "propertySchema.create",
      {
        propertySchemaId: SYSTEM_PROPERTY_UUIDS.hasTemplate,
        name: "Has template",
        type: "object",
        multi: true,
        targetClassFilter: [SYSTEM_CLASS_UUIDS.template],
      },
      step(),
    ),
  );
  return store;
}

function applyPlan(store: Store, target: "enabled" | "disabled"): void {
  // The disable clock starts strictly after the enable clock — LWW needs a
  // strictly newer HLC to win over the creates it archives.
  let t = target === "enabled" ? 1727300000000 : 1727500000000;
  const step = () => (t += 1000);
  for (const planned of planWorkflowToggle("research", target)) {
    store.apply(env(planned.opType, planned.payload, step()));
  }
}

describe("the workflow op plan applies against a real store", () => {
  it("the enable plan applies with zero failures (anchor live at the end)", () => {
    const store = seededStore();
    applyPlan(store, "enabled");
    const anchor = store.getNode(workflowAnchorId("research"));
    expect(anchor).toBeDefined();
    expect(anchor?.is_active).toBe(1);
    store.close();
  });

  it("the disable plan applies with zero failures (anchor archived, instances keep their classes)", () => {
    const store = seededStore();
    applyPlan(store, "enabled");
    // A synthesis instance the disable must NOT touch.
    const synthesisId = "0192a000-0000-7000-8000-000000000099";
    store.apply(
      env(
        "object.create",
        {
          objectId: synthesisId,
          parentId: null,
          classIds: ["4b7613a7-c050-5dd7-9f49-586d26797b08"],
          contentAst: text("Synthesis of the field"),
        },
        1727400000000,
      ),
    );
    applyPlan(store, "disabled");
    const anchor = store.getNode(workflowAnchorId("research"));
    expect(anchor?.is_active).toBe(0);
    const instance = store.getNode(synthesisId);
    expect(instance?.is_active).toBe(1);
    expect(JSON.parse(instance?.class_ids ?? "[]")).toContain(
      "4b7613a7-c050-5dd7-9f49-586d26797b08",
    );
    store.close();
  });
});
