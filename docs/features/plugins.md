# Plugins

**Workspace Settings → Plugins** — the plugin registry (owner/admin only — the **Admin settings** entry in the account popup): installed manifests list with their declared capabilities (export formats, importers, commands, widgets) and an enable toggle, plus an "Install manifest" paste-JSON box validated against the manifest grammar before anything is stored.

The registry is honest scaffolding — the plugin *runtime* that would execute a manifest is not built yet, so installing stores validated data and an enable flag, nothing more. The registry's HTTP surface enforces the reserved `admin` API-key scope ([api.md](../api.md)); why core flows never depend on plugins is [philosophy.md](../philosophy.md)'s ("What we took — and the wounds that became our rules").
