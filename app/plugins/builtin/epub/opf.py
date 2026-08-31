"""EPUB (OCF/OPF) metadata reading and writing with the standard library.

An EPUB is a ZIP container: ``META-INF/container.xml`` points at the OPF
package document whose ``<metadata>`` holds Dublin Core elements. This module
parses and rewrites that document with :mod:`zipfile` + :mod:`xml.etree` —
no third-party EPUB dependency.

Determinism: rewritten archives use a fixed entry timestamp and preserve the
original entry order, so injecting unchanged properties yields byte-identical
output (the core dedupes blobs by content hash).
"""

from __future__ import annotations

import zipfile
from io import BytesIO
from typing import Any
from xml.etree import ElementTree as ET

from app.plugins.core.metadata import AssetMetadataError

DC = "http://purl.org/dc/elements/1.1/"
OPF = "http://www.idpf.org/2007/opf"
CONTAINER_NS = "urn:oasis:names:tc:opendocument:xmlns:container"

# Fixed ZIP entry timestamp (DOS epoch) for deterministic rewrites.
_FIXED_DATE_TIME = (1980, 1, 1, 0, 0, 0)

# Manifest item id / metadata meta name used for the cover image.
_COVER_ITEM_ID = "notees-cover"
_COVER_META_NAME = "cover"  # EPUB 2 convention: <meta name="cover" content="<item id>"/>
_SERIES_META_NAME = "calibre:series"  # de-facto standard series field

ET.register_namespace("dc", DC)
ET.register_namespace("opf", OPF)


def _detect_image_mime(data: bytes) -> str | None:
    """Sniff the MIME type of cover image bytes from magic bytes."""
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def _image_extension(mime_type: str) -> str:
    return {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/gif": ".gif",
        "image/webp": ".webp",
    }.get(mime_type, ".jpg")


class _EpubPackage:
    """Parsed view of an EPUB archive."""

    def __init__(self, data: bytes) -> None:
        try:
            self._zip = zipfile.ZipFile(BytesIO(data))
        except zipfile.BadZipFile as exc:
            raise AssetMetadataError("Not a valid EPUB (ZIP) file") from exc
        try:
            container = ET.fromstring(self._zip.read("META-INF/container.xml"))
        except (KeyError, ET.ParseError) as exc:
            raise AssetMetadataError("EPUB is missing META-INF/container.xml") from exc
        rootfile = container.find(f"{{{CONTAINER_NS}}}rootfiles/{{{CONTAINER_NS}}}rootfile")
        if rootfile is None or not rootfile.get("full-path"):
            raise AssetMetadataError("EPUB container.xml has no rootfile")
        self.opf_path = rootfile.get("full-path", "")
        try:
            self.opf_tree = ET.ElementTree(ET.fromstring(self._zip.read(self.opf_path)))
        except (KeyError, ET.ParseError) as exc:
            raise AssetMetadataError(f"EPUB OPF document unreadable: {exc}") from exc
        # Directory prefix for hrefs relative to the OPF file ("" or "OEBPS/").
        self.opf_dir = self.opf_path.rsplit("/", 1)[0] + "/" if "/" in self.opf_path else ""

    @property
    def _metadata_el(self) -> ET.Element:
        el = self.opf_tree.getroot().find(f"{{{OPF}}}metadata")
        if el is None:
            raise AssetMetadataError("EPUB OPF has no <metadata> element")
        return el

    @property
    def _manifest_el(self) -> ET.Element | None:
        return self.opf_tree.getroot().find(f"{{{OPF}}}manifest")

    def _dc_texts(self, tag: str) -> list[str]:
        return [
            (el.text or "").strip() for el in self._metadata_el.findall(f"{{{DC}}}{tag}") if (el.text or "").strip()
        ]

    def read_entry(self, href: str) -> bytes | None:
        """Read an archive entry by OPF-relative href."""
        try:
            return self._zip.read(self.opf_dir + href)
        except KeyError:
            try:
                # Some producers store root-relative hrefs.
                return self._zip.read(href)
            except KeyError:
                return None


