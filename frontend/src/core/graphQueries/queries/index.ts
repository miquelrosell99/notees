import { registerQuery } from '../queryRegistry';
import { GetChildrenQuery } from './GetChildrenQuery';
import { GetBacklinksQuery } from './GetBacklinksQuery';
import { GetLinkedReferencesQuery } from './GetLinkedReferencesQuery';
import { GetPageQuery } from './GetPageQuery';
import { SearchQuery } from './SearchQuery';

export function registerAllQueries(): void {
  registerQuery(GetChildrenQuery);
  registerQuery(GetBacklinksQuery);
  registerQuery(GetLinkedReferencesQuery);
  registerQuery(GetPageQuery);
  registerQuery(SearchQuery);
}

export * from './GetChildrenQuery';
export * from './GetBacklinksQuery';
export * from './GetLinkedReferencesQuery';
export * from './GetPageQuery';
export * from './SearchQuery';
