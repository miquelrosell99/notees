"""PDF rendering adapter using WeasyPrint."""

from __future__ import annotations


def render_pdf(html_content: str, page_size: str = "a4") -> bytes:
    """Render an HTML string to a PDF document.

    Args:
        html_content: The HTML document to render.
        page_size: Target page size (a4, letter, legal).

    Returns:
        The rendered PDF bytes.

    Raises:
        ImportError: If WeasyPrint is not installed.
        Exception: If WeasyPrint fails to render the PDF.
    """
    from weasyprint import HTML as WEASYPRINT_HTML

    return WEASYPRINT_HTML(string=html_content).write_pdf()
