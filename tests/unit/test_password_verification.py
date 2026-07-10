"""Unit tests for password verification error handling.

Locks the contract that a genuine password mismatch returns ``False`` while a
technical fault (malformed hash, backend error) raises
``PasswordVerificationError`` so callers never report an outage as a wrong
password.
"""

from __future__ import annotations

import pytest

from app.utils import password as password_module
from app.utils.password import PasswordVerificationError, hash_password, verify_password

pytestmark = pytest.mark.unit


def test_verify_password_returns_true_for_correct_password() -> None:
    hashed = hash_password("Correct-Horse-42!")
    assert verify_password("Correct-Horse-42!", hashed) is True


def test_verify_password_returns_false_for_wrong_password() -> None:
    """A clean mismatch is False and must not raise."""
    hashed = hash_password("Correct-Horse-42!")
    assert verify_password("totally-wrong-password", hashed) is False


def test_verify_password_raises_on_technical_fault(monkeypatch: pytest.MonkeyPatch) -> None:
    """A hashing backend failure is surfaced, never swallowed as a mismatch."""

    def boom(_password: str, _hashed: str) -> bool:
        raise RuntimeError("simulated hashing backend failure")

    monkeypatch.setattr(password_module.pwd_context, "verify", boom)

    with pytest.raises(PasswordVerificationError) as excinfo:
        verify_password("anything", "$2b$12$looks-like-a-hash-but-will-not-be-used")

    assert excinfo.value.__cause__ is not None
    assert isinstance(excinfo.value.__cause__, RuntimeError)
