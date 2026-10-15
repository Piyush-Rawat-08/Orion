"""The blackboard: every agent works through tasks in the deck graph, so the work is shared and visible.

    (:Agent {name, role, pid, status, heartbeat_at, kinds})        in the shared pool graph (orion:pool)
    (:Task {uid, kind, status: open|claimed|done|failed|dead, payload, claimed_by, created_at, claimed_at, done_at,
            posted_by, attempts, root})-[:FOLLOWS]->(:Task)        in deck:<tenant>
    (:Task)-[:PRODUCED]->(:Finding {summary, result})

A task is claimed with one write query; FalkorDB runs writes to a graph one at a time, so two workers never take the
same task. A task is tried at most three times, then it is dead rather than looping. Workers are threads in the API
process (Simulator 1 and 2, the Cartographer, the Sentinel), each with a heartbeat; a task whose worker goes silent is
released.
"""

from __future__ import annotations

import json
import os
import secrets
import threading
import time
from typing import Callable

from orion import db as dbm
from orion.queries import cypher

POOL = "orion:pool"
MAX_ATTEMPTS = 3
HEARTBEAT_S = 5
DEAD_AFTER_S = 30
IDLE_MIN, IDLE_MAX = 0.25, 1.0


def now_ms() -> int:
    return int(time.time() * 1000)


def _deck(db: dbm.DB, t: str) -> str:
    from orion.universe import deck

    g = deck(db, t)
    if not db.exists(g) or not db.get(f"orion:deck-indexed:{g}"):
        db.q(g, "CREATE INDEX FOR (x:Task) ON (x.uid)")
        db.q(g, "CREATE INDEX FOR (x:Task) ON (x.status)")
        db.set(f"orion:deck-indexed:{g}", "1")
    return g


def register(db: dbm.DB, name: str, role: str, kinds: list[str]) -> None:
    with dbm.tagged("board"):
        db.q(POOL, """MERGE (a:Agent {name: $n}) SET a.role = $r, a.pid = $pid, a.status = 'idle', a.heartbeat_at = $t,
                      a.kinds = $k""", {"n": name, "r": role, "pid": os.getpid(), "t": now_ms(), "k": kinds})


def heartbeat(db: dbm.DB, name: str, status: str | None = None) -> None:
    with dbm.tagged("board"):
        db.q(POOL, "MATCH (a:Agent {name: $n}) SET a.heartbeat_at = $t" + (", a.status = $s" if status else ""),
             {"n": name, "t": now_ms(), "s": status})


def post(db: dbm.DB, t: str, kind: str, payload: dict, posted_by: str = "api", follows: str | None = None) -> str:
    g = _deck(db, t)
    uid = f"task:{secrets.token_hex(5)}"
    root = None
    if follows:
        db.follows(uid, follows)
        row = db.one(g, "MATCH (x:Task {uid: $u}) RETURN coalesce(x.root, x.uid) AS r", {"u": follows})
        root = row["r"] if row else None
    with dbm.tagged("board"):
        db.q(g, """CREATE (x:Task {uid: $u, kind: $k, status: 'open', payload: $p, created_at: $at, posted_by: $by,
                                  attempts: 0, root: $root})""",
             {"u": uid, "k": kind, "p": json.dumps(payload, default=str), "at": now_ms(), "by": posted_by, "root": root})
        if follows:
            db.q(g, "MATCH (a:Task {uid: $a}), (b:Task {uid: $b}) CREATE (a)-[:FOLLOWS]->(b)", {"a": uid, "b": follows})
    return uid


def _existing_deck(db: dbm.DB, t: str) -> str | None:
    """The deck, only if the tenant has one: workers and housekeeping never create it (a tenant deleted while they
    were looping would otherwise come back as an empty deck)."""
    g = dbm.deck(t)
    return g if db.exists(g) else None


