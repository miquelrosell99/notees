#!/usr/bin/env python3
"""
Convert raw [[uuid]] text references to broken_link AST nodes.

This script scans all active nodes' AST content for text nodes containing
[[uuid]] or [label]([[uuid]]) patterns where the target UUID does NOT exist.
It replaces these raw references with proper broken_link AST nodes.

Run with:
    python scripts/convert_raw_uuid_to_broken_link.py

Requires DATABASE_URL environment variable to be set.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import uuid as uuid_module
from datetime import datetime, timezone

import asyncpg

_UUID_RE = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
UUID_PATTERN = re.compile(
    rf"(?:\[(?P<label>[^\]]+)\]\(\[\[(?P<uuid_labeled>{_UUID_RE})\]\]\)|\[\[(?P<uuid_bare>{_UUID_RE})\]\])",
    re.IGNORECASE,
)


def extract_uuid_and_label(match) -> tuple[str, str | None]:
    if match.group("uuid_labeled"):
        return match.group("uuid_labeled").lower(), match.group("label") or None
    return match.group("uuid_bare").lower(), None


def transform_text_node(text_value: str, missing_uuids: set[str]) -> list[dict]:
    """Split a text node containing unresolved [[uuid]] into text + broken_link nodes."""
    parts: list[dict] = []
    last_end = 0

    for match in UUID_PATTERN.finditer(text_value):
        target_uuid, label = extract_uuid_and_label(match)
        if target_uuid not in missing_uuids:
            continue

        before = text_value[last_end : match.start()]
        if before:
            parts.append({"type": "text", "text": before})

        link_uuid = str(uuid_module.uuid4())
        link_id = f"{target_uuid}:{link_uuid}"
        broken_link: dict = {
            "type": "broken_link",
            "link_id": link_id,
        }
        if label:
            broken_link["label"] = label
        parts.append(broken_link)

        last_end = match.end()

    if last_end < len(text_value):
        remaining = text_value[last_end:]
        if remaining:
            parts.append({"type": "text", "text": remaining})

    return parts


def walk_and_transform(nodes: list, missing_uuids: set[str]) -> tuple[list, int]:
    """Walk AST, replacing unresolved [[uuid]] text with broken_link nodes.

    Returns (new_nodes, count_of_links_converted).
    """
    converted = 0
    new_nodes: list = []

    for node in nodes:
        if not isinstance(node, dict):
            new_nodes.append(node)
            continue

        if node.get("type") == "text":
            text_val = node.get("text", "")
            if "[[" in text_val and UUID_PATTERN.search(text_val):
                replacement = transform_text_node(text_val, missing_uuids)
                if replacement and replacement != [node]:
                    link_count = sum(
                        1
                        for r in replacement
                        if isinstance(r, dict) and r.get("type") == "broken_link"
                    )
                    if link_count > 0:
                        new_nodes.extend(replacement)
                        converted += link_count
                        continue
            new_nodes.append(node)
        elif "children" in node:
            child_nodes, child_converted = walk_and_transform(node["children"], missing_uuids)
            new_node = {**node, "children": child_nodes}
            new_nodes.append(new_node)
            converted += child_converted
        else:
            new_nodes.append(node)

    return new_nodes, converted


async def main() -> int:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("ERROR: DATABASE_URL environment variable is required", file=sys.stderr)
        return 1

    conn = await asyncpg.connect(database_url)
    try:
        print("[CONVERT_RAW_UUID] Fetching all active nodes...")
        rows = await conn.fetch(
            """
            SELECT id, workspace_id, name
            FROM node
            WHERE active = TRUE
            ORDER BY id
            """
        )
        print(f"[CONVERT_RAW_UUID] Processing {len(rows)} nodes")

        # First pass: collect all referenced UUIDs
        all_referenced_uuids: set[str] = set()
        for row in rows:
            content = row["name"]
            if not content or "[[" not in content:
                continue
            try:
                ast = json.loads(content)
                if not isinstance(ast, list):
                    continue
            except (json.JSONDecodeError, TypeError):
                continue

            def collect_uuids(nodes: list) -> None:
                for n in nodes:
                    if not isinstance(n, dict):
                        continue
                    if n.get("type") == "text":
                        text = n.get("text", "")
                        if "[[" in text:
                            for m in UUID_PATTERN.finditer(text):
                                uuid = (
                                    m.group("uuid_labeled") or m.group("uuid_bare")
                                ).lower()
                                all_referenced_uuids.add(uuid)
                    if "children" in n:
                        collect_uuids(n["children"])

            collect_uuids(ast)

        if not all_referenced_uuids:
            print("[CONVERT_RAW_UUID] No raw UUID references found")
            return 0

        print(
            f"[CONVERT_RAW_UUID] Found {len(all_referenced_uuids)} unique referenced UUIDs"
        )

        # Resolve which UUIDs exist
        missing_uuids: set[str] = set()
        for ref_uuid in all_referenced_uuids:
            exists = await conn.fetchval(
                "SELECT 1 FROM node WHERE uuid = $1 AND active = TRUE LIMIT 1",
                ref_uuid,
            )
            if not exists:
                missing_uuids.add(ref_uuid)

        print(
            f"[CONVERT_RAW_UUID] {len(missing_uuids)} UUIDs do not exist → will be converted to broken_link"
        )

        if not missing_uuids:
            print("[CONVERT_RAW_UUID] All referenced UUIDs exist — nothing to convert")
            return 0

        # Second pass: transform and save
        nodes_fixed = 0
        links_converted = 0
        errors: list[str] = []

        for row in rows:
            node_id = row["id"]
            content = row["name"]

            if not content or "[[" not in content:
                continue

            try:
                ast = json.loads(content)
                if not isinstance(ast, list):
                    continue
                if ast and (not isinstance(ast[0], dict) or "type" not in ast[0]):
                    continue
            except (json.JSONDecodeError, TypeError):
                continue

            try:
                new_ast, converted = walk_and_transform(ast, missing_uuids)
                if converted > 0:
                    new_content = json.dumps(new_ast, ensure_ascii=False)
                    await conn.execute(
                        """
                        UPDATE node
                        SET name = $1, write_date = $2
                        WHERE id = $3
                        """,
                        new_content,
                        datetime.now(timezone.utc),
                        node_id,
                    )
                    nodes_fixed += 1
                    links_converted += converted
                    if nodes_fixed % 50 == 0:
                        print(
                            f"[CONVERT_RAW_UUID] Progress: {nodes_fixed} nodes fixed, {links_converted} links converted"
                        )
            except Exception as e:
                errors.append(f"Node {node_id}: {e}")
                continue

        print(
            f"[CONVERT_RAW_UUID] Completed: {nodes_fixed} nodes fixed, {links_converted} links converted, {len(errors)} errors"
        )
        if errors:
            print(f"[CONVERT_RAW_UUID] Errors ({len(errors)}):")
            for err in errors[:20]:
                print(f"  - {err}")

        return 0
    finally:
        await conn.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
