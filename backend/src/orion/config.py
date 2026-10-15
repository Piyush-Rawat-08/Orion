"""Settings from the environment. A backend/.env file is read once, without overriding variables already set."""

from __future__ import annotations

import os
from pathlib import Path

_ENV = Path(__file__).resolve().parents[2] / ".env"


def _load_dotenv() -> None:
    if not _ENV.exists():
        return
    for line in _ENV.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv()


def env(name: str, default: str | None = None) -> str | None:
    v = os.environ.get(name)
    return v if v not in (None, "") else default


FALKORDB_HOST = env("FALKORDB_HOST", "127.0.0.1")
FALKORDB_PORT = int(env("FALKORDB_PORT", "6379"))
