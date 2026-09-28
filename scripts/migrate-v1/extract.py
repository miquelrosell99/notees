#!/usr/bin/env python3
"""Extract v1 relay envelopes for the three non-empty workspaces.

Streams `relay_envelope` rows (ORDER BY seq) from the v1 dev Postgres
container through psql COPY into JSONL files under `.extract/`:

    .extract/<workspace-uuid>.jsonl     one JSON object per envelope
    .extract/meta.json                  workspace names + row counts

Row shape (original v1 column names):
    id, workspace_id, actor_id, physical, logical, affected_node_ids,
    op_type, payload, timestamp (ISO-8601 UTC), seq

Usage: python3 extract.py
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
EXTRACT_DIR = HERE / ".extract"

DB_CONTAINER = "notees-db-dev"
DB_USER = "notees"
DB_NAME = "notees"

WORKSPACES = [
    "3b30e070-039b-47bc-ad0d-2440a2f173c5",
    "b42cb292-39f8-4d70-aa4d-a5fb7be12f8d",
    "bca97d7b-0dc0-48aa-9d14-abf67e1fdad3",
]

COLUMNS = (
    "id, workspace_id, actor_id, physical, logical, "
    "affected_node_ids::text, op_type, payload::text, "
    "to_char(timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'), seq"
)


def copy_unescape(field: str) -> str | None:
    """Decode one field of the psql COPY TEXT format.

    COPY escapes backslash, tab, newline and carriage return; ``\\N`` marks
    NULL. jsonb::text already JSON-escapes string contents — the only extra
    layer is COPY's meta-escaping.
    """
    if field == "\\N":
        return None
    out: list[str] = []
    i = 0
    while i < len(field):
        char = field[i]
        if char == "\\" and i + 1 < len(field):
            nxt = field[i + 1]
            if nxt == "\\":
                out.append("\\")
            elif nxt == "t":
                out.append("\t")
            elif nxt == "n":
                out.append("\n")
            elif nxt == "r":
                out.append("\r")
            else:
                out.append(nxt)
            i += 2
        else:
            out.append(char)
            i += 1
    return "".join(out)


def copy_workspace(workspace_id: str) -> int:
    """Stream one workspace's envelopes to .extract/<ws>.jsonl; return the count."""
    sql = (
        f"COPY (SELECT {COLUMNS} FROM relay_envelope "
        f"WHERE workspace_id = '{workspace_id}' ORDER BY seq) TO STDOUT"
    )
    proc = subprocess.Popen(
        ["docker", "exec", "-i", DB_CONTAINER, "psql", "-U", DB_USER, "-d", DB_NAME, "-c", sql],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    out_path = EXTRACT_DIR / f"{workspace_id}.jsonl"
    names = ["id", "workspace_id", "actor_id", "physical", "logical",
             "affected_node_ids", "op_type", "payload", "timestamp", "seq"]
    count = 0
    assert proc.stdout is not None
    with out_path.open("w", encoding="utf-8") as fh:
        for line in proc.stdout:
            line = line.rstrip("\n")
            if not line:
                continue
            fields = line.split("\t")
            if len(fields) != len(names):
                raise RuntimeError(f"malformed COPY line in {workspace_id}: {line[:200]!r}")
            fields = [copy_unescape(f) for f in fields]
            if any(f is None for f in fields):
                raise RuntimeError(f"unexpected NULL column in {workspace_id}: {dict(zip(names, fields))}")
            row = dict(zip(names, fields))
            row["physical"] = int(row["physical"])
            row["logical"] = int(row["logical"])
            row["affected_node_ids"] = json.loads(row["affected_node_ids"])
            row["payload"] = json.loads(row["payload"])
            row["seq"] = int(row["seq"])
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
            count += 1
    _, stderr = proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"psql COPY failed for {workspace_id}: {stderr}")
    return count


def workspace_names() -> dict[str, str]:
    sql = "SELECT uuid, name FROM workspace;"
    proc = subprocess.run(
        ["docker", "exec", "-i", DB_CONTAINER, "psql", "-U", DB_USER, "-d", DB_NAME, "-t", "-A", "-F", "\t", "-c", sql],
        capture_output=True,
        text=True,
        check=True,
    )
    names: dict[str, str] = {}
    for line in proc.stdout.splitlines():
        if not line.strip():
            continue
        uuid, _, name = line.partition("\t")
        names[uuid] = name
    return names


def main() -> None:
    EXTRACT_DIR.mkdir(parents=True, exist_ok=True)
    names = workspace_names()
    meta: dict[str, object] = {"workspaces": {}}
    for ws in WORKSPACES:
        count = copy_workspace(ws)
        meta["workspaces"][ws] = {"name": names.get(ws, "?"), "source_envelopes": count}
        print(f"{ws} ({names.get(ws, '?')}): {count} envelopes")
    (EXTRACT_DIR / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    total = sum(int(w["source_envelopes"]) for w in meta["workspaces"].values())  # type: ignore[index]
    print(f"total: {total} envelopes -> {EXTRACT_DIR}")


if __name__ == "__main__":
    main()
