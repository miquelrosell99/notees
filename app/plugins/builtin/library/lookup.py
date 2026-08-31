"""Bibliographic metadata lookup by identifier (ISBN/DOI) — Task 13.

Provider abstraction shared with future add-by-file flows (Task 14): a
provider resolves an identifier into normalized source metadata or raises
:class:`MetadataNotFoundError` / :class:`MetadataProviderUnavailableError`.
Callers either get complete metadata or an error — never a partial result,
so no half-created source nodes exist on provider failure.

Providers are public, auth-less APIs: Crossref for DOIs, Open Library for
ISBNs. All network access happens backend-side; the frontend only talks to
the plugin router.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx

CROSSREF_API_BASE = "https://api.crossref.org"
OPENLIBRARY_API_BASE = "https://openlibrary.org"

REQUEST_TIMEOUT = 15.0
# Crossref asks clients to identify themselves; Open Library ignores it.
USER_AGENT = "notees-library/1.0 (self-hosted note-taking app)"


class InvalidIdentifierError(ValueError):
    """The pasted text is neither a recognizable DOI nor an ISBN."""


class MetadataNotFoundError(Exception):
    """The provider knows the identifier space but has no record for it."""


class MetadataProviderUnavailableError(Exception):
    """The provider is unreachable, timed out, or returned an error."""


@dataclass
class SourceMetadata:
    """Normalized bibliographic record produced by any provider.

    ``creators`` uses the shared person/organization shape consumed by
    :func:`app.plugins.core.agents.find_or_create_creators`:
    ``{"given_name", "family_name"}`` or ``{"organization_name"}``.
    """

    title: str
    creators: list[dict[str, str]] = field(default_factory=list)
    publication_date: str | None = None
    publisher: str | None = None
    isbn: str | None = None
    doi: str | None = None
    class_name: str = "document"
    language: str | None = None
    provider: str = ""


class MetadataProvider(Protocol):
    """Resolves one identifier into normalized source metadata."""

    id: str

    async def lookup(self, identifier: str) -> SourceMetadata:
        """Return metadata for ``identifier``.

        Raises:
            MetadataNotFoundError: the identifier has no record.
            MetadataProviderUnavailableError: the provider failed.
        """
        ...


_DOI_RE = re.compile(r"^10\.\d{4,9}/\S+$", re.IGNORECASE)
_ISBN_STRIP_RE = re.compile(r"[-\s]")
_ISBN10_RE = re.compile(r"\d{9}[\dXx]")
_ISBN13_RE = re.compile(r"\d{13}")
_DOI_PREFIXES = ("https://doi.org/", "http://doi.org/", "doi:")


def classify_identifier(raw: str) -> tuple[str, str]:
    """Classify pasted text as ``("doi", value)`` or ``("isbn", value)``.

    DOIs may be pasted as URLs (``https://doi.org/10.…``) or with a ``doi:``
    prefix; ISBNs may contain hyphens/spaces. Raises
    :class:`InvalidIdentifierError` for anything else.
    """
    text = raw.strip()
    lowered = text.lower()
    for prefix in _DOI_PREFIXES:
        if lowered.startswith(prefix):
            text = text[len(prefix) :].strip()
            break
    if _DOI_RE.match(text):
        return ("doi", text)
    digits = _ISBN_STRIP_RE.sub("", text)
    if _ISBN13_RE.fullmatch(digits) or _ISBN10_RE.fullmatch(digits):
        return ("isbn", digits.upper())
    raise InvalidIdentifierError(f"Not a valid DOI or ISBN: {raw.strip()!r}")


def provider_for_kind(kind: str) -> MetadataProvider:
    """Return the provider implementation for an identifier kind."""
    if kind == "doi":
        return CrossrefProvider()
    if kind == "isbn":
        return OpenLibraryProvider()
    raise InvalidIdentifierError(f"Unknown identifier kind: {kind!r}")


async def _get_json(client: httpx.AsyncClient, url: str) -> dict[str, Any]:
    """GET ``url`` as JSON, mapping failures onto the provider error types."""
    try:
        response = await client.get(url)
    except httpx.HTTPError as exc:
        raise MetadataProviderUnavailableError(f"Metadata provider unreachable: {exc}") from exc
    if response.status_code == 404:
        raise MetadataNotFoundError("No record found for this identifier")
    if response.status_code >= 400:
        raise MetadataProviderUnavailableError(f"Metadata provider returned HTTP {response.status_code}")
    try:
        payload = response.json()
    except ValueError as exc:
        raise MetadataProviderUnavailableError("Metadata provider returned an unreadable response") from exc
    if not isinstance(payload, dict):
        raise MetadataProviderUnavailableError("Metadata provider returned an unexpected response")
    return payload


def _format_date_parts(date_parts: list[Any] | None) -> str | None:
    """Render Crossref ``date-parts`` ([[y, m, d]]) as YYYY[-MM[-DD]]."""
    if not date_parts or not isinstance(date_parts, list) or not date_parts:
        return None
    parts = date_parts[0]
    if not isinstance(parts, list) or not parts or not isinstance(parts[0], int):
        return None
    year = parts[0]
    month = parts[1] if len(parts) > 1 and isinstance(parts[1], int) else None
    day = parts[2] if len(parts) > 2 and isinstance(parts[2], int) else None
    if month is None:
        return f"{year:04d}"
    if day is None:
        return f"{year:04d}-{month:02d}"
    return f"{year:04d}-{month:02d}-{day:02d}"


def _split_person_name(full_name: str) -> dict[str, str]:
    """Split a free-form name into ``given_name``/``family_name``.

    Handles "Family, Given" and "Given … Family" forms; the last token is
    treated as the family name, mirroring the Zotero single-field fallback.
    """
    name = full_name.strip()
    if "," in name:
        family, given = (part.strip() for part in name.split(",", 1))
        return {"given_name": given, "family_name": family}
    tokens = name.split()
    if len(tokens) > 1:
        return {"given_name": " ".join(tokens[:-1]), "family_name": tokens[-1]}
    return {"given_name": "", "family_name": name}


# Crossref work type → system source class. Anything unmapped lands on the
# generic ``article`` class (journal-ish content is Crossref's main corpus).
CROSSREF_TYPE_CLASS_NAMES: dict[str, str] = {
    "journal-article": "paper",
    "proceedings-article": "paper",
    "posted-content": "paper",
    "book": "book",
    "monograph": "book",
    "edited-book": "book",
    "reference-book": "book",
    "book-chapter": "book",
    "book-section": "book",
    "book-series": "book",
    "dissertation": "thesis",
    "report": "document",
    "report-series": "document",
    "standard": "document",
}
CROSSREF_DEFAULT_CLASS_NAME = "article"


class CrossrefProvider:
    """DOI lookup against the Crossref REST API (api.crossref.org)."""

    id = "crossref"

    def __init__(self, http_client: httpx.AsyncClient | None = None) -> None:
        # Tests inject a MockTransport client; production builds one per call.
        self._client = http_client

    async def lookup(self, identifier: str) -> SourceMetadata:
        url = f"{CROSSREF_API_BASE}/works/{identifier}"
        if self._client is not None:
            payload = await _get_json(self._client, url)
        else:
            async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT, headers={"User-Agent": USER_AGENT}) as client:
                payload = await _get_json(client, url)
        return self._parse(payload)

    def _parse(self, payload: dict[str, Any]) -> SourceMetadata:
        message = payload.get("message")
        if not isinstance(message, dict):
            raise MetadataProviderUnavailableError("Crossref returned an unexpected response")

        titles = message.get("title")
        title = ""
        if isinstance(titles, list) and titles:
            title = str(titles[0]).strip()
        if not title:
            raise MetadataNotFoundError("Crossref record has no title")

        creators: list[dict[str, str]] = []
        for author in message.get("author") or []:
            if not isinstance(author, dict):
                continue
            literal = str(author.get("name", "")).strip()
            if literal:
                creators.append({"organization_name": literal})
                continue
            given = str(author.get("given", "")).strip()
            family = str(author.get("family", "")).strip()
            if given or family:
                creators.append({"given_name": given, "family_name": family})

        date = _format_date_parts((message.get("issued") or {}).get("date-parts"))
        if date is None:
            for key in ("published-print", "published-online", "published"):
                block = message.get(key)
                if isinstance(block, dict):
                    date = _format_date_parts(block.get("date-parts"))
                    if date is not None:
                        break

        isbns = message.get("ISBN")
        isbn = str(isbns[0]).strip() if isinstance(isbns, list) and isbns else None

        publisher = str(message.get("publisher", "")).strip() or None
        doi = str(message.get("DOI", "")).strip() or None
        language = str(message.get("language", "")).strip() or None
        work_type = str(message.get("type", "")).strip()

        return SourceMetadata(
            title=title,
            creators=creators,
            publication_date=date,
            publisher=publisher,
            isbn=isbn,
            doi=doi,
            class_name=CROSSREF_TYPE_CLASS_NAMES.get(work_type, CROSSREF_DEFAULT_CLASS_NAME),
            language=language,
            provider=self.id,
        )


class OpenLibraryProvider:
    """ISBN lookup against the Open Library API (openlibrary.org)."""

    id = "openlibrary"

    def __init__(self, http_client: httpx.AsyncClient | None = None) -> None:
        self._client = http_client

    async def _get(self, url: str) -> dict[str, Any]:
        if self._client is not None:
            return await _get_json(self._client, url)
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT, headers={"User-Agent": USER_AGENT}) as client:
            return await _get_json(client, url)

    async def lookup(self, identifier: str) -> SourceMetadata:
        edition = await self._get(f"{OPENLIBRARY_API_BASE}/isbn/{identifier}.json")

        title = str(edition.get("title", "")).strip()
        if not title:
            raise MetadataNotFoundError("Open Library record has no title")

        creators: list[dict[str, str]] = []
        for author_ref in edition.get("authors") or []:
            if not isinstance(author_ref, dict):
                continue
            key = str(author_ref.get("key", "")).strip()
            if not key:
                continue
            try:
                author = await self._get(f"{OPENLIBRARY_API_BASE}{key}.json")
            except (MetadataNotFoundError, MetadataProviderUnavailableError):
                # A missing author record must not sink the whole book.
                continue
            name = str(author.get("name", "")).strip()
            if name:
                creators.append(_split_person_name(name))

        publishers = edition.get("publishers")
        publisher = str(publishers[0]).strip() if isinstance(publishers, list) and publishers else None

        publish_date = str(edition.get("publish_date", "")).strip() or None

        languages = edition.get("languages")
        language = None
        if isinstance(languages, list) and languages and isinstance(languages[0], dict):
            key = str(languages[0].get("key", ""))
            language = key.rsplit("/", 1)[-1] or None

        isbn = identifier
        isbns_13 = edition.get("isbn_13")
        if isinstance(isbns_13, list) and isbns_13:
            isbn = str(isbns_13[0]).strip()

        return SourceMetadata(
            title=title,
            creators=creators,
            publication_date=publish_date,
            publisher=publisher or None,
            isbn=isbn,
            class_name="book",
            language=language,
            provider=self.id,
        )
