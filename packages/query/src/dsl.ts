/**
 * The Notees text query DSL — a compact, safe, injection-free language that
 * compiles to the versioned QueryAST (port of v1
 * `app/domain/services/query_language.py` concepts, adapted to the v2 AST and
 * extended where v1 fell short: ISO-8601 dates, DOIs/URLs and other values
 * containing `:` or `/` read cleanly, and property comparison operators).
 *
 * Grammar (fail loud — every syntax/resolution error is a QueryLanguageError
 * with a useful message):
 *
 *   query        := or
 *   or           := and (OR and)*
 *   and          := not ((AND)? not)*        -- juxtaposition = implicit AND
 *   not          := NOT primary | primary
 *   primary      := "(" or ")" | STRING | term
 *   term         := bareWord                 -- content contains (substring)
 *                 | field (op value)?        -- see fields below
 *
 *   Fields (word followed by an operator):
 *     class:Name        class membership (resolved by NAME, hierarchy-aware
 *                       at compile time);      "!=" negates
 *     isClass:true|false     class identity bit (Revision 11); "!=" negates
 *     presentAsMain:true|false render bit for parented nodes; "!=" negates
 *     text:term         content contains (value required)
 *     linked:Name       backlinksWithRollup to the named node; "!=" negates
 *     prop:name<op>val  property condition on the schema called `name`;
 *                       no value → exists
 *     <schema>:<op>val  shorthand: a bare field that resolves to a property
 *                       schema name is a property condition (year:>2010)
 *
 *   Operators: ":" (contains; bare ":" with no value → exists), ":=" / "="
 *   (eq), "!=" (neq), ":>" / ">" (gt), ":>=" / ">=" (gte), ":<" / "<" (lt),
 *   ":<=" / "<=" (lte).
 *
 *   Values: numbers coerce to JSON numbers (numeric comparison), "quoted
 *   strings" (phrase contains), or a bare run of non-space/non-paren text
 *   (ISO dates, DOIs, URLs, citekeys — lexicographic comparison).
 *
 * Name resolution is injected by the caller (`resolvers`) because ids are
 * workspace state the parser must not fetch: classes and property schemas
 * resolve by name, nodes by display name (for `linked:`). Unknown fields and
 * unresolvable names are hard errors, never silent text search.
 *
 * The parser emits only the supported AST — property conditions (all eight
 * ops), class, isClass, presentAsMain, content contains, linkedTo — no new
 * condition kinds.
 */

import type { Child, Condition, Group, QueryAst, Scope } from "./ast.js";

/** Raised when a query string cannot be tokenized, parsed or resolved. */
export class QueryLanguageError extends Error {
  /** Source position of the offending token, when known. */
  readonly position: number | undefined;

  constructor(message: string, position?: number) {
    super(message);
    this.name = "QueryLanguageError";
    this.position = position;
  }
}

/** Name → id lookups the caller injects (all optional; missing → error). */
export interface QueryLanguageResolvers {
  /** Class name → class id (matching policy — e.g. case-insensitive — is the resolver's job). */
  resolveClass?(name: string): string | undefined;
  /** Property schema name → schema id. */
  resolvePropertySchema?(name: string): string | undefined;
  /** Node display name → node id (`linked:`). */
  resolveNode?(name: string): string | undefined;
}

export interface ParseQueryLanguageOptions {
  /** Scope of the emitted AST; defaults to the entire workspace. */
  scope?: Scope | undefined;
  resolvers?: QueryLanguageResolvers | undefined;
  /** Extra known field names for the unknown-field error (e.g. property schema names). */
  knownFields?: string[] | undefined;
}

/** Reserved field names; a bare word matching none of these must resolve as a property schema. */
const RESERVED_FIELDS = ["class", "isclass", "presentasmain", "prop", "text", "linked"] as const;

// --- tokenizer ---------------------------------------------------------------

type Op = ":" | "=" | "!=" | ">=" | "<=" | ">" | "<" | ":=" | ":>" | ":>=" | ":<" | ":<=";

/** Longest-first operator table (the scanner matches a prefix against it). */
const OPERATORS: readonly Op[] = [":>=", ":<=", ":=", ":>", ":<", "!=", ">=", "<=", ":", "=", ">", "<"];

type Token =
  | { kind: "raw"; text: string; start: number }
  | { kind: "string"; text: string; start: number }
  | { kind: "op"; op: Op; start: number }
  | { kind: "lparen"; start: number }
  | { kind: "rparen"; start: number }
  | { kind: "and"; start: number }
  | { kind: "or"; start: number }
  | { kind: "not"; start: number }
  | { kind: "eof"; start: number };

class Scanner {
  pos = 0;

  constructor(private readonly text: string) {}

  private get length(): number {
    return this.text.length;
  }

  private isWhitespace(char: string): boolean {
    return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f" || char === "\v";
  }

