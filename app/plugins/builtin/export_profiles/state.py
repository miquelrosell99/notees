"""Engine-managed state for export profiles.

The reconciler distinguishes engine-managed files from foreign files by
tracking every path it created in plugin state (Decision 31: foreign files
are never modified or deleted). State also carries the last-run report
(including the skip report) surfaced by the status API.

State is stored as JSON in workspace settings under the plugin-namespaced
key ``state``, shaped as::

    {
      "<user_uuid>": {
        "<profile_id>": {
          "managed": {"<relative/path>": {"asset_uuid": ..., "hash": ...}},
          "last_run": "<iso timestamp>",
          "report": {...}
        }
      }
    }
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

STATE_SETTING_KEY = "state"


@dataclass
class ProfileRunState:
    """Per-(user, profile) engine state."""

    managed: dict[str, dict[str, Any]] = field(default_factory=dict)
    last_run: str | None = None
    report: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "managed": self.managed,
            "last_run": self.last_run,
            "report": self.report,
        }

    @staticmethod
    def from_dict(data: dict[str, Any] | None) -> ProfileRunState:
        if not isinstance(data, dict):
            return ProfileRunState()
        managed_raw = data.get("managed")
        managed = (
            {str(k): dict(v) for k, v in managed_raw.items() if isinstance(v, dict)}
            if isinstance(managed_raw, dict)
            else {}
        )
        report = data.get("report")
        return ProfileRunState(
            managed=managed,
            last_run=data.get("last_run") if isinstance(data.get("last_run"), str) else None,
            report=report if isinstance(report, dict) else {},
        )


def get_profile_state(
    state: dict[str, Any], user_uuid: str, profile_id: str
) -> ProfileRunState:
    """Extract one (user, profile) run state from the raw settings value."""
    user_state = state.get(user_uuid) if isinstance(state, dict) else None
    profile_state = user_state.get(profile_id) if isinstance(user_state, dict) else None
    return ProfileRunState.from_dict(profile_state)


def put_profile_state(
    state: dict[str, Any],
    user_uuid: str,
    profile_id: str,
    run_state: ProfileRunState,
) -> dict[str, Any]:
    """Return a new state dict with the (user, profile) entry replaced."""
    new_state = dict(state) if isinstance(state, dict) else {}
    user_state = dict(new_state.get(user_uuid) or {})
    user_state[profile_id] = run_state.to_dict()
    new_state[user_uuid] = user_state
    return new_state


def remove_profile_state(state: dict[str, Any], profile_id: str) -> dict[str, Any]:
    """Return a new state dict with the profile removed for every user."""
    new_state: dict[str, Any] = {}
    for user_uuid, user_state in (state.items() if isinstance(state, dict) else []):
        if isinstance(user_state, dict):
            remaining = {k: v for k, v in user_state.items() if k != profile_id}
            new_state[user_uuid] = remaining
    return new_state