def _identifier_scheme(el: ET.Element) -> str | None:
    """Classify a dc:identifier element as ISBN/DOI, or None."""
    scheme = (el.get(f"{{{OPF}}}scheme") or el.get("scheme") or "").strip().upper()
    if scheme in ("ISBN", "DOI"):
        return scheme.lower()
    text = (el.text or "").strip().lower()
    if text.startswith("urn:isbn:"):
        return "isbn"
    if text.startswith("urn:doi:"):
        return "doi"
    return None


def read_metadata(data: bytes) -> dict[str, Any]:
    """Extract the metadata dictionary from EPUB bytes."""
    pkg = _EpubPackage(data)
    metadata: dict[str, Any] = {}

    titles = pkg._dc_texts("title")
    if titles:
        metadata["title"] = titles[0]

    creators = pkg._dc_texts("creator")
    if creators:
        metadata["authors"] = creators

    publishers = pkg._dc_texts("publisher")
    if publishers:
        metadata["publisher"] = publishers[0]

    dates = pkg._dc_texts("date")
    if dates:
        metadata["publication_date"] = dates[0]

    for el in pkg._metadata_el.findall(f"{{{DC}}}identifier"):
        scheme = _identifier_scheme(el)
        if scheme and scheme not in metadata:
            text = (el.text or "").strip()
            # Strip any urn:isbn:/urn:doi: prefix; the bare value is stored.
            metadata[scheme] = text.split(":")[-1] if ":" in text else text

    languages = pkg._dc_texts("language")
    if languages:
        metadata["language"] = languages[0]

    for meta in pkg._metadata_el.findall(f"{{{OPF}}}meta"):
        if meta.get("name") == _SERIES_META_NAME and meta.get("content"):
            metadata["series"] = (meta.get("content") or "").strip()
            break

    return metadata


def read_cover(data: bytes) -> bytes | None:
    """Return the embedded cover image bytes, or None.

    Supports both conventions: EPUB 3 manifest item with
    ``properties="cover-image"`` and EPUB 2 ``<meta name="cover">``.
    """
    pkg = _EpubPackage(data)
    manifest = pkg._manifest_el
    if manifest is None:
        return None

    for item in manifest.findall(f"{{{OPF}}}item"):
        if "cover-image" in (item.get("properties") or "").split():
            href = item.get("href")
            if href:
                return pkg.read_entry(href)

    for meta in pkg._metadata_el.findall(f"{{{OPF}}}meta"):
        if meta.get("name") == _COVER_META_NAME and meta.get("content"):
            cover_id = meta.get("content")
            for item in manifest.findall(f"{{{OPF}}}item"):
                if item.get("id") == cover_id and item.get("href"):
                    return pkg.read_entry(item["href"])
    return None


def _replace_dc_elements(metadata_el: ET.Element, tag: str, values: list[str]) -> None:
    """Replace all dc:<tag> elements with one element per value."""
    for el in metadata_el.findall(f"{{{DC}}}{tag}"):
        metadata_el.remove(el)
    for value in values:
        el = ET.SubElement(metadata_el, f"{{{DC}}}{tag}")
        el.text = value


def _set_meta_content(metadata_el: ET.Element, name: str, content: str) -> None:
    """Update or add an OPF 2-style <meta name=... content=.../> element."""
    for meta in metadata_el.findall(f"{{{OPF}}}meta"):
        if meta.get("name") == name:
            meta.set("content", content)
            return
    meta = ET.SubElement(metadata_el, f"{{{OPF}}}meta")
    meta.set("name", name)
    meta.set("content", content)


