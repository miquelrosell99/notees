"""Centralized computation of class-synchronized node boolean flags.

These flags are denormalized boolean columns on the ``node`` table. They are
kept in sync with system class assignments by the node repository and the
class management service.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import TYPE_CHECKING

from .entities.constants import SYSTEM_CLASS_UUIDS

if TYPE_CHECKING:
    from .entities import Node

# Maps system class UUID -> the boolean flag column it controls.
CLASS_UUID_TO_FLAG: dict[str, str] = {
    SYSTEM_CLASS_UUIDS["class"]: "is_class",
    SYSTEM_CLASS_UUIDS["page"]: "is_page",
    SYSTEM_CLASS_UUIDS["day"]: "is_day",
    SYSTEM_CLASS_UUIDS["month"]: "is_month",
    SYSTEM_CLASS_UUIDS["year"]: "is_year",
    SYSTEM_CLASS_UUIDS["asset"]: "is_asset",
    SYSTEM_CLASS_UUIDS["template"]: "is_template",
    SYSTEM_CLASS_UUIDS["comment"]: "is_comment",
    SYSTEM_CLASS_UUIDS["task"]: "is_task",
    SYSTEM_CLASS_UUIDS["table"]: "is_table",
    SYSTEM_CLASS_UUIDS["card"]: "is_card",
    SYSTEM_CLASS_UUIDS["cloze"]: "is_cloze",
}

# Deterministic, de-duplicated ordering of all class-driven flags. This is used
# when building SQL updates so the flag list is stable and easy to reason about.
ALL_CLASS_FLAGS: tuple[str, ...] = tuple(dict.fromkeys(CLASS_UUID_TO_FLAG.values()))


def compute_node_flags(class_nodes: Iterable[Node]) -> dict[str, bool]:
    """Return the class-driven flag dictionary implied by ``class_nodes``.

    Args:
        class_nodes: Iterable of class nodes (usually the nodes referenced by
            ``class_ids``).

    Returns:
        A mapping from flag name to boolean. Every known class flag is present.
        Only flags whose corresponding system class appears in ``class_nodes``
        are set to ``True``.
    """
    flags: dict[str, bool] = dict.fromkeys(ALL_CLASS_FLAGS, False)
    for class_node in class_nodes:
        flag_name = CLASS_UUID_TO_FLAG.get(class_node.uuid)
        if flag_name:
            flags[flag_name] = True
    return flags
