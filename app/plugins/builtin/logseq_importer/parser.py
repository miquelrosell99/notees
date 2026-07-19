"""Parser for Logseq Markdown folders and ZIP archives."""

from __future__ import annotations

import contextlib
import io
import re
import zipfile
from dataclasses import dataclass, field
from urllib.parse import unquote


@dataclass
class LogseqMdBlock:
    """A single Logseq outline block."""

    content: str
    children: list[LogseqMdBlock] = field(default_factory=list)


@dataclass
class LogseqMdPage:
    """A parsed Logseq markdown page."""

    title: str
    properties: dict[str, str] = field(default_factory=dict)
    blocks: list[LogseqMdBlock] = field(default_factory=list)
    is_journal: bool = False
    journal_date: str | None = None


@dataclass
class LogseqFolderResult:
    """Result of parsing a Logseq markdown folder."""

    pages: list[LogseqMdPage] = field(default_factory=list)
    journals: list[LogseqMdPage] = field(default_factory=list)
    all_links: set[str] = field(default_factory=set)
    asset_count: int = 0


_WIKI_LINK_RE = re.compile(r"\[\[([^\]]+)\]\]")
_ASSET_REF_RE = re.compile(
    r"^!\[[^\]]*\]\(\.\.\/assets\/([^)]+)\)(\{[^}]*\})?\s*$"
)
_PROPERTY_RE = re.compile(r"^([a-zA-Z_-][\w-]*):: (.*)$")
_BULLET_RE = re.compile(r"^(\s*)- (.*)$")
_JOURNAL_DATE_RE = re.compile(r"^(\d{4})_(\d{2})_(\d{2})$")


def _title_from_filename(filename: str) -> str:
    """Derive a page title from a filename."""
    name = filename
    if name.lower().endswith(".md"):
        name = name[:-3]
    name = name.replace("___", "/")
    with contextlib.suppress(ValueError, UnicodeDecodeError):
        name = unquote(name)
    return name


def parse_logseq_md(filename: str, content: str) -> LogseqMdPage:
    """Parse a single Logseq markdown file into a :class:`LogseqMdPage`."""
    title = _title_from_filename(filename)
    properties: dict[str, str] = {}
    blocks: list[LogseqMdBlock] = []

    lines = content.split("\n")
    pos = 0
    while pos < len(lines):
        line = lines[pos]
        if line.strip() == "":
            pos += 1
            continue
        prop_match = _PROPERTY_RE.match(line)
        if prop_match:
            properties[prop_match.group(1)] = prop_match.group(2).strip()
            pos += 1
            continue
        break

    stack: list[tuple[int, LogseqMdBlock]] = []

    for line in lines[pos:]:
        bullet_match = _BULLET_RE.match(line)
        if not bullet_match:
            if stack:
                last_block = stack[-1][1]
                last_block.content += "\n" + line.lstrip()
            continue

        indent = len(bullet_match.group(1))
        text = bullet_match.group(2)
        new_block = LogseqMdBlock(content=text)

        while stack and stack[-1][0] >= indent:
            stack.pop()

        if not stack:
            blocks.append(new_block)
        else:
            stack[-1][1].children.append(new_block)

        stack.append((indent, new_block))

    return LogseqMdPage(title=title, properties=properties, blocks=blocks)


def parse_journal_date(filename: str) -> str | None:
    """Parse a journal filename (YYYY_MM_DD.md) into an ISO date string."""
    base = filename
    if base.lower().endswith(".md"):
        base = base[:-3]
    match = _JOURNAL_DATE_RE.match(base)
    if not match:
        return None
    year, month, day = match.groups()
    month_int = int(month)
    day_int = int(day)
    if month_int < 1 or month_int > 12 or day_int < 1 or day_int > 31:
        return None
    return f"{year}-{month}-{day}"


def count_md_blocks(blocks: list[LogseqMdBlock]) -> int:
    """Count total blocks including nested children."""
    total = len(blocks)
    for block in blocks:
        total += count_md_blocks(block.children)
    return total


def collect_wiki_links(blocks: list[LogseqMdBlock]) -> set[str]:
    """Return all unique ``[[page name]]`` references in the given blocks."""
    links: set[str] = set()

    def walk(block: LogseqMdBlock) -> None:
        for match in _WIKI_LINK_RE.finditer(block.content):
            links.add(match.group(1))
        for child in block.children:
            walk(child)

    for block in blocks:
        walk(block)
    return links


def extract_asset_filename(content: str) -> str | None:
    """Return the asset filename if the content is a pure asset reference."""
    match = _ASSET_REF_RE.match(content)
    return match.group(1) if match else None


def _decode_text(data: bytes) -> str:
    """Decode zip file bytes as UTF-8, falling back to latin-1."""
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("latin-1")


def parse_logseq_zip(payload: bytes) -> LogseqFolderResult:
    """Parse a ZIP archive containing Logseq pages, journals, and assets."""
    result = LogseqFolderResult()
    try:
        archive = zipfile.ZipFile(io.BytesIO(payload))
    except zipfile.BadZipFile as err:
        raise ValueError("Uploaded file is not a valid ZIP archive") from err

    page_files: list[tuple[str, str]] = []
    journal_files: list[tuple[str, str]] = []

    for info in archive.infolist():
        if info.is_dir():
            continue
        rel_path = info.filename
        parts = rel_path.split("/")
        if len(parts) < 3:
            continue
        subfolder = parts[1].lower()
        file_name = "/".join(parts[2:])

        if subfolder == "assets":
            result.asset_count += 1
            continue

        if not file_name.lower().endswith(".md"):
            continue

        if subfolder not in ("pages", "journals"):
            continue

        content = _decode_text(archive.read(info.filename))
        if subfolder == "pages":
            page_files.append((file_name, content))
        else:
            journal_files.append((file_name, content))

    result.pages = [parse_logseq_md(name, content) for name, content in page_files]
    for name, content in journal_files:
        page = parse_logseq_md(name, content)
        date = parse_journal_date(name)
        if date:
            page.is_journal = True
            page.journal_date = date
            result.journals.append(page)

    for page in result.pages + result.journals:
        result.all_links.update(collect_wiki_links(page.blocks))

    return result
