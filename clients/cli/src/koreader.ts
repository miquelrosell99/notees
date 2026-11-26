/**
 * KOReader docsettings sync — the parser and the item model for
 * `notees import koreader <dir>` (the koreader connector's executable half;
 * the plugin manifest for the parked runtime declares the importer).
 *
 * Input: a directory (scanned recursively) of KOReader `.metadata.lua`
 * docsetting sidecars — `koreader/docsettings/*.lua` synced off the device,
 * or a book's `.sdr` folder. Each sidecar is a Lua `return { … }` table
 * carrying the reading state (`status`, `percent_finished`, `last_read`)
 * and the `annotations` (highlights: text, note, chapter, page/pageno,
 * datetime). KOReader has no JSON for this data, so a tolerant Lua-table
 * subset parser lives here (strings with escapes + long brackets, numbers,
 * booleans, nested tables, identifier keys — enough for every docsettings
 * shape shipped to date; anything else fails loud per file, never guessed).
 *
 * Idempotency is the contract (the notees-import ruling): a re-run over the
 * same folder plans and writes nothing new — books match by normalized
 * title, highlights by the quote text + the `KOReader ·` marker convention.
 */

export interface KoreaderAnnotation {
  text: string;
  note: string | null;
  chapter: string | null;
  page: number | null;
  datetime: string | null;
}

export type KoreaderStatus = "reading" | "finished" | "abandoned" | "complete" | "unknown";

export interface KoreaderBook {
  /** Sidecar file name (the identity for reports). */
  file: string;
  /** Book title from doc_props.title, else the document file name. */
  title: string;
  author: string | null;
  status: KoreaderStatus;
  /** 0..1; -1 when absent. */
  percentFinished: number;
  /** Unix seconds; null when absent. */
  lastRead: number | null;
  annotations: KoreaderAnnotation[];
}

export interface KoreaderParseResult {
  books: KoreaderBook[];
  skipped: Array<{ file: string; error: string }>;
}

// --- the Lua subset parser -----------------------------------------------------

class LuaTableParser {
  private i = 0;
  constructor(private readonly src: string) {}

  private skipWs(): void {
    for (;;) {
      while (this.i < this.src.length && /\s/.test(this.src[this.i]!)) this.i += 1;
      if (this.src.startsWith("--", this.i)) {
        while (this.i < this.src.length && this.src[this.i] !== "\n") this.i += 1;
        continue;
      }
      return;
    }
  }

  private peek(): string {
    this.skipWs();
    return this.src[this.i] ?? "";
  }

  private expect(what: string): void {
    this.skipWs();
    if (!this.src.startsWith(what, this.i)) {
      throw new Error(`expected ${JSON.stringify(what)} at offset ${this.i}`);
    }
    this.i += what.length;
  }

  private parseString(): string {
    this.skipWs();
    if (this.src.startsWith("[[", this.i)) {
      const end = this.src.indexOf("]]", this.i + 2);
      if (end === -1) throw new Error("unterminated long-bracket string");
      const body = this.src.slice(this.i + 2, end);
      this.i = end + 2;
      return body.startsWith("\n") ? body.slice(1) : body;
    }
    if (this.src[this.i] !== '"' && this.src[this.i] !== "'") {
      throw new Error(`expected string at offset ${this.i}`);
    }
    const quote = this.src[this.i]!;
    this.i += 1;
    let out = "";
    while (this.i < this.src.length) {
      const ch = this.src[this.i]!;
      if (ch === quote) {
        this.i += 1;
        return out;
      }
      if (ch === "\\") {
        const next = this.src[this.i + 1] ?? "";
        const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", '"': '"', "'": "'" };
        out += escapes[next] ?? next;
        this.i += 2;
        continue;
      }
      out += ch;
      this.i += 1;
    }
    throw new Error("unterminated string");
  }

