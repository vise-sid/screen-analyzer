"""
Google Sign-In verification via JWKS.

We verify ID tokens in-process using Google's published JWKS. No round-trip
to Google's tokeninfo endpoint per request — the google-auth library caches
Google's public keys internally and refreshes when they rotate.

The ID token is a short-lived (~1h) JWT. The extension is responsible for
refreshing it (silent re-auth via launchWebAuthFlow with prompt=none).
"""

from __future__ import annotations

import os
from typing import Optional

from fastapi import Depends, Header, HTTPException, status
from google.auth.transport import requests as g_requests
from google.oauth2 import id_token

from db import upsert_user

# Single reusable transport — holds a connection pool, caches JWKS.
_REQUEST = g_requests.Request()

# The OAuth 2.0 Web Application client ID registered in Google Cloud Console.
# Must match the client_id the extension uses for launchWebAuthFlow.
_WEB_CLIENT_ID = os.getenv("GOOGLE_WEB_CLIENT_ID", "").strip()

# In dev, allow a permissive mode that skips verification and uses a fake user.
# Set AUTH_DEV_MODE=1 to enable. NEVER enable in production.
_DEV_MODE = os.getenv("AUTH_DEV_MODE", "").strip() == "1"


class AuthenticatedUser(dict):
    """Thin dict subclass so FastAPI treats it like a plain dict response
    but we can still access common attributes cleanly."""

    @property
    def sub(self) -> str:
        return self["sub"]

    @property
    def email(self) -> str:
        return self.get("email", "")

    @property
    def name(self) -> str:
        return self.get("name", "")

    @property
    def picture(self) -> str:
        return self.get("picture", "")


def _parse_bearer(authorization: Optional[str]) -> str:
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Authorization header",
            headers={"WWW-Authenticate": "Bearer"},
        )
    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Malformed Authorization header",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return parts[1]


def verify_id_token(token: str) -> AuthenticatedUser:
    """Verify a Google ID token via JWKS. Raises 401 on any problem.

    Returns a dict-like object with at minimum `sub`, `email`, `name`, `picture`.
    Also upserts the user in the local DB.
    """
    if _DEV_MODE:
        fake = AuthenticatedUser(
            sub="dev-user",
            email="dev@example.com",
            name="Dev User",
            picture="",
        )
        upsert_user(fake)
        return fake

    if not _WEB_CLIENT_ID:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Server missing GOOGLE_WEB_CLIENT_ID",
        )

    try:
        # google-auth fetches Google's JWKS, caches signing keys,
        # verifies signature + exp + iss + aud in-process.
        claims = id_token.verify_oauth2_token(
            token,
            _REQUEST,
            audience=_WEB_CLIENT_ID,
        )
    except ValueError as e:
        # Invalid signature, expired, wrong audience, etc.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid ID token: {e}",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Belt-and-suspenders: id_token.verify_oauth2_token already checks iss,
    # but explicit is better here.
    issuer = claims.get("iss", "")
    if issuer not in ("accounts.google.com", "https://accounts.google.com"):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Untrusted token issuer: {issuer}",
        )

    sub = claims.get("sub")
    if not sub:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token missing subject (sub)",
        )

    user = AuthenticatedUser(
        sub=sub,
        email=claims.get("email", ""),
        name=claims.get("name", ""),
        picture=claims.get("picture", ""),
    )
    upsert_user(user)
    return user


def get_current_user(
    authorization: Optional[str] = Header(None),
) -> AuthenticatedUser:
    """FastAPI dependency — attach to any endpoint that needs the signed-in user."""
    token = _parse_bearer(authorization)
    return verify_id_token(token)
