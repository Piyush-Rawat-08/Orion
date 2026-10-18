"""FalkorDB access. One instance holds every graph Orion uses; the names say what each one is:

    org:<tenant>                 the company: bi-temporal facts, sources, decisions, answers
    epoch:<tenant>:<date>:<mode> the company as it stood on a date (mode 'true' or 'known'), physically pruned
    epoch:<tenant>:now           the company now; the base every universe is copied from
    universe:<tenant>:<id>       a fork with a scenario applied
    mem:<tenant>:<user>          one person's memory
    deck:<tenant>                the agents' shared board: tasks, findings, universe registry, approvals
"""

from __future__ import annotations

import contextvars
import threading
import os
import time
from collections import deque
from contextlib import contextmanager
from dataclasses import dataclass
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


# Who a query runs for: "ui" (a screen drawing itself), "board" (housekeeping), "task:<uid>" (an agent's work).
# The Activity screen's technical log shows the agents' queries only.
ORIGIN: contextvars.ContextVar[str | None] = contextvars.ContextVar("orion_origin", default=None)


@contextmanager
def tagged(origin: str | None):
    token = ORIGIN.set(origin)
    try:
        yield
    finally:
        ORIGIN.reset(token)


@dataclass
class Logged:
    graph: str
    cypher: str
    ms: float
    rows: int
    read_only: bool
    at: float
    origin: str | None


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
        self.log: deque[Logged] = deque(maxlen=400)
        # per agent task: how many queries, how long they took, which graphs they touched, how many copies
        self._work: dict[str, dict] = {}
        self._work_lock = threading.Lock()
        self._follows: dict[str, str] = {}  # a task an agent handed on -> the task it was done for
        self._meta_ready = False

    def follows(self, task: str, parent: str) -> None:
        """Work done for `task` (the Simulator forking for the Navigator, say) counts toward `parent`."""
        with self._work_lock:
            if len(self._follows) > 500:
                self._follows.pop(next(iter(self._follows)))
            self._follows[f"task:{task}"] = f"task:{parent}"

    def _count(self, name: str, ms: float, copy: bool = False) -> None:
        origin = ORIGIN.get()
        if not origin or not origin.startswith("task:"):
            return
        with self._work_lock:
            for _ in range(8):
                if origin not in self._follows:
                    break
                origin = self._follows[origin]
            w = self._work.get(origin)
            if w is None:
                if len(self._work) > 200:  # tasks nobody asked about (the Cartographer's) don't pile up
                    self._work.pop(next(iter(self._work)))
                w = self._work[origin] = {"queries": 0, "copies": 0, "ms": 0.0, "graphs": set()}
            w["copies" if copy else "queries"] += 1
            w["ms"] += ms
            w["graphs"].add(name)

    def work(self, task: str | None) -> dict | None:
        """What a task asked of FalkorDB, for the line under an answer; forgets it once read."""
        with self._work_lock:
            w = self._work.pop(f"task:{task}", None)
        return w and {"queries": w["queries"], "copies": w["copies"], "ms": round(w["ms"]), "graphs": sorted(w["graphs"])}

    def _logged(self, name: str, cypher: str, t0: float, n: int, ro: bool) -> None:
        ms = (time.perf_counter() - t0) * 1000
        self.log.append(Logged(name, cypher, ms, n, ro, time.time() * 1000, ORIGIN.get()))
        self._count(name, ms)

    def graph(self, name: str):
        return self.client.select_graph(name)

    def q(self, name: str, cypher: str, params: dict | None = None, timeout: int | None = None) -> list[dict]:
        t0 = time.perf_counter()
        res = self.graph(name).query(cypher, params or {}, timeout=timeout)
        out = _rows(res)
        self._logged(name, cypher, t0, len(out), False)
        return out

    def ro(self, name: str, cypher: str, params: dict | None = None, timeout: int | None = 10000) -> list[dict]:
        """Read through GRAPH.RO_QUERY: FalkorDB refuses any write, so a tool can't change the graph by accident."""
        t0 = time.perf_counter()
        res = self.graph(name).ro_query(cypher, params or {}, timeout=timeout)
        out = _rows(res)
        self._logged(name, cypher, t0, len(out), True)
        return out

    def one(self, name: str, cypher: str, params: dict | None = None) -> dict | None:
        rows = self.ro(name, cypher, params)
        return rows[0] if rows else None

    def exists(self, name: str) -> bool:
        return bool(self.redis.exists(name))

    def copy(self, src: str, dst: str) -> float:
        """GRAPH.COPY; returns how long it took, in milliseconds. Some servers (FalkorDB Cloud) fork the process to
        copy, and only one fork can run at a time: copies are taken one after another (the work on them can still run
        side by side), and a copy refused because the server is mid-fork is retried."""
        if self.exists(dst):
            self.delete(dst)
        t0 = time.perf_counter()
        with _copy_lock:
            for attempt in range(8):
                try:
                    self.redis.execute_command("GRAPH.COPY", src, dst)
                    break
                except Exception as e:
                    if "fork" not in str(e).lower() or attempt == 7:
                        raise
                    time.sleep(0.15 * (attempt + 1))
        ms = (time.perf_counter() - t0) * 1000
        self._count(dst, ms, copy=True)
        return ms

    def delete(self, name: str) -> None:
        if self.exists(name):
            self.redis.execute_command("GRAPH.DELETE", name)

    def graphs(self, prefix: str = "") -> list[str]:
        names = [n.decode() if isinstance(n, bytes) else n for n in self.redis.execute_command("GRAPH.LIST")]
        return sorted(n for n in names if n.startswith(prefix))

    # Small state next to the graphs (tenant clocks, version counters, caches, locks) lives in a graph of its own,
    # orion:meta, not in Redis keys: FalkorDB Cloud users may run graph commands only. Writes to one graph run one at
    # a time, so incr and lock are atomic. These queries are housekeeping and stay out of the query log.
    def _meta(self, cypher: str, params: dict, write: bool = True) -> list:
        if not self._meta_ready:
            for label in ("KV", "Lock"):
                try:
                    self.graph(META).query(f"CREATE INDEX FOR (x:{label}) ON (x.k)")
                except Exception:
                    pass  # already there
            self._meta_ready = True
        g = self.graph(META)
        res = g.query(cypher, params) if write else g.ro_query(cypher, params)
        return res.result_set

    def get(self, key: str) -> str | None:
        rows = self._meta("MATCH (x:KV {k: $k}) WHERE x.exp IS NULL OR x.exp > $now RETURN x.v",
                          {"k": key, "now": time.time()}, write=False)
        return rows[0][0] if rows else None

    def set(self, key: str, value: str, ex: int | None = None) -> None:
        self._meta("MERGE (x:KV {k: $k}) SET x.v = $v, x.exp = $exp",
                   {"k": key, "v": value, "exp": time.time() + ex if ex else None})

    def incr(self, key: str) -> int:
        rows = self._meta("MERGE (x:KV {k: $k}) ON CREATE SET x.v = '0' SET x.v = toString(toInteger(x.v) + 1) RETURN x.v",
                          {"k": key})
        return int(rows[0][0])

    def drop(self, prefix: str) -> None:
        """Forget every key that starts with `prefix`."""
        self._meta("MATCH (x:KV) WHERE x.k STARTS WITH $p DELETE x", {"p": prefix})

    def lock(self, key: str, ttl: int = 60, wait: float | None = None) -> "GraphLock":
        return GraphLock(self, key, ttl, ttl if wait is None else wait)


