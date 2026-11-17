import { describe, expect, it } from "vitest";
import { SOURCE } from "../../src/shared/source";
import { pageRequestFromRelay, pageResponseToRelay } from "../../src/shared/messages";

describe("relay message mapping", () => {
  it("builds the normative page request verbatim", () => {
    const req = pageRequestFromRelay({
      source: SOURCE,
      type: "relay-to-page",
      requestId: "r1",
      payload: { url: "https://example.com/a", title: "A", mode: "source" },
    });
    expect(req).toEqual({
      source: "notees-connector",
      type: "notees-capture-request",
      requestId: "r1",
      payload: { url: "https://example.com/a", title: "A", mode: "source" },
    });
  });
  it("maps ok page responses", () => {
    expect(
      pageResponseToRelay({
        source: SOURCE,
        type: "notees-capture-response",
        requestId: "r2",
        ok: true,
        objectId: "obj-9",
      }),
    ).toEqual({ source: "notees-connector", type: "relay-from-page", requestId: "r2", ok: true, objectId: "obj-9" });
  });
  it("maps error page responses with the normative error subset", () => {
    const out = pageResponseToRelay({
      source: SOURCE,
      type: "notees-capture-response",
      requestId: "r3",
      ok: false,
      error: { code: "not_authenticated", message: "no session" },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("not_authenticated");
  });
});
