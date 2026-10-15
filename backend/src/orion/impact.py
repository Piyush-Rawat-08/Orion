"""What depends on what, at any depth.

A breadth-first walk up DEPENDS_ON, one indexed query per hop, that keeps for every service the most severe way it
is affected and one path that proves it (the witness). A dependency's kind says what losing it does:

    sync   the request fails            -> break
    async  work queues up or is dropped -> degrade
    data   a feed goes stale            -> stale

Along a path the softest hop decides (a sync caller of an async consumer degrades, it doesn't break); across paths
the most severe one wins. On the org graph the walk can be pinned to a date with `on`, which filters by validity;
epochs and universes are already pruned, so they don't need it.
"""

from __future__ import annotations

from orion import db as dbm

SEVERITY = {"break": 3, "degrade": 2, "stale": 1}
EFFECT = {"sync": "break", "async": "degrade", "data": "stale"}

HOP = """
MATCH (d:Service)-[r:DEPENDS_ON]->(s)
WHERE s.uid IN $frontier
RETURN d.uid AS dependent, d.name AS name, d.tier AS tier, s.uid AS on, r.kind AS kind, r.uid AS fact
"""

HOP_ON = """
MATCH (d:Service)-[r:DEPENDS_ON]->(s)
WHERE s.uid IN $frontier AND r.valid_from <= $on AND r.valid_to > $on AND d.created <= $on AND d.retired > $on
  AND ($known = false OR r.recorded_at <= $on)
RETURN d.uid AS dependent, d.name AS name, d.tier AS tier, s.uid AS on, r.kind AS kind, r.uid AS fact
"""


def walk(db: dbm.DB, graph: str, roots: list[str], on: str | None = None, known: bool = False,
         max_depth: int = 12) -> dict[str, dict]:
    """Every service that transitively depends on `roots`: {uid: {name, tier, effect, depth, path, facts}}.
    path is the chain of uids from the dependent down to a root; facts the DEPENDS_ON uids along it."""
    best: dict[str, dict] = {}
    # state per frontier node: (effect severity so far, depth, path, facts)
    state = {r: (SEVERITY["break"], 0, [r], []) for r in roots}
    frontier = list(roots)
    depth = 0
    while frontier and depth < max_depth:
        depth += 1
        params = {"frontier": frontier}
        if on:
            params |= {"on": on, "known": known}
        rows = db.ro(graph, HOP_ON if on else HOP, params)
        nxt: dict[str, tuple] = {}
        for r in rows:
            sev_in, _, path, facts = state[r["on"]]
            sev = min(sev_in, SEVERITY[EFFECT[r["kind"]]])
            uid = r["dependent"]
            if uid in roots:
                continue
            cur = best.get(uid)
            if cur and (SEVERITY[cur["effect"]] > sev or (SEVERITY[cur["effect"]] == sev and cur["depth"] <= depth)):
                continue
            cand = nxt.get(uid)
            if cand and cand[0] >= sev:
                continue
            nxt[uid] = (sev, depth, [uid] + path, [r["fact"]] + facts, r)
        state = {}
        for uid, (sev, d, path, facts, r) in nxt.items():
            effect = next(k for k, v in SEVERITY.items() if v == sev)
            best[uid] = {"uid": uid, "name": r["name"], "tier": r["tier"], "effect": effect, "depth": d,
                         "path": path, "facts": facts}
            state[uid] = (sev, d, path, facts)
        frontier = list(state)
    return best


def names(db: dbm.DB, graph: str, uids: list[str]) -> dict[str, str]:
    rows = db.ro(graph, "MATCH (n) WHERE n.uid IN $u RETURN n.uid AS uid, n.name AS name", {"u": list(uids)})
    return {r["uid"]: r["name"] for r in rows}