META = "orion:meta"


class LockTimeout(TimeoutError):
    pass


class GraphLock:
    """A lease on a key: taken by one MERGE, released by its holder, free again once it expires."""

    def __init__(self, db: "DB", key: str, ttl: int, wait: float):
        self.db, self.key, self.ttl, self.wait = db, key, ttl, wait
        self.token = os.urandom(8).hex()

    def acquire(self) -> bool:
        now = time.time()
        rows = self.db._meta("""MERGE (l:Lock {k: $k}) ON CREATE SET l.token = $tok, l.exp = $exp
                                WITH l WHERE l.token = $tok OR l.exp < $now
                                SET l.token = $tok, l.exp = $exp RETURN l.token""",
                             {"k": self.key, "tok": self.token, "exp": now + self.ttl, "now": now})
        return bool(rows)

    def __enter__(self):
        deadline = time.time() + self.wait
        while not self.acquire():
            if time.time() > deadline:
                raise LockTimeout(f"{self.key} is busy")
            time.sleep(0.1)
        return self

    def __exit__(self, *exc):
        self.db._meta("MATCH (l:Lock {k: $k}) WHERE l.token = $tok DELETE l", {"k": self.key, "tok": self.token})


def _rows(res) -> list[dict]:
    cols = [c[1] if isinstance(c, (list, tuple)) else c for c in res.header]
    cols = [c.decode() if isinstance(c, bytes) else str(c) for c in cols]
    return [{c: plain(v) for c, v in zip(cols, row)} for row in res.result_set]


