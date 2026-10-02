/**
 * Modals + overlays tests (jsdom): the ported dialogs render their legacy
 * chrome, write through the WorkspaceClient surface, and the export modal
 * builds its preview from the local @notees/export engine. The
 * BackendUnavailableOverlay toggles banner/lock off the sync status, and
 * the toast host connects the notification store to the presentational
 * toast.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { deriveDisplayName } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { ExportPageModal } from "../src/ui/components/modals/ExportPageModal.js";
import { DuplicatePageModal } from "../src/ui/components/modals/DuplicatePageModal.js";
import { CreatePageWithUuidModal } from "../src/ui/components/modals/CreatePageWithUuidModal.js";
import { QuickAddModal } from "../src/ui/components/modals/QuickAddModal.js";
import { WorkspaceNameModal } from "../src/ui/components/modals/WorkspaceNameModal.js";
import { BackendUnavailableOverlay } from "../src/ui/components/ui/BackendUnavailableOverlay.js";
import { LoadingSkeleton, Skeleton } from "../src/ui/components/ui/LoadingSkeleton.js";
import { NotificationToaster } from "../src/ui/components/ui/NotificationToaster.js";
import { notificationStore } from "../src/ui/components/ui/notificationStore.js";
import type { SyncStatusSnapshot } from "../src/core/workspace-client.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  notificationStore.clearAll();
});

async function makeClient(): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(new MemoryRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

const OK_STATUS: SyncStatusSnapshot = {
  status: "idle",
  error: null,
  pending: 0,
  failed: 0,
  quarantined: 0,
  parked: 0,
  realtime: false,
  cursorSeq: 0,
};

describe("ExportPageModal", () => {
  it("previews the subtree markdown from the local export engine", async () => {
    const client = await makeClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Trip" });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "Book flights" }],
    });
    const childId = await client.createObject({ presentAsMain: true, name: "Packing", parentId: pageId });
    await client.createObject({
      parentId: childId,
      contentAst: [{ type: "text", text: "Sunscreen" }],
    });

    render(
      <ExportPageModal isOpen={true} onClose={() => {}} client={client} nodeUuid={pageId} nodeName="Trip" />,
    );

    const preview = (await screen.findByLabelText("markdown preview", undefined, {
      timeout: 2000,
    })) as HTMLTextAreaElement;
    await vi.waitFor(
      () => {
        expect(preview.value).toContain("name: Trip");
        expect(preview.value).toContain("# Trip");
        expect(preview.value).toContain("- Book flights");
        // Child page included as its own section by default.
        expect(preview.value).toContain("# Packing");
        expect(preview.value).toContain("- Sunscreen");
      },
      { timeout: 2000 },
    );
  }, 10000);

  it("honors the Include child pages toggle", async () => {
    const client = await makeClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Trip" });
    const childId = await client.createObject({ presentAsMain: true, name: "Packing", parentId: pageId });
    await client.createObject({
      parentId: childId,
      contentAst: [{ type: "text", text: "Sunscreen" }],
    });

    render(<ExportPageModal isOpen={true} onClose={() => {}} client={client} nodeUuid={pageId} />);

    const preview = (await screen.findByLabelText("markdown preview", undefined, {
      timeout: 2000,
    })) as HTMLTextAreaElement;
    await vi.waitFor(() => expect(preview.value).toContain("# Packing"), { timeout: 2000 });

    // The toggle lives in the footer options panel (gear button).
    fireEvent.click(document.querySelector(".btn-panel-container > button")!);
    fireEvent.click(screen.getByRole("switch", { name: /include child pages/i }));

    await vi.waitFor(
      () => {
        expect((screen.getByLabelText("markdown preview") as HTMLTextAreaElement).value).not.toContain(
          "# Packing",
        );
      },
      { timeout: 2000 },
    );
  }, 10000);

  it("downloads the markdown file on Download", async () => {
    const client = await makeClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Trip" });

    const createObjectUrl = vi.fn(() => "blob:mock");
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { value: createObjectUrl, configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectUrl, configurable: true });
    let captured: HTMLAnchorElement | null = null;
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        captured = this;
      });

    render(<ExportPageModal isOpen={true} onClose={() => {}} client={client} nodeUuid={pageId} />);
    await screen.findByLabelText("markdown preview", undefined, { timeout: 2000 });

    fireEvent.click(screen.getByRole("button", { name: /download/i }));

    expect(createObjectUrl).toHaveBeenCalled();
    expect(captured).not.toBeNull();
    expect(captured!.getAttribute("download")).toBe("Trip.md");

    click.mockRestore();
  }, 10000);

  it("states honestly that service-dependent formats are unavailable", async () => {
    const client = await makeClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Trip" });

    render(<ExportPageModal isOpen={true} onClose={() => {}} client={client} nodeUuid={pageId} />);

    fireEvent.click(screen.getByRole("tab", { name: "PDF" }));

    // The limitation is stated in the preview error AND the placeholder.
    expect((await screen.findAllByText(/server export service/i, undefined, { timeout: 2000 })).length)
      .toBeGreaterThan(0);
    // No local preview for service-dependent formats → copy is inert; the
    // download attempt reports the limitation instead of producing a file.
    expect(screen.getByRole("button", { name: /copy/i })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /download/i }));
    expect((await screen.findAllByText(/server export service/i, undefined, { timeout: 2000 })).length)
      .toBeGreaterThan(0);
  }, 10000);
});

describe("DuplicatePageModal", () => {
  it("creates the page with the picked class", async () => {
    const client = await makeClient();
    const classId = await client.createClass("Company");
    // WORKAROUND(store applier): class.create's contentAst never lands in the
    // class node's content (the upsert's LWW update loses against the row its
    // own INSERT just wrote), so seed the title via object.update — the
    // later-HLC path that does persist. Remove once the applier is fixed.
    await client.updateObject(classId, { contentAst: [{ type: "text", text: "Company" }] });

    const onSuccess = vi.fn();
    render(
      <DuplicatePageModal
        isOpen={true}
        onClose={() => {}}
        pageName="Apple"
        conflictingClasses={["Fruit"]}
        originalClasses={["Fruit"]}
        parentId={null}
        client={client}
        onSuccess={onSuccess}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /company/i }));
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalled());
    const created = onSuccess.mock.calls[0]![0] as { id: string; contentAst: unknown; classIds: string[] };
    // Title-is-content: the duplicate's title is its content.
    expect(created.contentAst).toEqual([{ type: "text", text: "Apple" }]);
    expect(created.classIds).toContain(classId);
    expect(deriveDisplayName(client.getNode(created.id)!)).toBe("Apple");
  });
});

describe("CreatePageWithUuidModal", () => {
  it("creates a node with the user-specified UUID", async () => {
    const client = await makeClient();
    const fixed = "550e8400-e29b-41d4-a716-446655440000";

    const onSuccess = vi.fn();
    render(<CreatePageWithUuidModal isOpen={true} onClose={() => {}} client={client} onSuccess={onSuccess} />);

    fireEvent.change(screen.getByLabelText(/page name/i), { target: { value: "Fixed id page" } });
    fireEvent.change(screen.getByLabelText(/^uuid$/i), {
      target: { value: fixed },
    });
    fireEvent.click(screen.getByRole("button", { name: /^open$/i }));

    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalled());
    // Title-is-content: the page's title is its text content.
    expect(client.getNode(fixed)?.contentAst).toEqual([{ type: "text", text: "Fixed id page" }]);
  });

  it("refuses a UUID that already exists", async () => {
    const client = await makeClient();
    const fixed = "550e8400-e29b-41d4-a716-446655440000";
    await client.createObject({ id: fixed, presentAsMain: true, name: "Taken" });

    render(<CreatePageWithUuidModal isOpen={true} onClose={() => {}} client={client} onSuccess={() => {}} />);

    fireEvent.change(screen.getByLabelText(/page name/i), { target: { value: "Again" } });
    fireEvent.change(screen.getByLabelText(/^uuid$/i), {
      target: { value: fixed },
    });
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
  });
});

describe("QuickAddModal", () => {
  it("captures blocks into the Inbox page", async () => {
    const client = await makeClient();
    const inboxId = await client.createObject({ presentAsMain: true, name: "Inbox" });

    render(<QuickAddModal isOpen={true} onClose={() => {}} client={client} />);

    fireEvent.click(screen.getByRole("button", { name: /inbox/i }));
    fireEvent.change(screen.getByPlaceholderText("Type something..."), {
      target: { value: "Remember the milk" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await vi.waitFor(() => {
      const children = client.getChildren(inboxId);
      expect(children).toHaveLength(1);
      expect(children[0]!.contentAst).toEqual([{ type: "text", text: "Remember the milk" }]);
    });
  });

  it("keeps Send disabled when no Inbox page exists", async () => {
    const client = await makeClient();

    render(<QuickAddModal isOpen={true} onClose={() => {}} client={client} />);

    fireEvent.click(screen.getByRole("button", { name: /inbox/i }));
    fireEvent.change(screen.getByPlaceholderText("Type something..."), {
      target: { value: "Nowhere to go" },
    });

    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
  });
});

describe("WorkspaceNameModal", () => {
  it("validates and submits the trimmed name", async () => {
    const onSubmit = vi.fn();
    render(
      <WorkspaceNameModal
        isOpen={true}
        onClose={() => {}}
        onSubmit={onSubmit}
        title="Rename workspace"
        submitLabel="Rename"
      />,
    );

    fireEvent.change(screen.getByLabelText(/workspace name/i), { target: { value: "  " } });
    // The submit button is disabled for too-short names; submitting the form
    // directly (the Enter-key path) still surfaces the validation message.
    expect(screen.getByRole("button", { name: /^rename$/i })).toBeDisabled();
    fireEvent.submit(document.querySelector("form")!);
    expect(screen.getByText(/please enter a workspace name/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/workspace name/i), { target: { value: "  Garden  " } });
    fireEvent.click(screen.getByRole("button", { name: /^rename$/i }));
    expect(onSubmit).toHaveBeenCalledWith("Garden");
  });
});

describe("BackendUnavailableOverlay", () => {
  it("renders nothing while healthy, a banner on error, and a lock after dismiss", () => {
    const { rerender } = render(<BackendUnavailableOverlay syncStatus={OK_STATUS} />);
    expect(screen.queryByText(/backend unreachable/i)).not.toBeInTheDocument();

    const errorStatus: SyncStatusSnapshot = { ...OK_STATUS, status: "error", error: "boom" };
    rerender(<BackendUnavailableOverlay syncStatus={errorStatus} />);
    const banner = screen.getByRole("status");
    expect(banner).toHaveClass("backend-unavailable-banner");
    expect(within(banner).getByText(/backend unreachable/i)).toBeInTheDocument();

    fireEvent.click(within(banner).getByRole("button", { name: /dismiss/i }));

    const lock = screen.getByLabelText(/backend is unavailable/i);
    expect(lock).toHaveClass("backend-unavailable-overlay");
    expect(within(lock).getByText(/unlock automatically/i)).toBeInTheDocument();

    // Recovery clears the lock again.
    rerender(<BackendUnavailableOverlay syncStatus={OK_STATUS} />);
    expect(screen.queryByLabelText(/backend is unavailable/i)).not.toBeInTheDocument();
  });
});

describe("LoadingSkeleton", () => {
  it("renders the configured shimmer rows", () => {
    const { container } = render(<LoadingSkeleton rows={4} showHeading showAvatar />);
    expect(container.querySelectorAll(".skeleton-row")).toHaveLength(4);
    expect(container.querySelector(".skeleton-group__heading")).not.toBeNull();
    expect(container.querySelectorAll(".skeleton-row__avatar")).toHaveLength(4);
    expect(screen.getByRole("status", { name: /loading/i })).toBeInTheDocument();
  });

  it("renders a standalone Skeleton with shape and width classes", () => {
    const { container } = render(<Skeleton shape="circle" width="half" />);
    const skeleton = container.querySelector(".skeleton");
    expect(skeleton).toHaveClass("skeleton--circle");
    expect(skeleton).toHaveClass("skeleton--half");
  });
});

describe("NotificationToaster", () => {
  it("shows and dismisses store notifications", async () => {
    render(<NotificationToaster />);

    act(() => {
      notificationStore.success("Saved", "All changes synced");
    });

    const toast = screen.getByRole("status");
    expect(toast).toHaveClass("notification-toast--success");
    expect(within(toast).getByText("Saved")).toBeInTheDocument();

    fireEvent.click(within(toast).getByRole("button", { name: /dismiss/i }));
    // Dismissed toasts stay mounted briefly so the exit transition can play.
    expect(screen.getByText("Saved").closest(".notification-toast")).toHaveClass(
      "notification-toast--exiting",
    );
    await waitFor(() => expect(screen.queryByText("Saved")).not.toBeInTheDocument());
  });
});
