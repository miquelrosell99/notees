/**
 * Typed errors for the derived-state store. Appliers fail loud: constraint
 * violations, move-guard breaches, extends cycles and unsupported wire
 * carriers surface as dedicated error types instead of silent drops.
 */

export class StoreError extends Error {
  constructor(
    message: string,
    readonly opType?: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Envelope or payload failed protocol validation before application. */
export class EnvelopeValidationError extends StoreError {}

/** A node_type CHECK constraint rejected a write (bullet-proof schema). */
export class CheckConstraintError extends StoreError {
  constructor(
    message: string,
    readonly constraint?: string,
    opType?: string,
  ) {
    super(message, opType);
  }
}

/** Cross-row tree guard: a class node can never be a parent (SCHEMA.md). */
export class MoveGuardError extends StoreError {}

/** class.setExtends would introduce a cycle in the extends chain. */
export class CycleError extends StoreError {}

/**
 * object.update arrived with the canonical CRDT wire carrier
 * (contentDeltaB64) but no readable contentAst mirror. The Yjs port is M1+
 * store/sync work; until it lands this carrier cannot be interpreted, so the
 * applier fails loud rather than dropping a write silently.
 */
export class UnsupportedCarrierError extends StoreError {}

/** Referenced row (node/parent) does not exist in the derived state. */
export class NotFoundError extends StoreError {}

export function isSqliteError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string" &&
    ((error as { code: string }).code.startsWith("ERR_SQLITE") ||
      (error as { code: string }).code.startsWith("SQLITE_"))
  );
}

/** Convert a raw driver error (better-sqlite3 or tagged sql.js) into a typed store error. */
export function translateSqliteError(error: unknown, opType: string): StoreError {
  const message = error instanceof Error ? error.message : String(error);
  const match = /CHECK constraint failed: (.+)$/.exec(message);
  if (match) {
    return new CheckConstraintError(
      `${opType}: CHECK constraint failed: ${match[1]}`,
      match[1],
      opType,
    );
  }
  return new StoreError(`${opType}: ${message}`, opType);
}
