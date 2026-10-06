/**
 * Plugin manifest grammar tests: the strict schema accepts a
 * minimal and a full manifest, rejects every malformed shape loud (bad id,
 * bad semver, unknown keys, bad capability members, unknown permissions,
 * path-traversal entrypoints), and the summary helper renders the
 * management-surface line.
 */

import { describe, expect, it } from "vitest";

import {
  parsePluginManifest,
  PLUGIN_MANIFEST_VERSION,
  PLUGIN_PERMISSIONS,
  pluginManifestSchema,
  safeParsePluginManifest,
  summarizeCapabilities,
  type PluginManifest,
} from "../src/index.js";

const MINIMAL: PluginManifest = {
  manifestVersion: 1,
  id: "com.example.notes",
  name: "Notes",
  version: "1.2.3",
  capabilities: {},
};

const FULL: PluginManifest = {
  manifestVersion: 1,
  id: "dev.notees.bibtex",
  name: "BibTeX bridge",
  version: "0.4.0-rc.2+build.7",
  description: "Imports and exports BibTeX bibliographies.",
  author: "Ada <ada@example.com>",
  capabilities: {
    exportFormats: [{ id: "bibtex", label: "BibTeX", mime: "application/x-bibtex" }],
    importers: [{ id: "bibtex", label: "BibTeX file", mime: "application/x-bibtex", mode: "file" }],
    commands: [
      { id: "import-bibtex", label: "Import BibTeX…" },
      { id: "export-bibtex", label: "Export BibTeX" },
    ],
    widgets: [{ id: "reading-list", label: "Reading list" }],
  },
  entrypoint: "dist/index.js",
  permissions: ["objects.read", "objects.write", "export"],
};

describe("plugin manifest schema", () => {
  it("accepts a minimal manifest", () => {
    const parsed = pluginManifestSchema.safeParse(MINIMAL);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("accepts a full manifest with every capability member", () => {
    const parsed = pluginManifestSchema.safeParse(FULL);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("accepts a UUID id as well as reverse-domain", () => {
    const withUuid: PluginManifest = {
      ...MINIMAL,
      id: "018f3c2e-7b6d-7a1c-8e5f-2d4a6c8e0b1a",
    };
    expect(pluginManifestSchema.safeParse(withUuid).success).toBe(true);
  });

  it("rejects a missing or newer manifestVersion", () => {
    const { manifestVersion: _omit, ...rest } = MINIMAL;
    expect(pluginManifestSchema.safeParse(rest).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ ...MINIMAL, manifestVersion: 2 }).success).toBe(false);
    expect(PLUGIN_MANIFEST_VERSION).toBe(1);
  });

  it("rejects ids that are neither reverse-domain nor UUID", () => {
    for (const id of ["Notes", "com.example.Notes", "no-dots", ".leading.dot", "com..example", "a".repeat(256)]) {
      expect(pluginManifestSchema.safeParse({ ...MINIMAL, id }).success).toBe(false);
    }
  });

  it("rejects non-semver versions", () => {
    for (const version of ["1.2", "1.2.3.4", "v1.2.3", "1.02.3", "1.2.3-", "latest"]) {
      expect(pluginManifestSchema.safeParse({ ...MINIMAL, version }).success).toBe(false);
    }
  });

  it("rejects unknown top-level keys (strict)", () => {
    expect(pluginManifestSchema.safeParse({ ...MINIMAL, homepage: "https://example.com" }).success).toBe(false);
  });

  it("rejects unknown capability keys (strict)", () => {
    const capabilities = { ...MINIMAL.capabilities, sidebars: [] };
    expect(pluginManifestSchema.safeParse({ ...MINIMAL, capabilities }).success).toBe(false);
  });

  it("rejects an importer mode outside file|text", () => {
    const manifest = {
      ...FULL,
      capabilities: {
        ...FULL.capabilities,
        importers: [{ id: "bibtex", label: "BibTeX", mime: "application/x-bibtex", mode: "stream" }],
      },
    };
    expect(pluginManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it("rejects capability entries with unknown keys or empty labels", () => {
    const badFormat = {
      ...FULL,
      capabilities: { exportFormats: [{ id: "bibtex", label: "BibTeX", mime: "text/plain", extra: 1 }] },
    };
    expect(pluginManifestSchema.safeParse(badFormat).success).toBe(false);
    const emptyLabel = {
      ...FULL,
      capabilities: { commands: [{ id: "go", label: "  " }] },
    };
    expect(pluginManifestSchema.safeParse(emptyLabel).success).toBe(false);
  });

  it("rejects unknown permission names and duplicate-free lists validate", () => {
    const bad = { ...FULL, permissions: ["objects.read", "delete-everything"] };
    expect(pluginManifestSchema.safeParse(bad).success).toBe(false);
    const good = { ...FULL, permissions: PLUGIN_PERMISSIONS.slice(0, 4) };
    expect(pluginManifestSchema.safeParse(good).success).toBe(true);
  });

  it("rejects entrypoints that are absolute or traverse", () => {
    expect(pluginManifestSchema.safeParse({ ...FULL, entrypoint: "/etc/passwd" }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ ...FULL, entrypoint: "../escape.js" }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ ...FULL, entrypoint: "dist/../../escape.js" }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ ...FULL, entrypoint: "dist/index.js" }).success).toBe(true);
    expect(pluginManifestSchema.safeParse({ ...FULL, entrypoint: "./main.py" }).success).toBe(true);
  });

  it("parsePluginManifest returns the manifest; safeParse surfaces issues", () => {
    expect(parsePluginManifest(MINIMAL)).toEqual(MINIMAL);
    const result = safeParsePluginManifest({ ...MINIMAL, version: "nope" });
    expect(result.success).toBe(false);
    expect(() => parsePluginManifest({ ...MINIMAL, version: "nope" })).toThrow();
  });

  it("requires the capabilities object (no implicit empty set)", () => {
    const { capabilities: _omit, ...rest } = MINIMAL;
    expect(pluginManifestSchema.safeParse(rest).success).toBe(false);
  });
});

describe("summarizeCapabilities", () => {
  it("sums each capability family with plural rules", () => {
    expect(summarizeCapabilities(MINIMAL)).toBeNull();
    expect(summarizeCapabilities(FULL)).toBe(
      "1 export format · 1 importer · 2 commands · 1 widget",
    );
  });

  it("pluralizes and omits absent families", () => {
    const manifest: PluginManifest = {
      ...MINIMAL,
      capabilities: {
        commands: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
          { id: "c", label: "C" },
        ],
      },
    };
    expect(summarizeCapabilities(manifest)).toBe("3 commands");
  });
});
