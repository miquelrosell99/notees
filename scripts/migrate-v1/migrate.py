#!/usr/bin/env python3
"""v1 -> v2 workspace migrator for Notees.

Transforms v1 relay envelopes (extracted by extract.py into `.extract/`) into
v2 envelopes and replays them per workspace into the production v2 server.

Subcommands:
    dry-run   transform everything, write the report, push NOTHING
    apply     seed workspaces, push batches of 500, copy assets, verify

The transformation is deterministic (companion-op envelope ids are uuid5
hashes of the v1 envelope id), so re-running `apply` is idempotent: the v2
relay dedupes by envelope id.

Verified v1 payload shapes (sampled per op type from relay_envelope):
    node.create          {nodeId, kind, index?, parentId?, classIds?, color?, icon?, initialContent?}
    node.updateContent   {nodeId, content?|crdtUpdate?|textUpdateB64?|textUpdate?|treeUpdate?|treeUpdateB64?}
    node.move            {nodeId, newParentId, newIndex}      (fractional position strings)
    node.delete          {nodeId}
    class.assign         {nodeId, classId}
    class.unassign       {nodeId, classId}
    class.create         {classId, name, icon?, color?, extends?, propertySchemaIds?}
    class.update         {classId, icon?, color?}            (+name possible, absent in data)
    class.delete         {classId}
    propertySchema.create  {schemaId, name, type, config?, options?, multi?, scope?, isSystem?, classFilterUuids?, defaultValue?}
    propertySchema.update  {schemaId, type?, options?}
    classPropertyEdge.create {classId, propertySchemaId, sequence, hidden}
    property.set         {nodeId, schemaId, index, value|{value: value}, propertyValueId}
    property.unset       {nodeId, schemaId, index}
    nodeView.create      {...}                                 (dropped)
    user.favorite.add/remove {nodeId}                          (dropped)
"""

from __future__ import annotations

import argparse
import heapq
import json
import math
import re
import shutil
import time
import sqlite3
import sys
import urllib.error
import urllib.request
import uuid
from collections import Counter
from pathlib import Path
from typing import Any

from content_ast import content_tokens_from_source, normalize_class_name, plain_text

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent.parent  # /etc/periphery/stacks/notees
EXTRACT_DIR = HERE / ".extract"
SEEDS_TS = REPO_ROOT / "v2" / "packages" / "domain" / "src" / "seeds.ts"
V2_DATA_DIR = REPO_ROOT / "config" / "notees" / "sync"
V1_DATA_DIR = REPO_ROOT / "data"
API_KEY_FILE = V2_DATA_DIR / "api_key.txt"
SERVER = "http://localhost:8377"
BATCH_SIZE = 500

WORKSPACES = [
    "3b30e070-039b-47bc-ad0d-2440a2f173c5",
    "b42cb292-39f8-4d70-aa4d-a5fb7be12f8d",
    "bca97d7b-0dc0-48aa-9d14-abf67e1fdad3",
]

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

# v1 property-schema type -> v2 property-schema type (verified against the
# v2 propertySchemaCreatePayload enum and the observed v1 values).
SCHEMA_TYPE_MAP = {
    "text": "text",
    "number": "number",
    "boolean": "boolean",
    "checkbox": "boolean",
    "date": "date",
    "date_range": "date_range",
    "url": "url",
    "email": "email",
    "select": "select",
    "selection": "select",
    "multi_select": "multi_select",
    "node": "object",
    "file": "image",
    "image": "image",
}

# Ops the migrator knows how to handle. Anything else fails the run loudly.
MAPPED_OP_TYPES = {
    "node.create", "node.updateContent", "node.updateIcon", "node.updateColor",
    "node.move", "node.delete",
    "class.assign", "class.unassign", "class.create", "class.update", "class.delete",
    "propertySchema.create", "propertySchema.update",
    "classPropertyEdge.create",
    "property.set", "property.unset",
    "asset.upload",
}
DROPPED_OP_TYPES = {"nodeView.create", "user.favorite.add", "user.favorite.remove"}


# ---------------------------------------------------------------------------
# v2 seed constants (parsed from @notees/domain seeds.ts so they stay in sync)
# ---------------------------------------------------------------------------

def _parse_seeds() -> tuple[set[str], set[str], dict[str, str]]:
    """Return (seeded class ids, seeded SPECS schema ids, seeded page ids)."""
    text = SEEDS_TS.read_text(encoding="utf-8")

    def block(name: str) -> dict[str, str]:
        match = re.search(rf"export const {name} = \{{(.*?)\}} as const;", text, re.S)
        if not match:
            raise RuntimeError(f"{name} not found in {SEEDS_TS}")
        return dict(re.findall(r'(\w+):\s*"([0-9a-f-]{36})"', match.group(1)))

    class_uuids = block("SYSTEM_CLASS_UUIDS")
    property_uuids = block("SYSTEM_PROPERTY_UUIDS")
    page_uuids = block("SYSTEM_PAGE_UUIDS")
    specs = re.search(r"export const SYSTEM_PROPERTY_SPECS.*?= \{(.*?)\n\};", text, re.S)
    if not specs:
        raise RuntimeError("SYSTEM_PROPERTY_SPECS not found")
    spec_names = re.findall(r"^\s{2}(\w+):\s*\{", specs.group(1), re.M)
    specs_seeded = {property_uuids[n] for n in spec_names if n in property_uuids}
    # Only classes the workspace seed actually emits (SEEDED_SYSTEM_CLASSES)
    # count as pre-existing; the UUID map also lists unseeded ids
    # (warning/tip/info/danger/success) which must replay from the v1 log.
    seeded_names = re.search(r"export const SEEDED_SYSTEM_CLASSES.*?\[(.*?)\];", text, re.S)
    if not seeded_names:
        raise RuntimeError("SEEDED_SYSTEM_CLASSES not found")
    classes_seeded = {
        class_uuids[n.strip().strip('"')]
        for n in seeded_names.group(1).split(",")
        if n.strip().strip('"') in class_uuids
    }
    return classes_seeded, specs_seeded, set(page_uuids.values())


SEEDED_CLASS_IDS, SEEDED_SCHEMA_IDS, SEEDED_PAGE_IDS = _parse_seeds()

