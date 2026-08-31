"""Builtin ``bibliographic`` export provider (Decision 31).

Emits one file per selected attachment that passes ``asset_filter``, named
by ``filename_template``. System-field tokens (``{author}``, ``{title}``,
``{year}``, ``{citekey}``, ``{class}``, ``{extension}``/``{ext}``) resolve
from the source context; any other token resolves from a same-named user
property when defined (Decision 29). Missing tokens fall back to the title,
then the node UUID; filename collisions get deterministic suffixes;
attachment-less sources land in the skip report.
"""

from __future__ import annotations

from typing import Any

from app.domain.services.citekey import extract_year
from app.plugins.core.export import (
    ExportFile,
    ExportManifest,
    ExportNodeContext,
    ExportServices,
    SkippedNode,
)

from .templates import render_filename_template, resolve_filename_collisions

DEFAULT_FILENAME_TEMPLATE = "/{class}/{citekey}.{ext}"
DEFAULT_ROLES = ["representation"]

# System-field tokens resolved explicitly; everything else falls through to
# same-named user properties on the source (Decision 29).
_SYSTEM_TOKENS = {"author", "title", "year", "citekey", "class", "extension", "ext"}


def _extension_for(mime_type: str, original_name: str) -> str:
    """Derive a file extension from the original filename, then the MIME type."""
    if "." in original_name:
        suffix = original_name.rsplit(".", 1)[1].strip().lower()
        if suffix:
            return suffix
    from app.features.assets.utils import get_extension_from_content_type

    return get_extension_from_content_type(mime_type).lstrip(".") or "bin"


class BibliographicProvider:
    """v1 provider: bibliographic sources → one file per attachment."""

    id = "bibliographic"

    def generate_manifest(
        self,
        config: dict[str, Any],
        nodes: list[ExportNodeContext],
        services: ExportServices,
    ) -> ExportManifest:
        asset_filter = config.get("asset_filter") or {}
        roles = asset_filter.get("roles", DEFAULT_ROLES)
        mime_types = asset_filter.get("mime_types")
        template = str(config.get("filename_template") or DEFAULT_FILENAME_TEMPLATE)

        manifest = ExportManifest()
        # (asset_uuid, desired_path) candidates across all nodes; collisions
        # are resolved globally so two sources never claim the same path.
        candidates: list[tuple[str, str]] = []

        for node in sorted(nodes, key=lambda n: n.uuid):
            selected = [
                attachment
                for attachment in node.attachments
                if self._passes_filter(attachment, roles, mime_types)
            ]
            if not selected:
                manifest.skipped.append(
                    SkippedNode(
                        node_uuid=node.uuid,
                        title=node.title,
                        reason="no attachments match the asset filter",
                    )
                )
                continue
            for attachment in sorted(selected, key=lambda a: a.asset_uuid):
                tokens = self._tokens_for(node, attachment)
                rendered = render_filename_template(
                    template,
                    tokens,
                    title=node.title,
                    fallback_uuid=node.uuid,
                )
                candidates.append((attachment.asset_uuid, rendered))

        assigned = resolve_filename_collisions(candidates)
        for asset_uuid in sorted(assigned):
            manifest.files.append(
                ExportFile(asset_uuid=asset_uuid, relative_path=assigned[asset_uuid])
            )
        return manifest

    @staticmethod
    def _passes_filter(attachment: Any, roles: Any, mime_types: Any) -> bool:
        if roles:
            allowed = {str(role).lower() for role in roles}
            if (attachment.role or "").lower() not in allowed:
                return False
        if mime_types:
            allowed_mimes = {str(mime).lower() for mime in mime_types}
            if attachment.mime_type.lower() not in allowed_mimes:
                return False
        return True

    @staticmethod
    def _tokens_for(node: ExportNodeContext, attachment: Any) -> dict[str, str | None]:
        properties = node.properties or {}
        author = properties.get("author") or properties.get("authors")
        if isinstance(author, list):
            author = author[0] if author else None
        publication_date = properties.get("publication_date")
        tokens: dict[str, str | None] = {
            "author": str(author) if author else None,
            "title": node.title or None,
            "year": extract_year(str(publication_date)) if publication_date else None,
            "citekey": str(properties.get("citekey") or "") or None,
            "class": node.class_names[0] if node.class_names else None,
            "extension": _extension_for(attachment.mime_type, attachment.original_name),
        }
        # Decision 29: any same-named user property is available as a token
        # (e.g. {series}); system tokens win on name clashes.
        for name, value in properties.items():
            if name in tokens or not isinstance(name, str):
                continue
            if value is None:
                continue
            if isinstance(value, list):
                tokens[name] = ", ".join(str(v) for v in value) or None
            else:
                tokens[name] = str(value)
        return tokens
