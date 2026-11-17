// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "@webext-core/fake-browser";

vi.mock("../../src/background/probe", () => ({
  probeServer: vi.fn(),
}));

import { probeServer } from "../../src/background/probe";

async function typeAndSave() {
  (document.getElementById("server-url") as HTMLInputElement).value = "https://host.example/";
  (document.getElementById("api-key") as HTMLInputElement).value = "nk_test";
  document.getElementById("feat-readlater")!.click(); // uncheck
  document.getElementById("settings-form")!.dispatchEvent(
    new Event("submit", { cancelable: true }),
  );
  await vi.waitFor(() => {
    expect(document.getElementById("status")!.textContent).toBe("Saved.");
  });
}

describe("options page", () => {
  beforeEach(async () => {
    document.body.innerHTML = `
      <form id="settings-form">
        <input id="server-url" type="url" /><input id="api-key" type="password" />
        <input id="feat-bibliography" type="checkbox" checked />
        <input id="feat-readlater" type="checkbox" checked />
        <button id="test" type="button"></button><p id="status"></p>
      </form>`;
    delete (window as { __noteesOptionsInit?: boolean }).__noteesOptionsInit;
    vi.spyOn(fakeBrowser.permissions, "request").mockResolvedValue(true as never);
    const mod = await import("../../src/options/options");
    await (mod as unknown as { init?: () => Promise<void> }).init?.();
  });

  it("normalizes the URL, saves settings, and requests exactly the configured origin", async () => {
    await typeAndSave();
    const stored = await fakeBrowser.storage.local.get("settings");
    expect(stored.settings).toMatchObject({
      serverUrl: "https://host.example",
      apiKey: "nk_test",
      features: { bibliography: true, readLater: false },
    });
    expect(fakeBrowser.permissions.request).toHaveBeenCalledWith({
      origins: ["https://host.example/*"],
    });
  });

  it("rejects a misconfigured URL with a visible error and does not save", async () => {
    (document.getElementById("server-url") as HTMLInputElement).value = "not-a-url";
    document.getElementById("settings-form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => {
      expect(document.getElementById("status")!.className).toBe("err");
    });
    expect(await fakeBrowser.storage.local.get("settings")).toEqual({});
    expect(fakeBrowser.permissions.request).not.toHaveBeenCalled();
  });

  it("populates the form from stored settings on open", async () => {
    await fakeBrowser.storage.local.set({
      settings: {
        serverUrl: "https://stored.example",
        apiKey: "nk_stored",
        features: { bibliography: false, readLater: true },
      },
    });
    delete (window as { __noteesOptionsInit?: boolean }).__noteesOptionsInit;
    const mod = await import("../../src/options/options");
    await (mod as unknown as { init?: () => Promise<void> }).init?.();
    expect((document.getElementById("server-url") as HTMLInputElement).value).toBe("https://stored.example");
    expect((document.getElementById("api-key") as HTMLInputElement).value).toBe("nk_stored");
    expect((document.getElementById("feat-bibliography") as HTMLInputElement).checked).toBe(false);
    expect((document.getElementById("feat-readlater") as HTMLInputElement).checked).toBe(true);
  });

  it("test-connection button reports probe failure", async () => {
    (document.getElementById("server-url") as HTMLInputElement).value = "https://host.example";
    (document.getElementById("api-key") as HTMLInputElement).value = "nk_bad";
    vi.mocked(probeServer).mockResolvedValue({ ok: false, error: "unauthorized" });
    document.getElementById("test")!.dispatchEvent(new Event("click"));
    await vi.waitFor(() => {
      expect(document.getElementById("status")!.textContent).toContain("rejected the API key");
    });
  });

  it("test-connection button reports a non-Notees server distinctly", async () => {
    (document.getElementById("server-url") as HTMLInputElement).value = "https://host.example";
    (document.getElementById("api-key") as HTMLInputElement).value = "nk_ok";
    vi.mocked(probeServer).mockResolvedValue({ ok: false, error: "not-notees" });
    document.getElementById("test")!.dispatchEvent(new Event("click"));
    await vi.waitFor(() => {
      expect(document.getElementById("status")!.textContent).toContain("not a Notees sync server");
    });
    expect(document.getElementById("status")!.className).toBe("err");
  });
});
