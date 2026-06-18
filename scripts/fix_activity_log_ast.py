#!/usr/bin/env python3
"""Fix activity log entries that contain raw AST JSON in the details column.

Scans node_activity for rows where quoted values inside ``details`` are stored
as raw JSON AST (e.g. ``[{"type":"paragraph",...}]``) and converts them to
plain text so the UI shows human-readable labels.

Run inside the backend container:
    docker exec notees-backend-dev python scripts/fix_activity_log_ast.py
"""
from __future__ import annotations

import asyncio
import json
import os

import asyncpg

from app.domain.stringify_ast import ParseMode, StringifyMode, StringifyOptions, parse_ast, stringify_ast

DATABASE_URL = os.getenv("DATABASE_URL")


def _require_database_url() -> None:
    """Exit if DATABASE_URL is not configured."""
    if DATABASE_URL:
        return
    print(
        "Error: DATABASE_URL environment variable is required.\n"
        "Example:\n"
        "  DATABASE_URL=postgresql://notees:YOUR_PASSWORD@postgres:5432/notees "
        "python scripts/fix_activity_log_ast.py"
    )
    raise SystemExit(1)


def _find_quoted_ast_segments(text: str) -> list[tuple[int, int, str]]:
    """Find all ``'[{...}]'`` segments and return (start, end, json_content)."""
    results: list[tuple[int, int, str]] = []
    i = 0
    while i < len(text):
        if text[i] == "'":
            j = i + 1
            if j < len(text) and text[j] == "[":
                depth = 1
                k = j + 1
                while k < len(text) and depth > 0:
                    if text[k] == "[":
                        depth += 1
                    elif text[k] == "]":
                        depth -= 1
                    k += 1
                if depth == 0 and k < len(text) and text[k] == "'":
                    candidate = text[j:k]
                    try:
                        parsed = json.loads(candidate)
                        if (
                            isinstance(parsed, list)
                            and parsed
                            and isinstance(parsed[0], dict)
                            and "type" in parsed[0]
                        ):
                            results.append((i, k + 1, candidate))
                    except (json.JSONDecodeError, TypeError):
                        pass
                    i = k + 1
                    continue
        i += 1
    return results


def _ast_json_to_text(raw: str) -> str:
    """Convert a JSON AST string to plain text."""
    try:
        ast = parse_ast(raw, ParseMode.JSON)
        text = stringify_ast(ast, StringifyOptions(mode=StringifyMode.TEXT_ONLY))
        return text.strip()
    except (ValueError, TypeError, KeyError):
        return raw


def _fix_details(details: str) -> str | None:
    """Return updated details if any quoted AST was found, otherwise None."""
    segments = _find_quoted_ast_segments(details)
    if not segments:
        return None

    result = details
    # Replace from right to left so indices stay valid
    for start, end, ast_json in reversed(segments):
        plain_text = _ast_json_to_text(ast_json)
        result = result[:start] + f"'{plain_text}'" + result[end:]

    return result


async def fix_activity_log_ast() -> int:
    _require_database_url()
    conn = await asyncpg.connect(DATABASE_URL)
    try:
        rows = await conn.fetch(
            """
            SELECT id, details
            FROM node_activity
            WHERE details LIKE '%''[%'
              AND details LIKE '%]''%'
            """
        )
        print(f"[FIX_ACTIVITY_AST] Found {len(rows)} candidate rows")

        updated = 0
        skipped = 0
        errors: list[str] = []

        for row in rows:
            row_id = row["id"]
            details = row["details"]
            new_details = _fix_details(details)
            if new_details is None:
                skipped += 1
                continue

            try:
                await conn.execute(
                    "UPDATE node_activity SET details = $1 WHERE id = $2",
                    new_details,
                    row_id,
                )
                updated += 1
                if updated % 50 == 0:
                    print(f"[FIX_ACTIVITY_AST] Progress: {updated} rows fixed")
            except Exception as e:  # noqa: BLE001
                errors.append(f"Row {row_id}: {e}")

        print(
            f"[FIX_ACTIVITY_AST] Completed: {updated} fixed, {skipped} skipped, {len(errors)} errors"
        )
        if errors:
            print(f"[FIX_ACTIVITY_AST] Errors ({len(errors)}):")
            for err in errors[:20]:
                print(f"  - {err}")

        return 0
    finally:
        await conn.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(fix_activity_log_ast()))
