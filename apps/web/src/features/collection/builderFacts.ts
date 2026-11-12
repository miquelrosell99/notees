/**
 * builderFacts — the picker-source derivation the structured-filters panel
 * (FilterBlockBuilder + the filter-block value controls) shares: the bound
 * properties across all classes, enriched with each schema row's options +
 * target filter (the type-aware value controls), plus the
 * class/property name maps. The compact subset-builder field grid that used
 * to live here died with the Queries hub; the full-
 * grammar builder is the only composer now.
 */

import { useMemo } from "react";

import type { ClassBinding, ClientNode, ClientPropertySchema } from "@/core/workspace-client/index.js";

import { titleOfNode } from "../../ui/dateDisplay.js";

/** The read surface the pickers need (both client classes satisfy it). */
export interface BuilderFactsClient {
  listClasses(): ClientNode[];
  getClassBindings(classId: string): ClassBinding[];
  /** The schema rows (options / target filters) behind the bound ids. */
  listPropertySchemas(): ClientPropertySchema[];
}

export interface BuilderFacts {
  classes: ClientNode[];
  /** Bound properties across all classes (deduped by schema id), enriched
   * with the schema row's options + target filter (the type-aware value
   * controls). */
  boundProperties: Array<{
    id: string;
    name: string;
    type: string;
    options: Array<{ id: string; label: string }> | null;
    targetClassFilter: string[] | null;
  }>;
  numericProperties: Array<{ id: string; name: string; type: string }>;
  classNames: Map<string, string>;
  propertyNames: Map<string, string>;
}

/** The picker sources, derived once per client/notify cycle. */
export function useBuilderFacts(client: BuilderFactsClient): BuilderFacts {
  const classes = client.listClasses();
  return useMemo(() => {
    const schemasById = new Map(client.listPropertySchemas().map((schema) => [schema.id, schema]));
    const boundProperties: BuilderFacts["boundProperties"] = [];
    const seenSchemas = new Set<string>();
    for (const cls of classes) {
      for (const binding of client.getClassBindings(cls.id)) {
        if (seenSchemas.has(binding.propertySchemaId)) continue;
        seenSchemas.add(binding.propertySchemaId);
        const schema = schemasById.get(binding.propertySchemaId);
        boundProperties.push({
          id: binding.propertySchemaId,
          name: binding.name,
          type: binding.type,
          options: schema?.options ?? null,
          targetClassFilter: schema?.targetClassFilter ?? binding.targetClassFilter,
        });
      }
    }
    return {
      classes,
      boundProperties,
      numericProperties: boundProperties.filter((property) => property.type === "number"),
      classNames: new Map(classes.map((cls) => [cls.id, titleOfNode(cls) || cls.id])),
      propertyNames: new Map(boundProperties.map((property) => [property.id, property.name])),
    };
    // The bindings read follows the client's notify cycle; classes identity
    // is the cheap proxy (listClasses re-runs on every notify).
  }, [client, classes]);
}

