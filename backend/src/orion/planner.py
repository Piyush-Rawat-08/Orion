"""The safe path: how to make a change without breaking anything, found by searching parallel companies.

A what-if says what a change breaks. The planner says how to do it safely. For a change such as "switch off
sso-legacy" it searches the space of preparatory steps: move each system that relies on it onto a replacement, or
switch that system off too when nothing relies on it. Every candidate plan is a company of its own (a GRAPH.COPY
of today's company, or of the company on a past date, with the plan applied), assessed with the same risk terms as
a what-if. A beam search keeps the safest few plans at each depth, so a few dozen universes are explored, each in
tens of milliseconds, several at a time.

    assess(db, t, ops)               risk of a list of changes, on a throwaway copy
    replacements(db, t, g, R, S)     what a system relying on R could move to, and why
    plan(db, t, goal, emit)          the search; emits every universe it explores
"""

from __future__ import annotations

import secrets
import time
from concurrent.futures import ThreadPoolExecutor

from orion import db as dbm
from orion import epoch as ep
from orion import ops as opsm
from orion import universe as uv
from orion.queries import cypher

OPEN = "9999-12-31"
BEAM = 4
MAX_DEPTH = 4
PARALLEL = 6


# ---------------------------------------------------------------- assessment

def _base_info(db: dbm.DB, g: str) -> dict:
    return {"orphans": {r["uid"] for r in db.ro(g, cypher("knowledge_orphans"))},
            "stranded": {u for r in db.ro(g, cypher("stranded_clusters")) for u in r["uids"]},
            "tier": {r["uid"]: r["tier"] or 3 for r in db.ro(g, "MATCH (s:Service) RETURN s.uid AS uid, s.tier AS tier")}}


def assess(db: dbm.DB, t: str, ops: list[dict], snap: dict | None = None, info: dict | None = None) -> dict:
    """Apply `ops` to a copy of the snapshot and score it like a what-if (no universe is recorded)."""
    t0 = time.perf_counter()
    snap = snap or ep.checkout(db, t)
    base = snap["graph"]
    info = info or _base_info(db, base)
    resolved = opsm.resolve_ops(db, base, ops)
    g = f"scratch:{t}:{secrets.token_hex(4)}"
    db.copy(base, g)
    try:
        opsm.apply_physical(db, g, resolved, "plan")
        reach = uv.broken_in(db, g)
        roots = {x.root for x in reach.values()}
        names = {r["uid"]: r["name"] for r in db.ro(g, "MATCH (n) WHERE n.uid IN $u RETURN n.uid AS uid, n.name AS name",
                                                       {"u": list(roots | set(reach))})}
        broken = [{"uid": x.uid, "service": x.name, "because_of": names.get(x.root, x.root), "hops": x.hops,
                   "tier": info["tier"].get(x.uid, x.tier or 3), "effect": x.effect, "fact_uids": x.edges}
                  for x in sorted(reach.values(), key=lambda r: (r.hops, r.name))]
        customers = uv.customers_affected(db, g, [b["uid"] for b in broken], snap["asof"])
        orphans = [{"uid": r["uid"], "service": r["name"], "tier": r["tier"] or 3}
                   for r in db.ro(g, cypher("knowledge_orphans")) if r["uid"] not in info["orphans"]]
        stranded = [{"services": sorted(r["names"]), "uids": r["uids"]}
                    for r in db.ro(g, cypher("stranded_clusters")) if set(r["uids"]) - info["stranded"]]
    finally:
        db.delete(g)
    risk = uv.score_risk(broken, orphans, [], [], [], customers, stranded, {b["uid"]: b["effect"] for b in broken})
    return {"risk": risk["score"], "level": risk["level"], "terms": risk["terms"], "broken": broken,
            "customers": [c["customer"] for c in customers], "orphans": [o["service"] for o in orphans],
            "gaps": uv.migration_gaps(resolved), "ops": resolved, "ms": round((time.perf_counter() - t0) * 1000)}


# ---------------------------------------------------------------- what a dependent could move to

