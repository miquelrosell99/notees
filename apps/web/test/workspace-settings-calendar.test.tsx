/**
 * WorkspaceSettingsModal — Calendar Quick-Create section: enumerates the
 * eligible classes (the shared dateChipCandidates rule — EVENT FAMILY ONLY
 * since 2026-10-23: the system event class and everything extending it),
 * reflects the effective per-workspace list, persists unchecks/checks as
 * an explicit device-local list, offers Reset to defaults once the list
 * is explicit, and renders an honest note when no matching client is
 * available (no client, or another workspace's modal).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { newEnvelope, type Envelope } from "@notees/protocol";
import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { WorkspaceSettingsModal } from "../src/features/workspaces/WorkspaceSettingsModal.js";
import {
  QUICK_CREATE_CLASSES_PREFIX,
  readQuickCreateClassesSetting,
} from "../src/features/calendar/calendarQuickCreateSettings.js";

const WS = "0192a000-0000-7000-8000-0000000000e1";
const ACTOR = "0192a000-0000-7000-8000-0000000000e2";
const DEVICE = "test-device";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
  // jsdom lacks ResizeObserver; Tabs.List uses it for the active indicator.
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
});

function seedEnvelope(opType: string, payload: Record<string, unknown>, affected: string[]): Envelope {
  return newEnvelope({
    workspaceId: WS,
    actorId: ACTOR,
    deviceId: DEVICE,
    client: "seed",
    hlc: { physical: 1, logical: 0 },
    affectedNodeIds: affected,
    opType,
    payload,
  });
}

function seededRelay(): MemoryRelay {
  const relay = new MemoryRelay();
  relay.ingest([
    seedEnvelope(
      "class.create",
      { classId: SYSTEM_CLASS_UUIDS.event, contentAst: [{ type: "text", text: "event" }] },
      [SYSTEM_CLASS_UUIDS.event],
    ),
  ]);
  return relay;
}

async function seedClient(): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(seededRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

/** A user event subclass with a date binding — the eligible chip shape. */
async function seedEventSubclass(client: WorkspaceClient): Promise<string> {
  const schemaId = await client.createPropertySchema({ name: "When", type: "datetime" });
  const classId = await client.createClass("gathering");
  await client.setClassExtends(classId, [SYSTEM_CLASS_UUIDS.event]);
  await client.setClassProperty(classId, schemaId, {});
  return classId;
}

const MODAL_PROPS = {
  isOpen: true,
  onClose: () => {},
  serverUrl: "https://notees.example.com",
  credential: "session-token",
  workspaceId: WS,
  workspaceName: "Garden",
  workspaceRole: "owner",
};

function renderModal(extra: Partial<Parameters<typeof WorkspaceSettingsModal>[0]> = {}) {
  return render(<WorkspaceSettingsModal {...MODAL_PROPS} {...extra} />);
}

describe("WorkspaceSettingsModal calendar quick-create", () => {
  it("lists event-family classes with the driving date property and defaults all on", async () => {
    const client = await seedClient();
    await seedEventSubclass(client);

    renderModal({ client });

    expect(screen.getByText("Calendar Quick-Create")).toBeDefined();
    expect(screen.getByText(/event-type classes offered as quick-create chips/i)).toBeDefined();
    // The event-family class is eligible (with its driving property label);
    // task is NOT event family — never listed. The seeded system event class
    // is itself eligible through its synthesized eventDate binding.
    expect(screen.getByRole("switch", { name: "gathering" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "event" })).toBeChecked();
    expect(screen.queryByRole("switch", { name: "task" })).toBeNull();
    expect(screen.getByText("When")).toBeDefined();
    // Defaults: no explicit list stored, no reset affordance.
    expect(readQuickCreateClassesSetting(WS)).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset to defaults" })).toBeNull();
  });

  it("unchecking persists the narrowed list; Reset to defaults clears it", async () => {
    const client = await seedClient();
    await seedEventSubclass(client);

    renderModal({ client });

    fireEvent.click(screen.getByRole("switch", { name: "gathering" }));
    // The rest of the eligible set (the seeded event class) persists.
    expect(readQuickCreateClassesSetting(WS)).toEqual([SYSTEM_CLASS_UUIDS.event]);
    expect(screen.getByRole("switch", { name: "gathering" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Reset to defaults" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    expect(readQuickCreateClassesSetting(WS)).toBeNull();
    expect(screen.getByRole("switch", { name: "gathering" })).toBeChecked();
    expect(screen.queryByRole("button", { name: "Reset to defaults" })).toBeNull();
  });

  it("checking an unchecked class adds it back to the explicit list", async () => {
    const client = await seedClient();
    const classId = await seedEventSubclass(client);

    renderModal({ client });
    fireEvent.click(screen.getByRole("switch", { name: "gathering" }));
    expect(readQuickCreateClassesSetting(WS)).toEqual([SYSTEM_CLASS_UUIDS.event]);
    fireEvent.click(screen.getByRole("switch", { name: "gathering" }));
    expect(readQuickCreateClassesSetting(WS)).toEqual([SYSTEM_CLASS_UUIDS.event, classId]);
  });

  it("honest note without a client, or when the modal targets another workspace", async () => {
    const client = await seedClient();
    await seedEventSubclass(client);

    const { unmount } = renderModal();
    expect(screen.getByText(/open this workspace to configure/i)).toBeDefined();
    expect(screen.queryByRole("switch", { name: "gathering" })).toBeNull();
    unmount();

    renderModal({ client, workspaceId: "another-workspace" });
    expect(screen.getByText(/open this workspace to configure/i)).toBeDefined();
    expect(readQuickCreateClassesSetting("another-workspace")).toBeNull();
    // The other workspace's key was never written.
    expect(
      localStorage.getItem(`notees.settings.${QUICK_CREATE_CLASSES_PREFIX}.another-workspace`),
    ).toBeNull();
  });
});
