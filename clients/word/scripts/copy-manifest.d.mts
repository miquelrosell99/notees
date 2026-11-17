/** Type surface for scripts/copy-manifest.mjs (plain JS, imported by vitest). */
export declare const WORD_SERVE_DEFAULT_PORT: string;
export declare function manifestFlavor(
  argv?: string[],
  env?: NodeJS.ProcessEnv,
): { host: string; basePath: string };
export declare function renderManifest(
  template: string,
  flavor: { host: string; basePath: string },
): string;