  private isOpChar(char: string): boolean {
    return char === ":" || char === "=" || char === "!" || char === "<" || char === ">";
  }

  private isBoundary(char: string | undefined): boolean {
    return char === undefined || this.isWhitespace(char) || char === "(" || char === ")";
  }

  /** Scan the next token; raw tokens stop before whitespace, parens and operator chars. */
  next(): Token {
    while (this.pos < this.length && this.isWhitespace(this.text[this.pos]!)) this.pos += 1;
    const start = this.pos;
    if (this.pos >= this.length) return { kind: "eof", start };

    const char = this.text[this.pos]!;
    if (char === "(") {
      this.pos += 1;
      return { kind: "lparen", start };
    }
    if (char === ")") {
      this.pos += 1;
      return { kind: "rparen", start };
    }
    if (char === '"' || char === "'") {
      return this.readString(char, start);
    }
    if (this.isOpChar(char)) {
      for (const op of OPERATORS) {
        if (this.text.startsWith(op, this.pos)) {
          this.pos += op.length;
          return { kind: "op", op, start };
        }
      }
      throw new QueryLanguageError(`unexpected character '${char}' at position ${start}`, start);
    }
    let end = this.pos;
    while (end < this.length && !this.isBoundary(this.text[end]) && !this.isOpChar(this.text[end]!)) {
      end += 1;
    }
    if (end === this.pos) {
      throw new QueryLanguageError(`unexpected character '${char}' at position ${start}`, start);
    }
    this.pos = end;
    const text = this.text.slice(start, end);
    const upper = text.toUpperCase();
    if (upper === "AND") return { kind: "and", start };
    if (upper === "OR") return { kind: "or", start };
    if (upper === "NOT") return { kind: "not", start };
    return { kind: "raw", text, start };
  }

  private readString(quote: string, start: number): Token {
    this.pos += 1; // opening quote
    let value = "";
    while (this.pos < this.length) {
      const char = this.text[this.pos]!;
      if (char === quote) {
        this.pos += 1;
        return { kind: "string", text: value, start };
      }
      if (char === "\\" && this.pos + 1 < this.length) {
        value += this.text[this.pos + 1];
        this.pos += 2;
        continue;
      }
      value += char;
      this.pos += 1;
    }
    throw new QueryLanguageError("unterminated string literal", start);
  }
}

// --- value coercion ------------------------------------------------------------

const NUMBER_PATTERN = /^[+-]?\d+(\.\d+)?$/;

function isWhitespaceChar(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f" || char === "\v";
}

function isOpChar(char: string): boolean {
  return char === ":" || char === "=" || char === "!" || char === "<" || char === ">";
}

function coerceValue(raw: string): string | number {
  if (NUMBER_PATTERN.test(raw)) return Number(raw);
  return raw;
}

// --- parser --------------------------------------------------------------------

class Parser {
  private lookahead: Token;

  constructor(
    private readonly text: string,
    private readonly scanner: Scanner,
    private readonly options: ParseQueryLanguageOptions,
  ) {
    this.lookahead = this.scanner.next();
  }

  private advance(): Token {
    const token = this.lookahead;
    this.lookahead = this.scanner.next();
    return token;
  }

  /** Advance past an operator token the caller has already peeked (internal invariant). */
  private advanceOp(): Op {
    const token = this.advance();
    if (token.kind !== "op") {
      throw new QueryLanguageError("parser internal error: expected an operator token", token.start);
    }
    return token.op;
  }

  private error(message: string, position?: number): QueryLanguageError {
    return new QueryLanguageError(message, position ?? this.lookahead.start);
  }

  /** Fresh-typed lookahead read (TS keeps stale property narrowing across parser calls). */
  private peek(): Token {
    return this.lookahead;
  }

  parse(): QueryAst {
    if (this.peek().kind === "eof") {
      return { version: 1, scope: this.scope(), root: { type: "group", logic: "and", children: [] } };
    }
    const node = this.parseOr();
    const rest = this.peek();
    if (rest.kind !== "eof") {
      throw this.error(`unexpected '${this.describe(rest)}'`, rest.start);
    }
    const root: Group =
      node.type === "group" ? node : { type: "group", logic: "and", children: [node] };
    return { version: 1, scope: this.scope(), root };
  }

  private scope(): Scope {
    return this.options.scope ?? { type: "entire_workspace" };
  }

  // --- boolean layers (implicit-AND, OR-explicit, NOT prefix) ------------------

  private parseOr(): Child {
    let left = this.parseAnd();
    while (this.lookahead.kind === "or") {
      this.advance();
      const right = this.parseAnd();
      left =
        left.type === "group" && left.logic === "or"
          ? { ...left, children: [...left.children, right] }
          : { type: "group", logic: "or", children: [left, right] };
    }
    return left;
  }

