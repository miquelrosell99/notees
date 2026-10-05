/**
 * ImportTableModal — issue #9's write side: "Import table…" from the table
 * toolbar reads a .csv (RFC-4180) or .xlsx (SpreadsheetML) the user picked,
 * maps the header row onto the workspace (a case-insensitive "uuid" column
 * marks update-rows; a "class" column assigns classes by name; a title
 * column names new nodes; every other header matches a property schema by
 * display name), previews rows × mapped columns with create/update counts,
 * then writes per row through the ordinary client op path —
 * setProperty/unsetProperty/assignClass on uuid rows, createObject +
 * classIds + properties on the rest.
 *
 * Fail-loud per cell: a cell that cannot be coerced (bad number, unknown
 * select label, unresolvable node name, …) never guesses — it lands in the
 * final report with its row, column, value, and reason, and the import
 * continues with the next cell.
 *
 * Parsers live in @notees/export (table-import.ts — the package owns the
 * view-shaped table conventions); this modal owns only mapping, coercion,
 * and the op writes. Text-typed property values ride the node-backed shape
 * (PB2 one-shape-per-type): a fresh carrier child node per imported string,
 * mirroring the table cell's commit path.
 */

import { useMemo, useState } from "react";
import { parseCsvTable, parseXlsxTable, type TableMatrix } from "@notees/export";

import { Modal } from "../ui/Modal.js";
import { Button } from "../ui/Button.js";
import { FileDropZone } from "../ui/FileDropZone.js";
import { displayNameFromClient } from "../../dateDisplay.js";
import type { AnyClient } from "../../views/types.js";
import type { ClientPropertySchema } from "@/core/workspace-client.js";
import "./ImportTableModal.css";

/** How one header column maps onto the graph. */
export type ColumnMapping =
  | { kind: "uuid" }
  | { kind: "title" }
  | { kind: "class" }
  | { kind: "property"; schema: ClientPropertySchema }
  | { kind: "ignored"; header: string };

/** One cell that failed coercion/resolution — reported, never guessed. */
export interface ImportCellFailure {
  /** 1-based sheet row (header = 1) so the user can find it in the file. */
  row: number;
  column: string;
  value: string;
  error: string;
}

export interface ImportReport {
  created: number;
  updated: number;
  /** Fully-empty rows (no uuid, no title, no mapped cell) — not written. */
  skipped: number;
  failures: ImportCellFailure[];
  /** Headers that matched nothing and were left out of the write set. */
  ignoredHeaders: string[];
}

export interface ImportTableModalProps {
  isOpen: boolean;
  onClose: () => void;
  client: AnyClient;
  /**
   * The table view's name-column label (round-trip: the exported header).
   * Besides this, "name" and "title" (case-insensitive) also map to titles.
   */
  titleHeader?: string | undefined;
}

const norm = (value: string): string => value.trim().toLowerCase();

/** Header → mapping, in column order. "uuid"/"class"/title win over schemas. */
export function buildColumnMappings(
  schemas: readonly ClientPropertySchema[],
  headers: readonly string[],
  titleHeader?: string,
): ColumnMapping[] {
  const byName = new Map(schemas.map((schema) => [norm(schema.name), schema]));
  const titleNorm = titleHeader !== undefined && titleHeader.trim() !== "" ? norm(titleHeader) : null;
  return headers.map((header) => {
    const key = norm(header);
    if (key === "uuid") return { kind: "uuid" };
    if (key === "class" || key === "classes") return { kind: "class" };
    if (key === titleNorm || key === "name" || key === "title") return { kind: "title" };
    const schema = byName.get(key);
    return schema !== undefined ? { kind: "property", schema } : { kind: "ignored", header };
  });
}

/** Mapping summary for one column: "Pages (number)", "ignored — …", … */
export function mappingLabel(mapping: ColumnMapping): string {
  switch (mapping.kind) {
    case "uuid":
      return "node id (update)";
    case "title":
      return "title (new nodes)";
    case "class":
      return "classes (assign)";
    case "property": {
      const schema = mapping.schema;
      return `${schema.name} (${schema.type}${schema.multi ? ", multi" : ""})`;
    }
    case "ignored":
      return `ignored — no match for "${mapping.header}"`;
  }
}