def replacements(db: dbm.DB, t: str, g: str, retired: str, dependent: str, avoid: set[str], asof: str | None = None) -> list[dict]:
    """Systems `dependent` could rely on instead of `retired`, best first, each with the reason it was picked: a
    decision that names both, systems that had already moved to it from `retired` (by `asof`, never later), or the
    same owning team."""
    org = dbm.org(t)
    asof = asof or dbm.clock(db, t)
    votes: dict[str, dict] = {}

    def entry(uid: str) -> dict:
        return votes.setdefault(uid, {"decisions": [], "movers": [], "team": None})

    for r in db.ro(g, """MATCH (d:Decision)-[:AFFECTS]->(:Service {uid: $r}) MATCH (d)-[:AFFECTS]->(x:Service)
                         WHERE x.uid <> $r RETURN DISTINCT x.uid AS uid, d.key AS key""", {"r": retired}):
        entry(r["uid"])["decisions"].append(r["key"])
    for r in db.ro(org, f"""MATCH (s:Service)-[o:DEPENDS_ON]->(:Service {{uid: $r}})
                           WHERE o.valid_to <> '{OPEN}' AND o.valid_to <= $asof AND s.uid <> $dep
                           MATCH (s)-[n:DEPENDS_ON]->(x:Service) WHERE n.valid_from >= o.valid_from AND n.valid_from <= $asof
                             AND x.uid <> $r
                           RETURN DISTINCT x.uid AS uid, s.name AS mover""", {"r": retired, "asof": asof, "dep": dependent}):
        entry(r["uid"])["movers"].append(r["mover"])
    for r in db.ro(g, """MATCH (tm:Team)-[o:OWNS]->(:Service {uid: $r}) WHERE o.declared = true
                         MATCH (tm)-[o2:OWNS]->(x:Service) WHERE x.uid <> $r AND o2.declared = true
                         RETURN DISTINCT x.uid AS uid, tm.name AS team""", {"r": retired}):
        entry(r["uid"])["team"] = r["team"]
    live = {r["uid"]: r["name"] for r in db.ro(g, "MATCH (s:Service) WHERE s.uid IN $u RETURN s.uid AS uid, s.name AS name",
                                                  {"u": list(votes)})}
    rname = db.one(g, "MATCH (s {uid: $r}) RETURN s.name AS n", {"r": retired})
    rname = rname["n"] if rname else "it"
    out = []
    for uid, v in votes.items():
        if uid not in live or uid == dependent or uid in avoid:
            continue
        why = []
        if v["decisions"]:
            why.append(f"named alongside {rname} in {', '.join(sorted(v['decisions']))}")
        if v["movers"]:
            m = sorted(v["movers"])
            why.append(f"{len(m)} {'system' if len(m) == 1 else 'systems'} already moved to it from {rname} "
                       f"({', '.join(m[:2])}{'…' if len(m) > 2 else ''})")
        if v["team"] and not why:
            why.append(f"also run by {v['team']}")
        score = 3 * len(v["decisions"]) + 2 * min(3, len(v["movers"])) + (1 if v["team"] else 0)
        out.append({"uid": uid, "name": live[uid], "why": why, "score": score})
    return sorted(out, key=lambda x: (-x["score"], x["name"]))[:3]


def _options(db: dbm.DB, t: str, g: str, retired: str, target: dict, avoid: set[str], kind: str,
             asof: str | None = None) -> list[dict]:
    """The ways to stop `target` breaking: move it to each replacement, or switch it off too if nothing relies on it."""
    opts = []
    for x in replacements(db, t, g, retired, target["uid"], avoid, asof):
        opts.append({"label": f"Move {target['service']} onto {x['name']}", "why": "; ".join(x["why"]),
                     "ops": [{"op": "add_dependency", "source": target["uid"], "target": x["uid"], "kind": kind},
                             {"op": "remove_dependency", "source": target["uid"], "target": retired}]})
    dependents = db.one(g, "MATCH (:Service)-[:DEPENDS_ON]->(s:Service {uid: $s}) RETURN count(*) AS n", {"s": target["uid"]})["n"]
    if not dependents and target["tier"] >= 2:
        opts.append({"label": f"Switch {target['service']} off too", "why": "nothing relies on it",
                     "ops": [{"op": "deprecate_service", "service": target["uid"]}]})
    return opts


# ---------------------------------------------------------------- the search

def _order(fixes: list[dict], goal: list[dict]) -> list[dict]:
    """Preparation first (each move adds the new dependency before dropping the old one), the change itself last."""
    return [o for f in fixes for o in f["ops"]] + goal


def _effort(fixes: list[dict]) -> int:
    return sum(2 if any(o["op"] == "add_dependency" for o in f["ops"]) else 1 for f in fixes)


