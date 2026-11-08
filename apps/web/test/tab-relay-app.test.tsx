import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { render } from "@testing-library/react";
import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { WORKSPACE_FEATURES } from "@notees/protocol";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { notificationStore } from "../src/components/ui/kit/notificationStore.js";
import { useTabRelay } from "../src/ui/app/useTabRelay.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
const SERVER = "https://notees.example.com";

// The vendored tuple may not know readItLater yet (the feature id arrives
// via a vendor bump) — cast through readonly string[] exactly like the hook.
const READ_IT_LATER_KNOWN = (WORKSPACE_FEATURES as readonly string[]).includes("readItLater");

let sqlModule: SqlJsStatic;
beforeAll(async () => {
  sqlModule = await initSqlJs();
});

function Probe(props: Parameters<typeof useTabRelay>[0]) {
  useTabRelay(props);
  return null;
}

const clients: WorkspaceClient[] = [];
afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
  notificationStore.clearAll();
});

async function authedClient(): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(new MemoryRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

function post(data: unknown, origin = SERVER) {
  window.dispatchEvent(new MessageEvent("message", { origin, source: window, data }));
}

const REQUEST = (mode: "source" | "readlater") => ({
  source: "notees-connector",
  type: "notees-capture-request",
  requestId: `r-${mode}`,
  payload: { url: `https://example.com/${mode}`, title: mode, mode },
});

describe("useTabRelay", () => {
  it("no token → not_authenticated, no write attempted", async () => {
    const sent: unknown[] = [];
    vi.spyOn(window, "postMessage").mockImplementation((d: unknown) => void sent.push(d));
    const ref = { current: null };
    render(<Probe clientRef={ref} serverUrl={SERVER} token="" workspacePlaintext unlockRequest={null} />);
    post(REQUEST("source"));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ ok: false, error: { code: "not_authenticated" } });
  });

  it("authed: source-mode capture stamps a node and answers its id; a success toast lands", async () => {
    const client = await authedClient();
    const sent: unknown[] = [];
    vi.spyOn(window, "postMessage").mockImplementation((d: unknown) => void sent.push(d));
    const ref = { current: client };
    render(<Probe clientRef={ref} serverUrl={SERVER} token="tok" workspacePlaintext unlockRequest={null} />);
    post(REQUEST("source"));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const response = sent[0] as { ok: boolean; objectId?: string };
    expect(response.ok).toBe(true);
    expect(client.getNode(response.objectId!)).toBeDefined();
    expect(notificationStore.notifications.some((n) => n.type === "success")).toBe(true);
  });

  it("readlater mode with the feature OFF → feature_disabled (post-bump only)", async () => {
    if (!READ_IT_LATER_KNOWN) return; // pre-bump: the gate id does not exist
    const client = await authedClient();
    await client.setFeatureEnabled("readItLater" as never, false);
    const sent: unknown[] = [];
    vi.spyOn(window, "postMessage").mockImplementation((d: unknown) => void sent.push(d));
    const ref = { current: client };
    render(<Probe clientRef={ref} serverUrl={SERVER} token="tok" workspacePlaintext unlockRequest={null} />);
    post(REQUEST("readlater"));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ ok: false, error: { code: "feature_disabled" } });
  });

  it("keyed workspace with no master key in custody → failed, zero creates", async () => {
    const client = await authedClient();
    const sent: unknown[] = [];
    vi.spyOn(window, "postMessage").mockImplementation((d: unknown) => void sent.push(d));
    const ref = { current: client };
    render(
      <Probe clientRef={ref} serverUrl={SERVER} token="tok" workspacePlaintext={false} unlockRequest={{}} />,
    );
    post(REQUEST("source"));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ ok: false, error: { code: "failed" } });
  });
});
