import { expect, test } from "bun:test";
import { MemoryRelay } from "../src/relay";
import type { EncryptedEnvelope } from "../src/crypto";

test("relay broadcasts and catches up envelopes per workspace", () => {
  const relay = new MemoryRelay();
  const seen: EncryptedEnvelope[] = [];
  relay.subscribe("ws-1", (env) => seen.push(env));

  const env: EncryptedEnvelope = {
    ciphertext: "abc",
    iv: "iv",
    actorId: "actor-1",
    affectedNodeIds: ["n1"],
    opType: "node.create",
    hlc: { physical: 1000, logical: 0 },
  };
  relay.send("ws-1", env);
  relay.send("ws-2", env);

  expect(seen.length).toBe(1);
  const caught = relay.catchUp("ws-1", { physical: 0, logical: 0 });
  expect(caught.length).toBe(1);
});