type CoerceResult = { ok: true; value: unknown } | { ok: false; error: string };

/** Option labels → stored ids: exact case first, then case-insensitive. */
function matchOption(schema: ClientPropertySchema, label: string): string | null {
  const options = schema.options ?? [];
  const exact = options.find((option) => option.label === label);
  if (exact !== undefined) return exact.id;
  return options.find((option) => norm(option.label) === norm(label))?.id ?? null;
}

function optionNames(schema: ClientPropertySchema): string {
  return (schema.options ?? []).map((option) => option.label).join(", ");
}

/**
 * Cell text → typed property value for one schema. Multi columns split on
 * commas and return an ARRAY (the canonical multi shape: one value at idx 0,
 * the KanbanView/pickers precedent); single columns return the scalar.
 * Node-typed cells resolve by display name; select cells match option labels
 * to stored ids; dates must be ISO day strings (the caller turns them into
 * day-node refs via ensureDateChain); numbers must parse finite (integers
 * integral).
 */
export function coerceImportCell(client: AnyClient, schema: ClientPropertySchema, raw: string): CoerceResult {
  const text = raw.trim();
  if (schema.multi) {
    const values: unknown[] = [];
    for (const part of text.split(",").map((piece) => piece.trim())) {
      if (part === "") continue;
      const one = coerceSingle(client, schema, part);
      if (!one.ok) return one;
      values.push(one.value);
    }
    return { ok: true, value: values };
  }
  return coerceSingle(client, schema, text);
}

function coerceSingle(client: AnyClient, schema: ClientPropertySchema, text: string): CoerceResult {
  switch (schema.type) {
    case "boolean": {
      const key = norm(text);
      if (key === "true" || key === "yes" || key === "1") return { ok: true, value: true };
      if (key === "false" || key === "no" || key === "0") return { ok: true, value: false };
      return { ok: false, error: `not a boolean ("${text}")` };
    }
    case "number": {
      const value = Number(text);
      if (text !== "" && Number.isFinite(value)) return { ok: true, value };
      return { ok: false, error: `not a number ("${text}")` };
    }
    case "integer": {
      const value = Number(text);
      if (text !== "" && Number.isInteger(value)) return { ok: true, value };
      return { ok: false, error: `not an integer ("${text}")` };
    }
    case "select":
    case "multi_select": {
      if (schema.options === null || schema.options.length === 0) {
        return { ok: false, error: "the schema has no options" };
      }
      const id = matchOption(schema, text);
      return id !== null
        ? { ok: true, value: id }
        : { ok: false, error: `no option named "${text}" (${optionNames(schema)})` };
    }
    case "date": {
      if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return { ok: true, value: text };
      return { ok: false, error: `not an ISO date (YYYY-MM-DD): "${text}"` };
    }
    case "object": {
      const id = client.resolveNodeByName(text);
      return id !== null
        ? { ok: true, value: { nodeId: id } }
        : { ok: false, error: `no node named "${text}"` };
    }
    case "text":
    case "url":
    case "email":
      return { ok: true, value: text };
    default:
      return { ok: false, error: `import for "${schema.type}" properties is not supported` };
  }
}

