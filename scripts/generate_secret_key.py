#!/usr/bin/env python3
"""Generate a secure SECRET_KEY for Notees configuration.

This script generates a cryptographically secure random string suitable
for use as the SECRET_KEY environment variable.

Usage:
    python generate_secret_key.py
"""
import secrets

if __name__ == "__main__":
    secret_key = secrets.token_urlsafe(32)
    print("=" * 60)
    print("Generated SECRET_KEY:")
    print(secret_key)
    print("=" * 60)
    print("\nAdd this to your .env file:")
    print(f"SECRET_KEY={secret_key}")
    print("\nOr set it as an environment variable:")
    print(f"export SECRET_KEY={secret_key}  # Linux/Mac")
    print(f"$env:SECRET_KEY=\"{secret_key}\"  # Windows PowerShell")
