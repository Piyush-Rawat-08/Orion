"""Each visitor's own Corvane.

The demo's best moments change the company: a message closes a fact, an answer goes out of date, a plan is sent for
approval. On one shared company the second visitor would find the first one's story already told. So every browser
gets a copy of its own, made the way Orion makes everything else: GRAPH.COPY of each of the template's graphs (the
records, today's epoch, the what-if Priya's answer made, the agents' board, Priya's memory), with the few properties
that name their graph rewritten, and the template's clock, version and epoch records copied under the new name.

    create(db)       a fresh copy of the template; its id
    touch(db, t)     the visitor is still here
    active(db)       copies seen in the last quarter of an hour (the only ones workers and the janitor visit)
    gc(db)           delete copies idle for TTL, and the oldest beyond MAX
"""

from __future__ import annotations

import secrets
import time

from orion import db as dbm

TEMPLATE = "corvane"
PREFIX = "demo-"
TTL_S = 30 * 60          # a copy idle this long is deleted; coming back after that starts on a fresh one
TRIM_S = 10 * 60         # idle this long: its past-date epochs (Hindsight, History) are dropped, rebuilt if needed
EVICT_S = 60             # to make room, copies idle this long go first
ACTIVE_S = 15 * 60
MAX = 24
RESERVE = 24 * 2 ** 20   # a new copy is about 17 MB (records, today's epoch, the what-if), plus room to work in
SEEN = "orion:demo:"


class Full(Exception):
    """No room for another copy right now."""


def is_demo(t: str) -> bool:
    return t.startswith(PREFIX) and len(t) == len(PREFIX) + 8


def graphs_of(db: dbm.DB, t: str) -> list[str]:
    """Every graph of tenant `t`, matched exactly (a prefix like 'org:corvane' would also match other tenants)."""
    return [g for g in db.graphs() if g in (f"org:{t}", f"deck:{t}")
            or g.startswith((f"epoch:{t}:", f"universe:{t}:", f"mem:{t}:", f"scratch:{t}:"))]


def _pairs(src: str, dst: str) -> list[tuple[str, str]]:
    return [(f"org:{src}", f"org:{dst}"), (f"deck:{src}", f"deck:{dst}"), (f"epoch:{src}:", f"epoch:{dst}:"),
            (f"universe:{src}:", f"universe:{dst}:"), (f"mem:{src}:", f"mem:{dst}:")]


def _renamed(s: str, pairs: list[tuple[str, str]]) -> str:
    for a, b in pairs:
        s = s.replace(a, b)
    return s


def _meta_keys(src: str) -> tuple[str, ...]:
    return (f"orion:{src}:", f"orion:epoch:epoch:{src}:", f"orion:snap:epoch:{src}:", f"orion:deck-indexed:deck:{src}")


def clone(db: dbm.DB, src: str, dst: str) -> dict:
    """Copy tenant `src` to `dst`. {graphs, ms}."""
    t0 = time.perf_counter()
    pairs = _pairs(src, dst)
    params = {f"a{i}": a for i, (a, _) in enumerate(pairs)} | {f"b{i}": b for i, (_, b) in enumerate(pairs)}

    def rewrite(expr: str) -> str:
        for i in range(len(pairs)):
            expr = f"replace({expr}, $a{i}, $b{i})"
        return expr

    made = []
    for g in graphs_of(db, src):
        if g.startswith(f"scratch:{src}:"):
            continue
        new = _renamed(g, pairs)
        db.copy(g, new)
        made.append(new)
        db.q(new, "MATCH (c:Company) SET c.tenant = $dst", {"dst": dst})
        if new == f"deck:{dst}":
            db.q(new, f"""MATCH (u:Universe) SET u.graph = {rewrite('u.graph')}, u.base = {rewrite('u.base')},
                          u.diff_json = {rewrite('u.diff_json')}""", params)
        if new == f"org:{dst}":
            db.q(new, f"MATCH (a:Answer) WHERE a.payload IS NOT NULL SET a.payload = {rewrite('a.payload')}", params)
            db.q(new, f"MATCH (c:Claim) WHERE c.check IS NOT NULL SET c.check = {rewrite('c.check')}", params)
    rows = db._meta("MATCH (x:KV) WHERE any(p IN $p WHERE x.k STARTS WITH p) RETURN x.k, x.v, x.exp",
                    {"p": list(_meta_keys(src))}, write=False)
    for k, v, exp in rows:
        db._meta("MERGE (x:KV {k: $k}) SET x.v = $v, x.exp = $exp",
                 {"k": k.replace(f":{src}:", f":{dst}:").replace(f"deck:{src}", f"deck:{dst}"),
                  "v": _renamed(v, pairs) if isinstance(v, str) else v, "exp": exp})
    return {"graphs": made, "ms": round((time.perf_counter() - t0) * 1000)}


