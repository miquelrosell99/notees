/**
 * Plugin manifest grammar (owner 2026-10-04) — the DECLARED contract
 * between a plugin and the host. This is deliberately inert vocabulary: the
 * plugin RUNTIME (capability broker, subprocess host, manifest consumption)
 * is parked, so nothing executes, renders, imports, or
 * exports through this manifest today. What ships now is the normative shape
 * (this schema is the executable form of packages/protocol/SCHEMA.md "Plugin
 * manifest grammar"), the server-side registry that stores validated
 * manifests (server state, NOT log state — the prefs/shares ruling), and the
 * web management surface.
 *
 * Versioning: `manifestVersion` is the grammar version (literal 1). Additive
 * fields within v1 are allowed only by amending this strict schema; a
 * breaking change bumps the literal and is a protocol-batch decision. Unknown
 * keys are rejected outright (strict) — the no-backward-compatibility owner
 * directive applies here as everywhere on the wire.
 *
 * Capability honesty: the four capability lists are DECLARATIONS the future
 * runtime matches against host surfaces (export formats, importers, command
 * palette, widget slots). Declaring a capability stores and displays it — it
 * grants nothing until the runtime exists. `widgets` is the least-designed
 * member: ids/labels only, no renderer contract; the runtime design owns what
 * a widget receives and renders.
 */

import { z } from "zod";

/** The manifest grammar version this schema implements. */
export const PLUGIN_MANIFEST_VERSION = 1;

/**
 * Plugin identity: a lowercase reverse-domain id (`com.example.notes`) or a
 * UUID. Reverse-domain is the collision-free form for distributed authors;
 * UUID is accepted for single-user/local plugins. Identity is NEVER the
 * human name — names are attributes (the design law), and the registry keys
 * on id+version.
 */
export const pluginIdSchema = z
  .string()
  .max(255)
  .refine(
    (value) =>
      /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(value) || z.string().uuid().safeParse(value).success,
    "expected a lowercase reverse-domain id (com.example.notes) or a UUID",
  );

/** Strict semver 2.0.0 (the official grammar; build metadata + prerelease allowed). */
export const semverSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/,
    "expected a semver 2.0.0 version (1.2.3, 1.2.3-rc.1, 1.2.3+build)",
  );

/** A declared export format: the runtime-era exporter registry matches on `id`. */
export const exportFormatCapabilitySchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]*$/, "expected a lowercase slug").max(64),
    label: z.string().trim().min(1).max(120),
    mime: z.string().trim().min(3).max(255),
  })
  .strict();

/** A declared importer. `mode` pins the intake shape the runtime must offer. */
export const importerCapabilitySchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]*$/, "expected a lowercase slug").max(64),
    label: z.string().trim().min(1).max(120),
    mime: z.string().trim().min(3).max(255),
    mode: z.enum(["file", "text"]),
  })
  .strict();

/** A declared command-palette command (label only — no keybinding grammar yet). */
export const commandCapabilitySchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]*$/, "expected a lowercase slug").max(64),
    label: z.string().trim().min(1).max(120),
  })
  .strict();

/**
 * A declared widget slot claim. Least-designed member (see module header):
 * ids/labels only until the runtime design fixes the widget contract.
 */
export const widgetCapabilitySchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]*$/, "expected a lowercase slug").max(64),
    label: z.string().trim().min(1).max(120),
  })
  .strict();

/**
 * Reserved permission vocabulary. Plugins are API clients with an embedded
 * token, so the permission names ARE the API scope set, plus the
 * two plugin-era additions (`events.subscribe` — durable event
 * delivery; `network` — explicit egress, off by default). The reserved
 * vocabulary is validated now; enforcement is entirely a runtime-era concern
 * (a parked runtime enforces nothing).
 */
export const PLUGIN_PERMISSIONS = [
  "objects.read",
  "objects.write",
  "objects.delete",
  "relations.read",
  "relations.write",
  "assets.read",
  "assets.write",
  "annotations",
  "citations",
  "collections.write",
  "search",
  "export",
  "events.subscribe",
  "network",
  "admin",
] as const;

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

