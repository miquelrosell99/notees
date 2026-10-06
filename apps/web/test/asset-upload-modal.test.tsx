/**
 * AssetUploadModal tests: the drop zone
 * accepts a picked file, the preview row shows name + size + category chip
 * (image/audio/document), the upload runs the CAS path (uploadAsset → asset
 * node → attachAsset) with an explicit progress state, the caller receives
 * the asset node id, and a failure keeps the file selected with a retryable
 * error. The M33 additions: the modal-internal paste capture
 * (clipboardData.items) selects a pasted file, `initialFile` prefills
 * through the same validation, `acceptedTypes` narrows the accept list and
 * rejects other categories with the v1 wording, and the v1 size caps reject
 * oversized files before the upload starts. Success path uses a stubbed
 * uploadAsset (the REST POST is outside the suite's scope; the
 * workspace-client's own tests cover the transport).
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

/** A File whose size is faked without allocating the bytes. */
function sizedFile(name: string, type: string, size: number): File {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

/** A minimal clipboardData.items stand-in for the paste capture. */
function pasteData(...files: File[]): { clipboardData: { items: Array<{ kind: string; type: string; getAsFile(): File | null }> } } {
  return {
    clipboardData: {
      items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
    },
  };
}

/** Dispatch a native paste on document with a synthetic clipboardData
 *  (jsdom's ClipboardEvent has no setter for clipboardData, so the property
 *  is defined directly on a plain Event). */
function pasteOnDocument(init: object): void {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: (init as { clipboardData: unknown }).clipboardData });
  document.dispatchEvent(event);
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

  it("M33: a clipboard paste inside the modal selects the file", async () => {
    const client = await seedClient();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL: vi.fn(),
    });
    render(
      <AssetUploadModal
        isOpen
        client={client}
        assetClassId={SYSTEM_CLASS_UUIDS.asset}
        onUploaded={() => {}}
        onClose={() => {}}
      />,
    );
    pasteOnDocument(pasteData(new File(["bytes"], "pasted.png", { type: "image/png" })));
    expect((await screen.findAllByText("pasted.png")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Image")).not.toBeNull();
  });

  it("M33: the paste capture ignores clipboard entries without files", async () => {
    const client = await seedClient();
    render(
      <AssetUploadModal
        isOpen
        client={client}
        assetClassId={SYSTEM_CLASS_UUIDS.asset}
        onUploaded={() => {}}
        onClose={() => {}}
      />,
    );
    pasteOnDocument({
      clipboardData: {
        items: [{ kind: "string", type: "text/plain", getAsFile: () => null }],
      },
    });
    // Nothing selected: still the empty drop zone, no error.
    expect(screen.getByText("Drop a file here")).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("M33: initialFile prefills the drop zone (invalid files error, no selection)", async () => {
    const client = await seedClient();
    const { rerender } = render(
      <AssetUploadModal
        isOpen
        client={client}
        assetClassId={SYSTEM_CLASS_UUIDS.asset}
        initialFile={new File(["%PDF-"], "prefill.pdf", { type: "application/pdf" })}
        onUploaded={() => {}}
        onClose={() => {}}
      />,
    );
    expect((await screen.findAllByText("prefill.pdf")).length).toBeGreaterThanOrEqual(1);

    // An oversize initialFile is rejected up front with the v1 wording.
    rerender(
      <AssetUploadModal
        isOpen
        client={client}
        assetClassId={SYSTEM_CLASS_UUIDS.asset}
        initialFile={sizedFile("huge.pdf", "application/pdf", 100 * 1024 * 1024 + 1)}
        onUploaded={() => {}}
        onClose={() => {}}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "File too large. Maximum size is 100MB.",
    );
  });

  it("M33: acceptedTypes narrows the accept list and rejects other categories", async () => {
    const client = await seedClient();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL: vi.fn(),
    });
    render(
      <AssetUploadModal
        isOpen
        client={client}
        assetClassId={SYSTEM_CLASS_UUIDS.asset}
        acceptedTypes={["image"]}
        onUploaded={() => {}}
        onClose={() => {}}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Upload image" });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.accept).toContain("image/jpeg");
    expect(input.accept).not.toContain("pdf");

    // A document through the image-only modal: rejected, no selection.
    pickFile(new File(["%PDF-"], "scan.pdf", { type: "application/pdf" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Only image files are accepted.",
    );
    expect(screen.queryByText("scan.pdf")).toBeNull();

    // An image still passes.
    pickFile(new File(["bytes"], "photo.png", { type: "image/png" }));
    expect((await screen.findAllByText("photo.png")).length).toBeGreaterThanOrEqual(1);
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  it("M33: the v1 size caps reject oversized files before the upload starts", async () => {
    const client = await seedClient();
    const upload = vi.spyOn(client, "uploadAsset").mockResolvedValue(uploadResult("big.jpg"));
    render(
      <AssetUploadModal
        isOpen
        client={client}
        assetClassId={SYSTEM_CLASS_UUIDS.asset}
        onUploaded={() => {}}
        onClose={() => {}}
      />,
    );
    // Media cap: 50 MB.
    pickFile(sizedFile("big.jpg", "image/jpeg", 50 * 1024 * 1024 + 1));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "File too large. Maximum size is 50MB.",
    );
    expect(upload).not.toHaveBeenCalled();

    // Document cap: 100 MB.
    pickFile(sizedFile("big.pdf", "application/pdf", 100 * 1024 * 1024 + 1));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "File too large. Maximum size is 100MB.",
    );
    expect(upload).not.toHaveBeenCalled();
  });

  it("M33: unsupported types are rejected with the v1 wording", async () => {
    const client = await seedClient();
    render(
      <AssetUploadModal
        isOpen
        client={client}
        assetClassId={SYSTEM_CLASS_UUIDS.asset}
        onUploaded={() => {}}
        onClose={() => {}}
      />,
    );
    pickFile(new File(["plain"], "notes.txt", { type: "text/plain" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unsupported file type.");
  });
});