# Types of the seeded object-typed property schemas (from SYSTEM_PROPERTY_SPECS
# in seeds.ts) — needed to fix up property.set values that reference seeded
# schemas created outside this workspace's v1 log.
SEEDED_SCHEMA_TYPES = {
    "00000000-0000-0000-0000-000000000011": ("object", True),   # attachments
    "00000000-0000-0000-0000-000000000012": ("object", True),   # authors
    "00000000-0000-0000-0000-000000000020": ("object", False),  # highlightAsset
}

# Types of the seeded class-scoped system schemas that are NOT in SPECS but are
# referenced by migrated property.set ops (so value fixups stay correct).
SEEDED_SCHEMA_TYPES.update({
    "00000000-0000-0000-0003-000000000001": ("select", False),  # taskStatus
    "00000000-0000-0000-0003-000000000004": ("select", False),  # taskPriority
    "00000000-0000-0000-0003-000000000006": ("select", False),  # taskRecurrence
    "00000000-0000-0000-0000-000000000005": ("image", False),   # cover
    "00000000-0000-0000-0000-000000000006": ("image", False),   # banner
    "00000000-0000-0000-0000-000000000009": ("text", False),    # description
    "00000000-0000-0000-0000-000000000003": ("boolean", False), # showHierarchy
})


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _is_uuid(value: str) -> bool:
    return bool(UUID_RE.match(value))


ACTOR_CACHE: dict[str, str] = {}


def remap_actor(actor: str) -> tuple[str, str | None]:
    """v2 requires actorId to be a uuid. v1 backfill actors embed one."""
    if actor in ACTOR_CACHE:
        return ACTOR_CACHE[actor], None if ACTOR_CACHE[actor] == actor else actor
    if _is_uuid(actor):
        ACTOR_CACHE[actor] = actor
        return actor, None
    match = re.search(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$", actor)
    remapped = match.group(1) if match else str(uuid.uuid5(uuid.NAMESPACE_URL, f"notees-v1-actor:{actor}"))
    ACTOR_CACHE[actor] = remapped
    return remapped, actor


def companion_id(v1_id: str, suffix: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"notees-migrate-v1|{v1_id}|{suffix}"))


def position_of(index: Any, length: int) -> int:
    """Fractional v1 index string ('6.0', '-1024.0', '0.5') -> clamped int slot."""
    if index is None:
        return length
    try:
        value = float(index)
    except (TypeError, ValueError):
        return length
    rounded = math.floor(value + 0.5) if value >= 0 else math.ceil(value - 0.5)
    return max(0, min(rounded, length))