export const pluginPermissionSchema = z.enum(PLUGIN_PERMISSIONS);

export const pluginCapabilitiesSchema = z
  .object({
    exportFormats: z.array(exportFormatCapabilitySchema).max(64).optional(),
    importers: z.array(importerCapabilitySchema).max(64).optional(),
    commands: z.array(commandCapabilitySchema).max(64).optional(),
    widgets: z.array(widgetCapabilitySchema).max(64).optional(),
  })
  .strict();

export type PluginCapabilities = {
  exportFormats?: Array<z.infer<typeof exportFormatCapabilitySchema>> | undefined;
  importers?: Array<z.infer<typeof importerCapabilitySchema>> | undefined;
  commands?: Array<z.infer<typeof commandCapabilitySchema>> | undefined;
  widgets?: Array<z.infer<typeof widgetCapabilitySchema>> | undefined;
};

export type PluginManifest = {
  manifestVersion: typeof PLUGIN_MANIFEST_VERSION;
  id: string;
  name: string;
  version: string;
  description?: string | undefined;
  author?: string | undefined;
  capabilities: PluginCapabilities;
  entrypoint?: string | undefined;
  permissions?: PluginPermission[] | undefined;
};

export const pluginManifestSchema = z
  .object({
    manifestVersion: z.literal(PLUGIN_MANIFEST_VERSION),
    id: pluginIdSchema,
    name: z.string().trim().min(1).max(120),
    version: semverSchema,
    description: z.string().max(2000).optional(),
    author: z.string().max(255).optional(),
    capabilities: pluginCapabilitiesSchema,
    /**
     * Reserved: the runtime-era entrypoint (a module path or executable the
     * host would load/spawn). Validated shape only — a relative path with no
     * traversal — and NEVER executed by the shipped registry. The toggle and
     * install flows store it; nothing reads it back into a loader.
     */
    entrypoint: z
      .string()
      .max(512)
      .regex(/^[^/\\][^\\]*$/, "expected a relative path")
      .refine((value) => !value.split("/").includes(".."), "path traversal is not allowed")
      .optional(),
    /** Reserved: declared permission set, validated against the vocabulary. */
    permissions: z.array(pluginPermissionSchema).max(32).optional(),
  })
  .strict() satisfies z.ZodType<PluginManifest>;

/** Parse + validate a serialized manifest. Unknown keys / versions fail loud. */
export function parsePluginManifest(input: unknown): PluginManifest {
  return pluginManifestSchema.parse(input);
}

export function safeParsePluginManifest(
  input: unknown,
): z.SafeParseReturnType<unknown, PluginManifest> {
  return pluginManifestSchema.safeParse(input);
}

/**
 * One-line capability summary for management surfaces (the web Plugins tab,
 * CLI lists): "2 export formats · 1 importer · 3 commands". Empty set → null.
 */
export function summarizeCapabilities(manifest: PluginManifest): string | null {
  const parts: string[] = [];
  const caps = manifest.capabilities;
  if ((caps.exportFormats?.length ?? 0) > 0) {
    parts.push(`${caps.exportFormats!.length} export format${caps.exportFormats!.length === 1 ? "" : "s"}`);
  }
  if ((caps.importers?.length ?? 0) > 0) {
    parts.push(`${caps.importers!.length} importer${caps.importers!.length === 1 ? "" : "s"}`);
  }
  if ((caps.commands?.length ?? 0) > 0) {
    parts.push(`${caps.commands!.length} command${caps.commands!.length === 1 ? "" : "s"}`);
  }
  if ((caps.widgets?.length ?? 0) > 0) {
    parts.push(`${caps.widgets!.length} widget${caps.widgets!.length === 1 ? "" : "s"}`);
  }
  return parts.length === 0 ? null : parts.join(" · ");
}
