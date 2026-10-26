import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { render, screen } from "@testing-library/react";
import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_CLASS_UUIDS } from "@notees/domain";
import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { PageView } from "../src/ui/PageView.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;
beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];
afterEach(() => {
  try {
    while (clients.length > 0) clients.pop()!.close();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log("CLOSE FAILED:", err instanceof Error ? err.stack : err);
    throw err;
  }
});

describe("page with invalid query block", () => {
  it("renders a page with an invalid query block", async () => {
    try {
      const client = await WorkspaceClient.create({
        transport: new MemoryTransport(new MemoryRelay()),
        actorId: ACTOR,
        sqlJs: sqlModule,
      });
      clients.push(client);
      await client.bootstrapWorkspace(WS);
      const host = await client.createObject({ isEmbedded: false, name: "Host" });
      await client.createObject({
        parentId: host,
        // The block is marked by the query system class; the token carries a malformed AST.
        classIds: [SYSTEM_CLASS_UUIDS.query],
        contentAst: [
          {
            type: "query",
            queryAst: { version: 2, scope: { type: "entire_workspace" }, root: { type: "group", logic: "and", children: [] } },
          },
        ],
      });
      render(<PageView client={client} pageId={host} />);
      expect(await screen.findByText("invalid query")).not.toBeNull();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log("CAUGHT:", err instanceof Error ? err.stack : err);
      throw err;
    }
  });
});