def claim(db: dbm.DB, t: str, agent: str, kinds: list[str], uid: str | None = None) -> dict | None:
    g = _existing_deck(db, t)
    if not g:
        return None
    with dbm.tagged("board"):
        if uid:
            rows = db.q(g, """MATCH (x:Task {uid: $u}) WHERE x.status = 'open'
                              SET x.status = 'claimed', x.claimed_by = $a, x.claimed_at = $now, x.attempts = x.attempts + 1
                              RETURN x.uid AS uid, x.kind AS kind, x.payload AS payload, x.attempts AS lease""",
                        {"u": uid, "a": agent, "now": now_ms()})
        else:
            rows = db.q(g, cypher("claim_task"), {"kinds": kinds, "agent": agent, "now": now_ms(), "max": MAX_ATTEMPTS})
    if not rows:
        return None
    r = rows[0]
    return r | {"payload": json.loads(r["payload"])}


# a worker that claimed a task holds a lease on it: the attempt number it claimed. A task released from a worker
# that went silent and claimed again has a new lease, so the first worker, if it was only slow, can't overwrite it.
LEASED = " AND x.status = 'claimed' AND x.claimed_by = $agent AND x.attempts = $lease"


def complete(db: dbm.DB, t: str, uid: str, result: dict, summary: str, ok: bool = True,
             agent: str | None = None, lease: int | None = None) -> bool:
    """Record the result; with a lease, only if it is still this worker's. True when it was recorded."""
    g = _existing_deck(db, t)
    if not g:
        return False
    with dbm.tagged("board"):
        rows = db.q(g, f"""MATCH (x:Task {{uid: $u}}) WHERE true{LEASED if lease is not None else ""}
                           SET x.status = $s, x.done_at = $now, x.result = $r
                           CREATE (x)-[:PRODUCED]->(:Finding {{summary: $sum}}) RETURN x.uid AS uid""",
                    {"u": uid, "s": "done" if ok else "failed", "now": now_ms(), "r": json.dumps(result, default=str)[:20000],
                     "sum": summary, "agent": agent, "lease": lease})
    return bool(rows)


def fail(db: dbm.DB, t: str, uid: str, error: str, agent: str | None = None, lease: int | None = None) -> bool:
    g = _existing_deck(db, t)
    if not g:
        return False
    with dbm.tagged("board"):
        rows = db.q(g, f"""MATCH (x:Task {{uid: $u}}) WHERE true{LEASED if lease is not None else ""}
                           SET x.status = CASE WHEN x.attempts >= $max THEN 'dead' ELSE 'open' END, x.error = $e
                           RETURN x.uid AS uid""",
                    {"u": uid, "e": error[:500], "max": MAX_ATTEMPTS, "agent": agent, "lease": lease})
    return bool(rows)


class beating:
    """Heartbeat from a thread of its own while a task runs, so a worker busy for minutes is never taken for dead."""

    def __init__(self, db: dbm.DB, name: str, every: float | None = None):
        self.db, self.name, self.every = db, name, every or HEARTBEAT_S
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        while not self.stop.wait(self.every):
            try:
                heartbeat(self.db, self.name, "working")
            except Exception:
                pass

    def __enter__(self):
        heartbeat(self.db, self.name, "working")
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.stop.set()
        self.thread.join(timeout=2)
        return False


# ---------------------------------------------------------------- execution

EXECUTORS: dict[str, Callable] = {}


def executor(kind: str):
    def deco(fn):
        EXECUTORS[kind] = fn
        return fn
    return deco


@executor("fork")
def _fork(db: dbm.DB, t: str, task: str, payload: dict, agent: str) -> tuple[dict, str]:
    from orion import universe as uv

    res = uv.fork(db, t, payload["ops"], kind=payload.get("kind", "whatif"), title=payload.get("title"),
                  created_by=payload.get("created_by", agent), uid=payload.get("universe_uid"), task=task)
    return res, f"{res['uid']}: {res['title']} → risk {res['diff']['risk']['level']} {res['diff']['risk']['score']}"


@executor("simulate")
def _simulate(db: dbm.DB, t: str, task: str, payload: dict, agent: str) -> tuple[dict, str]:
    from orion.agents.simulator import simulate

    res = simulate(db, t, payload["scenario"], payload.get("created_by"), uid=payload.get("universe_uid"), task=task)
    return res, f"{res['uid']}: {res['title']} → risk {res['diff']['risk']['level']} {res['diff']['risk']['score']}"


