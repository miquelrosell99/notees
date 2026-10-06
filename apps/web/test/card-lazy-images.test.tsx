/**
 * Card imagery lazy loading + the click-to-zoom lightbox.
 *
 * The Pokemon-class freeze: 100 windowed cards each fired a full-bytes
 * fetch + base64 + decode on mount. Now the list renders instantly with
 * placeholders (useLazyInView) and the fetch starts only when the card
 * nears the viewport. These tests drive a MOCK IntersectionObserver (jsdom
 * has none — without the mock the hook honestly falls back to eager):
 *   - before the observer fires, NO asset-bytes fetch happens;
 *   - after it fires, the img renders and the fetch ran exactly once;
 *   - clicking the loaded cover opens the ImageModal lightbox (the
 *     AssetImage pattern), with the download + fullscreen + close buttons.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { NodeCollection } from "../src/ui/views/index.js";

const WS = "0192a000-0000-7000-8000-0000000000e1";
const ACTOR = "0192a000-0000-7000-8000-0000000000e2";

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

/** A mock IntersectionObserver that records observations and never fires
 *  until a test triggers it (the below-the-fold state). */
class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  readonly observed: Element[] = [];
  constructor(
    private readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    MockIntersectionObserver.instances.push(this);
  }
  observe(element: Element): void {
    this.observed.push(element);
  }
  unobserve(): void {}
  disconnect(): void {}
  trigger(): void {
    this.callback(
      this.observed.map((target) => ({ isIntersecting: true, target }) as IntersectionObserverEntry),
      this as unknown as IntersectionObserver,
    );
  }
}

describe("card cover lazy loading", () => {
  it("renders placeholders without fetching; the viewport gate starts the fetch once", async () => {
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    MockIntersectionObserver.instances = [];

    const client = await seedClient();
    const assets: string[] = [];
    for (const name of ["a.png", "b.png"]) {
      const id = await client.createObject({ presentAsMain: true, name });
      await client.assignClass(id, SYSTEM_CLASS_UUIDS.asset);
      assets.push(id);
    }
    const fetchUrl = vi
      .spyOn(client, "getAssetDataUrl")
      .mockResolvedValue("data:image/png;base64,LAZY");
    const { container } = render(
      <NodeCollection
        viewMode="cards"
        client={client}
        items={assets.map((id) => ({ node: client.getNode(id)! }))}
      />,
    );
    await act(async () => {});

    // Both cards show the pending placeholder; nothing fetched yet.
    expect(container.querySelectorAll(".node-card__cover--pending").length).toBe(2);
    expect(container.querySelector("img")).toBeNull();
    expect(fetchUrl).not.toHaveBeenCalled();
    expect(MockIntersectionObserver.instances.length).toBeGreaterThan(0);

    // The viewport reaches them: observers fire, the images load.
    for (const instance of MockIntersectionObserver.instances) instance.trigger();
    await act(async () => {});
    await screen.findAllByAltText("");
    expect(fetchUrl).toHaveBeenCalledTimes(2);
    expect(container.querySelectorAll(".node-card__cover--pending").length).toBe(0);
  });

  it("the loaded cover clicks open the lightbox (download + fullscreen + close)", async () => {
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    MockIntersectionObserver.instances = [];
    Object.defineProperty(document, "fullscreenEnabled", {
      value: true,
      configurable: true,
    });

    const client = await seedClient();
    const asset = await client.createObject({ presentAsMain: true, name: "art.png" });
    await client.assignClass(asset, SYSTEM_CLASS_UUIDS.asset);
    vi.spyOn(client, "getAssetDataUrl").mockResolvedValue("data:image/png;base64,ZOOM");
    const { container } = render(
      <NodeCollection
        viewMode="cards"
        client={client}
        items={[{ node: client.getNode(asset)! }]}
      />,
    );
    for (const instance of MockIntersectionObserver.instances) instance.trigger();
    await act(async () => {});
    await screen.findByAltText("");

    fireEvent.click(container.querySelector(".node-card__cover--button")!);
    expect(screen.getByRole("button", { name: "Download image" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Toggle fullscreen" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Close (Esc)" })).not.toBeNull();
    expect(document.body.querySelector(".image-modal-image")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close (Esc)" }));
    expect(document.body.querySelector(".image-modal-image")).toBeNull();
  });

  it("without IntersectionObserver (the jsdom default) the eager fallback loads immediately", async () => {
    const client = await seedClient();
    const asset = await client.createObject({ presentAsMain: true, name: "eager.png" });
    await client.assignClass(asset, SYSTEM_CLASS_UUIDS.asset);
    vi.spyOn(client, "getAssetDataUrl").mockResolvedValue("data:image/png;base64,EAGER");
    render(
      <NodeCollection
        viewMode="cards"
        client={client}
        items={[{ node: client.getNode(asset)! }]}
      />,
    );
    await screen.findByAltText("");
    expect(client.getAssetDataUrl).toHaveBeenCalledTimes(1);
  });
});
