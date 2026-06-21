# Notees Plugin System

This document describes the Notees plugin architecture: how plugins are packaged, loaded, and how they extend both the backend and the frontend.

## Overview

Notees plugins are optional, self-contained packages that can add features without modifying core code. They follow a declarative manifest + imperative setup pattern similar to Obsidian, VS Code, and Zotero plugins:

- **`manifest.json`** describes the plugin, its permissions, and the extension points it contributes.
- **`setup(context)`** (backend and/or frontend) wires runtime behavior by registering commands, views, importers, routers, etc.

Plugins are failure-isolated: a missing optional dependency or a plugin that throws during setup disables only that plugin; core note-taking continues to work.

## Plugin locations

Plugins can live in three places:

| Location | Purpose |
|---|---|
| `app/plugins/builtin/` | Built-in plugins shipped with Notees (e.g., Flashcards, Zotero, BibTeX). |
| `data/plugins/` | User-installed plugins. This directory is gitignored and survives updates. |
| `frontend/src/plugins/builtin/` | Frontend half of built-in plugins. |

Backend plugins are Python packages. Frontend plugins are TypeScript/JavaScript modules that are either bundled with the app or loaded dynamically from `data/plugins/<id>/dist/`.

## Manifest format

Every plugin must contain a `manifest.json` at its root:

```json
{
  "id": "notees.zotero",
  "name": "Zotero Connector",
  "version": "1.0.0",
  "description": "Sync Zotero libraries and cite items in the editor.",
  "author": "Notees",
  "license": "AGPL-3.0",
  "min_app_version": "0.9.0",
  "permissions": ["read_nodes", "write_nodes", "read_properties", "background_sync"],
  "backend": {
    "entrypoint": "zotero_plugin:setup",
    "dependencies": ["pyzotero>=1.5.0"]
  },
  "frontend": {
    "entrypoint": "./dist/plugin.js",
    "css": ["./dist/plugin.css"]
  },
  "contributes": {
    "settings": [
      {"id": "zotero_api_url", "type": "string", "label": "Zotero local API URL", "default": "http://127.0.0.1:23119/"}
    ],
    "commands": [
      {"id": "zotero.openSettings", "label": "Zotero: Open settings", "icon": "bookshelf"}
    ],
    "slashCommands": [
      {"id": "zotero.cite", "label": "Cite from Zotero"}
    ],
    "importers": [
      {"id": "zotero.library", "label": "Zotero library"}
    ],
    "exportFormats": [],
    "views": [],
    "sidebarItems": []
  }
}
```

### Manifest fields

| Field | Required | Description |
|---|---|---|
| `id` | yes | Unique reverse-DNS identifier. Must be stable across versions. |
| `name` | yes | Human-readable name. |
| `version` | yes | SemVer version string. |
| `description` | no | Short description shown in the plugin manager. |
| `author` | no | Author or organization. |
| `license` | no | SPDX license identifier. |
| `min_app_version` | no | Minimum Notees app version required. |
| `permissions` | no | Array of permission strings (see below). |
| `backend.entrypoint` | no | Dotted path to a `setup(context)` callable. |
| `backend.dependencies` | no | Optional Python packages. Missing deps disable the backend half only. |
| `frontend.entrypoint` | no | Relative path to the plugin's JS entry point. |
| `frontend.css` | no | Array of CSS files to inject. |
| `contributes.*` | no | Declarative list of contributed extension points. |

## Permissions

Permissions are declared in the manifest and validated when a plugin registers an extension point. A plugin cannot register a capability it has not declared.

| Permission | Allows |
|---|---|
| `read_nodes` | Read nodes via `NodeService` / `NodeRepository`. |
| `write_nodes` | Create, update, delete nodes. |
| `read_properties` | Read property definitions and values. |
| `write_properties` | Create or update property definitions and values. |
| `read_assets` | Read assets. |
| `write_assets` | Upload or delete assets. |
| `background_sync` | Register a sync source that runs outside request scope. |
| `export` | Register an export format adapter. |
| `import` | Register an importer adapter. |
| `router` | Register a FastAPI router. |
| `settings` | Register workspace-scoped plugin setting schemas. |

## Backend plugins

A backend plugin is a Python package with a `setup(context: PluginContext)` function exposed by `backend.entrypoint`.

### `PluginContext` API

```python
from app.plugins.core.context import PluginContext

async def setup(context: PluginContext) -> None:
    # Register a FastAPI router
    context.register_router(router, prefix="zotero")

    # Register an importer
    context.register_importer(ZoteroImporter())

    # Register a sync source
    context.register_sync_source(ZoteroSyncSource())

    # Register a workspace setting schema
    context.register_setting(SettingSchema(id="zotero_api_url", type="string", label="..."))

    # React to class assignment
    context.register_node_class_side_effect(
        class_uuid=SYSTEM_CLASS_UUIDS.card,
        handler=on_card_class_assigned,
    )

    # Access core domain services
    node_service = context.get_port("NodeService")
```

### Ports

Plugins receive core services through a port lookup rather than concrete imports:

- `NodeService`
- `PropertyService`
- `AssetService`
- `ExportService`
- `WorkspaceIOService`

This preserves the hexagonal architecture: plugins depend on abstractions, not PostgreSQL implementations.

### Importer adapter

```python
from app.plugins.core.ports import ImporterAdapter, ImportResult

class ZoteroImporter(ImporterAdapter):
    id = "zotero.library"
    label = "Zotero library"

    async def import_data(self, payload: bytes, content_type: str | None, context: ImportContext) -> ImportResult:
        ...
```