def map_options(raw: Any) -> list[dict[str, Any]] | None:
    """v1 options ({id|uuid, name|label, icon?, sequence?}) -> v2 {id, label}."""
    if not isinstance(raw, list):
        return None
    options: list[dict[str, Any]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        option_id = entry.get("id") if isinstance(entry.get("id"), str) else entry.get("uuid")
        label = entry.get("name") if isinstance(entry.get("name"), str) else entry.get("label")
        if isinstance(option_id, str) and isinstance(label, str):
            options.append({"id": option_id, "label": label})
    return options


# ---------------------------------------------------------------------------
# transformer
# ---------------------------------------------------------------------------

class WorkspaceTransformer:
    def __init__(self, workspace_id: str) -> None:
        self.ws = workspace_id
        self.source_path = EXTRACT_DIR / f"{workspace_id}.jsonl"
        self.out_path = EXTRACT_DIR / f"{workspace_id}.v2.jsonl"
        self.known_ids: set[str] = set(SEEDED_CLASS_IDS) | set(SEEDED_PAGE_IDS)
        self.schema_types: dict[str, tuple[str, bool]] = {}  # schemaId -> (v2 type, multi)
        self.first_create_seq: dict[str, int] = {}
        self.class_create_seq: dict[str, int] = {}
        self.parent_of: dict[str, str | None] = {}
        self.class_kind_nodes: set[str] = set()
        self.create_rows: list[dict[str, Any]] = []
        self.superseded_deletes: set[int] = set()
        self.report: dict[str, Any] = {
            "source": 0, "emitted": 0, "companions": 0,
            "mapped_by_op": Counter(), "dropped_by_op": Counter(),
            "skipped_by_reason": Counter(), "content_fallbacks": 0,
            "actor_remapped_from": Counter(), "parentless_blocks": 0,
            "asset_records": [],
            "deferred_set_extends": 0, "topo_cycle_fallback": 0,
        }
        # child-order simulation state
        self.child_lists: dict[str | None, list[str]] = {}
        self.node_parent: dict[str, str | None] = {}
        self.deferred: list[dict[str, Any]] = []  # setExtends companions, emitted at end
        self._file_schema_emitted: set[str] = set()
        self.last_content: dict[str, str] = {}  # nodeId -> latest v1 plain text (verification)
        # Best-effort v1 name table for mention capture: class.create carries
        # names; node.create may in some v1 builds (v2 derives the rest from
        # content at display time, so missing entries are safe).
        self.v1_names: dict[str, str] = {}

    def resolve_v1_name(self, node_id: str) -> str:
        return self.v1_names.get(node_id, "")

    # -- pass 1 ---------------------------------------------------------------
    def collect_known_ids(self) -> None:
        max_create_seq: dict[str, int] = {}
        delete_rows: list[tuple[int, str]] = []
        with self.source_path.open(encoding="utf-8") as fh:
            for line in fh:
                row = json.loads(line)
                op = row["op_type"]
                payload = row["payload"]
                if op == "node.create":
                    self.create_rows.append(row)
                    node_id = payload.get("nodeId")
                    if isinstance(node_id, str):
                        self.known_ids.add(node_id)
                        if isinstance(payload.get("name"), str):
                            self.v1_names[node_id] = payload["name"]
                        if payload.get("kind") == "class":
                            self.class_kind_nodes.add(node_id)
                        if node_id not in self.first_create_seq:
                            self.first_create_seq[node_id] = row["seq"]
                            self.parent_of[node_id] = payload.get("parentId")
                        max_create_seq[node_id] = max(max_create_seq.get(node_id, 0), row["seq"])
                elif op == "node.delete":
                    node_id = payload.get("nodeId")
                    if isinstance(node_id, str):
                        delete_rows.append((row["seq"], node_id))
                elif op == "class.create":
                    self.create_rows.append(row)
                    class_id = payload.get("classId")
                    if isinstance(class_id, str):
                        self.known_ids.add(class_id)
                        if isinstance(payload.get("name"), str):
                            self.v1_names[class_id] = payload["name"]
                        if class_id not in self.class_create_seq:
                            self.class_create_seq[class_id] = row["seq"]
                elif op == "propertySchema.create":
                    self._remember_schema(payload)
        # v1 hard-deletes and the log may re-create the node later; v2 has no
        # revive op, so a delete that a later create supersedes is dropped.
        for seq, node_id in delete_rows:
            if max_create_seq.get(node_id, 0) > seq:
                self.superseded_deletes.add(seq)

    def sorted_create_rows(self) -> list[dict[str, Any]]:
        """All create rows ordered so every node create follows its parent's.

        v1 tolerated child-before-parent logs; v2 requires the parent to
        exist at apply time. Class creates go first (classes are tree-external,
        parents of nothing); node creates follow in a stable topological sort
        (seq order tie-break), duplicate re-creates trailing their first.
        """
        class_rows = [r for r in self.create_rows if r["op_type"] == "class.create"]
        node_rows = [r for r in self.create_rows if r["op_type"] == "node.create"]
        node_ids = {r["payload"]["nodeId"] for r in node_rows}
        first_row: dict[str, dict[str, Any]] = {}
        duplicates: dict[str, list[dict[str, Any]]] = {}
        for row in node_rows:
            node_id = row["payload"]["nodeId"]
            if node_id not in first_row:
                first_row[node_id] = row
            else:
                duplicates.setdefault(node_id, []).append(row)

        children_of: dict[str, list[str]] = {}
        indegree: dict[str, int] = {}
        for node_id, row in first_row.items():
            parent = row["payload"].get("parentId")
            if parent in first_row:
                children_of.setdefault(parent, []).append(node_id)
                indegree[node_id] = 1
        available = [(row["seq"], node_id) for node_id, row in first_row.items() if indegree.get(node_id, 0) == 0]
        heapq.heapify(available)
        ordered: list[dict[str, Any]] = []
        emitted: set[str] = set()
        while available:
            _, node_id = heapq.heappop(available)
            if node_id in emitted:
                continue
            emitted.add(node_id)
            ordered.append(first_row[node_id])
            for child in children_of.get(node_id, []):
                indegree[child] -= 1
                if indegree[child] == 0:
                    heapq.heappush(available, (first_row[child]["seq"], child))
        if len(ordered) != len(first_row):
            leftover = [nid for nid in first_row if nid not in emitted]
            self.report["topo_cycle_fallback"] = len(leftover)
            for nid in sorted(leftover, key=lambda n: first_row[n]["seq"]):
                ordered.append(first_row[nid])
        result = class_rows + [
            row for node_row in ordered for row in [node_row, *duplicates.get(node_row["payload"]["nodeId"], [])]
        ]
        return result

    def _remember_schema(self, payload: dict[str, Any]) -> None:
        schema_id = payload.get("schemaId")
        if not isinstance(schema_id, str):
            return
        raw_type = payload.get("type")
        mapped = SCHEMA_TYPE_MAP.get(str(raw_type))
        if mapped is None:
            raise RuntimeError(f"unmapped v1 propertySchema type {raw_type!r} on {schema_id}")
        self.schema_types[schema_id] = (mapped, bool(payload.get("multi")))

    # -- envelope scaffold ------------------------------------------------------
    def _envelope(self, row: dict[str, Any], op_type: str, payload: dict[str, Any],
                  env_id: str | None = None, logical_bump: int = 0) -> dict[str, Any]:
        actor, remapped_from = remap_actor(row["actor_id"])
        if remapped_from:
            self.report["actor_remapped_from"][remapped_from] += 1
        return {
            "id": env_id if env_id is not None else row["id"],
            "protocolVersion": 3,
            "workspaceId": row["workspace_id"],
            "actorId": actor,
            "deviceId": "migrated-v1",
            "client": "migrate-v1",
            "hlc": {"physical": row["physical"], "logical": row["logical"] + logical_bump},
            "affectedNodeIds": row["affected_node_ids"],
            "opType": op_type,
            "timestamp": row["timestamp"],
            "payload": payload,
        }

    # -- main transform ---------------------------------------------------------
    def transform(self) -> None:
        out = self.out_path.open("w", encoding="utf-8")
        try:
            # Creates first (classes, then nodes in stable topological order):
            # every later op then applies against an existing node.
            for row in self.sorted_create_rows():
                self._emit(self._transform_row(row), out)
            # Everything else in original seq order.
            with self.source_path.open(encoding="utf-8") as fh:
                for line in fh:
                    row = json.loads(line)
                    self.report["source"] += 1
                    if row["op_type"] in ("node.create", "class.create"):
                        continue  # already emitted above
                    self._emit(self._transform_row(row), out)
            # deferred class.setExtends companions (all classes exist by now)
            for env in self.deferred:
                out.write(json.dumps(env, ensure_ascii=False) + "\n")
                self.report["emitted"] += 1
                self.report["companions"] += 1
        finally:
            out.close()
        self.report["mapped_by_op"] = dict(self.report["mapped_by_op"])
        self.report["dropped_by_op"] = dict(self.report["dropped_by_op"])
        self.report["skipped_by_reason"] = dict(self.report["skipped_by_reason"])
        self.report["actor_remapped_from"] = dict(self.report["actor_remapped_from"])

    def _emit(self, envs: list[dict[str, Any]], out: Any) -> None:
        for env in envs:
            out.write(json.dumps(env, ensure_ascii=False) + "\n")
            self.report["emitted"] += 1

    def _note(self, kind: str, key: str) -> None:
        self.report[kind][key] += 1

    def _transform_row(self, row: dict[str, Any]) -> list[dict[str, Any]]:
        op = row["op_type"]
        payload = row["payload"]
        if op in DROPPED_OP_TYPES:
            self._note("dropped_by_op", op)
            return []
        if op not in MAPPED_OP_TYPES:
            raise RuntimeError(f"UNMAPPED op type {op!r} (seq {row['seq']}) — refusing to drop silently")
        handler = getattr(self, f"_op_{op.replace('.', '_')}")
        return handler(row, payload)

    # -- node.* ------------------------------------------------------------------
    def _is_class_id(self, node_id: str | None) -> bool:
        return node_id is not None and (
            node_id in self.class_create_seq or node_id in self.class_kind_nodes)

    def _op_node_create(self, row: dict[str, Any], p: dict[str, Any]) -> list[dict[str, Any]]:
        node_id = p["nodeId"]
        kind = p.get("kind", "block")
        parent_id = p.get("parentId")
        if parent_id is not None and parent_id not in self.known_ids:
            # Parent never created anywhere in the log (v1 kept the dangling
            # reference; v2 would fail). Migrate as a root page.
            parent_id = None
            self._note("skipped_by_reason", "orphan_parent_create")
        if kind == "class" and parent_id is not None:
            # v2 classes are always roots (CHECK is_class = 0 OR parent_id IS
            # NULL); v1 had one class-kind node carrying a parent.
            parent_id = None
            self._note("skipped_by_reason", "class_kind_parent_dropped")
        if self._is_class_id(parent_id):
            # v1 allowed nodes under class nodes. The importer keeps its
            # conservative choice — migrate the node as a root page — even
            # though v2 now renders non-class children inside classes.
            parent_id = None
            self._note("skipped_by_reason", "class_parent_rejected_create")
        if kind == "class":
            # Class declaration is the class.create op (Revision 11): the
            # class node is a root and takes no parent/classIds/render bit.
            out_payload: dict[str, Any] = {"classId": node_id}
            initial = p.get("initialContent")
            if isinstance(initial, list) and initial:
                tokens = content_tokens_from_source(initial, self.resolve_v1_name)
                out_payload["contentAst"] = tokens
                self.last_content[node_id] = plain_text(tokens)
            if isinstance(p.get("icon"), str):
                out_payload["icon"] = p["icon"]
            if isinstance(p.get("color"), str):
                out_payload["color"] = p["color"]
            envs = [self._envelope(row, "class.create", out_payload)]
            self._note("mapped_by_op", row["op_type"])
            return envs
        # Render state (Revision 11): pages present as main; blocks are
        # inline-body children. v1 allowed parentless blocks — they migrate
        # as root pages (document chrome either way) so nothing is lost.
        present_as_main = True
        if kind == "block" and parent_id is not None:
            present_as_main = False
        if kind == "block" and parent_id is None:
            self.report["parentless_blocks"] += 1
        out_payload = {"objectId": node_id, "presentAsMain": present_as_main}
        class_ids = p.get("classIds")
        if isinstance(class_ids, list) and class_ids:
            out_payload["classIds"] = class_ids
        if parent_id is not None:
            out_payload["parentId"] = parent_id
        initial = p.get("initialContent")
        if isinstance(initial, list) and initial:
            tokens = content_tokens_from_source(initial, self.resolve_v1_name)
            out_payload["contentAst"] = tokens
            self.last_content[node_id] = plain_text(tokens)
        envs = [self._envelope(row, "object.create", out_payload)]
        # icon/color ride object.update (object.create has no such fields)
        update_fields: dict[str, Any] = {"objectId": node_id}
        if isinstance(p.get("icon"), str):
            update_fields["icon"] = p["icon"]
        if isinstance(p.get("color"), str):
            update_fields["color"] = p["color"]
        if len(update_fields) > 1:
            envs.append(self._envelope(row, "object.update", update_fields,
                                       env_id=companion_id(row["id"], "appearance"), logical_bump=1))
            self.report["companions"] += 1
        # child-order simulation
        self.node_parent[node_id] = parent_id
        siblings = self.child_lists.setdefault(parent_id, [])
        if node_id not in siblings:
            siblings.insert(position_of(p.get("index"), len(siblings)), node_id)
        self._note("mapped_by_op", row["op_type"])
        return envs

    def _op_node_updateContent(self, row: dict[str, Any], p: dict[str, Any]) -> list[dict[str, Any]]:
        node_id = p["nodeId"]
        if node_id not in self.known_ids:
            self._note("skipped_by_reason", "updateContent_unknown_node")
            return []
        source = p.get("content") if "content" in p else p.get("crdtUpdate")
        if source is None:
            # CRDT-binary-only op with no usable mirror (textUpdateB64 /
            # textUpdate / treeUpdate carriers) — nothing readable to migrate.
            self._note("skipped_by_reason", "crdt_only_no_mirror")
            return []
        raw_string = source if isinstance(source, str) else None
        tokens = content_tokens_from_source(source, self.resolve_v1_name)
        if raw_string is not None and raw_string.strip():
            try:
                json.loads(raw_string)
            except ValueError:
                # Unparseable content AST: content_tokens_from_source already
                # fell back to a single raw-string text token.
                self.report["content_fallbacks"] += 1
        self.last_content[node_id] = plain_text(tokens)
        self._note("mapped_by_op", row["op_type"])
        return [self._envelope(row, "object.update", {"objectId": node_id, "contentAst": tokens})]

    def _op_node_updateIcon(self, row: dict[str, Any], p: dict[str, Any]) -> list[dict[str, Any]]:
        self._note("mapped_by_op", row["op_type"])
        return [self._envelope(row, "object.update", {"objectId": p["nodeId"], "icon": p["icon"]})]

    def _op_node_updateColor(self, row: dict[str, Any], p: dict[str, Any]) -> list[dict[str, Any]]:
        self._note("mapped_by_op", row["op_type"])
        return [self._envelope(row, "object.update", {"objectId": p["nodeId"], "color": p["color"]})]

    def _op_node_move(self, row: dict[str, Any], p: dict[str, Any]) -> list[dict[str, Any]]:
        node_id = p["nodeId"]
        new_parent = p.get("newParentId")
        if node_id not in self.known_ids or (new_parent is not None and new_parent not in self.known_ids):
            self._note("skipped_by_reason", "move_unknown_node_or_parent")
            return []
        if self._is_class_id(new_parent):
            self._note("skipped_by_reason", "class_parent_rejected_move")
            return []
        old_parent = self.node_parent.get(node_id)
        old_list = self.child_lists.setdefault(old_parent, [])
        if node_id in old_list:
            old_list.remove(node_id)
        siblings = self.child_lists.setdefault(new_parent, [])
        pos = position_of(p.get("newIndex"), len(siblings))
        siblings.insert(pos, node_id)
        self.node_parent[node_id] = new_parent
        out_payload: dict[str, Any] = {"objectId": node_id, "parentId": new_parent}
        if pos > 0:
            out_payload["afterId"] = siblings[pos - 1]
        self._note("mapped_by_op", row["op_type"])
        return [self._envelope(row, "object.move", out_payload)]

    def _op_node_delete(self, row: dict[str, Any], p: dict[str, Any]) -> list[dict[str, Any]]:
        node_id = p["nodeId"]
        if node_id not in self.known_ids:
            self._note("skipped_by_reason", "delete_unknown_node")
            return []
        if row["seq"] in self.superseded_deletes:
            # v1 hard-deleted and later re-created the node; v2 has no revive
            # op, so keeping the node alive is the closest applicable mapping.
            self._note("skipped_by_reason", "delete_dropped_node_recreated")
            return []
        self._note("mapped_by_op", row["op_type"])
        # v1 hard-deletes a single node row; v2's object.delete trashes the
        # subtree instead (permanent would destroy descendant content that v1
        # kept). Noted in the report as a semantic deviation.
        return [self._envelope(row, "object.delete", {"objectId": node_id})]

    # -- class.* -----------------------------------------------------------------
    def _op_class_assign(self, row: dict[str, Any], p: dict[str, Any]) -> list[dict[str, Any]]:
        node_id = p["nodeId"]
        if node_id not in self.known_ids:
            self._note("skipped_by_reason", "assign_unknown_node")
            return []
        self._note("mapped_by_op", row["op_type"])
        # v2's OR-Set membership carrier: a re-issued object.create whose
        # classIds the applier unions into class_member_set (tree no-op).
        return [self._envelope(row, "object.create", {"objectId": node_id, "classIds": [p["classId"]]})]

    def _op_class_unassign(self, row: dict[str, Any], p: dict[str, Any]) -> list[dict[str, Any]]:
        node_id = p["nodeId"]
        if node_id not in self.known_ids:
            self._note("skipped_by_reason", "unassign_unknown_node")
            return []
        self._note("mapped_by_op", row["op_type"])
        return [self._envelope(row, "class.unassign", {"objectId": node_id, "classId": p["classId"]})]

    def _op_class_create(self, row: dict[str, Any], p: dict[str, Any]) -> list[dict[str, Any]]:
        class_id = p["classId"]
        if class_id in SEEDED_CLASS_IDS:
            # v2's workspace seed already created this class (same fixed uuid,
            # newer HLC) — replaying would clobber the seed registry row.
            self._note("dropped_by_op", "class.create (seed duplicate)")
            return []
        # Title-is-content: the class's name is its text content (a single
        # text token — class.create carries contentAst, not a name field).
        name = normalize_class_name(p.get("name"))
        out_payload: dict[str, Any] = {"classId": class_id, "contentAst": [{"type": "text", "text": name}]}
        if isinstance(p.get("icon"), str):
            out_payload["icon"] = p["icon"]
        if isinstance(p.get("color"), str):
            out_payload["color"] = p["color"]
        envs = [self._envelope(row, "class.create", out_payload)]
        if isinstance(p.get("propertySchemaIds"), list) and p["propertySchemaIds"]:
            self._note("skipped_by_reason", "class.create_propertySchemaIds_dropped")
        extends = p.get("extends")
        if isinstance(extends, list) and extends:
            parents = [e for e in extends if isinstance(e, str)]
            if all(parent in self.known_ids for parent in parents):
                # Deferred to the end of the stream: some v1 logs create a
                # child class before its parent (24 rows), and v2's
                # class.setExtends requires both nodes to exist.
                self.deferred.append(
                    self._envelope(row, "class.setExtends",
                                   {"classId": class_id, "parentClassIds": parents},
                                   env_id=companion_id(row["id"], "extends"), logical_bump=1))
            else:
                self._note("skipped_by_reason", "setExtends_dangling_parent")
        self._note("mapped_by_op", row["op_type"])
        return envs

    def _op_class_update(self, row: dict[str, Any], p: dict[str, Any]) -> list[dict[str, Any]]:
        class_id = p["classId"]
        if class_id in SEEDED_CLASS_IDS:
            self._note("dropped_by_op", "class.update (seed duplicate)")
            return []
        out_payload: dict[str, Any] = {"classId": class_id}
        for field in ("name", "icon", "color"):
            if isinstance(p.get(field), str):
                if field == "name":
                    # Title-is-content: the rename rewrites the class's text
                    # content (class.update carries contentAst, not name).
                    out_payload["contentAst"] = [{"type": "text", "text": normalize_class_name(p[field])}]
                else:
                    out_payload[field] = p[field]
        if len(out_payload) == 1:
            self._note("skipped_by_reason", "class_update_no_fields")
            return []
        self._note("mapped_by_op", row["op_type"])
        return [self._envelope(row, "class.update", out_payload)]

    def _op_class_delete(self, row: dict[str, Any], p: dict[str, Any]) -> list[dict[str, Any]]:
        class_id = p["classId"]
        if class_id in SEEDED_CLASS_IDS:
            self._note("dropped_by_op", "class.delete (seed duplicate)")
            return []
        if class_id not in self.known_ids:
            self._note("skipped_by_reason", "class_delete_unknown")
            return []
        self._note("mapped_by_op", row["op_type"])
        return [self._envelope(row, "class.delete", {"classId": class_id})]

    # -- property schemas ---------------------------------------------------------
    def _op_propertySchema_create(self, row: dict[str, Any], p: dict[str, Any]) -> list[dict[str, Any]]:
        schema_id = p["schemaId"]
        if schema_id in SEEDED_SCHEMA_IDS:
            self._note("dropped_by_op", "propertySchema.create (seed duplicate)")
            return []
        self._remember_schema(p)
        schema_type, multi = self.schema_types[schema_id]
        out_payload: dict[str, Any] = {
            "propertySchemaId": schema_id,
            "name": normalize_class_name(p.get("name")),
            "type": schema_type,
            "multi": multi,
        }
        scope = p.get("scope")
        out_payload["scope"] = scope if scope in ("global", "class", "object") else "global"
        options = None
        config = p.get("config")
        if isinstance(config, dict) and isinstance(config.get("options"), list):
            options = map_options(config["options"])
        elif isinstance(p.get("options"), list):
            options = map_options(p["options"])
        if options:
            out_payload["options"] = options
        if isinstance(p.get("classFilterUuids"), list) and p["classFilterUuids"]:
            out_payload["targetClassFilter"] = p["classFilterUuids"]
        for dropped in ("isSystem", "defaultValue"):
            if dropped in p:
                self._note("skipped_by_reason", f"schema_field_dropped:{dropped}")
        self._note("mapped_by_op", row["op_type"])
        return [self._envelope(row, "propertySchema.create", out_payload)]

    def _op_propertySchema_update(self, row: dict[str, Any], p: dict[str, Any]) -> list[dict[str, Any]]:
        schema_id = p["schemaId"]
        if schema_id in SEEDED_SCHEMA_IDS:
            self._note("dropped_by_op", "propertySchema.update (seed duplicate)")
            return []
        out_payload: dict[str, Any] = {"propertySchemaId": schema_id}
        options = map_options(p.get("options"))
        if options is not None:
            out_payload["options"] = options
        if "type" in p:
            self._note("skipped_by_reason", "schema_update_field_dropped:type")
        if len(out_payload) == 1:
            self._note("skipped_by_reason", "schema_update_no_fields")
            return []
        self._note("mapped_by_op", row["op_type"])
        return [self._envelope(row, "propertySchema.update", out_payload)]

    def _op_classPropertyEdge_create(self, row: dict[str, Any], p: dict[str, Any]) -> list[dict[str, Any]]:
        out_payload: dict[str, Any] = {
            "classId": p["classId"],
            "propertySchemaId": self._remap_file_schema(p["propertySchemaId"]),
            "sequence": int(p.get("sequence", 0)),
        }
        if "hidden" in p:
            out_payload["hideWhenEmpty"] = bool(p["hidden"])
        self._note("mapped_by_op", row["op_type"])
        return [self._envelope(row, "class.property.set", out_payload)]

    # -- property values ------------------------------------------------------------
    def _fix_property_value(self, schema_id: str, value: Any) -> Any:
        schema_id = self._remap_file_schema(schema_id)
        schema = self.schema_types.get(schema_id) or SEEDED_SCHEMA_TYPES.get(schema_id)
        if schema is None:
            self._note("skipped_by_reason", "property_value_unknown_schema")
            return value
        schema_type, _multi = schema
        if schema_type == "object":
            if isinstance(value, str):
                return {"nodeId": value}
            if isinstance(value, list):
                return [{"nodeId": v} if isinstance(v, str) else v for v in value]
        return value

    FILE_SCHEMA_RE = re.compile(r"^file-schema-([0-9a-f-]{36})$")

    def _remap_file_schema(self, schema_id: str) -> str:
        """v1's asset migration used a non-uuid schema id ('file-schema-<ws>').

        Remap it to a deterministic uuid and synthesize the v2
        propertySchema.create (type image) before the first reference.
        """
        match = self.FILE_SCHEMA_RE.match(schema_id)
        if not match:
            return schema_id
        remapped = str(uuid.uuid5(uuid.NAMESPACE_URL, f"notees-migrate-v1|schema|{schema_id}"))
        if remapped not in self.schema_types:
            self.schema_types[remapped] = ("image", False)
        return remapped

    def _file_schema_create(self, row: dict[str, Any], remapped: str) -> dict[str, Any]:
        """Synthesized propertySchema.create for the remapped file schema."""
        self._note("skipped_by_reason", "file_schema_synthesized")
        return self._envelope(
            row,
            "propertySchema.create",
            {"propertySchemaId": remapped, "name": "file", "type": "image",
             "multi": False, "scope": "global"},
            env_id=companion_id(f"{self.ws}:{remapped}", "file-schema-create"),
        )

    def _maybe_file_schema_create(self, row: dict[str, Any], schema_id: str) -> list[dict[str, Any]]:
        match = self.FILE_SCHEMA_RE.match(schema_id)
        if not match:
            return []
        remapped = self._remap_file_schema(schema_id)
        if remapped in self._file_schema_emitted:
            return []
        self._file_schema_emitted.add(remapped)
        env = self._file_schema_create(row, remapped)
        self.report["companions"] += 1
        return [env]

    def _op_property_set(self, row: dict[str, Any], p: dict[str, Any]) -> list[dict[str, Any]]:
        node_id = p["nodeId"]
        if node_id not in self.known_ids:
            self._note("skipped_by_reason", "property_set_unknown_node")
            return []
        envs = self._maybe_file_schema_create(row, p["schemaId"])
        raw = p.get("value")
        value = raw.get("value") if isinstance(raw, dict) and "value" in raw else raw
        value = self._fix_property_value(p["schemaId"], value)
        if isinstance(value, dict) and isinstance(value.get("hash"), str):
            # v1 file-typed value: an asset content reference. Record it for
            # the asset-copy step (the bytes may still exist on disk).
            self.report["asset_records"].append({
                "workspaceId": row["workspace_id"],
                "hash": value["hash"],
                "originalName": value.get("filename") or value["hash"],
            })
        if "propertyValueId" in p:
            self._note("skipped_by_reason", "propertyValueId_dropped")
        out_payload: dict[str, Any] = {
            "objectId": node_id,
            "propertySchemaId": self._remap_file_schema(p["schemaId"]),
            "value": value,
            "idx": int(p.get("index", 0) or 0),
        }
        self._note("mapped_by_op", row["op_type"])
        envs.append(self._envelope(row, "property.set", out_payload))
        return envs

    def _op_property_unset(self, row: dict[str, Any], p: dict[str, Any]) -> list[dict[str, Any]]:
        node_id = p["nodeId"]
        if node_id not in self.known_ids:
            self._note("skipped_by_reason", "property_unset_unknown_node")
            return []
        envs = self._maybe_file_schema_create(row, p["schemaId"])
        out_payload: dict[str, Any] = {
            "objectId": node_id,
            "propertySchemaId": self._remap_file_schema(p["schemaId"]),
            "idx": int(p.get("index", 0) or 0),
        }
        self._note("mapped_by_op", row["op_type"])
        envs.append(self._envelope(row, "property.unset", out_payload))
        return envs

    # -- assets ---------------------------------------------------------------------
    def _op_asset_upload(self, row: dict[str, Any], p: dict[str, Any]) -> list[dict[str, Any]]:
        # Not present in the migrated v1 logs; implemented for completeness.
        hash_value = p.get("hash")
        out_payload: dict[str, Any] = {
            "objectId": p["nodeId"],
            "assetId": p["assetId"],
            "hash": hash_value,
            "mimeType": p["mimeType"],
            "size": int(p["size"]),
            "originalName": p["originalName"],
        }
        self.report["asset_records"].append({
            "workspaceId": row["workspace_id"], "hash": hash_value,
            "originalName": p["originalName"],
        })
        self._note("mapped_by_op", row["op_type"])
        return [self._envelope(row, "asset.attach", out_payload)]


# ---------------------------------------------------------------------------
# server I/O
# ---------------------------------------------------------------------------

def api_key() -> str:
    return API_KEY_FILE.read_text(encoding="utf-8").strip()


def http_json(method: str, path: str, workspace: str | None = None,
              body: Any = None, timeout: int = 120) -> Any:
    headers = {"X-API-Key": api_key()}
    if workspace:
        headers["X-Workspace-Id"] = workspace
    data = json.dumps(body).encode("utf-8") if body is not None else None
    if data:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(SERVER + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {path} -> HTTP {error.code}: {detail[:2000]}") from error


def stats(workspace: str) -> int:
    return int(http_json("GET", f"/api/relay/v2/stats?workspaceId={workspace}", workspace)["envelopeCount"])


def seed_workspace(workspace: str) -> None:
    # v2 seeds a workspace on first object-route touch (ensureSeeded). The
    # seeded system class nodes must exist before migrated class.setExtends /
    # property ops apply.
    http_json("GET", "/api/objects?presentAsMain=true&limit=1", workspace)


def push_workspace(workspace: str) -> dict[str, Any]:
    before = stats(workspace)
    seed_workspace(workspace)
    after_seed = stats(workspace)
    seeded = after_seed - before

    expected = sum(1 for _ in (EXTRACT_DIR / f"{workspace}.v2.jsonl").open(encoding="utf-8"))
    # Seed envelopes present in the workspace (this run's delta on a fresh
    # workspace; on re-runs the seed is a no-op, so derive it by subtracting
    # the migrated envelopes already present before this run).
    seed_present = after_seed - min(before, expected)
    already = min(before, expected)
    if already >= expected:
        print(f"  already fully pushed ({already} envelopes), skipping", flush=True)
        return {"seeded_envelopes": seeded, "seed_total": seed_present,
                "pushed_envelopes": expected, "skipped": True}

    emitted = 0
    batch: list[str] = []
    path = EXTRACT_DIR / f"{workspace}.v2.jsonl"
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            batch.append(line)
            if len(batch) == BATCH_SIZE:
                emitted += _post_batch(workspace, batch)
                batch = []
    if batch:
        emitted += _post_batch(workspace, batch)
    return {"seeded_envelopes": seeded, "seed_total": seed_present, "pushed_envelopes": emitted}


def _post_batch(workspace: str, batch_lines: list[str]) -> int:
    envelopes = [json.loads(line) for line in batch_lines]
    for attempt in range(6):
        try:
            result = http_json("POST", "/api/relay/v2/batch", workspace, {"envelopes": envelopes})
            break
        except RuntimeError as error:
            if "429" not in str(error) or attempt == 5:
                raise
            time.sleep(15 * (attempt + 1))
    saved = int(result.get("savedCount", -1))
    if saved != len(envelopes):
        # Partial save = envelope ids already present (idempotent re-run) or an
        # apply failure; the server saved what it could, so surface it.
        print(f"  batch saved {saved}/{len(envelopes)} envelopes", flush=True)
    return saved


# ---------------------------------------------------------------------------
# assets
# ---------------------------------------------------------------------------

def copy_assets(records: list[dict[str, Any]]) -> dict[str, Any]:
    copied, missing = 0, 0
    for record in records:
        workspace = record["workspaceId"]
        hash_value = record["hash"]
        src_dir = V1_DATA_DIR / "workspaces" / workspace / "assets" / hash_value[:4]
        candidates = list(src_dir.glob(f"{hash_value}.*")) if src_dir.is_dir() else []
        refs_db = V1_DATA_DIR / "workspaces" / workspace / "assets" / ".asset_refs.db"
        on_disk = bool(candidates)
        in_refs = False
        if refs_db.is_file():
            conn = sqlite3.connect(refs_db)
            try:
                tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")]
                for table in tables:
                    cols = [r[1] for r in conn.execute(f"PRAGMA table_info({table})")]
                    hash_cols = [c for c in cols if "hash" in c.lower()]
                    for col in hash_cols:
                        in_refs = in_refs or conn.execute(
                            f"SELECT 1 FROM {table} WHERE {col} = ? LIMIT 1", (hash_value,)
                        ).fetchone() is not None
            finally:
                conn.close()
        if not on_disk:
            missing += 1
            print(f"  asset missing: {workspace}/{hash_value} "
                  f"(disk={'yes' if on_disk else 'no'}, asset_refs.db={'yes' if in_refs else 'no'})")
            continue
        target = V2_DATA_DIR / "workspaces" / workspace / "assets" / hash_value[:4] / hash_value
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            shutil.copyfile(candidates[0], target)
        copied += 1
    return {"records": len(records), "copied": copied, "missing": missing}


# ---------------------------------------------------------------------------
# verification
# ---------------------------------------------------------------------------

def verify_workspace(workspace: str, expected_envelopes: int,
                     spot_ids: list[str], expected_content: dict[str, str]) -> dict[str, Any]:
    actual = stats(workspace)
    verification: dict[str, Any] = {
        "envelopeCount": {
            "expected": expected_envelopes,
            "actual": actual,
            "match": actual == expected_envelopes,
        },
        "spot_checks": [],
        "page_count": None,
    }
    for node_id in spot_ids:
        try:
            obj = http_json("GET", f"/api/objects/{node_id}", workspace)["object"]
            got = plain_text(obj.get("contentAst") or [])
            want = expected_content.get(node_id, "")
            verification["spot_checks"].append({
                "nodeId": node_id,
                "v2_name": obj.get("name"),
                "v2_isClass": obj.get("isClass"),
                "v2_presentAsMain": obj.get("presentAsMain"),
                "content_match": got.strip() == want.strip(),
                "v2_plain": got[:120],
                "v1_plain": want[:120],
            })
        except RuntimeError as error:
            verification["spot_checks"].append({"nodeId": node_id, "error": str(error)[:300]})
    pages = 0
    cursor = ""
    while True:
        result = http_json("GET", f"/api/objects?presentAsMain=true&limit=500&cursor={cursor}", workspace)
        batch = result.get("objects", [])
        pages += len(batch)
        cursor = result.get("nextCursor") or ""
        if not cursor or not batch:
            break
    verification["page_count"] = pages
    return verification


def pick_spot_ids(workspace: str, count: int) -> tuple[list[str], dict[str, str]]:
    """Pick page node ids with content from the transformed extract.

    Expected content is the max-HLC updateContent mirror per node — that is
    what v2's row-level LWW retains (v1 seq order has ~2.4k HLC inversions).
    """
    ids: list[str] = []
    content: dict[str, str] = {}
    path = EXTRACT_DIR / f"{workspace}.jsonl"
    pages: list[str] = []
    best: dict[str, tuple[int, int, str]] = {}
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            row = json.loads(line)
            if row["op_type"] == "node.create" and row["payload"].get("kind") == "page":
                pages.append(row["payload"]["nodeId"])
                continue
            if row["op_type"] != "node.updateContent":
                continue
            node_id = row["payload"].get("nodeId")
            if node_id not in pages:
                continue
            source = row["payload"].get("content") if "content" in row["payload"] else row["payload"].get("crdtUpdate")
            if source is None:
                continue
            tokens = content_tokens_from_source(source, self.resolve_v1_name)
            text = plain_text(tokens)
            key = (row["physical"], row["logical"])
            if key >= (best.get(node_id, (0, 0, ""))[0], best.get(node_id, (0, 0, ""))[1]):
                best[node_id] = (key[0], key[1], text)
    preferred = [node_id for node_id in pages if len(best.get(node_id, (0, 0, ""))[2].strip()) >= 3]
    chosen = preferred[:count] if len(preferred) >= count else (preferred + pages)[:count]
    for node_id in chosen:
        ids.append(node_id)
        content[node_id] = best.get(node_id, (0, 0, ""))[2]
    return ids, content


# ---------------------------------------------------------------------------
# orchestration
# ---------------------------------------------------------------------------

def run_transform(workspaces: list[str]) -> dict[str, Any]:
    report: dict[str, Any] = {"workspaces": {}, "deviations": [
        "v1 node.delete hard-deletes a single node row; migrated as v2 soft "
        "delete (trash) so later ops in the replay keep applying — deletes "
        "superseded by a later re-create are dropped (v2 has no revive op)",
        "v1 class names that were user-renamed on seeded system classes (e.g. "
        "year/month/day) are not carried over — the v2 seed already created "
        "those classes with newer HLCs and its canonical names win",
        "453 parentless v1 blocks migrate as pages (447 originally parentless; "
        "6 more were parented under class nodes, which v2 forbids)",
        "6 v1 moves under class nodes are skipped (v2 classes are tree-external)",
        "2,148 broken_link pills carry no label and are dropped by the reference "
        "conversion (port semantics)",
    ]}
    for ws in workspaces:
        print(f"transforming {ws} ...", flush=True)
        transformer = WorkspaceTransformer(ws)
        transformer.collect_known_ids()
        transformer.transform()
        report["workspaces"][ws] = transformer.report
        r = transformer.report
        print(f"  source={r['source']} emitted={r['emitted']} "
              f"dropped={sum(r['dropped_by_op'].values())} "
              f"skipped={sum(r['skipped_by_reason'].values())} "
              f"fallbacks={r['content_fallbacks']}", flush=True)
    return report


def cmd_dry_run(_args: argparse.Namespace) -> None:
    report = run_transform(WORKSPACES)
    report["mode"] = "dry-run"
    out = HERE / "report.json"
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\ndry-run report written to {out}")
    print_summary(report)


def print_summary(report: dict[str, Any]) -> None:
    print("\n=== dry-run summary ===")
    for ws, r in report["workspaces"].items():
        print(f"\n{ws}")
        print(f"  source envelopes : {r['source']}")
        print(f"  emitted envelopes: {r['emitted']} (incl. {r['companions']} companions)")
        dropped = sum(r["dropped_by_op"].values())
        skipped = sum(r["skipped_by_reason"].values())
        print(f"  dropped          : {dropped}")
        for key, n in sorted(r["dropped_by_op"].items()):
            print(f"    {key}: {n}")
        print(f"  skipped          : {skipped}")
        for key, n in sorted(r["skipped_by_reason"].items()):
            print(f"    {key}: {n}")
        print(f"  content fallbacks: {r['content_fallbacks']}")
        print(f"  parentless blocks: {r['parentless_blocks']}")
        if r["actor_remapped_from"]:
            print(f"  actors remapped  : {sum(r['actor_remapped_from'].values())}")


def cmd_apply(args: argparse.Namespace) -> None:
    report = run_transform(WORKSPACES)
    report["mode"] = "apply"
    only = args.workspace

    for ws in WORKSPACES:
        if only and ws != only:
            continue
        print(f"\napplying {ws} ...", flush=True)
        push = push_workspace(ws)
        report["workspaces"][ws]["push"] = push
        print(f"  seeded={push['seeded_envelopes']} pushed={push['pushed_envelopes']}", flush=True)

    all_assets = [rec for r in report["workspaces"].values() for rec in r["asset_records"]]
    report["assets"] = copy_assets(all_assets)
    print(f"\nassets: {report['assets']}")

    for ws in WORKSPACES:
        if only and ws != only:
            continue
        ws_report = report["workspaces"][ws]
        expected = ws_report["push"]["seed_total"] + ws_report["emitted"]
        spot_ids, expected_content = pick_spot_ids(ws, 2)
        verification = verify_workspace(ws, expected, spot_ids, expected_content)
        ws_report["verification"] = verification
        match = verification["envelopeCount"]["match"]
        print(f"verify {ws}: envelopes {verification['envelopeCount']['actual']}/{expected} "
              f"{'OK' if match else 'MISMATCH'}", flush=True)
        for check in verification["spot_checks"]:
            if "error" in check:
                print(f"  spot {check['nodeId']}: ERROR {check['error']}", flush=True)
            else:
                print(f"  spot {check['nodeId']}: content_match={check['content_match']} "
                      f"name={check['v2_name']!r} isClass={check['v2_isClass']} "
                      f"presentAsMain={check['v2_presentAsMain']}", flush=True)
        print(f"  pages listed: {verification['page_count']}", flush=True)

    out = HERE / "report.json"
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\napply report written to {out}")
    print_summary(report)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("dry-run", help="transform everything, write the report, push NOTHING")
    apply_parser = sub.add_parser("apply", help="seed, push batches of 500, copy assets, verify")
    apply_parser.add_argument("--workspace", help="apply a single workspace only")
    args = parser.parse_args()
    if args.command == "dry-run":
        cmd_dry_run(args)
    else:
        cmd_apply(args)


if __name__ == "__main__":
    main()