/** File → bytes, with a FileReader fallback for jsdom (whose Blob lacks arrayBuffer). */
async function fileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === "function") {
    return new Uint8Array(await file.arrayBuffer());
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

function parsePickedFile(name: string, bytes: Uint8Array): TableMatrix {
  const lower = name.toLowerCase();
  if (lower.endsWith(".xlsx")) return parseXlsxTable(bytes);
  if (lower.endsWith(".csv")) return parseCsvTable(new TextDecoder().decode(bytes));
  throw new Error(`unsupported file type — pick a .csv or .xlsx file ("${name}")`);
}

interface DataRow {
  /** 1-based sheet row number (header = 1) for preview + failure reports. */
  sheetRow: number;
  cells: string[];
}

interface ParsedSheet {
  headers: string[];
  dataRows: DataRow[];
}

function toParsedSheet(matrix: TableMatrix): ParsedSheet {
  if (matrix.length === 0) throw new Error("the file has no rows — a header row is required");
  const headers = (matrix[0] ?? []).map((cell) => cell.trim());
  if (headers.every((header) => header === "")) {
    throw new Error("the first row is empty — a header row is required");
  }
  const dataRows = matrix.slice(1).map((cells, index) => ({ sheetRow: index + 2, cells }));
  return { headers, dataRows };
}

/** Column indices per role, resolved once per import. */
interface ColumnPlan {
  uuidCol: number;
  titleCol: number;
  classCol: number;
  /** Original column index + schema, for the property columns only. */
  propertyCols: Array<{ index: number; schema: ClientPropertySchema }>;
}

function planColumns(mappings: readonly ColumnMapping[]): ColumnPlan {
  let uuidCol = -1;
  let titleCol = -1;
  let classCol = -1;
  const propertyCols: ColumnPlan["propertyCols"] = [];
  mappings.forEach((mapping, index) => {
    if (mapping.kind === "uuid") uuidCol = index;
    else if (mapping.kind === "title") titleCol = index;
    else if (mapping.kind === "class") classCol = index;
    else if (mapping.kind === "property") propertyCols.push({ index, schema: mapping.schema });
  });
  return { uuidCol, titleCol, classCol, propertyCols };
}

type Step =
  | { phase: "pick" }
  | { phase: "preview"; parsed: ParsedSheet; mappings: ColumnMapping[] }
  | { phase: "report"; report: ImportReport };

const PREVIEW_ROWS = 8;

export function ImportTableModal({ isOpen, onClose, client, titleHeader }: ImportTableModalProps) {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<Step>({ phase: "pick" });

  const schemas = useMemo(() => client.listPropertySchemas(), [client]);
  const classes = useMemo(() => client.listClasses(), [client]);
  const classIdByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const cls of classes) {
      const name = displayNameFromClient(client, cls.id) ?? cls.id;
      if (!map.has(norm(name))) map.set(norm(name), cls.id);
    }
    return map;
  }, [classes, client]);

  const reset = () => {
    setFile(null);
    setError(null);
    setBusy(false);
    setStep({ phase: "pick" });
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleFile = async (picked: File) => {
    setFile(picked);
    setError(null);
    setBusy(true);
    try {
      const matrix = parsePickedFile(picked.name, await fileBytes(picked));
      const parsed = toParsedSheet(matrix);
      setStep({ phase: "preview", parsed, mappings: buildColumnMappings(schemas, parsed.headers, titleHeader) });
    } catch (cause) {
      setStep({ phase: "pick" });
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const runImport = async (parsed: ParsedSheet, mappings: ColumnMapping[]) => {
    setBusy(true);
    const failures: ImportCellFailure[] = [];
    const ignoredHeaders = mappings.flatMap((mapping) =>
      mapping.kind === "ignored" ? [mapping.header] : [],
    );
    const plan = planColumns(mappings);
    let created = 0;
    let updated = 0;
    let skipped = 0;

    const resolveClasses = (raw: string, sheetRow: number): string[] => {
      const ids: string[] = [];
      for (const name of raw.split(",").map((part) => part.trim())) {
        if (name === "") continue;
        const id = classIdByName.get(norm(name));
        if (id === undefined) {
          failures.push({
            row: sheetRow,
            column: parsed.headers[plan.classCol] ?? "class",
            value: name,
            error: "no class with this name",
          });
        } else {
          ids.push(id);
        }
      }
      return ids;
    };

    /** The slots a node currently holds for one schema (any source). */
    const heldSlots = (nodeId: string, schemaId: string): number[] =>
      client
        .getEffectiveProperties(nodeId)
        .filter((prop) => prop.propertySchemaId === schemaId)
        .map((prop) => prop.idx);

    const writeProperty = async (
      nodeId: string,
      colIndex: number,
      schema: ClientPropertySchema,
      raw: string,
      sheetRow: number,
    ): Promise<void> => {
      const header = parsed.headers[colIndex] ?? schema.name;
      const valueText = raw.trim();
      if (valueText === "") {
        // Empty clears the value (every held slot, paranoia included).
        for (const idx of heldSlots(nodeId, schema.id)) {
          await client.unsetProperty(nodeId, schema.id, idx);
        }
        return;
      }
      const coerced = coerceImportCell(client, schema, valueText);
      if (!coerced.ok) {
        failures.push({ row: sheetRow, column: header, value: valueText, error: coerced.error });
        return;
      }
      if (schema.type === "date") {
        // ISO day → the day-node chain; multi dates ride the array shape.
        if (Array.isArray(coerced.value)) {
          const refs: Array<{ nodeId: string }> = [];
          for (const iso of coerced.value as string[]) {
            const { day } = await client.ensureDateChain(iso);
            refs.push({ nodeId: day });
          }
          await client.setProperty(nodeId, schema.id, refs, 0);
          return;
        }
        const { day } = await client.ensureDateChain(coerced.value as string);
        await client.setProperty(nodeId, schema.id, { nodeId: day }, 0);
        return;
      }
      if (schema.type === "text") {
        // Node-backed text values (PB2): a fresh carrier child per string —
        // single cells one ref, multi cells the ref array (the shape the
        // table's display/export reads back).
        const parts = Array.isArray(coerced.value)
          ? (coerced.value as string[])
          : [coerced.value as string];
        const refs: Array<{ nodeId: string }> = [];
        for (const part of parts) {
          const carrier = await client.createObject({
            parentId: nodeId,
            contentAst: [{ type: "text", text: part }],
          });
          refs.push({ nodeId: carrier });
        }
        await client.setProperty(nodeId, schema.id, Array.isArray(coerced.value) ? refs : refs[0], 0);
        return;
      }
      // Scalars and the canonical multi array (selects, node refs, multi
      // text/url/email/number/boolean) write in one property.set at idx 0.
      await client.setProperty(nodeId, schema.id, coerced.value, 0);
    };

    for (const row of parsed.dataRows) {
      const cellAt = (index: number): string => (index >= 0 ? (row.cells[index] ?? "").trim() : "");
      const uuid = cellAt(plan.uuidCol);
      const title = cellAt(plan.titleCol);
      const classRaw = cellAt(plan.classCol);
      const hasContent =
        title !== "" ||
        classRaw !== "" ||
        plan.propertyCols.some(({ index }) => cellAt(index) !== "");
      if (uuid === "" && !hasContent) {
        skipped += 1;
        continue;
      }
      if (uuid !== "") {
        const node = client.getNode(uuid);
        if (node === undefined) {
          failures.push({
            row: row.sheetRow,
            column: parsed.headers[plan.uuidCol] ?? "uuid",
            value: uuid,
            error: "no node with this uuid",
          });
          continue;
        }
        if (title !== "") {
          await client.updateObject(uuid, { contentAst: [{ type: "text", text: title }] });
        }
        for (const classId of resolveClasses(classRaw, row.sheetRow)) {
          await client.assignClass(uuid, classId);
        }
        for (const { index, schema } of plan.propertyCols) {
          await writeProperty(uuid, index, schema, cellAt(index), row.sheetRow);
        }
        updated += 1;
      } else {
        const classIds = resolveClasses(classRaw, row.sheetRow);
        const id = await client.createObject({
          ...(title !== "" ? { name: title } : {}),
          ...(classIds.length > 0 ? { classIds } : {}),
        });
        for (const { index, schema } of plan.propertyCols) {
          await writeProperty(id, index, schema, cellAt(index), row.sheetRow);
        }
        created += 1;
      }
    }
    setBusy(false);
    setStep({ phase: "report", report: { created, updated, skipped, failures, ignoredHeaders } });
  };

  const previewCounts = (parsed: ParsedSheet, mappings: ColumnMapping[]) => {
    const plan = planColumns(mappings);
    let updates = 0;
    let creates = 0;
    let skipped = 0;
    for (const row of parsed.dataRows) {
      const cellAt = (index: number): string => (index >= 0 ? (row.cells[index] ?? "").trim() : "");
      if (cellAt(plan.uuidCol) !== "") updates += 1;
      else if (
        cellAt(plan.titleCol) !== "" ||
        cellAt(plan.classCol) !== "" ||
        plan.propertyCols.some(({ index }) => cellAt(index) !== "")
      ) {
        creates += 1;
      } else {
        skipped += 1;
      }
    }
    return { updates, creates, skipped };
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Import table"
      size="lg"
      footer={
        step.phase === "preview" ? (
          <>
            <Button variant="ghost" onClick={reset} disabled={busy}>
              Back
            </Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={() => {
                if (step.phase === "preview") void runImport(step.parsed, step.mappings);
              }}
            >
              Import
            </Button>
          </>
        ) : step.phase === "report" ? (
          <Button variant="primary" onClick={handleClose}>
            Done
          </Button>
        ) : undefined
      }
    >
      {step.phase === "pick" && (
        <div className="import-modal__body">
          <p className="import-modal__hint">
            Pick a <code>.csv</code> or <code>.xlsx</code> file whose first row names the columns. A{" "}
            <code>uuid</code> column updates the rows with those ids; rows without one create new nodes
            (a <code>name</code>/<code>title</code> column is the new node's title, <code>class</code> assigns
            classes by name, and every other header matches a property by name).
          </p>
          <FileDropZone
            file={file}
            accept=".csv,.xlsx"
            onSelect={(picked) => void handleFile(picked)}
            onClear={() => {
              setFile(null);
              setError(null);
            }}
            placeholder="Drop a table file here"
            hint="or click to browse — .csv or .xlsx"
            disabled={busy}
          />
          {error !== null && <p className="import-modal__error">{error}</p>}
        </div>
      )}

      {step.phase === "preview" && (
        <div className="import-modal__body">
          {(() => {
            const counts = previewCounts(step.parsed, step.mappings);
            return (
              <p className="import-modal__hint" data-testid="import-preview-counts">
                <strong>{counts.updates}</strong> row{counts.updates === 1 ? "" : "s"} will update existing
                nodes, <strong>{counts.creates}</strong> will create new nodes
                {counts.skipped > 0 && (
                  <>
                    , <strong>{counts.skipped}</strong> empty row{counts.skipped === 1 ? "" : "s"} skipped
                  </>
                )}
                . Unmapped columns are ignored.
              </p>
            );
          })()}
          <div className="import-modal__mapping">
            {step.parsed.headers.map((header, index) => (
              <span
                key={index}
                className={`import-modal__chip${
                  step.mappings[index]?.kind === "ignored" ? " import-modal__chip--ignored" : ""
                }`}
              >
                {header || "(empty)"} → {mappingLabel(step.mappings[index]!)}
              </span>
            ))}
          </div>
          <div className="import-modal__table-wrap">
            <table className="import-modal__table">
              <thead>
                <tr>
                  {step.parsed.headers.map((header, index) => (
                    <th key={index}>{header || "(empty)"}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {step.parsed.dataRows.slice(0, PREVIEW_ROWS).map((row) => (
                  <tr key={row.sheetRow}>
                    {step.parsed.headers.map((_, index) => (
                      <td key={index}>{row.cells[index] ?? ""}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {step.parsed.dataRows.length > PREVIEW_ROWS && (
              <p className="import-modal__hint">
                …and {step.parsed.dataRows.length - PREVIEW_ROWS} more row
                {step.parsed.dataRows.length - PREVIEW_ROWS === 1 ? "" : "s"}.
              </p>
            )}
          </div>
        </div>
      )}

      {step.phase === "report" && (
        <div className="import-modal__body">
          <p className="import-modal__hint">
            Imported: <strong>{step.report.created}</strong> created, <strong>{step.report.updated}</strong>{" "}
            updated, <strong>{step.report.skipped}</strong> skipped.
          </p>
          {step.report.ignoredHeaders.length > 0 && (
            <p className="import-modal__hint">
              Ignored columns: {step.report.ignoredHeaders.join(", ")}.
            </p>
          )}
          {step.report.failures.length > 0 ? (
            <div className="import-modal__failures">
              <p className="import-modal__error">
                {step.report.failures.length} cell
                {step.report.failures.length === 1 ? "" : "s"} failed — nothing was guessed:
              </p>
              <ul className="import-modal__failure-list">
                {step.report.failures.map((failure, index) => (
                  <li key={index}>
                    Row {failure.row}, <strong>{failure.column}</strong> = "{failure.value}" —{" "}
                    {failure.error}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="import-modal__hint">Every mapped cell wrote cleanly.</p>
          )}
        </div>
      )}
    </Modal>
  );
}
