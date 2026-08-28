# Plugins

Notees has a runtime plugin system that extends the backend and frontend without modifying core code. Plugins declare their contributions in a `manifest.json` file and are loaded from `data/plugins/` (user-installed) or built into the frontend bundle.

---

## Plugin manifest

A plugin manifest is a JSON file validated by `app/plugins/core/manifest.py` / `frontend/src/plugins/core/manifest.ts`. It declares metadata and the extension points the plugin contributes.

Key manifest fields:

| Field | Description |
|-------|-------------|
| `id` | Unique plugin identifier (no path separators). |
| `name` | Human-readable name. |
| `version` | Semantic version (`major.minor.patch`, numeric parts only). |
| `description` | Short description. |
| `author` | Plugin author. |
| `license` | Plugin license. |
| `minAppVersion` | Minimum compatible Notees version. |
| `permissions` | List of required permissions (see below). |
| `backend.entrypoint` | Path to the backend setup module. |
| `frontend.entrypoint` | Path to the frontend setup module. |
| `contributes` | Declarative list of extension points. |

### Permissions

Known permission names include:

- `read_nodes`, `write_nodes`
- `read_properties`, `write_properties`
- `read_assets`, `write_assets`
- `background_sync`
- `export`, `import`
- `router`
- `settings`

### Contributed extension points

| Contribution | Backend registry | Frontend registry | Description |
|--------------|------------------|-------------------|-------------|
| Importers | `PluginRegistry.add_importer` | `importerRegistry` | Import external data into Notees nodes. |
| Exporters | `PluginRegistry.add_exporter` | export format registry | Export Notees nodes to a custom format. |
| Sync sources | `PluginRegistry.add_sync_source` | — | Pull-only external sync source. |
| Routers | `PluginRegistry.add_router` | — | FastAPI router mounted under the plugin prefix. |
| Settings | `PluginRegistry.add_setting` | `PluginSettingsPanel` | Workspace-scoped plugin settings. |
| Commands | — | command registry | Commands available in the command palette. |
| Slash commands | — | slash-command registry | Slash commands in the editor. |
| Views | — | view registry | Top-level plugin views. |
| Sidebar items | — | sidebar registry | Sidebar navigation entries. |
| Class side effects | `PluginRegistry.add_class_side_effect` | — | React to class assignment/removal on a node. |

---

## Backend plugin system

The backend plugin runtime is in `app/plugins/core/`:

- `registry.py` — `PluginRegistry` holds loaded plugins and their contributions.
- `ports.py` — adapter interfaces (`ImporterAdapter`, `ExporterAdapter`, `SyncSource`, `SettingSchema`, `ClassSideEffectHandler`, etc.).
- `manifest.py` — Pydantic manifest validation.

Plugins implement the adapter interfaces from `ports.py` and receive a `PluginContext` with access to domain services. Plugins should never import PostgreSQL implementations directly.

### Importer adapter

```python
class ImporterAdapter(ABC):
    id: ClassVar[str] = ""
    label: ClassVar[str] = ""
    file_extensions: ClassVar[list[str]] = []

    @abstractmethod
    async def import_data(
        self,
        payload: bytes,
        content_type: str | None,
        context: ImportContext,
    ) -> ImportResult:
        ...
```

### Exporter adapter

```python
class ExporterAdapter(ABC):
    format_id: ClassVar[str] = ""
    label: ClassVar[str] = ""
    extension: ClassVar[str] = ""
    mime_type: ClassVar[str] = "application/octet-stream"

    @abstractmethod
    async def export_nodes(self, context: ExportContext) -> ExportResult:
        ...
```

### Sync source

```python
class SyncSource(ABC):
    id: ClassVar[str] = ""
    label: ClassVar[str] = ""

    @abstractmethod
    async def sync(self, context: SyncContext) -> SyncResult:
        ...
```

### Class side effects

A `ClassSideEffectHandler` is invoked when a class is assigned to or removed from a node. The context includes the node UUID, class UUID, workspace UUID, actor UUID, and whether the class was added or removed. Built-in flashcards use this mechanism to auto-create flashcard rows when a node is assigned the `card` class.

---

## Frontend plugin system

The frontend plugin runtime is in `frontend/src/plugins/core/`:

- `PluginManager.ts` — loads manifests and setup modules.
- `registries.ts` — frontend registries for commands, slash commands, views, sidebar items, importers, exporters, and settings.
- `hooks/` — React hooks for plugin state, installation, and lifecycle.
- `components/` — plugin manager UI (`PluginManagerModal`, `PluginSettingsPanel`, `PluginSettingsTab`).

Built-in plugins live under `frontend/src/plugins/builtin/`:

| Plugin | Path | Purpose |
|--------|------|---------|
| OPML exporter | `frontend/src/plugins/builtin/opml_exporter/` | Export node trees to OPML 2.0. |
| Flashcards | `frontend/src/plugins/builtin/flashcards/` | Cloze-deletion flashcard study UI. |
| Hello (sample) | `frontend/src/plugins/builtin/hello/` | Minimal example plugin. |
| BibTeX | `frontend/src/plugins/builtin/bibtex/` | BibTeX-related plugin stub. |
| Logseq importer | `frontend/src/plugins/builtin/logseq_importer/` | Logseq Markdown-folder importer. |
| Zotero | `frontend/src/plugins/builtin/zotero/` | Zotero integration stub. |

The OPML exporter (`notees.opml_exporter`) is registered as a built-in export format and consumes the already-fetched node tree through `ExportContext.nodes_data`.

---

## Installing plugins

User-installed plugins are loaded from `data/plugins/`. Each plugin is a folder containing a `manifest.json` and its entrypoint files. Enable or disable plugins through the **Plugin Manager** in the web app.

---

## Writing a plugin

1. Create a folder under `data/plugins/<plugin-id>/`.
2. Add a `manifest.json` with `id`, `name`, `version`, at least one entrypoint, and the contributions you need.
3. Implement the backend adapter(s) in the file referenced by `backend.entrypoint`.
4. Implement the frontend setup in the file referenced by `frontend.entrypoint`.
5. Register contributions through the provided `PluginContext` / registries.
6. Reload the app.

For the manifest schema and available permissions, see `app/plugins/core/manifest.py` and `frontend/src/plugins/core/manifest.ts`.