def run_task(db: dbm.DB, t: str, task: dict, agent: str) -> dict:
    lease = task.get("lease")
    with dbm.tagged(f"task:{task['uid']}"), beating(db, agent):
        try:
            res, summary = EXECUTORS[task["kind"]](db, t, task["uid"], task["payload"], agent)
        except Exception as e:
            fail(db, t, task["uid"], f"{type(e).__name__}: {e}", agent, lease)
            raise
    kept = complete(db, t, task["uid"], {k: res.get(k) for k in ("uid", "title", "risk", "risk_level", "assumptions",
                                                                 "scenario", "fork_ms", "copy_ms")},
                    summary, agent=agent, lease=lease)
    return res | {"_worker": agent, "_task": task["uid"], "_stale": not kept}


def live_workers(db: dbm.DB, t: str | None = None, role: str = "simulator") -> int:
    if not db.exists(POOL):
        return 0
    with dbm.tagged("board"):
        return db.one(POOL, "MATCH (a:Agent {role: $r}) WHERE a.heartbeat_at > $since RETURN count(a) AS n",
                      {"r": role, "since": now_ms() - DEAD_AFTER_S * 1000})["n"]


def _finished(db: dbm.DB, t: str, uid: str, payload: dict) -> dict:
    """A finished fork or simulate task, read back from the board and the universe it made (any process may have
    done it)."""
    from orion import universe as uv

    row = db.one(_deck(db, t), "MATCH (x:Task {uid: $u}) RETURN x.result AS r, x.claimed_by AS w", {"u": uid})
    extra = json.loads(row["r"] or "{}") if row else {}
    res = uv.fork(db, t, payload.get("ops") or [], uid=payload["universe_uid"])
    return res | {k: extra[k] for k in ("assumptions", "scenario", "fork_ms") if extra.get(k) is not None} | {
        "_worker": row["w"] if row else None, "_task": uid}


def run(db: dbm.DB, t: str, kind: str, payload: dict, posted_by: str = "api", follows: str | None = None,
        timeout: float = 90.0, pickup: float = 8.0) -> dict:
    """Post a task and wait until a worker has done it. With no live worker, or none picking it up within `pickup`
    seconds, it runs here instead. Waiting reads the board, so the worker can be in any process."""
    payload = dict(payload)
    if kind in ("fork", "simulate") and "universe_uid" not in payload:
        from orion.universe import next_uid

        payload["universe_uid"] = next_uid(db, t)  # a retried task rebuilds the same universe
    uid = post(db, t, kind, payload, posted_by, follows)
    if live_workers(db, t) == 0:
        return run_task(db, t, claim(db, t, "inline", [kind], uid=uid), "inline")
    g = _deck(db, t)
    start = time.time()
    while time.time() - start < timeout:
        with dbm.tagged("board"):
            row = db.one(g, "MATCH (x:Task {uid: $u}) RETURN x.status AS s, x.error AS e", {"u": uid})
        status = row["s"] if row else "dead"
        if status == "done":
            return _finished(db, t, uid, payload)
        if status in ("failed", "dead"):
            raise RuntimeError(row.get("e") if row else "the task disappeared")
        if status == "open" and time.time() - start > pickup:
            task = claim(db, t, "inline", [kind], uid=uid)  # nobody took it: do it here
            if task:
                return run_task(db, t, task, "inline")
        time.sleep(0.2)
    raise RuntimeError(f"{kind} task {uid} didn't finish in {timeout:.0f} s")


