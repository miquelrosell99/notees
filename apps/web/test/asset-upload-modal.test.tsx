/**
 * AssetUploadModal tests: the drop zone accepts a picked
 * file, the preview row shows name + size + category chip (image/audio/
 * document), the upload runs the CAS path (uploadAsset → asset node →
 * attachAsset) with an explicit progress state, the caller receives the
 * asset node id, and a failure keeps the file selected with a retryable
 * error. Success path uses a stubbed uploadAsset (the REST POST is outside
 * the suite's scope; the workspace-client's own tests cover the transport).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { AssetUploadModal } from "../src/ui/components/modals/AssetUploadModal.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
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

function uploadResult(name: string) {
  return {
    assetId: "0192a000-0000-7000-8000-0000000000a1",
    hash: "a".repeat(64),
    mimeType: "application/pdf",
    size: 5,
    originalName: name,
  };
}

/** Pick a file through the FileDropZone's hidden input (the modal portals
 *  to document.body, so the query is document-scoped). */
function pickFile(file: File): void {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error("file input missing");
  fireEvent.change(input, { target: { files: [file] } });
}

describe("AssetUploadModal", () => {
  it("shows the drop zone, then a preview row with name, size, and category", async () => {
    const client = await seedClient();
    const { container } = render(
      <AssetUploadModal
        isOpen
        client={client}
        assetClassId={SYSTEM_CLASS_UUIDS.asset}
        onUploaded={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Drop a file here")).not.toBeNull();

    pickFile(new File(["%PDF-"], "scan.pdf", { type: "application/pdf" }));
    expect((await screen.findAllByText("scan.pdf")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Document")).not.toBeNull();
    expect(screen.getByText("5 B")).not.toBeNull();
    // The document icon renders (no image thumb for a PDF).
    expect(document.querySelector(".asset-upload-modal__thumb")).toBeNull();
  });

  it("image files render a thumbnail preview", async () => {
    const client = await seedClient();
    // jsdom's URL.createObjectURL is a stub unless polyfilled — spy it.
    const createObjectURL = vi.fn(() => "blob:preview");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });

    const { container } = render(
      <AssetUploadModal
        isOpen
        client={client}
        assetClassId={SYSTEM_CLASS_UUIDS.asset}
        onUploaded={() => {}}
        onClose={() => {}}
      />,
    );
    pickFile(new File(["bytes"], "photo.jpg", { type: "image/jpeg" }));
    await screen.findAllByText("photo.jpg");
    expect(document.querySelector(".asset-upload-modal__thumb")).not.toBeNull();
  });

  it("audio files render a player preview", async () => {
    const client = await seedClient();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:audio"),
      revokeObjectURL: vi.fn(),
    });
    const { container } = render(
      <AssetUploadModal
        isOpen
        client={client}
        assetClassId={SYSTEM_CLASS_UUIDS.asset}
        onUploaded={() => {}}
        onClose={() => {}}
      />,
    );
    pickFile(new File(["bytes"], "voice.ogg", { type: "audio/ogg" }));
    await screen.findAllByText("voice.ogg");
    expect(screen.getByText("Audio")).not.toBeNull();
    expect(document.querySelector("audio")).not.toBeNull();
  });

  it("upload runs the CAS path and reports the asset node id", async () => {
    const client = await seedClient();
    const upload = vi.spyOn(client, "uploadAsset").mockResolvedValue(uploadResult("scan.pdf"));
    const attach = vi.spyOn(client, "attachAsset").mockResolvedValue(undefined);
    const uploaded: string[] = [];
    const onClose = vi.fn();

    const { container } = render(
      <AssetUploadModal
        isOpen
        client={client}
        assetClassId={SYSTEM_CLASS_UUIDS.asset}
        onUploaded={(id) => uploaded.push(id)}
        onClose={onClose}
      />,
    );
    pickFile(new File(["%PDF-"], "scan.pdf", { type: "application/pdf" }));
    await screen.findAllByText("scan.pdf");

    const dialog = screen.getByRole("dialog", { name: /upload file/i });
    fireEvent.click(within(dialog).getByRole("button", { name: /upload/i }));

    await waitFor(() => expect(uploaded.length).toBe(1));
    expect(upload).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledTimes(1);
    // The asset node carries the asset class and the uploaded name.
    const node = client.getNode(uploaded[0]!);
    expect(node?.classIds).toContain(SYSTEM_CLASS_UUIDS.asset);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the uploading state, then a retryable error on failure", async () => {
    const client = await seedClient();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const upload = vi
      .spyOn(client, "uploadAsset")
      .mockImplementation(() => gate.then(() => Promise.reject(new Error("HTTP 413: too large"))));
    const { container } = render(
      <AssetUploadModal
        isOpen
        client={client}
        assetClassId={SYSTEM_CLASS_UUIDS.asset}
        onUploaded={() => {}}
        onClose={() => {}}
      />,
    );
    pickFile(new File(["%PDF-"], "big.pdf", { type: "application/pdf" }));
    await screen.findAllByText("big.pdf");

    const dialog = screen.getByRole("dialog", { name: /upload file/i });
    const uploadButton = within(dialog).getByRole("button", { name: /upload/i });
    fireEvent.click(uploadButton);
    // Explicit progress state while in flight.
    expect(await screen.findByText(/uploading big\.pdf/i)).not.toBeNull();

    release!();
    expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 413: too large");
    // The file stays selected; the failure is retryable.
    expect(screen.getAllByText("big.pdf").length).toBeGreaterThanOrEqual(1);
    expect(within(dialog).getByRole("button", { name: /upload/i })).not.toBeNull();
  });
});
