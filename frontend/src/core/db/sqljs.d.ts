declare module 'sql.js' {
  export type SqlValue = string | number | Uint8Array | null;

  export interface ParamsObject {
    [key: string]: SqlValue;
  }

  export interface QueryResults {
    columns: string[];
    values: SqlValue[][];
  }

  export class Statement {
    bind(values?: SqlValue[] | ParamsObject | null): boolean;
    step(): boolean;
    get(): SqlValue[];
    getAsObject(): Record<string, SqlValue>;
    getColumnNames(): string[];
    run(values?: SqlValue[] | ParamsObject | null): void;
    free(): void;
  }

  export class Database {
    constructor(data?: ArrayBuffer | Uint8Array | null);
    run(sql: string, params?: SqlValue[] | ParamsObject): Database;
    exec(sql: string, params?: Record<string, SqlValue>): QueryResults[];
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
    getRowsModified(): number;
  }

  interface SqlJsStatic {
    Database: typeof Database;
    Statement: typeof Statement;
  }

  interface InitSqlJsOptions {
    locateFile?: (file: string) => string;
  }

  function initSqlJs(options?: InitSqlJsOptions): Promise<SqlJsStatic>;
  export default initSqlJs;
}
