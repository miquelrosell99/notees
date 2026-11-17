import { describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "@webext-core/fake-browser";
import { notifyFailure } from "../../src/background/notify";

describe("notifyFailure", () => {
  it("409 e2ee_required → 'open Notees' guidance", async () => {
    const spy = vi.spyOn(fakeBrowser.notifications, "create").mockResolvedValue("n1" as never);
    await notifyFailure({ code: "e2ee_required", message: "E2EE workspace" });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "basic", title: "Open Notees to capture" }),
    );
    expect(spy.mock.calls[0][0].message).toContain("Open your Notees tab");
  });
  it("network_error → server-unreachable guidance", async () => {
    const spy = vi.spyOn(fakeBrowser.notifications, "create").mockResolvedValue("n2" as never);
    await notifyFailure({ code: "network_error", message: "Could not reach the Notees server" });
    expect(spy.mock.calls[0][0].title).toBe("Notees server unreachable");
  });
  it("not_authenticated → sign-in guidance", async () => {
    const spy = vi.spyOn(fakeBrowser.notifications, "create").mockResolvedValue("n3" as never);
    await notifyFailure({ code: "not_authenticated", message: "no session" });
    expect(spy.mock.calls[0][0].title).toBe("Notees is not signed in");
  });
  it("feature_disabled → workspace-settings guidance", async () => {
    const spy = vi.spyOn(fakeBrowser.notifications, "create").mockResolvedValue("n4" as never);
    await notifyFailure({ code: "feature_disabled", message: "read-it-later is off" });
    expect(spy.mock.calls[0][0].title).toBe("Feature not enabled");
    expect(spy.mock.calls[0][0].message).toContain("workspace settings");
  });
  it("http_error → server-error title, honest generic body", async () => {
    const spy = vi.spyOn(fakeBrowser.notifications, "create").mockResolvedValue("n5" as never);
    await notifyFailure({ code: "http_error", message: "Server answered 500" });
    expect(spy.mock.calls[0][0].title).toBe("Notees server error");
    expect(spy.mock.calls[0][0].message).toContain("unexpected error");
  });
  it("failed → generic capture-failure copy", async () => {
    const spy = vi.spyOn(fakeBrowser.notifications, "create").mockResolvedValue("n6" as never);
    await notifyFailure({ code: "failed", message: "tab did not answer" });
    expect(spy.mock.calls[0][0].title).toBe("Notees capture failed");
    expect(spy.mock.calls[0][0].message).toContain("capturing this page");
  });
});
