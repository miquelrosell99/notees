import type { WorkspaceStore } from '../store';
import type { GraphQuery } from './GraphQuery';

const registry = new Map<string, GraphQuery<unknown, unknown>>();

export function registerQuery<Input, Output>(query: GraphQuery<Input, Output>): void {
  registry.set(query.name, query as GraphQuery<unknown, unknown>);
}

export function executeGraphQuery(store: WorkspaceStore, name: string, input: unknown): unknown {
  const query = registry.get(name);
  if (!query) throw new Error(`Unknown graph query: ${name}`);
  return query.execute(store, input);
}

export function getRegisteredQueryNames(): string[] {
  return Array.from(registry.keys());
}
