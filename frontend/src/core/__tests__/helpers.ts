import initSqlJs, { type Database } from 'sql.js';
import { createSchema } from '../db/schema';

export async function createTestDatabase(): Promise<Database> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  createSchema(db);
  return db;
}