  private parseKey(): string | number | null {
    this.skipWs();
    if (this.src[this.i] === "[") {
      this.i += 1;
      this.skipWs();
      const key = this.src[this.i] === '"' || this.src[this.i] === "'" ? this.parseString() : this.parseValue();
      this.skipWs();
      this.expect("]");
      this.expect("=");
      return typeof key === "string" || typeof key === "number" ? key : null;
    }
    if (/[A-Za-z_]/.test(this.src[this.i] ?? "")) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.i))!;
      this.i += match[0].length;
      this.skipWs();
      this.expect("=");
      return match[0];
    }
    return null; // array-style entry — value only
  }

  private parseValue(): unknown {
    this.skipWs();
    const ch = this.src[this.i] ?? "";
    if (ch === '"' || ch === "'" || this.src.startsWith("[[", this.i)) return this.parseString();
    if (ch === "{") {
      this.i += 1;
      const out: Record<string, unknown> = {};
      for (;;) {
        this.skipWs();
        if (this.src[this.i] === "}") {
          this.i += 1;
          return out;
        }
        const key = this.parseKey();
        const value = this.parseValue();
        if (key !== null) out[String(key)] = value;
        this.skipWs();
        if (this.src[this.i] === "," || this.src[this.i] === ";") this.i += 1;
      }
    }
    if (this.src.startsWith("true", this.i)) {
      this.i += 4;
      return true;
    }
    if (this.src.startsWith("false", this.i)) {
      this.i += 5;
      return false;
    }
    if (this.src.startsWith("nil", this.i)) {
      this.i += 3;
      return null;
    }
    const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.src.slice(this.i));
    if (match !== null) {
      this.i += match[0].length;
      return Number(match[0]);
    }
    throw new Error(`unexpected token at offset ${this.i}`);
  }

  parse(): unknown {
    this.skipWs();
    if (this.src.startsWith("return", this.i)) this.i += "return".length;
    const value = this.parseValue();
    return value;
  }
}

/** Parse one docsettings sidecar into a KoreaderBook (throws on bad Lua). */
export function parseKoreaderSidecar(file: string, text: string): KoreaderBook {
  const raw = new LuaTableParser(text).parse() as Record<string, unknown>;
  const docProps = (raw["doc_props"] ?? {}) as Record<string, unknown>;
  const docPath = typeof raw["doc_path"] === "string" ? raw["doc_path"] : file;
  const base = docPath.split("/").pop() ?? file;
  const title =
    (typeof docProps["title"] === "string" && docProps["title"].length > 0
      ? docProps["title"]
      : base.replace(/\.(metadata\.lua|[a-z0-9]+)$/i, "")) || base;
  const author = typeof docProps["authors"] === "string" && docProps["authors"].length > 0
    ? docProps["authors"]
    : null;
  const statusRaw = typeof raw["status"] === "string" ? raw["status"] : "unknown";
  const status: KoreaderStatus =
    statusRaw === "reading" || statusRaw === "finished" || statusRaw === "abandoned" || statusRaw === "complete"
      ? statusRaw
      : "unknown";
  const percent = typeof raw["percent_finished"] === "number" ? (raw["percent_finished"] as number) : -1;
  const lastRead = typeof raw["last_read"] === "number" ? (raw["last_read"] as number) : null;
  const annotations: KoreaderAnnotation[] = [];
  const rawAnnotations = raw["annotations"];
  if (Array.isArray(rawAnnotations) || (typeof rawAnnotations === "object" && rawAnnotations !== null)) {
    for (const entry of Object.values(rawAnnotations as Record<string, unknown>)) {
      const a = entry as Record<string, unknown>;
      const textField = typeof a["text"] === "string" ? a["text"] : "";
      if (textField.trim() === "") continue;
      annotations.push({
        text: textField,
        note: typeof a["note"] === "string" && a["note"].trim() !== "" ? a["note"] : null,
        chapter: typeof a["chapter"] === "string" && a["chapter"].trim() !== "" ? a["chapter"] : null,
        page: typeof a["pageno"] === "number" ? (a["pageno"] as number) : null,
        datetime: typeof a["datetime"] === "string" ? a["datetime"] : null,
      });
    }
  }
  return { file, title, author, status, percentFinished: percent, lastRead, annotations };
}
