/**
 * WorkspaceSettingsModal — Calendar Quick-Create section: enumerates the
 * eligible classes (shared dateChipCandidates rule — task prefers
 * taskScheduled), reflects the effective per-workspace list, persists
 * unchecks/checks as an explicit device-local list, offers Reset to
 * defaults once the list is explicit, and renders an honest note when no
 * matching client is available (no client, or another workspace's modal).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { newEnvelope, type Envelope } from "@notees/protocol";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { WorkspaceSettingsModal } from "../src/ui/components/modals/WorkspaceSettingsModal.js";
import { ensureTaskFamily } from "../src/ui/components/taskFamily.js";
import {
  QUICK_CREATE_CLASSES_PREFIX,
  readQuickCreateClassesSetting,
} from "../src/ui/components/calendarQuickCreateSettings.js";

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
      { classId: SYSTEM_CLASS_UUIDS.task, contentAst: [{ type: "text", text: "task" }], icon: "mdiCheckboxMarkedCircleOutline" },
      [SYSTEM_CLASS_UUIDS.task],
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
  it("lists eligible classes with the driving date property and defaults all on", async () => {
    const client = await seedClient();
    await ensureTaskFamily(client);
    const schemaId = await client.createPropertySchema({ name: "When", type: "date" });
    // A generic user class — "meeting" is system-class vocabulary (a user
    // class with that title absorbs the seed family bindings).
    const classId = await client.createClass("gathering");
    await client.setClassProperty(classId, schemaId, {});

    renderModal({ client });

    expect(screen.getByText("Calendar Quick-Create")).toBeDefined();
    expect(screen.getByText(/by default every class with a date property appears/i)).toBeDefined();
    // Both eligible classes, defaults checked, property labels alongside.
    expect(screen.getByRole("switch", { name: "gathering" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "task" })).toBeChecked();
    expect(screen.getByText("When")).toBeDefined();
    expect(screen.getByText("Scheduled")).toBeDefined();
    // Defaults: no explicit list stored, no reset affordance.
    expect(readQuickCreateClassesSetting(WS)).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset to defaults" })).toBeNull();
  });

  it("unchecking persists the narrowed list; Reset to defaults clears it", async () => {
    const client = await seedClient();
    await ensureTaskFamily(client);

    renderModal({ client });

    fireEvent.click(screen.getByRole("switch", { name: "task" }));
    expect(readQuickCreateClassesSetting(WS)).toEqual([]);
    expect(screen.getByRole("switch", { name: "task" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Reset to defaults" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    expect(readQuickCreateClassesSetting(WS)).toBeNull();
    expect(screen.getByRole("switch", { name: "task" })).toBeChecked();
    expect(screen.queryByRole("button", { name: "Reset to defaults" })).toBeNull();
  });

  it("checking an unchecked class adds it back to the explicit list", async () => {
    const client = await seedClient();
    await ensureTaskFamily(client);

    renderModal({ client });
    fireEvent.click(screen.getByRole("switch", { name: "task" }));
    expect(readQuickCreateClassesSetting(WS)).toEqual([]);
    fireEvent.click(screen.getByRole("switch", { name: "task" }));
    expect(readQuickCreateClassesSetting(WS)).toEqual([SYSTEM_CLASS_UUIDS.task]);
  });

  it("honest note without a client, or when the modal targets another workspace", async () => {
    const client = await seedClient();
    await ensureTaskFamily(client);

    const { unmount } = renderModal();
    expect(screen.getByText(/open this workspace to configure/i)).toBeDefined();
    expect(screen.queryByRole("switch", { name: "task" })).toBeNull();
    unmount();

    renderModal({ client, workspaceId: "another-workspace" });
    expect(screen.getByText(/open this workspace to configure/i)).toBeDefined();
    expect(readQuickCreateClassesSetting("another-workspace")).toBeNull();
    // The other workspace's key was never written.
    expect(
      localStorage.getItem(`notees.settings.${QUICK_CREATE_CLASSES_PREFIX}.another-workspace`),
    ).toBeNull();
  });

  it("notes when no class is eligible yet", async () => {
    const client = await seedClient(); // task class seeded, but no date schemas
    renderModal({ client });
    expect(screen.getByText(/no classes with a date property yet/i)).toBeDefined();
  });
});
