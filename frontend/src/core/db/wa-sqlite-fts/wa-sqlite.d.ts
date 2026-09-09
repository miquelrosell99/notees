/**
 * Types for the vendored Emscripten glue (wa-sqlite sync build, FTS-enabled).
 * The factory returns the raw Emscripten module; the adapter casts it to its
 * own WaSqliteModule interface, so `unknown` is sufficient here.
 */
declare const SQLiteESMFactory: (config?: {
  wasmBinary?: ArrayBuffer | Uint8Array;
  locateFile?: (path: string, scriptDirectory: string) => string;
}) => Promise<unknown>;
export default SQLiteESMFactory;
