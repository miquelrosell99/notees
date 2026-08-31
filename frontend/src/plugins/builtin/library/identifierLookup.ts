/**
 * Add-by-identifier dialog logic (Library plugin, Task 13).
 *
 * Pure, testable core of the "Add by identifier" flow: client-side
 * identifier classification (mirrors the backend's `classify_identifier` so
 * obvious typos fail fast without a round trip), the lookup/confirm payload
 * shapes, and error mapping for the dialog's three failure states (invalid
 * identifier, not found, provider unreachable).
 */

export type IdentifierKind = 'doi' | 'isbn';

export interface ClassifiedIdentifier {
  kind: IdentifierKind;
  value: string;
}

/** Normalized metadata returned by POST /plugins/notees.library/lookup. */
export interface LookupMetadata {
  title: string;
  creators: Array<Record<string, string>>;
  publication_date: string | null;
  publisher: string | null;
  isbn: string | null;
  doi: string | null;
  class_name: string;
  language: string | null;
  provider: string;
}

/** Payload accepted by POST /plugins/notees.library/sources. */
export interface CreateSourcePayload {
  title: string;
  class_name: string;
  creators: Array<Record<string, string>>;
  publication_date: string | null;
  publisher: string | null;
  isbn: string | null;
  doi: string | null;
}

const DOI_RE = /^10\.\d{4,9}\/\S+$/i;
const ISBN10_RE = /^\d{9}[\dXx]$/;
const ISBN13_RE = /^\d{13}$/;
const DOI_PREFIXES = ['https://doi.org/', 'http://doi.org/', 'doi:'];

/**
 * Classify pasted text as a DOI or ISBN. Accepts doi.org URLs, `doi:`
 * prefixes, and hyphenated/spaced ISBNs. Returns null for anything else.
 */
export function classifyIdentifier(raw: string): ClassifiedIdentifier | null {
  let text = raw.trim();
  const lowered = text.toLowerCase();
  for (const prefix of DOI_PREFIXES) {
    if (lowered.startsWith(prefix)) {
      text = text.slice(prefix.length).trim();
      break;
    }
  }
  if (DOI_RE.test(text)) return { kind: 'doi', value: text };
  const digits = text.replace(/[-\s]/g, '');
  if (ISBN13_RE.test(digits) || ISBN10_RE.test(digits)) {
    return { kind: 'isbn', value: digits.toUpperCase() };
  }
  return null;
}

/** Build the create payload from looked-up metadata plus the (edited) title. */
export function buildCreatePayload(metadata: LookupMetadata, title: string): CreateSourcePayload {
  return {
    title: title.trim(),
    class_name: metadata.class_name,
    creators: metadata.creators,
    publication_date: metadata.publication_date,
    publisher: metadata.publisher,
    isbn: metadata.isbn,
    doi: metadata.doi,
  };
}

/** Display name for a creator dict (person given/family or organization). */
export function creatorDisplayName(creator: Record<string, string>): string {
  const organization = (creator.organization_name ?? '').trim();
  if (organization) return organization;
  return `${(creator.given_name ?? '').trim()} ${(creator.family_name ?? '').trim()}`.trim();
}

export type LookupErrorKind = 'invalid' | 'not_found' | 'unavailable' | 'unknown';

interface ApiErrorShape {
  response?: { status?: number; data?: { detail?: unknown } };
}

/**
 * Map a failed lookup call to the dialog's error states. 400 = invalid
 * identifier, 404 = not found, 502 = provider unreachable; anything without
 * a response is treated as the server being down.
 */
export function lookupErrorKind(error: unknown): LookupErrorKind {
  const status = (error as ApiErrorShape | null)?.response?.status;
  if (status === 400) return 'invalid';
  if (status === 404) return 'not_found';
  if (status === 502) return 'unavailable';
  return 'unknown';
}
