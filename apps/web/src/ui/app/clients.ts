/**
 * clients — the client-type union shared by the shell modules.
 *
 * `AnyClient` is whichever store client the connection produced: the
 * OPFS-persisted WorkerClient (background store) or the in-process
 * WorkspaceClient (sql.js on the UI thread).
 */

import type { WorkspaceClient } from "@/core/workspace-client/index.js";
import type { WorkerClient } from "@/core/worker-client.js";

export type AnyClient = WorkspaceClient | WorkerClient;
