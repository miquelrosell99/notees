import { describe, expect, it } from 'vitest';

import {
  buildCreatePayload,
  classifyIdentifier,
  creatorDisplayName,
  lookupErrorKind,
  type LookupMetadata,
} from './identifierLookup';

describe('classifyIdentifier', () => {
  it('accepts a plain DOI', () => {
    expect(classifyIdentifier('10.1038/nature12373')).toEqual({
      kind: 'doi',
      value: '10.1038/nature12373',
    });
  });

  it('strips a doi.org URL prefix', () => {
    expect(classifyIdentifier('https://doi.org/10.1038/nature12373')).toEqual({
      kind: 'doi',
      value: '10.1038/nature12373',
    });
  });

  it('strips a doi: prefix', () => {
    expect(classifyIdentifier('doi:10.1000/xyz')).toEqual({ kind: 'doi', value: '10.1000/xyz' });
  });

  it('accepts a hyphenated ISBN-13', () => {
    expect(classifyIdentifier('978-0-441-17271-9')).toEqual({
      kind: 'isbn',
      value: '9780441172719',
    });
  });

  it('accepts an ISBN-10 with a check digit X and uppercases it', () => {
    expect(classifyIdentifier('0-8044-2957-x')).toEqual({ kind: 'isbn', value: '080442957X' });
  });

  it('returns null for free text', () => {
    expect(classifyIdentifier('some random text')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(classifyIdentifier('   ')).toBeNull();
  });
});

const metadata: LookupMetadata = {
  title: 'Dune',
  creators: [{ given_name: 'Frank', family_name: 'Herbert' }],
  publication_date: 'August 1965',
  publisher: 'Chilton Books',
  isbn: '9780441172719',
  doi: null,
  class_name: 'book',
  language: 'eng',
  provider: 'openlibrary',
};

describe('buildCreatePayload', () => {
  it('carries metadata through with the (edited) title trimmed', () => {
    expect(buildCreatePayload(metadata, '  Dune (edited) ')).toEqual({
      title: 'Dune (edited)',
      class_name: 'book',
      creators: [{ given_name: 'Frank', family_name: 'Herbert' }],
      publication_date: 'August 1965',
      publisher: 'Chilton Books',
      isbn: '9780441172719',
      doi: null,
    });
  });
});

describe('creatorDisplayName', () => {
  it('joins given and family names', () => {
    expect(creatorDisplayName({ given_name: 'Frank', family_name: 'Herbert' })).toBe(
      'Frank Herbert',
    );
  });

  it('prefers the organization name', () => {
    expect(creatorDisplayName({ organization_name: 'Wnt Consortium' })).toBe('Wnt Consortium');
  });

  it('handles family-only persons', () => {
    expect(creatorDisplayName({ given_name: '', family_name: 'Herodotus' })).toBe('Herodotus');
  });
});

describe('lookupErrorKind', () => {
  const errWithStatus = (status: number) => ({ response: { status, data: { detail: 'x' } } });

  it('maps 400 to invalid', () => {
    expect(lookupErrorKind(errWithStatus(400))).toBe('invalid');
  });

  it('maps 404 to not_found', () => {
    expect(lookupErrorKind(errWithStatus(404))).toBe('not_found');
  });

  it('maps 502 to unavailable', () => {
    expect(lookupErrorKind(errWithStatus(502))).toBe('unavailable');
  });

  it('maps errors without a response to unknown', () => {
    expect(lookupErrorKind(new Error('Network Error'))).toBe('unknown');
  });
});
