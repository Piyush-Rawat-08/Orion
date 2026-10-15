"""What happens after the company changes: every answer that relied on something that changed is re-checked."""

from __future__ import annotations

from orion import db as dbm


def after_change(db: dbm.DB, t: str, touched: list[str], cause: str) -> list[dict]:
    """Re-check the claims about the touched entities. Filled in with the claim checker (claims.py)."""
    return []
