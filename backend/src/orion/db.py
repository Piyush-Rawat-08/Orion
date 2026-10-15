"""FalkorDB access. One instance holds every graph Orion uses; the names say what each one is:

    org:<tenant>                 the company: bi-temporal facts, sources, decisions, answers
    epoch:<tenant>:<date>:<mode> the company as it stood on a date (mode 'true' or 'known'), physically pruned
    epoch:<tenant>:now           the company now; the base every universe is copied from
    universe:<tenant>:<id>       a fork with a scenario applied
    mem:<tenant>:<user>          one person's memory
    deck:<tenant>                the agents' shared board: tasks, findings, universe registry, approvals
"""

from __future__ import annotations

import threading
from typing import Any

from falkordb import FalkorDB
from falkordb.edge import Edge
from falkordb.node import Node
from falkordb.path import Path

from orion import config


def org(t: str) -> str:
    return f"org:{t}"


def epoch(t: str, on: str = "now", mode: str = "true") -> str:
    return f"epoch:{t}:now" if on == "now" else f"epoch:{t}:{on}:{mode}"


def universe(t: str, uid: str) -> str:
    return f"universe:{t}:{uid}"


def mem(t: str, user: str) -> str:
    return f"mem:{t}:{user.split(':', 1)[-1]}"


def deck(t: str) -> str:
    return f"deck:{t}"


def plain(v: Any) -> Any:
    """FalkorDB values as JSON-ready Python: nodes and edges become dicts of their properties."""
    if isinstance(v, Node):
        return {**v.properties, "_labels": list(v.labels or [])}
    if isinstance(v, Edge):
        return {**v.properties, "_type": v.relation}
    if isinstance(v, Path):
        return {"nodes": [plain(n) for n in v.nodes()], "edges": [plain(e) for e in v.edges()]}
    if isinstance(v, list):
        return [plain(x) for x in v]
    if isinstance(v, dict):
        return {k: plain(x) for k, x in v.items()}
    if isinstance(v, bytes):
        return v.decode()
    return v


class DB:
    def __init__(self, host: str | None = None, port: int | None = None):
        self.client = FalkorDB(host=host or config.FALKORDB_HOST, port=port or config.FALKORDB_PORT,
                               username=config.FALKORDB_USERNAME, password=config.FALKORDB_PASSWORD,
                               ssl=config.FALKORDB_SSL)
        self.redis = self.client.connection

    def graph(self, name: str):
        return self.client.select_graph(name)

    def q(self, name: str, cypher: str, params: dict | None = None, timeout: int | None = None) -> list[dict]:
        res = self.graph(name).query(cypher, params or {}, timeout=timeout)
        return _rows(res)

    def ro(self, name: str, cypher: str, params: dict | None = None, timeout: int | None = 10000) -> list[dict]:
        """Read through GRAPH.RO_QUERY: FalkorDB refuses any write, so a tool can't change the graph by accident."""
        res = self.graph(name).ro_query(cypher, params or {}, timeout=timeout)
        return _rows(res)

    def one(self, name: str, cypher: str, params: dict | None = None) -> dict | None:
        rows = self.ro(name, cypher, params)
        return rows[0] if rows else None

    def exists(self, name: str) -> bool:
        return bool(self.redis.exists(name))

    def copy(self, src: str, dst: str) -> None:
        if self.exists(dst):
            self.delete(dst)
        self.redis.execute_command("GRAPH.COPY", src, dst)

    def delete(self, name: str) -> None:
        if self.exists(name):
            self.redis.execute_command("GRAPH.DELETE", name)

    def graphs(self, prefix: str = "") -> list[str]:
        names = [n.decode() if isinstance(n, bytes) else n for n in self.redis.execute_command("GRAPH.LIST")]
        return sorted(n for n in names if n.startswith(prefix))

    # small key-value state next to the graphs: tenant clocks and version counters
    def get(self, key: str) -> str | None:
        v = self.redis.get(key)
        return v.decode() if isinstance(v, bytes) else v

    def set(self, key: str, value: str) -> None:
        self.redis.set(key, value)

    def incr(self, key: str) -> int:
        return int(self.redis.incr(key))

    def lock(self, key: str, ttl: int = 60):
        return self.redis.lock(f"orion:lock:{key}", timeout=ttl, blocking_timeout=ttl)


def _rows(res) -> list[dict]:
    cols = [c[1] if isinstance(c, (list, tuple)) else c for c in res.header]
    cols = [c.decode() if isinstance(c, bytes) else str(c) for c in cols]
    return [{c: plain(v) for c, v in zip(cols, row)} for row in res.result_set]


_db: DB | None = None
_db_lock = threading.Lock()


def get_db() -> DB:
    global _db
    with _db_lock:
        if _db is None:
            _db = DB()
        return _db


def clock(db: DB, t: str) -> str:
    """The tenant's 'now'. Corvane is pinned to a demo moment; live events move it forward a minute at a time."""
    return db.get(f"orion:{t}:clock") or "2026-10-01T09:00"


def tick(db: DB, t: str, minutes: int = 1) -> str:
    from datetime import datetime, timedelta

    now = datetime.fromisoformat(clock(db, t)) + timedelta(minutes=minutes)
    v = now.strftime("%Y-%m-%dT%H:%M")
    db.set(f"orion:{t}:clock", v)
    return v


def version(db: DB, t: str) -> int:
    """Bumped on every write to the org graph; epochs built from an older version are rebuilt."""
    return int(db.get(f"orion:{t}:version") or 0)


def bump(db: DB, t: str) -> int:
    return db.incr(f"orion:{t}:version")