def agent_loop(name: str, role: str, kinds: list[str], stop: threading.Event, tenants: Callable[[], list[str]],
               takes: list[str] | None = None) -> None:
    """A worker: claim tasks of the kinds it `takes` from every tenant, run them, heartbeat. The Cartographer and
    the Sentinel take nothing from the open board: their steps are claimed the moment they are posted."""
    db = dbm.get_db()
    register(db, name, role, kinds)
    takes = kinds if takes is None else takes
    idle = IDLE_MIN
    last = 0.0
    while not stop.is_set():
        did = False
        for t in tenants() if takes else []:
            try:
                task = claim(db, t, name, takes)
            except Exception:
                task = None
            if not task:
                continue
            did = True
            try:
                run_task(db, t, task, name)  # done or failed is written on the board, where the poster reads it
            except Exception:
                pass
            heartbeat(db, name, "idle")
        if time.time() - last > HEARTBEAT_S:
            heartbeat(db, name, "idle")
            last = time.time()
        if did:
            idle = IDLE_MIN
        else:  # poll less often the longer the board stays empty: a small host keeps its CPU for real work
            stop.wait(idle)
            idle = min(IDLE_MAX, idle * 1.5)


def release_dead(db: dbm.DB, t: str) -> int:
    """Tasks claimed by a worker that stopped heartbeating go back on the board."""
    if not db.exists(POOL):
        return 0
    with dbm.tagged("board"):
        dead = [r["n"] for r in db.ro(POOL, "MATCH (a:Agent) WHERE a.heartbeat_at < $since RETURN a.name AS n",
                                      {"since": now_ms() - DEAD_AFTER_S * 1000})]
        g = _existing_deck(db, t)
        if not dead or not g:
            return 0
        rows = db.q(g, """MATCH (x:Task {status: 'claimed'}) WHERE x.claimed_by IN $d
                                     SET x.status = CASE WHEN x.attempts >= $max THEN 'dead' ELSE 'open' END
                                     RETURN count(x) AS n""", {"d": dead, "max": MAX_ATTEMPTS})
        return rows[0]["n"] if rows else 0


def retention(db: dbm.DB, t: str, days: int = 7) -> int:
    g = _existing_deck(db, t)
    if not g:
        return 0
    with dbm.tagged("board"):
        rows = db.q(g, """MATCH (x:Task) WHERE x.status IN ['done', 'dead'] AND x.done_at < $cut
                                     OPTIONAL MATCH (x)-[:PRODUCED]->(f) DETACH DELETE x, f RETURN count(*) AS n""",
                    {"cut": now_ms() - days * 86400_000})
        return rows[0]["n"] if rows else 0


def prune_agents(db: dbm.DB) -> None:
    if db.exists(POOL):
        with dbm.tagged("board"):
            db.q(POOL, "MATCH (a:Agent) WHERE a.heartbeat_at < $cut DELETE a", {"cut": now_ms() - 3600_000})


def activity(db: dbm.DB, t: str, limit: int = 40) -> dict:
    agents = db.ro(POOL, """MATCH (a:Agent) RETURN a.name AS name, a.role AS role, a.pid AS pid, a.status AS status,
                            a.heartbeat_at AS heartbeat_at, a.kinds AS kinds ORDER BY a.name""") if db.exists(POOL) else []
    g = _deck(db, t)
    tasks = db.ro(g, """MATCH (x:Task) OPTIONAL MATCH (x)-[:PRODUCED]->(f:Finding) OPTIONAL MATCH (x)-[:FOLLOWS]->(p:Task)
                        RETURN x.uid AS uid, x.kind AS kind, x.status AS status, x.claimed_by AS worker,
                               x.created_at AS created_at, x.claimed_at AS claimed_at, x.done_at AS done_at,
                               x.posted_by AS posted_by, f.summary AS summary, x.attempts AS attempts,
                               coalesce(x.root, x.uid) AS root, p.uid AS follows
                        ORDER BY created_at DESC LIMIT $n""", {"n": limit})
    return {"agents": agents, "tasks": tasks, "now": now_ms()}


def chain(db: dbm.DB, t: str, task: str) -> list[dict]:
    g = _deck(db, t)
    row = db.one(g, "MATCH (x:Task {uid: $u}) RETURN coalesce(x.root, x.uid) AS r", {"u": task})
    if not row:
        return []
    return db.ro(g, """MATCH (x:Task) WHERE x.root = $r OR x.uid = $r
                       RETURN x.uid AS uid, x.kind AS kind, x.status AS status, x.claimed_by AS worker,
                              x.created_at AS created_at ORDER BY created_at""", {"r": row["r"]})
