"""Per-user authentication for the OPDS catalog.

OPDS clients (KOReader, Panels, …) authenticate with HTTP Basic, so the feed
endpoints accept ``Authorization: Basic <base64(email:password)>`` verified
against the existing auth system, in addition to the standard session
mechanisms (access-token cookie, JWT bearer, X-API-Key) reused from the core
dependencies. Every 401 carries ``WWW-Authenticate: Basic`` so clients prompt
for credentials. The resolved context scopes the catalog to the user's active
workspace — the feed can only expose content that user can access.
"""

from __future__ import annotations

import base64
import binascii
from collections.abc import AsyncGenerator

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials

from app.db.connection import get_pool, get_workspace_uuid
from app.dependencies import (
    _get_workspace_context_cached,
    _resolve_user_from_auth,
    security,
)
from app.features.auth.auth import authenticate_user
from app.plugins.builtin.export_profiles.dependencies import RequestContext

BASIC_CHALLENGE = 'Basic realm="Notees OPDS"'


def _unauthorized(detail: str = "Not authenticated") -> None:
    raise HTTPException(
        status_code=401,
        detail=detail,
        headers={"WWW-Authenticate": BASIC_CHALLENGE},
    )


async def _resolve_basic_user(request: Request) -> dict | None:
    """Resolve a user from HTTP Basic credentials, or None if not a Basic request."""
    header = request.headers.get("Authorization")
    if not header or not header.lower().startswith("basic "):
        return None
    try:
        decoded = base64.b64decode(header[6:].strip(), validate=True).decode("utf-8")
    except (binascii.Error, ValueError, UnicodeDecodeError):
        _unauthorized("Malformed basic credentials")
    email, separator, password = decoded.partition(":")
    if not separator or not email:
        _unauthorized("Malformed basic credentials")
    user = await authenticate_user(email, password)
    if user is None:
        _unauthorized("Invalid credentials")
    user.pop("hashed_password", None)
    return user


async def get_opds_request_context(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Depends(security),  # noqa: B008
) -> AsyncGenerator[RequestContext, None]:
    """Resolve workspace/user ids for an OPDS request (Basic auth or session)."""
    user_dict = await _resolve_basic_user(request)
    if user_dict is None:
        api_key = request.headers.get("X-API-Key")
        user_dict = await _resolve_user_from_auth(request, credentials, api_key)
    if not user_dict:
        _unauthorized()

    from app.models import User

    scopes = user_dict.pop("_api_key_scopes", None)
    user = User(**user_dict)
    user.scopes = scopes

    pool = await get_pool()
    workspace_id, _ = await _get_workspace_context_cached(pool, int(user.id))
    workspace_uuid = await get_workspace_uuid(workspace_id)
    if workspace_uuid is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    yield RequestContext(
        user=user,
        workspace_id=workspace_id,
        workspace_uuid=workspace_uuid,
        user_uuid=str(user.uuid),
    )
