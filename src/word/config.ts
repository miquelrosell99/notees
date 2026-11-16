import { CliError, EXIT } from "../exit-codes.js";

export interface WordServeConfig {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly restart: boolean;
}

/**
 * Flag/env resolution for `notees word serve`. Like the citation bridge,
 * the loopback bind is the command's reason to exist — `host` is a
 * constant, not an option. Port precedence: --port > NOTEES_WORD_PORT >
 * 8471 (the fixed default the vendored manifest template is built for).
 */
export function resolveWordServeConfig(
  options: { port?: string; restart?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): WordServeConfig {
  const portText = options.port ?? env.NOTEES_WORD_PORT ?? "8471";
  const port = strictInteger(portText);
  if (port === undefined || port < 0 || port > 65535) {
    throw new CliError(EXIT.usage, `--port must be an integer between 0 and 65535 (got "${portText}")`);
  }
  return { host: "127.0.0.1", port, restart: options.restart === true };
}

/**
 * Whole-string integer parse: Number.parseInt alone would accept "1.5" as 1,
 * silently rounding flag values the caller meant to be rejected.
 */
function strictInteger(text: string): number | undefined {
  if (!/^-?\d+$/.test(text.trim())) return undefined;
  return Number.parseInt(text, 10);
}
