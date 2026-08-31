"""Core-owned asset metadata orchestration (Decision 30).

MIME-registered plugin handlers (see :mod:`app.plugins.core.metadata`) operate
on streams only; this service owns everything around them:

- resolving an asset node to its blob stream,
- mapping the handler's metadata dict onto a source node's properties
  (title → node content, authors → find-or-create agent nodes, system
  properties, same-named user schemas for extras — never creating schemas),
- gathering a source node's properties for the inject direction (including the
  ``cover`` property's blob),
- storage, hashing, and ``blob_ref`` updates: inject writes the modified bytes
  as a new CAS blob and points the asset node at it via the ordinary
  ``asset.delete`` + ``asset.upload`` operations, keeping the node's identity;
  the old blob is dropped through normal CAS reference counting.
"""

from __future__ import annotations

import hashlib
import json
from io import BytesIO
from typing import TYPE_CHECKING, Any, BinaryIO

from PIL import Image

from app.core.uuid import uuidv7
from app.core.workspace_store import WorkspaceStore
from app.domain.entities.constants import SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS
from app.domain.stringify_ast import ParseMode, parse_ast
from app.features.assets.service import AssetMissingError, AssetService
from app.logging_config import get_logger
from app.plugins.core.metadata import SYSTEM_METADATA_KEYS, AssetMetadataHandler

if TYPE_CHECKING:
    from app.plugins.core.registry import PluginRegistry

logger = get_logger(__name__)

ATTACHMENTS_SCHEMA_UUID = SYSTEM_PROPERTY_UUIDS["attachments"]
COVER_SCHEMA_UUID = SYSTEM_PROPERTY_UUIDS["cover"]
AUTHORS_SCHEMA_UUID = SYSTEM_PROPERTY_UUIDS["authors"]

# PIL format → MIME type for sniffed cover images.
_IMAGE_FORMAT_MIME = {
    "JPEG": "image/jpeg",
    "PNG": "image/png",
    "GIF": "image/gif",
    "WEBP": "image/webp",
}

_IMAGE_MIME_EXTENSION = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
}


class AssetMetadataNotSupportedError(Exception):
    """No metadata handler is registered for the asset's MIME type."""


def _content_to_text(raw_content: str | None) -> str | None:
    """Extract plain text from a node's JSON content, falling back to None."""
    if not raw_content:
        return None
    try:
        content = json.loads(raw_content)
    except (ValueError, TypeError):
        return None

    def _walk(node: Any) -> str:
        if isinstance(node, dict):
            if "text" in node:
                text = node["text"]
                return text if isinstance(text, str) else ""
            return "".join(_walk(child) for child in node.get("children", []))
        if isinstance(node, list):
            return "".join(_walk(child) for child in node)
        return ""

    text = _walk(content).strip()
    return text or None


def split_creator_name(name: str) -> dict[str, str]:
    """Normalize a free-form creator name into the agents helper shape.

    ``"Herbert, Frank"`` and ``"Frank Herbert"`` both yield
    ``{"given_name": "Frank", "family_name": "Herbert"}``; single-token names
    land in ``family_name``.
    """
    name = name.strip()
    if "," in name:
        family, _, given = name.partition(",")
        return {"given_name": given.strip(), "family_name": family.strip()}
    parts = name.split()
    if len(parts) <= 1:
        return {"given_name": "", "family_name": name}
    return {"given_name": " ".join(parts[:-1]), "family_name": parts[-1]}


