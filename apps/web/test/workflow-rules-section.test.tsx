/**
 * WorkflowRulesSection (workspace settings → Automation): the workflow-rules
 * editor over the coordination API.
 *
 * - List render: name, trigger summary, active state, last-run status from
 *   the run audit.
 * - Create round-trip against a mocked rules API: the POST body matches the
 *   server's rule schema exactly; the list refreshes.
 * - Validation surface: the client's shape checks (uuid, criteria) AND the
 *   server's 422 message both reach the form.
 * - Toggle (PATCH enabled) + delete behind the confirm (DELETE).
 * - Offline degradation: the "rules sync when the server answers" note.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkflowRulesSection } from "../src/features/settings/WorkflowRulesSection.js";

const SERVER = "https://notees.example.com";
const CREDENTIAL = "session-token";

const RULE_A = {
  id: "0192a000-0000-7000-8000-0000000000a1",
  workspaceId: "3b30e070-039b-47bc-ad0d-2440a2f173c5",
  name: "Flag papers",
  enabled: true,
  trigger: { opType: "object.create" },
  criteria: {
    version: 2,
    scope: { type: "entire_workspace" },
    root: {
      type: "group",
      logic: "and",
      children: [
        { type: "member", family: "class", op: "in", target: { mode: "ids", ids: ["0192a000-0000-7000-8000-0000000000c1"] } },
      ],
    },
  },
  actions: [
    { type: "property.set", propertySchemaId: "0192a000-0000-7000-8000-0000000000d1", value: "review", idx: 0 },
  ],
  createdAt: 1,
  updatedAt: 1,
};

const RUN_A = {
  id: "0192a000-0000-7000-8000-0000000000b1",
  ruleId: RULE_A.id,
  triggerEnvelopeId: "0192a000-0000-7000-8000-0000000000e1",
  nodeId: "0192a000-0000-7000-8000-0000000000e2",
  actionsWritten: [{ opType: "property.set", envelopeId: "0192a000-0000-7000-8000-0000000000e3" }],
  outcome: "actions_written",
  detail: null,
  createdAt: 1_800_000_000_000,
};

interface Mock {
  fetchMock: ReturnType<typeof vi.fn>;
  calls: Array<{ method: string; url: string; body: unknown }>;
  rules: typeof RULE_A[];
}

function makeMock(options: { failList?: boolean } = {}): Mock {
  const calls: Mock["calls"] = [];
  const state: Mock = {
    calls,
    rules: [RULE_A],
    fetchMock: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      calls.push({ method, url, body });
      if (url.endsWith("/api/workflows") && method === "GET") {
        if (options.failList === true) return Response.json({ error: { message: "offline" } }, { status: 503 });
        return Response.json({ rules: state.rules });
      }
      const runsMatch = /\/api\/workflows\/[^/]+\/runs$/.exec(url);
      if (runsMatch !== null && method === "GET") {
        return Response.json({ runs: [RUN_A] });
      }
      if (url.endsWith("/api/workflows") && method === "POST") {
        const rule = {
          ...RULE_A,
          id: "0192a000-0000-7000-8000-0000000000a2",
          name: body.name,
          enabled: body.enabled,
          trigger: body.trigger,
          criteria: body.criteria,
          actions: body.actions,
        };
        state.rules = [...state.rules, rule];
        return Response.json({ rule }, { status: 201 });
      }
      const ruleMatch = /\/api\/workflows\/([^/]+)$/.exec(url);
      if (ruleMatch !== null && method === "PATCH") {
        state.rules = state.rules.map((rule) =>
          rule.id === ruleMatch[1] ? { ...rule, ...body } : rule,
        );
        return Response.json({ rule: state.rules.find((rule) => rule.id === ruleMatch[1]) });
      }
      if (ruleMatch !== null && method === "DELETE") {
        state.rules = state.rules.filter((rule) => rule.id !== ruleMatch[1]);
        return Response.json({ ok: true });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  };
  return state;
}

function renderSection(mock: Mock) {
  vi.stubGlobal("fetch", mock.fetchMock);
  render(<WorkflowRulesSection serverUrl={SERVER} credential={CREDENTIAL} />);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WorkflowRulesSection", () => {
  it("lists the rules with trigger summary, active state, and the last-run status", async () => {
    const mock = makeMock();
    renderSection(mock);
    expect(await screen.findByText("Flag papers")).toBeInTheDocument();
    expect(screen.getByText(/Node created · Set property 0192a000/i)).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText(/Last run: actions written/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new rule/i })).toBeInTheDocument();
  });

  it("create round-trip: the POST body matches the server schema and the list refreshes", async () => {
    const mock = makeMock();
    renderSection(mock);
    await screen.findByText("Flag papers");

    fireEvent.click(screen.getByRole("button", { name: /new rule/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "Mark meetings" } });
    fireEvent.change(screen.getByLabelText(/^property schema uuid$/i), {
      target: { value: "0192a000-0000-7000-8000-0000000000d9" },
    });
    fireEvent.change(screen.getByLabelText(/^value \(json, or text\)$/i), { target: { value: '"logged"' } });
    fireEvent.click(screen.getByRole("button", { name: /^save rule$/i }));

    await screen.findByText("Mark meetings", {}, { timeout: 5_000 });
    const post = mock.calls.find((c) => c.method === "POST" && c.url.endsWith("/api/workflows"));
    expect(post?.body).toEqual({
      name: "Mark meetings",
      enabled: true,
      trigger: { opType: "object.create" },
      criteria: {
        version: 2,
        scope: { type: "entire_workspace" },
        root: { type: "group", logic: "and", children: [] },
      },
      actions: [
        { type: "property.set", propertySchemaId: "0192a000-0000-7000-8000-0000000000d9", value: "logged", idx: 0 },
      ],
    });
  });

  it("the client's shape validation surfaces before any network write", async () => {
    const mock = makeMock();
    renderSection(mock);
    await screen.findByText("Flag papers");

    fireEvent.click(screen.getByRole("button", { name: /new rule/i }));
    await screen.findByRole("dialog");
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "No uuid" } });
    fireEvent.click(screen.getByRole("button", { name: /^save rule$/i }));
    await screen.findByText(/property-schema uuid/i);
    expect(mock.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("the server's 422 message surfaces verbatim on submit", async () => {
    const mock = makeMock();
    renderSection(mock);
    await screen.findByText("Flag papers");
    mock.fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      mock.calls.push({ method, url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      if (url.endsWith("/api/workflows") && method === "POST") {
        return Response.json({ error: { message: "workflow criteria must not carry an aggregation" } }, { status: 422 });
      }
      if (url.endsWith("/api/workflows") && method === "GET") return Response.json({ rules: mock.rules });
      return Response.json({ runs: [] });
    });

    fireEvent.click(screen.getByRole("button", { name: /new rule/i }));
    await screen.findByRole("dialog");
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "Aggregated" } });
    fireEvent.change(screen.getByLabelText(/^property schema uuid$/i), {
      target: { value: "0192a000-0000-7000-8000-0000000000d9" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^save rule$/i }));
    await screen.findByText(/must not carry an aggregation/i);
  });

  it("active toggle PATCHes enabled; delete confirms then DELETEs", async () => {
    const mock = makeMock();
    renderSection(mock);
    await screen.findByText("Flag papers");

    fireEvent.click(screen.getByRole("switch", { name: /toggle flag papers/i }));
    await waitFor(() => {
      const patch = mock.calls.find((c) => c.method === "PATCH");
      expect(patch?.body).toEqual({ enabled: false });
    });
    expect(await screen.findByText("Paused")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    const confirm = await screen.findByRole("dialog");
    fireEvent.click(await screen.findByRole("button", { name: /^delete$/i }, { container: confirm }));
    await waitFor(() => expect(screen.queryByText("Flag papers")).toBeNull());
    expect(mock.calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("offline: the server-unreachable note replaces the list", async () => {
    const mock = makeMock({ failList: true });
    renderSection(mock);
    expect(
      await screen.findByText(/rules sync when the server answers/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("Flag papers")).toBeNull();
    expect(screen.getByRole("button", { name: /new rule/i })).toBeInTheDocument();
  });
});
