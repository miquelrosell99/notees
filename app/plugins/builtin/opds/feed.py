"""OPDS 1.2 feed rendering (Atom XML).

Pure builders: they take resolved catalog entries and a feed base URL and
return Atom XML bytes. All hrefs are derived from the request's base URL and
point at the plugin's own endpoints — internal storage paths and asset hashes
never appear in a feed.
"""

from __future__ import annotations

from datetime import UTC, datetime
from urllib.parse import quote
from xml.etree import ElementTree as ET

from .selection import CatalogEntry

ATOM_NS = "http://www.w3.org/2005/Atom"
DC_NS = "http://purl.org/dc/terms/"

ET.register_namespace("", ATOM_NS)
ET.register_namespace("dc", DC_NS)

NAV_MEDIA_TYPE = "application/atom+xml;profile=opds-catalog;kind=navigation"
ACQ_MEDIA_TYPE = "application/atom+xml;profile=opds-catalog;kind=acquisition"

REL_SUBSECTION = "subsection"
REL_ACQUISITION = "http://opds-spec.org/acquisition"
REL_COVER = "http://opds-spec.org/image"
REL_COVER_THUMBNAIL = "http://opds-spec.org/image/thumbnail"


def _atom(tag: str) -> str:
    return f"{{{ATOM_NS}}}{tag}"


def _dc(tag: str) -> str:
    return f"{{{DC_NS}}}{tag}"


def _now_rfc3339() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _sub(parent: ET.Element, tag: str, text: str | None = None, **attrs: str) -> ET.Element:
    element = ET.SubElement(parent, tag, attrs)
    if text is not None:
        element.text = text
    return element


def _feed_shell(feed_id: str, title: str, updated: str, self_href: str, media_type: str) -> ET.Element:
    feed = ET.Element(_atom("feed"))
    _sub(feed, _atom("id"), feed_id)
    _sub(feed, _atom("title"), title)
    _sub(feed, _atom("updated"), updated)
    _sub(feed, _atom("link"), rel="self", type=media_type, href=self_href)
    return feed


def class_feed_path(class_name: str) -> str:
    """Relative path of a per-class acquisition feed."""
    return f"/opds/class/{quote(class_name, safe='')}"


def build_root_feed(
    feed_base: str,
    feed_id_prefix: str,
    entries: list[CatalogEntry],
) -> bytes:
    """Root navigation feed: "All publications" plus one entry per class."""
    updated = _now_rfc3339()
    feed = _feed_shell(
        f"{feed_id_prefix}:root",
        "Notees OPDS Catalog",
        updated,
        f"{feed_base}/opds",
        NAV_MEDIA_TYPE,
    )
    _sub(feed, _atom("link"), rel="start", type=NAV_MEDIA_TYPE, href=f"{feed_base}/opds")

    def _nav_entry(entry_id: str, title: str, path: str, count: int) -> None:
        entry = _sub(feed, _atom("entry"))
        _sub(entry, _atom("id"), f"{feed_id_prefix}:{entry_id}")
        _sub(entry, _atom("title"), title)
        _sub(entry, _atom("updated"), updated)
        _sub(
            entry,
            _atom("link"),
            rel=REL_SUBSECTION,
            type=ACQ_MEDIA_TYPE,
            href=f"{feed_base}{path}",
        )
        label = "publication" if count == 1 else "publications"
        _sub(entry, _atom("content"), f"{count} {label}", type="text")

    _nav_entry("all", "All publications", "/opds/all", len(entries))

    counts: dict[str, int] = {}
    for entry in entries:
        primary = entry.primary_class
        if primary is not None:
            counts[primary] = counts.get(primary, 0) + 1
    for class_name in sorted(counts):
        _nav_entry(
            f"class:{class_name}",
            class_name.replace("-", " ").title(),
            class_feed_path(class_name),
            counts[class_name],
        )
    return ET.tostring(feed, encoding="utf-8", xml_declaration=True)


def build_acquisition_feed(
    feed_base: str,
    feed_id: str,
    title: str,
    entries: list[CatalogEntry],
    self_path: str,
) -> bytes:
    """Acquisition feed with one OPDS entry per catalog entry."""
    updated = _now_rfc3339()
    feed = _feed_shell(feed_id, title, updated, f"{feed_base}{self_path}", ACQ_MEDIA_TYPE)
    _sub(feed, _atom("link"), rel="start", type=NAV_MEDIA_TYPE, href=f"{feed_base}/opds")
    _sub(feed, _atom("link"), rel="up", type=NAV_MEDIA_TYPE, href=f"{feed_base}/opds")

    for catalog_entry in entries:
        entry = _sub(feed, _atom("entry"))
        _sub(entry, _atom("id"), f"urn:uuid:{catalog_entry.uuid}")
        _sub(entry, _atom("title"), catalog_entry.title or "Untitled")
        _sub(entry, _atom("updated"), updated)

        for author in catalog_entry.authors:
            author_el = _sub(entry, _atom("author"))
            _sub(author_el, _atom("name"), author)
            _sub(entry, _dc("creator"), author)

        if catalog_entry.isbn:
            _sub(entry, _dc("identifier"), f"isbn:{catalog_entry.isbn}")
        if catalog_entry.doi:
            _sub(entry, _dc("identifier"), f"doi:{catalog_entry.doi}")
        if catalog_entry.citekey:
            _sub(entry, _dc("identifier"), f"citekey:{catalog_entry.citekey}")
        if catalog_entry.publication_date:
            _sub(entry, _dc("issued"), catalog_entry.publication_date)
            _sub(entry, _atom("published"), catalog_entry.publication_date)

        for attachment in catalog_entry.acquisitions:
            _sub(
                entry,
                _atom("link"),
                rel=REL_ACQUISITION,
                type=attachment.mime_type,
                href=f"{feed_base}/opds/download/{attachment.asset_uuid}",
                title=attachment.original_name or attachment.asset_uuid,
            )

        if catalog_entry.cover is not None:
            cover_href = f"{feed_base}/opds/download/{catalog_entry.cover.asset_uuid}"
            _sub(
                entry,
                _atom("link"),
                rel=REL_COVER,
                type=catalog_entry.cover.mime_type,
                href=cover_href,
            )
            _sub(
                entry,
                _atom("link"),
                rel=REL_COVER_THUMBNAIL,
                type=catalog_entry.cover.mime_type,
                href=cover_href,
            )

        if catalog_entry.primary_class:
            _sub(
                entry,
                _atom("category"),
                term=catalog_entry.primary_class,
                label=catalog_entry.primary_class.replace("-", " ").title(),
            )
    return ET.tostring(feed, encoding="utf-8", xml_declaration=True)