def touch(db: dbm.DB, t: str) -> None:
    db.set(SEEN + t, str(time.time()))


def seen(db: dbm.DB) -> dict[str, float]:
    rows = db._meta("MATCH (x:KV) WHERE x.k STARTS WITH $p RETURN x.k, x.v", {"p": SEEN}, write=False)
    return {k[len(SEEN):]: float(v) for k, v in rows}


def active(db: dbm.DB, within: float = ACTIVE_S) -> list[str]:
    cut = time.time() - within
    return [t for t, at in seen(db).items() if at > cut]


def remove(db: dbm.DB, t: str) -> None:
    if not is_demo(t):
        raise ValueError(f"{t} is not a visitor's copy")
    for g in graphs_of(db, t):
        db.delete(g)
    for p in _meta_keys(t) + (SEEN + t,):
        db.drop(p)


def trim(db: dbm.DB, t: str) -> int:
    """Drop the epochs of past dates (and their records); today's stays. They are rebuilt when next asked for."""
    old = [g for g in db.graphs(f"epoch:{t}:") if g != f"epoch:{t}:now"]
    for g in old:
        db.delete(g)
        db.drop(f"orion:epoch:{g}")
        db.drop(f"orion:snap:{g}")
    return len(old)


def gc(db: dbm.DB, keep: int = MAX) -> list[str]:
    """Copies idle for TTL_S go, and past `keep` the least recently seen; copies idle for TRIM_S lose their past
    epochs."""
    by = sorted(seen(db).items(), key=lambda x: -x[1])
    now = time.time()
    gone = [t for i, (t, at) in enumerate(by) if at < now - TTL_S or i >= keep]
    for t in gone:
        try:
            remove(db, t)
        except Exception as e:
            print(f"demo gc {t}: {type(e).__name__}: {e}", flush=True)
    for t, at in by:
        if t not in gone and at < now - TRIM_S:
            try:
                trim(db, t)
            except Exception as e:
                print(f"demo trim {t}: {type(e).__name__}: {e}", flush=True)
    return gone


def memory(db: dbm.DB) -> tuple[int, int | None]:
    """(used, limit) in bytes; no limit on a local server."""
    info = db.redis.info("memory")
    return int(info["used_memory"]), int(info.get("maxmemory") or 0) or None


def make_room(db: dbm.DB) -> None:
    """Evict copies until another one fits under the server's memory limit: idle ones first, then the least recently
    seen even if it is in use (its visitor is moved to a fresh copy on their next request). A newcomer always gets a
    copy; Full only when the template alone leaves no room."""
    used, cap = memory(db)
    if not cap:
        return
    by = sorted(seen(db).items(), key=lambda x: x[1])
    order = [t for t, at in by if at < time.time() - EVICT_S] + [t for t, at in by if at >= time.time() - EVICT_S]
    while used + RESERVE > cap * 0.95:
        if not order:
            raise Full(f"{used // 2 ** 20} MB of {cap // 2 ** 20} MB in use")
        remove(db, order.pop(0))
        time.sleep(0.5)  # deletes are asynchronous on the server
        used, cap = memory(db)


def create(db: dbm.DB) -> dict:
    """A fresh copy of the template for one visitor. Raises Full when there is no room for one."""
    with db.lock("demo:create", ttl=120):
        gc(db, keep=MAX - 1)
        make_room(db)
        t = PREFIX + secrets.token_hex(4)
        out = clone(db, TEMPLATE, t)
        touch(db, t)
    return {"tenant": t, **out}