_db: DB | None = None
_db_lock = threading.Lock()
_copy_lock = threading.Lock()


def get_db() -> DB:
    global _db
    with _db_lock:
        if _db is None:
            _db = DB()
        return _db


_MEMO: contextvars.ContextVar[dict | None] = contextvars.ContextVar("orion_memo", default=None)


@contextmanager
def remembered():
    """A stretch of read-only work (checking an answer's points) where the records can't change: the tenant's
    version and clock, epoch checkouts and name lookups are read once and remembered until it ends. On a remote
    database each of those is a round trip, and one answer's checks repeat them hundreds of times. Work started
    from inside (threads given this context) shares the memo."""
    token = _MEMO.set({})
    try:
        yield
    finally:
        _MEMO.reset(token)


def memo() -> dict | None:
    """The memo of the enclosing remembered() block, or None outside one."""
    return _MEMO.get()


TZ = os.environ.get("ORION_TZ", "Asia/Kolkata")


def wall() -> str:
    """The real time in ORION_TZ, to the minute. ORION_NOW pins it, so tests and evals are reproducible."""
    from datetime import datetime
    from zoneinfo import ZoneInfo

    return os.environ.get("ORION_NOW") or datetime.now(ZoneInfo(TZ)).strftime("%Y-%m-%dT%H:%M")


def recorded(db: DB, t: str) -> str:
    """The time of the tenant's latest record: where Corvane's history ends, a repository's last pull request, or the
    last live event."""
    return db.get(f"orion:{t}:clock") or ""


def clock(db: DB, t: str) -> str:
    """The tenant's 'now': the real time, never earlier than its latest record."""
    m = _MEMO.get()
    if m is not None and ("clock", t) in m:
        return m[("clock", t)]
    out = max(wall(), recorded(db, t))
    if m is not None:
        m[("clock", t)] = out
    return out


def tick(db: DB, t: str, minutes: int = 1) -> str:
    """The time of a new live event: now, and always after the event before it, so events keep their order."""
    from datetime import datetime, timedelta

    last = recorded(db, t)
    after = (datetime.fromisoformat(last) + timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M") if last else ""
    v = max(wall(), after)
    db.set(f"orion:{t}:clock", v)
    return v


def version(db: DB, t: str) -> int:
    """Bumped on every write to the org graph; epochs built from an older version are rebuilt."""
    m = _MEMO.get()
    if m is not None and ("version", t) in m:
        return m[("version", t)]
    out = int(db.get(f"orion:{t}:version") or 0)
    if m is not None:
        m[("version", t)] = out
    return out


def bump(db: DB, t: str) -> int:
    m = _MEMO.get()
    if m is not None:
        m.clear()  # a write inside a remembered block: forget everything
    return db.incr(f"orion:{t}:version")