class AssetMetadataService:
    """Orchestrates extract/inject between asset blobs and source nodes."""

    def __init__(
        self,
        store: WorkspaceStore,
        asset_service: AssetService,
        registry: PluginRegistry | None = None,
    ) -> None:
        self._store = store
        self._asset_service = asset_service
        if registry is None:
            # Late import: the manager imports app.config, which must not load
            # at module import time in tests.
            from app.plugins.core.manager import plugin_manager

            registry = plugin_manager.registry
        self._registry = registry

    # ── Handler / blob resolution ───────────────────────────────────────────

    async def _get_asset_row(self, asset_uuid: str) -> dict[str, Any]:
        await self._store.sync()
        rows = await self._store.query(
            "SELECT node_id, asset_hash, mime_type, size, original_name FROM node_asset WHERE node_id = ?",
            (asset_uuid,),
        )
        if not rows:
            raise AssetMissingError("Asset not found")
        return dict(rows[0])

    def _get_handler(self, mime_type: str) -> AssetMetadataHandler:
        entry = self._registry.get_asset_metadata_handler(mime_type)
        if entry is None:
            raise AssetMetadataNotSupportedError(f"No metadata handler registered for MIME type '{mime_type}'")
        return entry[1]

    def _read_blob(self, asset_hash: str) -> bytes:
        path = self._asset_service.file_service.find_source_file(asset_hash)
        if path is None:
            raise AssetMissingError("Asset file not found")
        return path.read_bytes()

    async def find_referencing_sources(self, asset_uuid: str) -> list[str]:
        """Return node UUIDs whose ``attachments`` property references the asset."""
        await self._store.sync()
        rows = await self._store.query(
            "SELECT DISTINCT node_id FROM property_value WHERE property_schema_id = ? AND value = ?",
            (ATTACHMENTS_SCHEMA_UUID, json.dumps(asset_uuid)),
        )
        return [row["node_id"] for row in rows]

    # ── Extract direction (file → source) ───────────────────────────────────

    async def extract(self, asset_uuid: str) -> dict[str, Any]:
        """Run the MIME handler's ``extract`` over the asset blob."""
        row = await self._get_asset_row(asset_uuid)
        handler = self._get_handler(row["mime_type"])
        return handler.extract(BytesIO(self._read_blob(row["asset_hash"])))

    async def extract_cover(self, asset_uuid: str) -> tuple[bytes, str] | None:
        """Return the embedded cover image ``(bytes, mime_type)``, if any."""
        row = await self._get_asset_row(asset_uuid)
        handler = self._get_handler(row["mime_type"])
        cover_stream = handler.extract_cover(BytesIO(self._read_blob(row["asset_hash"])))
        if cover_stream is None:
            return None
        data = cover_stream.read()
        mime_type = sniff_image_mime(data)
        if mime_type is None:
            logger.warning("Cover image in asset %s has an unsupported format", asset_uuid)
            return None
        return data, mime_type

    async def apply_extract_to_source(self, asset_uuid: str, source_uuid: str) -> dict[str, Any]:
        """Extract metadata from the asset and apply it to the source node.

        Returns a summary of the applied fields. Extras land on same-named
        user property schemas only; schemas are never created (Decision 29).
        """
        metadata = await self.extract(asset_uuid)
        applied: dict[str, Any] = {}

        title = metadata.get("title")
        if title:
            await self._store.update_content(source_uuid, parse_ast(str(title), ParseMode.PLAIN))
            applied["title"] = title

        authors = [str(a).strip() for a in metadata.get("authors") or [] if str(a).strip()]
        if authors:
            author_uuids = [await self._find_or_create_agent(split_creator_name(name)) for name in authors]
            await self._set_single_or_multi(source_uuid, AUTHORS_SCHEMA_UUID, author_uuids)
            applied["authors"] = authors

        for key in ("publisher", "publication_date", "isbn", "doi"):
            value = metadata.get(key)
            if value:
                await self._store.set_property(
                    property_value_id=uuidv7(),
                    node_id=source_uuid,
                    schema_id=SYSTEM_PROPERTY_UUIDS[key],
                    value=str(value),
                )
                applied[key] = value

        schema_by_name = await self._user_schemas_by_name()
        for key, value in metadata.items():
            if key in SYSTEM_METADATA_KEYS or value in (None, "", []):
                continue
            schema = schema_by_name.get(key.lower())
            if schema is None:
                continue  # No user schema with this name: extra is ignored.
            values = value if isinstance(value, list) else [value]
            await self._set_single_or_multi(
                source_uuid, schema["id"], [str(v) for v in values], multi=bool(schema["multi"])
            )
            applied[key] = value

        cover = await self.extract_cover(asset_uuid)
        if cover is not None:
            cover_uuid = await self._refresh_source_cover(source_uuid, cover[0], cover[1])
            if cover_uuid is not None:
                applied["cover"] = cover_uuid

        await self._store.sync()
        return {"source_uuid": source_uuid, "applied": applied}

    # ── Inject direction (source → file) ────────────────────────────────────

    async def inject_from_source(self, asset_uuid: str, source_uuid: str) -> dict[str, Any]:
        """Write the source node's metadata into the asset blob.

        The asset node keeps its identity; its blob/hash is replaced via the
        ordinary ``asset.delete`` + ``asset.upload`` ops. Re-injecting
        unchanged metadata is a no-op (the CAS hash is unchanged).
        """
        row = await self._get_asset_row(asset_uuid)
        handler = self._get_handler(row["mime_type"])

        properties = await self._gather_source_properties(source_uuid, handler)
        cover_stream = await self._source_cover_stream(source_uuid)

        new_stream = handler.inject(BytesIO(self._read_blob(row["asset_hash"])), properties, cover_stream)
        new_bytes = new_stream.read()

        file_service = self._asset_service.file_service
        new_hash = hashlib.sha256(new_bytes).hexdigest()
        old_hash = row["asset_hash"]
        if new_hash == old_hash:
            return {"asset_uuid": asset_uuid, "changed": False, "asset_hash": old_hash}

        # CAS write first; emit ops only after the bytes are durable.
        await file_service.create_asset(
            file_bytes=new_bytes,
            original_filename=row["original_name"],
            content_type=row["mime_type"],
        )
        try:
            await self._store.delete_asset(asset_uuid, asset_uuid)
            await self._store.upload_asset(
                asset_id=asset_uuid,
                node_id=asset_uuid,
                file_hash=new_hash,
                mime_type=row["mime_type"],
                size=len(new_bytes),
                original_name=row["original_name"],
            )
            await self._store.sync()
        except Exception:
            await file_service.delete_asset(new_hash)
            raise

        # Drop the old blob reference through normal CAS rules.
        await file_service.delete_asset(old_hash)
        return {"asset_uuid": asset_uuid, "changed": True, "asset_hash": new_hash}

    # ── Source property mapping helpers ─────────────────────────────────────

    async def _get_node_row(self, node_uuid: str) -> dict[str, Any] | None:
        rows = await self._store.query(
            "SELECT id, content, class_ids FROM node WHERE id = ? AND active = 1",
            (node_uuid,),
        )
        return dict(rows[0]) if rows else None

    async def _get_property_values(self, node_uuid: str, schema_uuid: str) -> list[Any]:
        rows = await self._store.query(
            "SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ? ORDER BY idx",
            (node_uuid, schema_uuid),
        )
        return [json.loads(row["value"]) for row in rows]

    async def _set_single_or_multi(
        self, node_uuid: str, schema_uuid: str, values: list[Any], multi: bool = True
    ) -> None:
        """Set values convergently (one row per index), like set_multi_property."""
        if not multi:
            values = values[:1]
        existing = await self._get_property_values(node_uuid, schema_uuid)
        for index, value in enumerate(values):
            if index < len(existing) and existing[index] == value:
                continue
            await self._store.set_property(
                property_value_id=uuidv7(),
                node_id=node_uuid,
                schema_id=schema_uuid,
                value=value,
                index=index,
            )
        for index in range(len(values), len(existing)):
            await self._store.unset_property(node_uuid, schema_uuid, index=index)

    async def _find_or_create_agent(self, creator: dict[str, str]) -> str:
        """Find-or-create a ``person`` node for the creator (dedupe by name)."""
        given = creator.get("given_name", "").strip()
        family = creator.get("family_name", "").strip()
        name = f"{given} {family}".strip()
        person_class_uuid = SYSTEM_CLASS_UUIDS["person"]

        rows = await self._store.query("SELECT id, content, class_ids FROM node WHERE active = 1")
        for row in rows:
            if _content_to_text(row["content"]) != name:
                continue
            if person_class_uuid in set(json.loads(row["class_ids"]) or []):
                return row["id"]

        node_uuid = uuidv7()
        await self._store.create_node(
            node_id=node_uuid,
            kind="page",
            initial_content=[{"type": "paragraph", "children": [{"text": name}]}],
            class_ids=[person_class_uuid],
        )
        property_values: dict[str, str] = {}
        if given:
            property_values[SYSTEM_PROPERTY_UUIDS["given_name"]] = given
        if family:
            property_values[SYSTEM_PROPERTY_UUIDS["family_name"]] = family
        for schema_uuid, value in property_values.items():
            await self._store.set_property(
                property_value_id=uuidv7(),
                node_id=node_uuid,
                schema_id=schema_uuid,
                value=value,
            )
        return node_uuid

    async def _user_schemas_by_name(self) -> dict[str, dict[str, Any]]:
        """Map lowercased names of active non-system schemas to their rows."""
        rows = await self._store.query("SELECT id, name, multi FROM property_schema WHERE active = 1 AND is_system = 0")
        return {(row["name"] or "").lower(): dict(row) for row in rows if row["name"]}

    async def _gather_source_properties(self, source_uuid: str, handler: AssetMetadataHandler) -> dict[str, Any]:
        """Build the handler properties dict from the source node."""
        await self._store.sync()
        node_row = await self._get_node_row(source_uuid)
        if node_row is None:
            raise AssetMissingError("Source node not found")

        properties: dict[str, Any] = {}
        title = _content_to_text(node_row["content"])
        if title:
            properties["title"] = title

        author_uuids = await self._get_property_values(source_uuid, AUTHORS_SCHEMA_UUID)
        authors: list[str] = []
        for author_uuid in author_uuids:
            author_row = await self._get_node_row(str(author_uuid))
            if author_row is None:
                continue
            name = _content_to_text(author_row["content"])
            if name:
                authors.append(name)
        if authors:
            properties["authors"] = authors

        for key in ("publisher", "publication_date", "isbn", "doi"):
            values = await self._get_property_values(source_uuid, SYSTEM_PROPERTY_UUIDS[key])
            if values and values[0] not in (None, ""):
                properties[key] = str(values[0])

        # Extras round-trip only through same-named user schemas the handler
        # declares support for; schemas are never created (Decision 29).
        schema_by_name = await self._user_schemas_by_name()
        for field in handler.extra_fields:
            schema = schema_by_name.get(field.lower())
            if schema is None:
                continue
            values = await self._get_property_values(source_uuid, schema["id"])
            values = [v for v in values if v not in (None, "")]
            if not values:
                continue
            properties[field] = values if schema["multi"] else values[0]

        return properties

    async def _source_cover_stream(self, source_uuid: str) -> BinaryIO | None:
        """Open the blob stream of the source's ``cover`` asset, if set."""
        values = await self._get_property_values(source_uuid, COVER_SCHEMA_UUID)
        if not values or not values[0]:
            return None
        rows = await self._store.query(
            "SELECT asset_hash FROM node_asset WHERE node_id = ?",
            (str(values[0]),),
        )
        if not rows:
            return None
        path = self._asset_service.file_service.find_source_file(rows[0]["asset_hash"])
        if path is None:
            return None
        return path.open("rb")

    async def _refresh_source_cover(self, source_uuid: str, cover_bytes: bytes, cover_mime: str) -> str | None:
        """Point the source's ``cover`` at an asset holding ``cover_bytes``.

        Returns the cover asset node UUID, or None when the existing cover
        already holds identical bytes (content-hash comparison keeps repeated
        extracts from piling up duplicate cover asset nodes).
        """
        new_hash = hashlib.sha256(cover_bytes).hexdigest()

        current = await self._get_property_values(source_uuid, COVER_SCHEMA_UUID)
        if current and current[0]:
            rows = await self._store.query(
                "SELECT asset_hash FROM node_asset WHERE node_id = ?",
                (str(current[0]),),
            )
            if rows and rows[0]["asset_hash"] == new_hash:
                return None

        extension = _IMAGE_MIME_EXTENSION.get(cover_mime, ".jpg")
        asset = await self._asset_service.upload_asset(
            file_bytes=cover_bytes,
            filename=f"cover{extension}",
            content_type=cover_mime,
        )
        await self._store.set_property(
            property_value_id=uuidv7(),
            node_id=source_uuid,
            schema_id=COVER_SCHEMA_UUID,
            value=asset["uuid"],
        )
        return asset["uuid"]


def sniff_image_mime(data: bytes) -> str | None:
    """Return the MIME type of image bytes via PIL, or None if unrecognized."""
    try:
        with Image.open(BytesIO(data)) as img:
            return _IMAGE_FORMAT_MIME.get(img.format or "")
    except Exception:  # noqa: BLE001 - any PIL/codec failure means "not an image we handle"
        return None
