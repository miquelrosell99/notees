"""PDF identifier extraction for the add-by-file flow (Task 14).

Given the raw bytes of a PDF, extract bibliographic identifiers without any
network access:

- **DOI** — first from XMP metadata (``prism:doi`` or any ``*:doi`` element),
  then from the document info dictionary (``/Subject``, ``/Keywords``), then
  by regex over the text of the first pages.
- **ISBN** — by regex over the same extracted text (books carry it on the
  copyright page).
- **Title hint** — XMP ``dc:title``, then ``/Title`` in the info dict, then
  the most prominent line of the first page (largest font size via the pypdf
  text-extraction visitor), then the first non-empty line.

Extraction is deliberately best-effort: an unreadable or encrypted PDF raises
:class:`PdfExtractionError` (mapped to an explicit 400 by the router), while a
*readable* PDF that simply yields no identifiers returns an empty
:class:`PdfIdentifiers` — the caller then falls back to a filename-based
source marked for manual completion.
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass
from typing import Any

from pypdf import PdfReader
from pypdf.errors import PdfReadError

from .lookup import _DOI_RE, _ISBN10_RE, _ISBN13_RE, _ISBN_STRIP_RE

# How many leading pages to scan for identifiers/title text. Title pages and
# copyright pages of academic PDFs and ebooks live here.
TEXT_PAGES_LIMIT = 3

# DOI as it appears in running text ("doi:10.…", "https://doi.org/10.…" or a
# bare "10.…/…"). Delimiters excluded so a match stops at quotes/brackets.
_DOI_TEXT_RE = re.compile(r"10\.\d{4,9}/[^\s\"'<>()\[\]{}]+", re.IGNORECASE)
# Characters a regex match may drag in from surrounding prose.
_DOI_TRAILING_CHARS = ".,;:"

# "ISBN", "ISBN-13:", "ISBN 978-…" followed by the number itself.
_ISBN_TEXT_RE = re.compile(
    r"ISBN(?:-1[03])?[:\s]\s*([0-9Xx][0-9Xx\s\-]{8,20}[0-9Xx])",
    re.IGNORECASE,
)

_MIN_TITLE_LENGTH = 4
_MAX_TITLE_LENGTH = 300
# Font sizes below this are body text, not a title.
_MIN_PROMINENT_FONT_SIZE = 8.0


class PdfExtractionError(Exception):
    """The file is not a readable PDF (corrupt, encrypted, not a PDF)."""


@dataclass
class PdfIdentifiers:
    """Best-effort identifiers and title extracted from one PDF."""

    doi: str | None = None
    isbn: str | None = None
    title_hint: str | None = None

    @property
    def identifier(self) -> tuple[str, str] | None:
        """The single identifier to resolve, DOI preferred over ISBN."""
        if self.doi:
            return ("doi", self.doi)
        if self.isbn:
            return ("isbn", self.isbn)
        return None


def _clean_doi(candidate: str) -> str | None:
    """Strip surrounding prose from a regex DOI match; validate the result."""
    doi = candidate.strip().rstrip(_DOI_TRAILING_CHARS)
    return doi if _DOI_RE.match(doi) else None


def _find_doi_in_text(text: str) -> str | None:
    for match in _DOI_TEXT_RE.finditer(text):
        doi = _clean_doi(match.group(0))
        if doi:
            return doi
    return None


def _find_isbn_in_text(text: str) -> str | None:
    for match in _ISBN_TEXT_RE.finditer(text):
        digits = _ISBN_STRIP_RE.sub("", match.group(1))
        if _ISBN13_RE.fullmatch(digits) or _ISBN10_RE.fullmatch(digits):
            return digits.upper()
    return None


def _xmp_doi(reader: PdfReader) -> str | None:
    """Read a DOI from the XMP packet (``prism:doi`` or any ``*:doi``)."""
    try:
        xmp = reader.xmp_metadata
    except Exception:  # noqa: BLE001 — malformed XMP must not sink extraction
        return None
    if xmp is None:
        return None
    rdf_root = getattr(xmp, "rdf_root", None)
    if rdf_root is None:
        return None
    try:
        elements = rdf_root.getElementsByTagNameNS("*", "doi")
    except Exception:  # noqa: BLE001
        return None
    for element in elements:
        text = "".join(node.data for node in element.childNodes if node.nodeType == node.TEXT_NODE).strip()
        doi = _clean_doi(text) if text else None
        if doi:
            return doi
    return None


def _xmp_title(reader: PdfReader) -> str | None:
    try:
        xmp = reader.xmp_metadata
    except Exception:  # noqa: BLE001
        return None
    if xmp is None:
        return None
    dc_title = getattr(xmp, "dc_title", None)
    if isinstance(dc_title, dict):
        for value in dc_title.values():
            title = str(value).strip()
            if title:
                return title
    return None


def _info_dict_text(reader: PdfReader) -> tuple[str | None, str | None]:
    """Return ``(title, doi)`` from the document info dictionary."""
    try:
        metadata = reader.metadata
    except Exception:  # noqa: BLE001
        return None, None
    if metadata is None:
        return None, None
    title = (metadata.title or "").strip() or None
    doi = None
    for key in ("/Subject", "/Keywords"):
        value = metadata.get(key)
        if isinstance(value, str):
            doi = _find_doi_in_text(value)
            if doi:
                break
    return title, doi


def _page_texts(reader: PdfReader) -> list[str]:
    """Extract the text of the first pages; unreadable pages yield ""."""
    texts: list[str] = []
    for page in reader.pages[:TEXT_PAGES_LIMIT]:
        try:
            texts.append(page.extract_text() or "")
        except Exception:  # noqa: BLE001 — one bad page must not sink the rest
            texts.append("")
    return texts


def _first_meaningful_line(text: str) -> str | None:
    for line in text.splitlines():
        stripped = line.strip()
        if len(stripped) >= _MIN_TITLE_LENGTH:
            return stripped[:_MAX_TITLE_LENGTH]
    return None


def _prominent_line(reader: PdfReader) -> str | None:
    """Largest-font text run of the first page (the title, in most layouts).

    Falls back to the first meaningful line when font information is absent
    or the largest run is implausible as a title.
    """
    if not reader.pages:
        return None
    page = reader.pages[0]
    by_size: dict[float, list[str]] = {}

    def visitor(text: str, _cm: Any, _tm: Any, _font_dict: Any, font_size: Any) -> None:
        stripped = text.strip()
        if not stripped or not isinstance(font_size, (int, float)):
            return
        if font_size < _MIN_PROMINENT_FONT_SIZE:
            return
        by_size.setdefault(round(float(font_size), 1), []).append(stripped)

    try:
        page.extract_text(visitor_text=visitor)
    except Exception:  # noqa: BLE001
        return None
    if by_size:
        joined = " ".join(by_size[max(by_size)]).strip()
        if _MIN_TITLE_LENGTH <= len(joined) <= _MAX_TITLE_LENGTH:
            return joined
    try:
        return _first_meaningful_line(page.extract_text() or "")
    except Exception:  # noqa: BLE001
        return None


def extract_pdf_identifiers(data: bytes) -> PdfIdentifiers:
    """Extract DOI/ISBN/title hints from raw PDF bytes.

    Raises :class:`PdfExtractionError` when the bytes are not a readable PDF.
    A scanned/image-only PDF parses fine but yields empty identifiers — the
    caller's fallback path handles that case.
    """
    try:
        reader = PdfReader(io.BytesIO(data))
        # Try the empty password; anything else is unsupported.
        if reader.is_encrypted and reader.decrypt("") == 0:
            raise PdfExtractionError("The PDF is password-protected")
    except PdfExtractionError:
        raise
    except (PdfReadError, ValueError, OSError) as exc:
        raise PdfExtractionError(f"Could not read the PDF: {exc}") from exc

    info_title, info_doi = _info_dict_text(reader)
    texts = _page_texts(reader)
    body = "\n".join(texts)

    doi = _xmp_doi(reader) or info_doi or _find_doi_in_text(body)
    isbn = _find_isbn_in_text(body)
    title_hint = _xmp_title(reader) or info_title or _prominent_line(reader)

    return PdfIdentifiers(doi=doi, isbn=isbn, title_hint=title_hint)
