/**
 * Add-by-file (PDF) dialog logic (Library plugin, Task 14).
 *
 * Pure, testable core of the "Add PDF" flow: payload shapes for the two
 * backend endpoints (`POST /plugins/notees.library/pdf/inspect` and
 * `POST /plugins/notees.library/sources/from-pdf`), the multipart FormData
 * builders, flow classification (resolved vs. filename fallback), and error
 * mapping for the dialog's failure states (not a PDF, identifier unknown,
 * provider unreachable).
 */
import type { LookupMetadata } from './identifierLookup';

/** Identifiers the backend extracted from the uploaded PDF. */
export interface PdfIdentifiers {
  doi: string | null;
  isbn: string | null;
  title_hint: string | null;
}

/** Response of POST /plugins/notees.library/pdf/inspect. */
export interface PdfInspectResponse {
  filename: string;
  identifiers: PdfIdentifiers;
  /** XMP/info-dict title, prominent first-page line, or the filename. */
  suggested_title: string;
  /** Provider-resolved metadata; null when the PDF has no identifiers. */
  metadata: LookupMetadata | null;
}

/** Response of POST /plugins/notees.library/sources/from-pdf. */
export interface CreateFromPdfResponse {
  node_uuid: string;
  citekey: string | null;
  asset_uuid: string | null;
  /** True when no identifiers were involved — complete details manually. */
  needs_metadata: boolean;
}

/** Editable fields the user confirms before source creation. */
export interface PdfSourceFields {
  title: string;
  class_name: string;
  creators: Array<Record<string, string>>;
  publication_date: string | null;
  publisher: string | null;
  isbn: string | null;
  doi: string | null;
  attach: boolean;
}

export type PdfFlowKind = 'resolved' | 'fallback';

/** Classify an inspect response: resolved metadata or filename fallback. */
export function classifyPdfFlow(response: PdfInspectResponse): PdfFlowKind {
  return response.metadata !== null ? 'resolved' : 'fallback';
}

/** Initial confirm-form fields from an inspect response. */
export function fieldsFromInspect(response: PdfInspectResponse): PdfSourceFields {
  const metadata = response.metadata;
  return {
    title: metadata?.title ?? response.suggested_title,
    class_name: metadata?.class_name ?? 'document',
    creators: metadata?.creators ?? [],
    publication_date: metadata?.publication_date ?? null,
    publisher: metadata?.publisher ?? null,
    isbn: metadata?.isbn ?? response.identifiers.isbn,
    doi: metadata?.doi ?? response.identifiers.doi,
    attach: true,
  };
}

/** Multipart body for POST /pdf/inspect. */
export function buildInspectFormData(file: File): FormData {
  const formData = new FormData();
  formData.append('file', file);
  return formData;
}

/** Multipart body for POST /sources/from-pdf (file re-sent + confirmed fields). */
export function buildCreateFormData(file: File, fields: PdfSourceFields): FormData {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('title', fields.title.trim());
  formData.append('class_name', fields.class_name);
  formData.append('creators', JSON.stringify(fields.creators));
  if (fields.publication_date) formData.append('publication_date', fields.publication_date);
  if (fields.publisher) formData.append('publisher', fields.publisher);
  if (fields.isbn) formData.append('isbn', fields.isbn);
  if (fields.doi) formData.append('doi', fields.doi);
  formData.append('attach', String(fields.attach));
  return formData;
}

export type PdfInspectErrorKind = 'not_pdf' | 'not_found' | 'unavailable' | 'unknown';

interface ApiErrorShape {
  response?: { status?: number };
}

/**
 * Map a failed inspect call to the dialog's error states. 400 = not a
 * readable PDF, 404 = the extracted identifier has no record, 502 = the
 * metadata provider is unreachable.
 */
export function inspectErrorKind(error: unknown): PdfInspectErrorKind {
  const status = (error as ApiErrorShape | null)?.response?.status;
  if (status === 400) return 'not_pdf';
  if (status === 404) return 'not_found';
  if (status === 502) return 'unavailable';
  return 'unknown';
}

/** True when the picked file looks like a PDF (client-side fast check). */
export function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}
