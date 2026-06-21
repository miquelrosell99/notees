"""Plugin manifest validation."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class _PluginBaseModel(BaseModel):
    """Base model that accepts both camelCase JSON aliases and snake_case names."""

    model_config = ConfigDict(populate_by_name=True)


class PluginBackendManifest(_PluginBaseModel):
    """Backend-specific manifest section."""

    entrypoint: str | None = None
    dependencies: list[str] = Field(default_factory=list)


class PluginFrontendManifest(_PluginBaseModel):
    """Frontend-specific manifest section."""

    entrypoint: str | None = None
    css: list[str] = Field(default_factory=list)


class ContributedSetting(_PluginBaseModel):
    """Setting contributed by a plugin."""

    id: str
    type: str = "string"
    label: str
    default: Any = None
    options: list[dict[str, Any]] = Field(default_factory=list)
    description: str | None = None
    required: bool = False


class ContributedCommand(_PluginBaseModel):
    """Command contributed by a plugin."""

    id: str
    label: str
    icon: str | None = None


class ContributedSlashCommand(_PluginBaseModel):
    """Slash command contributed by a plugin."""

    id: str
    label: str
    description: str | None = None


class ContributedImporter(_PluginBaseModel):
    """Importer contributed by a plugin."""

    id: str
    label: str
    file_extensions: list[str] = Field(default_factory=list, alias="fileExtensions")


class ContributedExporter(_PluginBaseModel):
    """Exporter contributed by a plugin."""

    id: str
    label: str
    extension: str
    mime_type: str = Field(default="application/octet-stream", alias="mimeType")


class ContributedView(_PluginBaseModel):
    """Top-level view contributed by a plugin."""

    id: str
    label: str
    icon: str | None = None


class ContributedSidebarItem(_PluginBaseModel):
    """Sidebar item contributed by a plugin."""

    id: str
    label: str
    icon: str | None = None
    view_id: str = Field(alias="viewId")


class PluginContributesManifest(_PluginBaseModel):
    """Declarative list of extension points contributed by a plugin."""

    settings: list[ContributedSetting] = Field(default_factory=list)
    commands: list[ContributedCommand] = Field(default_factory=list)
    slash_commands: list[ContributedSlashCommand] = Field(
        default_factory=list, alias="slashCommands"
    )
    importers: list[ContributedImporter] = Field(default_factory=list)
    export_formats: list[ContributedExporter] = Field(
        default_factory=list, alias="exportFormats"
    )
    views: list[ContributedView] = Field(default_factory=list)
    sidebar_items: list[ContributedSidebarItem] = Field(
        default_factory=list, alias="sidebarItems"
    )


class PluginManifest(_PluginBaseModel):
    """Validated plugin manifest."""

    id: str
    name: str
    version: str
    description: str = ""
    author: str = ""
    license: str = ""
    min_app_version: str = Field(default="", alias="minAppVersion")
    permissions: list[str] = Field(default_factory=list)
    backend: PluginBackendManifest = Field(default_factory=PluginBackendManifest)
    frontend: PluginFrontendManifest = Field(default_factory=PluginFrontendManifest)
    contributes: PluginContributesManifest = Field(
        default_factory=PluginContributesManifest
    )
    builtin: bool = False
    enabled_by_default: bool = Field(default=False, alias="enabledByDefault")

    @field_validator("permissions")
    @classmethod
    def validate_permissions(cls, v: list[str]) -> list[str]:
        known = {
            "read_nodes",
            "write_nodes",
            "read_properties",
            "write_properties",
            "read_assets",
            "write_assets",
            "background_sync",
            "export",
            "import",
            "router",
            "settings",
        }
        for permission in v:
            if permission not in known:
                raise ValueError(f"Unknown permission: {permission}")
        return v

    @field_validator("id")
    @classmethod
    def validate_id(cls, v: str) -> str:
        if not v:
            raise ValueError("Plugin id is required")
        if "/" in v or "\\" in v:
            raise ValueError("Plugin id cannot contain path separators")
        return v

    @field_validator("version")
    @classmethod
    def validate_version(cls, v: str) -> str:
        # Minimal SemVer-like validation: at least major.minor.patch digits.
        parts = v.split(".")
        if len(parts) < 2:
            raise ValueError("Plugin version must follow semantic versioning (e.g., 1.0.0)")
        for part in parts:
            if not part.isdigit():
                raise ValueError(f"Plugin version part must be numeric: {part}")
        return v

    @model_validator(mode="after")
    def validate_entrypoints(self) -> PluginManifest:
        if not self.backend.entrypoint and not self.frontend.entrypoint:
            raise ValueError("Plugin must declare at least one backend or frontend entrypoint")
        return self

    @property
    def safe_id(self) -> str:
        """Return a filesystem-safe identifier."""
        return self.id.replace(".", "_")

    @classmethod
    def from_file(cls, path: Path) -> PluginManifest:
        """Load and validate a manifest from a JSON file."""
        import json

        data = json.loads(path.read_text(encoding="utf-8"))
        return cls.model_validate(data)
