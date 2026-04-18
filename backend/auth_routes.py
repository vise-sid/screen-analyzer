"""
Auth routes — minimal sign-in surface for the extension.

  POST /auth/verify  — body: { id_token }
                       returns: { sub, email, name, picture } on success, 401 otherwise.
  GET  /auth/me      — Bearer-token guarded; returns the same shape.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from auth import AuthenticatedUser, require_user, verify_id_token

router = APIRouter(prefix="/auth", tags=["auth"])


class VerifyRequest(BaseModel):
    id_token: str


class UserResponse(BaseModel):
    sub: str
    email: str | None = None
    name: str | None = None
    picture: str | None = None


@router.post("/verify", response_model=UserResponse)
def verify(req: VerifyRequest) -> UserResponse:
    user = verify_id_token(req.id_token)
    return UserResponse(
        sub=user.sub, email=user.email, name=user.name, picture=user.picture
    )


@router.get("/me", response_model=UserResponse)
def me(user: AuthenticatedUser = Depends(require_user)) -> UserResponse:
    return UserResponse(
        sub=user.sub, email=user.email, name=user.name, picture=user.picture
    )
