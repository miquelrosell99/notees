import { vi, beforeEach } from "vitest";

vi.mock("webextension-polyfill", async () => {
  const { fakeBrowser } = await import("@webext-core/fake-browser");
  return { default: fakeBrowser };
});

beforeEach(async () => {
  const { fakeBrowser } = await import("@webext-core/fake-browser");
  fakeBrowser.reset();
});