  private parseAnd(): Child {
    let left = this.parseNot();
    while (this.isOperandStart(this.lookahead)) {
      if (this.lookahead.kind === "and") this.advance();
      const right = this.parseNot();
      left =
        left.type === "group" && left.logic === "and"
          ? { ...left, children: [...left.children, right] }
          : { type: "group", logic: "and", children: [left, right] };
    }
    return left;
  }

  private isOperandStart(token: Token): boolean {
    return token.kind === "and" || token.kind === "not" || token.kind === "raw" || token.kind === "string" || token.kind === "lparen";
  }

  private parseNot(): Child {
    if (this.peek().kind === "not") {
      this.advance();
      // NOT binds to one primary (the AST's Not wraps a Condition | Group).
      const child = this.parsePrimary();
      if (child.type === "not") {
        throw this.error("NOT cannot negate another NOT; write NOT (…) once");
      }
      return { type: "not", child };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Child {
    const token = this.lookahead;
    if (token.kind === "lparen") {
      this.advance();
      const inner = this.parseOr();
      if (this.lookahead.kind !== "rparen") {
        throw this.error("expected ')'", this.lookahead.start);
      }
      this.advance();
      return inner;
    }
    if (token.kind === "string") {
      this.advance();
      return contentContains(token.text);
    }
    if (token.kind === "raw") {
      if (this.isReservedKeyword(token.text)) {
        throw this.error(`'${token.text}' is a reserved word; use it between operands or quote it`, token.start);
      }
      this.advance();
      if (this.lookahead.kind === "op") {
        const op = this.advanceOp();
        return this.buildFieldCondition(token.text, op);
      }
      return contentContains(token.text);
    }
    if (token.kind === "eof") {
      throw this.error("expected a term", token.start);
    }
    throw this.error(`unexpected '${this.describe(token)}'`, token.start);
  }

  private isReservedKeyword(text: string): boolean {
    const upper = text.toUpperCase();
    return upper === "AND" || upper === "OR" || upper === "NOT";
  }

  private describe(token: Token): string {
    switch (token.kind) {
      case "raw":
        return token.text;
      case "string":
        return `"${token.text}"`;
      case "op":
        return token.op;
      case "lparen":
        return "(";
      case "rparen":
        return ")";
      case "and":
      case "or":
      case "not":
        return token.kind.toUpperCase();
      case "eof":
        return "end of query";
    }
  }

  // --- fields --------------------------------------------------------------------

  private buildFieldCondition(field: string, op: Op): Child {
    const lower = field.toLowerCase();
    switch (lower) {
      case "class":
        return this.negatable(op, () => ({
          type: "class",
          classId: this.resolveClass(String(this.readValue("a class name", "token"))),
        }));
      case "isclass":
        return this.negatable(op, () => ({ type: "isClass", isClass: this.readBoolean("isClass") }));
      case "presentasmain":
        return this.negatable(op, () => ({
          type: "presentAsMain",
          presentAsMain: this.readBoolean("presentAsMain"),
        }));
      case "text":
        this.requireContainsOp(op, "text");
        return contentContains(String(this.readValue("a text term")));
      case "linked":
        return this.negatable(op, () => ({
          type: "linkedTo",
          nodeId: this.resolveNode(String(this.readValue("a node name", "token"))),
        }));
      case "prop": {
        // `prop` is a prefix, not a condition: the schema name follows the
        // first colon, and a second operator (`prop:year:>2010`) is the real
        // property operator. With no second operator the first one applies
        // (`prop:year:1950` = contains; `prop:year` = exists).
        const schemaName = this.readSchemaName();
        const effectiveOp = this.lookahead.kind === "op" ? this.advanceOp() : op;
        return this.buildPropertyCondition(schemaName, effectiveOp);
      }
      default:
        return this.buildPropertyCondition(field, op);
    }
  }

  /** class/isClass/presentAsMain/linked support ":" and "=" (positive) and "!=" (wrapped in NOT). */
  private negatable(op: Op, build: () => Condition): Child {
    if (op === ":" || op === "=") return build();
    if (op === "!=") return { type: "not", child: build() };
    throw this.error(`operator '${op}' is not supported here (use ':', '=' or '!=')`);
  }

  private requireContainsOp(op: Op, field: string): void {
    if (op !== ":" && op !== "=") {
      throw this.error(`operator '${op}' is not supported for ${field} (use ':')`);
    }
  }

  private readBoolean(field: string): boolean {
    const raw = String(this.readValue("true or false", "token")).toLowerCase();
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw this.error(`unknown ${field} value '${raw}' (expected true or false)`);
  }

  private buildPropertyCondition(schemaName: string, op: Op): Child {
    const schemaId = this.options.resolvers?.resolvePropertySchema?.(schemaName);
    if (schemaId === undefined) {
      throw this.unknownField(schemaName);
    }
    const propertyOp = this.mapPropertyOp(op);
    if (propertyOp === "exists") {
      return { type: "property", schemaId, op: "exists" };
    }
    if (this.lookahead.kind === "eof" || this.lookahead.kind === "rparen") {
      throw this.error(`operator '${op}' requires a value`);
    }
    return { type: "property", schemaId, op: propertyOp, value: this.readValue("a property value") };
  }

  private unknownField(field: string): QueryLanguageError {
    const known = [...RESERVED_FIELDS, ...(this.options.knownFields ?? [])];
    return this.error(`unknown field '${field}' (known fields: ${known.join(", ")})`);
  }

  /** ":" with no following value means exists; the rest map onto the v1 operator family. */
  private mapPropertyOp(op: Op): "eq" | "neq" | "contains" | "exists" | "gt" | "gte" | "lt" | "lte" {
    switch (op) {
      case ":":
        // A following boolean keyword ends the condition (the value slot is
        // empty): `prop:year AND …` / `prop:year NOT …` = year exists.
        return this.lookahead.kind === "eof" ||
          this.lookahead.kind === "rparen" ||
          this.lookahead.kind === "and" ||
          this.lookahead.kind === "or" ||
          this.lookahead.kind === "not"
          ? "exists"
          : "contains";
      case "=":
      case ":=":
        return "eq";
      case "!=":
        return "neq";
      case ">":
      case ":>":
        return "gt";
      case ">=":
      case ":>=":
        return "gte";
      case "<":
      case ":<":
        return "lt";
      case "<=":
      case ":<=":
        return "lte";
    }
  }

  // --- resolution + values ----------------------------------------------------------

  private resolveClass(name: string): string {
    const id = this.options.resolvers?.resolveClass?.(name);
    if (id === undefined) throw this.error(`unknown class '${name}'`);
    return id;
  }

  private resolveNode(name: string): string {
    const id = this.options.resolvers?.resolveNode?.(name);
    if (id === undefined) throw this.error(`unknown node '${name}'`);
    return id;
  }

  /** Schema names are single tokens: `prop:year:>2010` must stop the name before the second operator. */
  private readSchemaName(): string {
    const token: Token = this.lookahead;
    if (token.kind === "eof" || token.kind === "op" || token.kind === "lparen" || token.kind === "rparen") {
      throw this.error("expected a property schema name", token.start);
    }
    return String(this.readValue("a property schema name", "token"));
  }

  /**
   * Read a field value.
   *
   * "token" mode (names: class/type/linked/schema) stops the value at operator
   * characters too, so a trailing operator surfaces as its own syntax error
   * (`class:paper>3` complains about `>`, not about a class named "paper>3").
   *
   * "slice" mode (prop values, text terms) reads the raw source up to the next
   * whitespace/paren, so URLs (`https://…`), DOIs (`10.2307/…`) and ISO dates
   * survive intact (v1's word/number lexer could not carry them). Numbers
   * coerce to JSON numbers; everything else stays a string.
   */
  private readValue(what: string, mode: "token" | "slice" = "slice"): string | number {
    const token = this.lookahead;
    if (token.kind === "eof" || token.kind === "rparen" || token.kind === "op" || token.kind === "lparen") {
      throw this.error(`expected ${what}`, token.start);
    }
    if (token.kind === "string") {
      this.advance();
      return token.text;
    }
    const stopAtOp = mode === "token";
    let end = token.start;
    while (end < this.text.length) {
      const char = this.text[end]!;
      if (isWhitespaceChar(char) || char === "(" || char === ")" || (stopAtOp && isOpChar(char))) {
        break;
      }
      end += 1;
    }
    this.scanner.pos = end;
    this.advance();
    return coerceValue(this.text.slice(token.start, end));
  }
}

function contentContains(value: string): Condition {
  return { type: "content", op: "contains", value };
}

/**
 * Parse a query-language string into a versioned QueryAST. Syntax errors,
 * unknown fields and unresolvable class/schema/node names all throw
 * {@link QueryLanguageError} with a position and a useful message.
 */
export function parseQueryLanguage(text: string, options: ParseQueryLanguageOptions = {}): QueryAst {
  return new Parser(text, new Scanner(text), options).parse();
}

/**
 * Heuristic gate for search boxes deciding whether an input should go through
 * the DSL or plain text search: a `word:` field prefix (excluding URL schemes
 * like `http://`), standalone AND/OR/NOT keywords, or a quoted phrase.
 */
export function looksLikeQueryLanguage(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (/(?:^|\s)[A-Za-z_][\w.-]*:(?!\/\/)/.test(trimmed)) return true;
  if (/(?:^|\s)(?:AND|OR|NOT)(?=\s|$)/.test(trimmed)) return true;
  if (trimmed.includes('"')) return true;
  return false;
}