def plan(db: dbm.DB, t: str, goal: list[dict], emit=None, asof: str | None = None, mode: str = "true",
         beam: int = BEAM, max_depth: int = MAX_DEPTH) -> dict:
    emit = emit or (lambda e: None)
    t0 = time.perf_counter()
    snap = ep.checkout(db, t, asof, mode) if asof else ep.checkout(db, t)
    g = snap["graph"]
    info = _base_info(db, g)
    goal = opsm.resolve_ops(db, g, goal)
    retired = [o["service"] for o in goal if o["op"] in ("deprecate_service", "outage")]
    if not retired:
        raise ValueError("the safe path plans switching a system off; this change switches nothing off")
    names = opsm.names_of(db, g, goal)
    title = "; ".join(opsm.describe(o, names) for o in goal)
    emit({"type": "status", "text": f"exploring ways to {title.lower()} safely"})

    seq = iter(range(1, 10_000))
    explored: list[dict] = []

    def node(fixes: list[dict], parent: str | None, depth: int, label: str, why: str = "") -> dict:
        r = assess(db, t, _order(fixes, goal), snap, info)
        n = {"id": f"p{next(seq)}", "parent": parent, "depth": depth, "label": label, "why": why, "fixes": fixes,
             "risk": r["risk"], "level": r["level"], "broken": [b["service"] for b in r["broken"]],
             "customers": len(r["customers"]), "orphans": r["orphans"], "effort": _effort(fixes), "ms": r["ms"],
             "result": r}
        explored.append(n)
        emit({"type": "universe", **{k: v for k, v in n.items() if k not in ("fixes", "result")},
              "steps": [f["label"] for f in fixes]})
        return n

    root = node([], None, 0, title)
    frontier = [root]
    done: list[dict] = [root]
    kinds = {r["s"]: r["k"] for r in db.ro(g, """MATCH (s:Service)-[d:DEPENDS_ON]->(r:Service) WHERE r.uid IN $r
                                                 RETURN s.uid AS s, d.kind AS k""", {"r": retired})}
    for depth in range(1, max_depth + 1):
        jobs = []
        for st in frontier:
            direct = [b for b in st["result"]["broken"] if b["hops"] == 1 and b["because_of"] in names.values()]
            if not direct:
                continue
            target = sorted(direct, key=lambda b: (b["tier"], b["service"]))[0]
            rid = next(u for u, nm in names.items() if nm == target["because_of"])
            avoid = set(retired) | {b["uid"] for b in root["result"]["broken"]}
            for opt in _options(db, t, g, rid, target, avoid, kinds.get(target["uid"]) or "sync", snap["asof"]):
                jobs.append((st, opt))
        if not jobs:
            break
        emit({"type": "status", "text": f"depth {depth}: forking {len(jobs)} parallel companies"})
        with ThreadPoolExecutor(PARALLEL) as ex:
            kids = list(ex.map(lambda j: _try(node, j[0]["fixes"] + [j[1]], j[0]["id"], depth, j[1]), jobs))
        kids = [k for k in kids if k]
        done += kids
        frontier = sorted(kids, key=lambda n: (n["risk"], n["effort"]))[:beam]
        if frontier and frontier[0]["risk"] == 0:
            break

    best = min(done, key=lambda n: (n["risk"], n["effort"], n["depth"]))
    path, cur = [], best
    by_id = {n["id"]: n for n in done}
    while cur:
        path.append(cur["id"])
        cur = by_id.get(cur["parent"]) if cur["parent"] else None
    steps = [{"label": f["label"], "why": f["why"], "ops": opsm.named(f["ops"], opsm.names_of(db, g, f["ops"]))} for f in best["fixes"]]
    steps.append({"label": title, "why": "the change you asked for, once nothing relies on it", "ops": opsm.named(goal, names)})
    # risk after each prefix of the plan, along the winning branch
    curve = [{"after": "nothing yet" if i == 0 else by_id[p]["label"], "risk": by_id[p]["risk"]}
             for i, p in enumerate(reversed(path))]
    out = {"goal": title, "asof": snap["asof"], "mode": mode, "baseline": _public(root), "best": _public(best),
           "path": list(reversed(path)), "steps": steps, "curve": curve,
           "plan_ops": [o for f in best["fixes"] for o in opsm.named(f["ops"], opsm.names_of(db, g, f["ops"]))] + opsm.named(goal, names),
           "explored": len(done), "ms": round((time.perf_counter() - t0) * 1000),
           "universes": [_public(n) for n in done]}
    emit({"type": "best", "id": best["id"], "path": out["path"], "risk": best["risk"]})
    return out


def _try(node, fixes, parent, depth, opt):
    try:
        return node(fixes, parent, depth, opt["label"], opt["why"])
    except opsm.OpError:
        return None


def _public(n: dict) -> dict:
    return {k: v for k, v in n.items() if k not in ("fixes", "result")} | {"steps": [f["label"] for f in n["fixes"]]}