def write_metadata(data: bytes, properties: dict[str, Any], cover_bytes: bytes | None = None) -> bytes:
    """Rewrite the EPUB with ``properties`` merged into its OPF metadata.

    Provided keys overwrite; absent keys are left untouched. ``cover_bytes``
    replaces any existing cover image. The output is deterministic: identical
    inputs produce identical bytes.
    """
    pkg = _EpubPackage(data)
    metadata_el = pkg._metadata_el
    manifest_el = pkg._manifest_el

    title = properties.get("title")
    if title:
        _replace_dc_elements(metadata_el, "title", [str(title)])

    authors = properties.get("authors")
    if authors:
        _replace_dc_elements(metadata_el, "creator", [str(a) for a in authors])

    if properties.get("publisher"):
        _replace_dc_elements(metadata_el, "publisher", [str(properties["publisher"])])
    if properties.get("publication_date"):
        _replace_dc_elements(metadata_el, "date", [str(properties["publication_date"])])
    if properties.get("language"):
        _replace_dc_elements(metadata_el, "language", [str(properties["language"])])

    # Identifiers: drop existing ISBN/DOI identifiers being replaced, keep all
    # others (UUIDs, custom schemes), and write urn:-prefixed values (no
    # namespaced attributes needed, valid in EPUB 2 and 3).
    replaced_schemes = {k for k in ("isbn", "doi") if properties.get(k)}
    if replaced_schemes:
        for el in metadata_el.findall(f"{{{DC}}}identifier"):
            if _identifier_scheme(el) in replaced_schemes:
                metadata_el.remove(el)
        for scheme in ("isbn", "doi"):
            if properties.get(scheme):
                el = ET.SubElement(metadata_el, f"{{{DC}}}identifier")
                el.text = f"urn:{scheme}:{properties[scheme]}"

    if properties.get("series"):
        _set_meta_content(metadata_el, _SERIES_META_NAME, str(properties["series"]))

    dropped_entries: set[str] = set()
    cover_mime: str | None = None
    cover_href: str | None = None
    if cover_bytes is not None:
        cover_mime = _detect_image_mime(cover_bytes) or "image/jpeg"
        cover_href = f"cover{_image_extension(cover_mime)}"
        if manifest_el is not None:
            # Remove previous cover declarations (EPUB 3 item + EPUB 2 meta
            # pointer); the old cover file entry is dropped from the archive.
            for item in manifest_el.findall(f"{{{OPF}}}item"):
                if "cover-image" in (item.get("properties") or "").split():
                    href = item.get("href")
                    if href and href != cover_href:
                        dropped_entries.add(pkg.opf_dir + href)
                    manifest_el.remove(item)
            for meta in metadata_el.findall(f"{{{OPF}}}meta"):
                if meta.get("name") == _COVER_META_NAME:
                    metadata_el.remove(meta)
            item = ET.SubElement(manifest_el, f"{{{OPF}}}item")
            item.set("id", _COVER_ITEM_ID)
            item.set("href", cover_href)
            item.set("media-type", cover_mime)
            item.set("properties", "cover-image")
            _set_meta_content(metadata_el, _COVER_META_NAME, _COVER_ITEM_ID)

    opf_bytes = ET.tostring(pkg.opf_tree.getroot(), encoding="UTF-8", xml_declaration=True)

    out = BytesIO()
    with zipfile.ZipFile(out, "w") as zout:
        for info in pkg._zip.infolist():
            if info.filename == pkg.opf_path or info.filename in dropped_entries:
                continue
            if cover_href is not None and info.filename == pkg.opf_dir + cover_href:
                continue  # replaced below
            entry = zipfile.ZipInfo(info.filename, date_time=_FIXED_DATE_TIME)
            entry.compress_type = info.compress_type
            entry.external_attr = info.external_attr
            zout.writestr(entry, pkg._zip.read(info.filename))
        zout.writestr(zipfile.ZipInfo(pkg.opf_path, date_time=_FIXED_DATE_TIME), opf_bytes)
        if cover_bytes is not None and cover_href is not None:
            zout.writestr(
                zipfile.ZipInfo(pkg.opf_dir + cover_href, date_time=_FIXED_DATE_TIME),
                cover_bytes,
            )
    return out.getvalue()
