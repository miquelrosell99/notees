import { describe, expect, it } from 'vitest';

import type { LookupMetadata } from './identifierLookup';
import {
  buildCreateFormData,
  buildInspectFormData,
  classifyPdfFlow,
  fieldsFromInspect,
  inspectErrorKind,
  isPdfFile,
  type PdfInspectResponse,
} from './pdfImport';

const resolvedMetadata: LookupMetadata = {
  title: 'Wnt signalling in stem cells',
  creators: [{ given_name: 'Jane', family_name: 'Doe' }],
  publication_date: '2013-07-04',
  publisher: 'Nature Publishing Group',
  isbn: null,
  doi: '10.1038/nature12373',
  class_name: 'paper',
  language: 'en',
  provider: 'crossref',
};

const resolvedResponse: PdfInspectResponse = {
  filename: 'nature12373.pdf',
  identifiers: { doi: '10.1038/nature12373', isbn: null, title_hint: 'Wnt signalling' },
  suggested_title: 'Wnt signalling',
  metadata: resolvedMetadata,
};

const fallbackResponse: PdfInspectResponse = {
  filename: 'my-paper_draft.pdf',
  identifiers: { doi: null, isbn: null, title_hint: null },
  suggested_title: 'my paper draft',
  metadata: null,
};

describe('classifyPdfFlow', () => {
  it('is resolved when metadata is present', () => {
    expect(classifyPdfFlow(resolvedResponse)).toBe('resolved');
  });

  it('is fallback when metadata is null', () => {
    expect(classifyPdfFlow(fallbackResponse)).toBe('fallback');
  });
});

describe('fieldsFromInspect', () => {
  it('prefers provider metadata for a resolved PDF', () => {
    const fields = fieldsFromInspect(resolvedResponse);
    expect(fields).toEqual({
      title: 'Wnt signalling in stem cells',
      class_name: 'paper',
      creators: [{ given_name: 'Jane', family_name: 'Doe' }],
      publication_date: '2013-07-04',
      publisher: 'Nature Publishing Group',
      isbn: null,
      doi: '10.1038/nature12373',
      attach: true,
    });
  });

  it('falls back to the suggested title for an unidentified PDF', () => {
    const fields = fieldsFromInspect(fallbackResponse);
    expect(fields.title).toBe('my paper draft');
    expect(fields.class_name).toBe('document');
    expect(fields.creators).toEqual([]);
    expect(fields.doi).toBeNull();
    expect(fields.attach).toBe(true);
  });

  it('keeps an extracted-but-unresolved ISBN as a field', () => {
    const fields = fieldsFromInspect({
      ...fallbackResponse,
      identifiers: { doi: null, isbn: '9780441172719', title_hint: 'Dune' },
    });
    expect(fields.isbn).toBe('9780441172719');
  });
});

describe('buildInspectFormData', () => {
  it('attaches the file', () => {
    const file = new File(['%PDF-'], 'paper.pdf', { type: 'application/pdf' });
    const formData = buildInspectFormData(file);
    expect(formData.get('file')).toBe(file);
  });
});

describe('buildCreateFormData', () => {
  it('serializes the confirmed fields and re-attaches the file', () => {
    const file = new File(['%PDF-'], 'paper.pdf', { type: 'application/pdf' });
    const formData = buildCreateFormData(file, {
      title: '  Wnt signalling in stem cells  ',
      class_name: 'paper',
      creators: [{ given_name: 'Jane', family_name: 'Doe' }],
      publication_date: '2013-07-04',
      publisher: null,
      isbn: null,
      doi: '10.1038/nature12373',
      attach: true,
    });
    expect(formData.get('file')).toBe(file);
    expect(formData.get('title')).toBe('Wnt signalling in stem cells');
    expect(formData.get('class_name')).toBe('paper');
    expect(formData.get('creators')).toBe('[{"given_name":"Jane","family_name":"Doe"}]');
    expect(formData.get('publication_date')).toBe('2013-07-04');
    expect(formData.get('doi')).toBe('10.1038/nature12373');
    expect(formData.get('attach')).toBe('true');
    // Null optional fields are omitted, not sent as "null".
    expect(formData.has('publisher')).toBe(false);
    expect(formData.has('isbn')).toBe(false);
  });

  it('sends attach=false when the user declines the attachment', () => {
    const file = new File(['%PDF-'], 'paper.pdf', { type: 'application/pdf' });
    const formData = buildCreateFormData(file, {
      ...fieldsFromInspect(fallbackResponse),
      attach: false,
    });
    expect(formData.get('attach')).toBe('false');
  });
});

describe('inspectErrorKind', () => {
  it('maps 400 to not_pdf', () => {
    expect(inspectErrorKind({ response: { status: 400 } })).toBe('not_pdf');
  });

  it('maps 404 to not_found', () => {
    expect(inspectErrorKind({ response: { status: 404 } })).toBe('not_found');
  });

  it('maps 502 to unavailable', () => {
    expect(inspectErrorKind({ response: { status: 502 } })).toBe('unavailable');
  });

  it('maps anything else to unknown', () => {
    expect(inspectErrorKind({ response: { status: 500 } })).toBe('unknown');
    expect(inspectErrorKind(new Error('network'))).toBe('unknown');
  });
});

describe('isPdfFile', () => {
  it('accepts the PDF mime type', () => {
    expect(isPdfFile(new File(['%PDF-'], 'scan', { type: 'application/pdf' }))).toBe(true);
  });

  it('accepts the .pdf extension when the mime type is missing', () => {
    expect(isPdfFile(new File(['%PDF-'], 'Paper.PDF', { type: '' }))).toBe(true);
  });

  it('rejects other files', () => {
    expect(isPdfFile(new File(['x'], 'notes.txt', { type: 'text/plain' }))).toBe(false);
  });
});
