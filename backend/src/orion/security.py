"""Who is calling. The demo has no passwords: you pick a person, and the server hands you a token signed with
ORION_SECRET that names that person and one tenant. Every tenant endpoint takes the user from the token, never
from the request body, and refuses a token minted for another tenant."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from collections import defaultdict, deque

from fastapi import Header, HTTPException, Request

from orion.config import env

_SECRET = (env("ORION_SECRET") or secrets.token_hex(32)).encode()
TTL = 12 * 3600


def mint(tenant: str, user: str) -> str:
    body = base64.urlsafe_b64encode(json.dumps({"t": tenant, "u": user, "exp": int(time.time()) + TTL}).encode()).decode()
    sig = hmac.new(_SECRET, body.encode(), hashlib.sha256).hexdigest()
    return f"{body}.{sig}"


def read(token: str) -> dict:
    try:
        body, sig = token.rsplit(".", 1)
    except ValueError:
        raise HTTPException(401, "malformed token")
    if not hmac.compare_digest(hmac.new(_SECRET, body.encode(), hashlib.sha256).hexdigest(), sig):
        raise HTTPException(401, "bad token")
    data = json.loads(base64.urlsafe_b64decode(body))
    if data["exp"] < time.time():
        raise HTTPException(401, "token expired")
    return data


class Session:
    def __init__(self, tenant: str, user: str):
        self.tenant, self.user = tenant, user


def session(tenant: str, authorization: str | None = Header(None), token: str | None = None) -> Session:
    """FastAPI dependency. EventSource can't send headers, so a `token` query parameter is accepted too."""
    raw = (authorization or "").removeprefix("Bearer ").strip() or (token or "")
    if not raw:
        raise HTTPException(401, "sign in first")
    data = read(raw)
    if data["t"] != tenant:
        raise HTTPException(403, "this token is for another company")
    return Session(tenant, data["u"])


def require_admin(request: Request) -> None:
    want = env("ORION_ADMIN_TOKEN")
    if not want or not hmac.compare_digest(request.headers.get("x-admin-token", ""), want):
        raise HTTPException(403, "admin only (set ORION_ADMIN_TOKEN and send it as X-Admin-Token)")


def client_ip(request: Request) -> str:
    trusted = {p.strip() for p in (env("ORION_TRUSTED_PROXIES") or "").split(",") if p.strip()}
    peer = request.client.host if request.client else "?"
    if peer in trusted:
        fwd = request.headers.get("x-forwarded-for", "")
        if fwd:
            return fwd.split(",")[0].strip()
    return peer


_hits: dict[str, deque] = defaultdict(deque)
PER_HOUR = int(os.environ.get("ORION_LLM_PER_HOUR", "120"))


def limit(request: Request, bucket: str = "llm", cost: int = 1) -> None:
    """Calls that spend model tokens are limited per client per hour."""
    key = f"{bucket}:{client_ip(request)}"
    now = time.time()
    q = _hits[key]
    while q and q[0] < now - 3600:
        q.popleft()
    if len(q) + cost > PER_HOUR:
        raise HTTPException(429, "too many model calls from here this hour")
    for _ in range(cost):
        q.append(now)
