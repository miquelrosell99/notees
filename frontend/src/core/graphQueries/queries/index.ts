import { registerQuery } from '../queryRegistry';
import { GetChildrenQuery } from './GetChildrenQuery';
import { GetBacklinksQuery } from './GetBacklinksQuery';
import { GetLinkedReferencesQuery } from './GetLinkedReferencesQuery';
import { HydrateLinkedReferencesQuery } from './HydrateLinkedReferencesQuery';
import { GetPageQuery } from './GetPageQuery';
import { GetNodeTreeQuery } from './GetNodeTreeQuery';
import { SearchQuery } from './SearchQuery';

export function registerAllQueries(): void {
  registerQuery(GetChildrenQuery);
  registerQuery(GetBacklinksQuery);
  registerQuery(GetLinkedReferencesQuery);
  registerQuery(HydrateLinkedReferencesQuery);
  registerQuery(GetPageQuery);
  registerQuery(GetNodeTreeQuery);
  registerQuery(SearchQuery);
}

export * from './GetChildrenQuery';
export * from './GetBacklinksQuery';
export * from './GetLinkedReferencesQuery';
export * from './HydrateLinkedReferencesQuery';
export * from './GetPageQuery';
export * from './GetNodeTreeQuery';
export * from './SearchQuery';
