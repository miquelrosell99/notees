"""Unit tests for the TOTP 2FA helper module (no database)."""

from __future__ import annotations

from types import SimpleNamespace

import pyotp
import pytest

from app.features.auth import totp

pytestmark = pytest.mark.unit


def test_generate_secret_is_random_base32() -> None:
    a = totp.generate_secret()
    b = totp.generate_secret()
    assert a and b and a != b
    # pyotp secrets are uppercase base32 (A-Z2-7), length 32.
    assert len(a) == 32
    assert all(c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567" for c in a)


def test_provisioning_uri_carries_issuer_email_and_secret() -> None:
    secret = totp.generate_secret()
    uri = totp.provisioning_uri(secret, "alice@example.com")
    assert uri.startswith("otpauth://totp/")
    assert totp.ISSUER in uri
    assert "alice%40example.com" in uri or "alice@example.com" in uri
    assert secret in uri


def test_verify_code_accepts_current_and_rejects_wrong() -> None:
    secret = totp.generate_secret()
    current = pyotp.TOTP(secret).now()
    assert totp.verify_code(secret, current) is True

    other_code = pyotp.TOTP(totp.generate_secret()).now()
    assert totp.verify_code(secret, other_code) is False


def test_verify_code_rejects_garbage() -> None:
    secret = totp.generate_secret()
    assert totp.verify_code(secret, "") is False
    assert totp.verify_code(secret, "abcdef") is False
    assert totp.verify_code("", "123456") is False


def test_encrypt_decrypt_roundtrip(monkeypatch: pytest.MonkeyPatch) -> None:
    # Deterministic instance key for the test; reset the cached Fernet.
    monkeypatch.setattr(totp, "settings", SimpleNamespace(secret_key="x" * 32))
    monkeypatch.setattr(totp, "_fernet", None)

    secret = totp.generate_secret()
    token = totp.encrypt_secret(secret)
    assert token != secret
    assert totp.decrypt_secret(token) == secret


def test_generate_qr_svg_emits_svg() -> None:
    uri = totp.provisioning_uri(totp.generate_secret(), "bob@example.com")
    svg = totp.generate_qr_svg(uri)
    assert "<svg" in svg and "</svg>" in svg


def test_backup_codes_format_and_verify() -> None:
    codes = totp.generate_backup_codes()
    assert len(codes) == totp.BACKUP_CODE_COUNT
    for code in codes:
        assert len(code) == 9 and code[4] == "-"
        hashed = totp.hash_backup_code(code)
        # Exact, and normalized (no dash / different case) both verify.
        assert totp.verify_backup_code(code, hashed) is True
        assert totp.verify_backup_code(code.replace("-", "").upper(), hashed) is True
        assert totp.verify_backup_code("zzzz-zzzz", hashed) is False
