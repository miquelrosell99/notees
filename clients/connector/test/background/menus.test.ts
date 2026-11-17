import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "@webext-core/fake-browser";
import { buildMenus, MENU_READLATER_ID, MENU_SOURCE_ID } from "../../src/background/menus";

beforeEach(() => {
  vi.restoreAllMocks();
  fakeBrowser.reset();
});

describe("buildMenus", () => {
  it("creates both entries when both toggles are on", async () => {
    const removeAll = vi.spyOn(fakeBrowser.contextMenus, "removeAll").mockResolvedValue(undefined as never);
    const create = vi.spyOn(fakeBrowser.contextMenus, "create").mockReturnValue(1 as never);
    buildMenus({ bibliography: true, readLater: true });
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(removeAll).toHaveBeenCalledTimes(1);
    const ids = create.mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(ids).toEqual([MENU_SOURCE_ID, MENU_READLATER_ID]);
    expect(create.mock.calls[0][0]).toMatchObject({ title: "Save to bibliography", contexts: ["page", "link"], enabled: true });
    expect(create.mock.calls[1][0]).toMatchObject({ title: "Read later", contexts: ["page", "link"], enabled: true });
  });
  it("keeps both entries but disables the bibliography one when its toggle is off", async () => {
    vi.spyOn(fakeBrowser.contextMenus, "removeAll").mockResolvedValue(undefined as never);
    const create = vi.spyOn(fakeBrowser.contextMenus, "create").mockReturnValue(1 as never);
    buildMenus({ bibliography: false, readLater: true });
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[0][0]).toMatchObject({ id: MENU_SOURCE_ID, enabled: false });
    expect(create.mock.calls[1][0]).toMatchObject({ id: MENU_READLATER_ID, enabled: true });
  });
  it("disables the read-later entry when its toggle is off", async () => {
    vi.spyOn(fakeBrowser.contextMenus, "removeAll").mockResolvedValue(undefined as never);
    const create = vi.spyOn(fakeBrowser.contextMenus, "create").mockReturnValue(1 as never);
    buildMenus({ bibliography: true, readLater: false });
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[0][0]).toMatchObject({ id: MENU_SOURCE_ID, enabled: true });
    expect(create.mock.calls[1][0]).toMatchObject({ id: MENU_READLATER_ID, enabled: false });
  });
  it("rebuild drops entries created by a previous build", async () => {
    vi.spyOn(fakeBrowser.contextMenus, "removeAll").mockResolvedValue(undefined as never);
    const create = vi.spyOn(fakeBrowser.contextMenus, "create").mockReturnValue(1 as never);
    buildMenus({ bibliography: true, readLater: true });
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    buildMenus({ bibliography: false, readLater: false });
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(4));
  });
});
