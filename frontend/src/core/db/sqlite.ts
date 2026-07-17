import { type Database, type SqlValue } from 'sql.js';

export type SqlParam = SqlValue;

export function queryOne<T>(
  db: Database,
  sql: string,
  params?: SqlParam[]
): T | undefined {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    if (stmt.step()) {
      return stmt.getAsObject() as T;
    }
    return undefined;
  } finally {
    stmt.free();
  }
}

export function queryAll<T>(
  db: Database,
  sql: string,
  params?: SqlParam[]
): T[] {
  const stmt = db.prepare(sql);
  const results: T[] = [];
  try {
    stmt.bind(params);
    while (stmt.step()) {
      results.push(stmt.getAsObject() as T);
    }
    return results;
  } finally {
    stmt.free();
  }
}

export function transaction(db: Database, fn: () => void): void {
  db.run('BEGIN');
  try {
    fn();
    db.run('COMMIT');
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }
}
