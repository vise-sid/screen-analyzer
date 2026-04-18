"""
Google ID token verification (JWKS).

The extension obtains an ID token via chrome.identity.launchWebAuthFlow
against our Web Application OAuth client, then POSTs it to /auth/verify.
We verify signature + audience + expiry via google-auth's JWKS path
(no round-trip to tokeninfo per request).

Env:
  GOOGLE_OAUTH_CLIENT_ID   The Web Application client_id we issued the
                           token for. Must match the `aud` claim.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

from fastapi import Header, HTTPException, status
from google.auth.transport import requests as grequests
from google.oauth2 import id_token

# Default to the Web Application client we verified works in GCP
# (chromiumapp.org redirect configured for extension phkpioih...).
DEFAULT_CLIENT_ID = (
    "412083714557-nqvf6jq1jda8shc9sjo6scv7ui5fp0vl.apps.googleusercontent.com"
)
GOOGLE_OAUTH_CLIENT_ID = os.getenv("GOOGLE_OAUTH_CLIENT_ID", DEFAULT_CLIENT_ID)

_VALID_ISSUERS = {"accounts.google.com", "https://accounts.google.com"}

_grequest = grequests.Request()


@dataclass
class AuthenticatedUser:
    sub: str
    email: str | None
    name: str | None
    picture: str | None


def verify_id_token(token: str) -> AuthenticatedUser:
    """Verify a Google ID token. Raises HTTPException(401) on any failure."""
    try:
        claims = id_token.verify_oauth2_token(
            token, _grequest, GOOGLE_OAUTH_CLIENT_ID
        )
    except ValueError as e:
        raise HTTPException(status_code=401, detail=f"invalid id token: {e}")

    iss = claims.get("iss")
    if iss not in _VALID_ISSUERS:
        raise HTTPException(status_code=401, detail=f"bad issuer: {iss}")

    sub = claims.get("sub")
    if not sub:
        raise HTTPException(status_code=401, detail="id token missing sub")

    return AuthenticatedUser(
        sub=sub,
        email=claims.get("email"),
        name=claims.get("name"),
        picture=claims.get("picture"),
    )


def require_user(authorization: str | None = Header(default=None)) -> AuthenticatedUser:
    """FastAPI dependency. Pulls Bearer token from Authorization header."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing Bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = authorization.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(status_code=401, detail="empty Bearer token")
    return verify_id_token(token)