### Sync source

```python
from app.plugins.core.ports import SyncSource, SyncResult

class ZoteroSyncSource(SyncSource):
    id = "zotero.library"
    label = "Zotero library"

    async def sync(self, context: SyncContext) -> SyncResult:
        ...
```

## Frontend plugins

A frontend plugin is a JavaScript/TypeScript module that exports a `setup(context: PluginContext)` function.

### `PluginContext` API

```typescript
import type { PluginContext } from '@/plugins/core';

export function setup(context: PluginContext) {
  // Command palette
  context.registerCommand({
    id: 'zotero.openSettings',
    label: 'Zotero: Open settings',
    icon: 'bookshelf',
    execute: () => { ... },
  });

  // Editor slash command
  context.registerSlashCommand({
    id: 'zotero.cite',
    label: 'Cite from Zotero',
    execute: ({ editor, blockServerId }) => { ... },
  });

  // Settings tab
  context.registerSettingTab({
    id: 'zotero',
    label: 'Zotero',
    component: ZoteroSettings,
  });

  // Top-level view
  context.registerView({
    id: 'zotero-library',
    label: 'Zotero Library',
    component: ZoteroLibraryView,
  });
}
```

### Loading

Built-in frontend plugins are bundled with the app. User-installed plugins are loaded dynamically:

1. `PluginManager` fetches manifests from `GET /api/plugins`.
2. For each enabled plugin with a `frontend.entrypoint`, it performs a dynamic `import()` of the plugin's `dist/plugin.js`.
3. It calls the exported `setup(context)` function.

### Runtime lifecycle

Administrators can load, unload, reload, update, and uninstall plugins at runtime through the Plugin Manager modal or the REST API:

| Endpoint | Method | Description |
|---|---|---|
| `/api/plugins/{id}/load` | `POST` | Activate an installed plugin without restarting. |
| `/api/plugins/{id}/unload` | `POST` | Deactivate a loaded plugin. |
| `/api/plugins/{id}/reload` | `POST` | Refresh a plugin's code and re-register contributions. |
| `/api/plugins/{id}/update` | `POST` | Run `git pull` in the plugin directory and reload. |
| `/api/plugins/{id}` | `DELETE` | Unload and delete a user-installed plugin. |

On the frontend, `PluginManager` mirrors these operations: `loadPlugin`, `unloadPlugin`, and `reloadPlugin` call the backend endpoints, import the plugin bundle, run `setup(context)`, and clean up registered contributions on unload.

### Auto-registered contributions

Plugins do not need frontend code for declarative contributions. When a plugin manifest includes:

- `contributes.settings` — a generic **Settings** tab is automatically added to the user settings modal. The tab renders a typed form from the setting schemas and persists values per workspace via `PUT /api/plugins/{id}/settings/{key}`.
- `contributes.exportFormats` — each exporter is automatically registered in the export format registry and appears as a tab in the export modal. Selecting the tab triggers the plugin's backend `ExporterAdapter`.
- `contributes.importers` — each importer is automatically listed in the unified **Import Workspace** modal and can import a file into the current workspace via `POST /api/plugins/import/{importer_id}`.

Plugins can still override these defaults by calling `context.registerSettingsTab`, `context.registerExportFormat`, or `context.registerImporter` in their own `setup()`.

### Plugin settings API

```typescript
import { usePluginSettings, useSetPluginSetting } from '@/plugins/core';

function MyPluginPanel({ pluginId }: { pluginId: string }) {
  const { data: settings } = usePluginSettings(pluginId);
  const setSetting = useSetPluginSetting(pluginId);
  // settings is an array of { id, type, label, description, default, options, value }
}
```

## Security model

- **Permissions are mandatory.** The backend validates that a plugin only uses extension points allowed by its manifest permissions.
- **User-installed plugins are opt-in.** They are discovered at startup but remain disabled until explicitly enabled in the plugin manager.
- **Optional dependencies are lazy.** A missing `pyzotero` only disables the Zotero plugin; core keeps running.
- **Routers are namespaced.** Plugin routes are mounted under `/api/plugins/<plugin-id>/`.
- **CSP for frontend bundles.** User plugin JS is served from `data/plugins/` and should be restricted by a strict Content-Security-Policy. See `docs/SECURITY.md` for CSP guidance.

## Moving an internal feature to a plugin

1. Move backend code from `app/features/<feature>/` to `app/plugins/builtin/<feature>/`.
2. Add a `manifest.json` with appropriate permissions.
3. Expose `setup(context)` that registers routers, settings, commands, side effects, etc.
4. Move frontend code from `frontend/src/features/<feature>/` to `frontend/src/plugins/builtin/<feature>/`.
5. Add a `setup(context)` that registers views, sidebar items, commands, etc.
6. Remove hardcoded imports from core files (`MainContentPane.tsx`, `NavigationSidebar.tsx`, `main.py`, etc.).
7. Update tests and run the full suite.

## Examples

See the built-in plugins for working examples:

- `app/plugins/builtin/flashcards/` — migrated internal feature.
- `app/plugins/builtin/zotero/` — external service sync.
- `app/plugins/builtin/bibtex/` — file-based importer/exporter.
- `app/plugins/builtin/koreader/` — device sync.
- `app/plugins/builtin/logseq_importer/` — folder importer.

## Future work

- Plugin marketplace: read a remote JSON catalog and offer one-click install.
- Dependency resolution and automatic virtual-environment isolation for user plugins.
- Sandboxed execution for untrusted plugins.
