"""What depends on what, at any depth.

A breadth-first walk along DEPENDS_ON, one indexed query per hop, that keeps for every service the most severe way
it is affected and one path that proves it (the witness). A dependency's kind says what losing it does:

    sync   the request fails            -> break
    async  work queues up or is dropped -> degrade
    data   a feed goes stale            -> stale

Along a path the softest hop decides (a sync caller of an async consumer degrades, it doesn't break); across paths
the most severe one wins. On the org graph the walk can be pinned to a date with `on`, which filters by validity;
epochs and universes are already pruned, so they don't need it.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from orion import db as dbm

SEVERITY = {"break": 3, "degrade": 2, "stale": 1}
EFFECT = {"sync": "break", "async": "degrade", "data": "stale"}
SEVERITY_OF_KIND = {"sync": 3, "async": 2, "data": 1}


@dataclass
class Reach:
    uid: str
    name: str
    tier: int
    hops: int
    root: str                                         # the start node this one was reached from
    effect: str
    nodes: list[str] = field(default_factory=list)    # witness path, this node first, root last
    edges: list[str] = field(default_factory=list)    # DEPENDS_ON uids along it
    kinds: list[str] = field(default_factory=list)
    declared: list[bool] = field(default_factory=list)

    @property
    def undeclared(self) -> list[str]:
        """The links on the path that are on no official list (found in conversation)."""
        return [e for e, d in zip(self.edges, self.declared) if d is False]

    # the names older callers used
    @property
    def depth(self) -> int:
        return self.hops

    @property
    def path(self) -> list[str]:
        return self.nodes

    @property
    def facts(self) -> list[str]:
        return self.edges

    def __getitem__(self, k):  # dict-style access for older callers
        return getattr(self, k)

    def get(self, k, default=None):
        return getattr(self, k, default)


def _hop(direction: str, on: bool) -> str:
    pattern = "(d:Service)-[r:DEPENDS_ON]->(s)" if direction == "up" else "(s)-[r:DEPENDS_ON]->(d:Service)"
    valid = """ AND r.valid_from <= $on AND r.valid_to > $on AND d.created <= $on AND d.retired > $on
                AND ($known = false OR r.recorded_at <= $on)""" if on else ""
    return f"""MATCH {pattern} WHERE s.uid IN $frontier{valid}
               RETURN d.uid AS next, d.name AS name, d.tier AS tier, s.uid AS via, r.kind AS kind, r.uid AS fact,
                      r.declared AS declared"""


HOP = _hop("up", False)
HOP_ON = _hop("up", True)


def walk(db: dbm.DB, graph: str, roots: list[str], on: str | None = None, known: bool = False,
         max_depth: int = 40, direction: str = "up") -> dict[str, Reach]:
    """Everything that transitively depends on `roots` (direction 'up'), or everything `roots` depend on ('down').
    {uid: Reach}."""
    best: dict[str, Reach] = {}
    state = {r: (SEVERITY["break"], [r], [], [], [], r) for r in roots}
    frontier = list(dict.fromkeys(roots))
    q = _hop(direction, bool(on))
    depth = 0
    while frontier and depth < max_depth:
        depth += 1
        params = {"frontier": frontier}
        if on:
            params |= {"on": on, "known": known}
        nxt: dict[str, tuple] = {}
        for r in db.ro(graph, q, params):
            sev_in, path, edges, kinds, decl, root = state[r["via"]]
            sev = min(sev_in, SEVERITY[EFFECT.get(r["kind"] or "sync", "break")])
            uid = r["next"]
            if uid in state or uid in best and (SEVERITY[best[uid].effect] >= sev):
                continue
            if uid in nxt and nxt[uid][0] >= sev:
                continue
            nxt[uid] = (sev, [uid] + path, [r["fact"]] + edges, [r["kind"] or "sync"] + kinds,
                        [r["declared"]] + decl, root, r)
        state = {}
        for uid, (sev, path, edges, kinds, decl, root, r) in nxt.items():
            effect = next(k for k, v in SEVERITY.items() if v == sev)
            best[uid] = Reach(uid=uid, name=r["name"], tier=r["tier"] or 3, hops=depth, root=root, effect=effect,
                              nodes=path, edges=edges, kinds=kinds, declared=decl)
            state[uid] = (sev, path, edges, kinds, decl, root)
        frontier = list(state)
    for r in roots:
        best.pop(r, None)
    return best


def names(db: dbm.DB, graph: str, uids) -> dict[str, str]:
    rows = db.ro(graph, "MATCH (n) WHERE n.uid IN $u RETURN n.uid AS uid, coalesce(n.name, n.key) AS name",
                 {"u": list(uids)})
    return {r["uid"]: r["name"] for r in rows}
