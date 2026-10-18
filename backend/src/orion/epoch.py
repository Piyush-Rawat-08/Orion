"""Epochs: the company as it stood on a date, as its own graph.

The org graph keeps everything with validity intervals, so plain Cypher can ask about any date with a WHERE. Graph
algorithms can't: algo.WCC, algo.betweenness, algo.pageRank and algo.labelPropagation filter by label and
relationship type, never by property, so a closed DEPENDS_ON would still be walked. An epoch is therefore a
GRAPH.COPY of the org graph, physically pruned to one date:

  - facts not valid on that date are deleted (and, in 'known' mode, facts recorded after it too);
  - sources, decisions, tickets and people from after the date are deleted, statuses are rewound;
  - people who had left are relabelled :Former and retired services :Retired, so algorithms skip them;
  - derived edges are recomputed as of the date: KNOWS (3+ changes or reviews of a service in 180 days)
    and COLLABORATES (shared changes, each worth 2 points, decaying with a 90-day half-life; kept from 3; both directions).

Every universe starts as a copy of epoch:<tenant>:now.
"""

from __future__ import annotations

import json
import threading
import time

from orion import db as dbm
from orion.world.corvane import day_index

KNOWS_MIN = 3
KNOWS_WINDOW = 180
COLLAB_MIN = 3.0
COLLAB_HALF_LIFE = 90.0
LN2 = 0.6931471805599453


PRUNE = [
    # answers and agent output belong to the org graph only
    "MATCH (n:Answer) DETACH DELETE n",
    "MATCH (n:Claim) DETACH DELETE n",
    "MATCH (n:Finding) DETACH DELETE n",
    # facts outside their validity on this date
    "MATCH ()-[r]->() WHERE r.valid_from IS NOT NULL AND (r.valid_from > $d OR r.valid_to <= $d) DELETE r",
    # everything that hadn't happened yet
    "MATCH (s:Source) WHERE s.at > $d DETACH DELETE s",
    "MATCH (x:Decision) WHERE x.at > $d DETACH DELETE x",
    "MATCH (x:Contradiction) WHERE x.at > $d DETACH DELETE x",
    "MATCH (p:Person) WHERE p.joined > $d DETACH DELETE p",
    "MATCH (s:Service) WHERE s.created > $d DETACH DELETE s",
    "MATCH (c:Customer) WHERE c.since > $d DETACH DELETE c",
    "MATCH (j:Project) WHERE j.started > $d DETACH DELETE j",
    # rewind statuses
    "MATCH (t:Ticket) WHERE t.closed > $d SET t.status = 'open'",
    "MATCH (x:Decision) SET x.status = 'accepted'",
    """MATCH (a:Decision)-[s:SUPERSEDES]->(b:Decision)
       SET b.status = CASE s.how WHEN 'reverses' THEN 'reversed' ELSE 'superseded' END""",
    "MATCH (j:Project) WHERE j.ended > $d SET j.status = CASE j.status WHEN 'done' THEN 'active' ELSE j.status END",
    # who had gone, what had been switched off
    "MATCH (p:Person) WHERE p.left <= $d SET p:Former REMOVE p:Person",
    "MATCH (s:Service) WHERE s.retired <= $d SET s:Retired REMOVE s:Service",
    "MATCH (t:Team) WHERE t.dissolved <= $d SET t:FormerTeam REMOVE t:Team",
]

DERIVE_KNOWS = """
MATCH (p:Person)-[:AUTHORED|REVIEWED]->(c:Change)-[:MODIFIES]->(s:Service)
WHERE c.day > $day - $window
WITH p, s, count(c) AS n, max(c.at) AS last_at
WHERE n >= $min
CREATE (p)-[:KNOWS {n: n, touches: n, last_at: last_at}]->(s)
"""

# who actually runs a service: the team whose people made most of its changes in the window. When that isn't the
# declared owner and they made at least half of them, it becomes a de-facto owner (OWNS {declared: false})
DEFACTO = """
MATCH (p:Person)-[:AUTHORED]->(c:Change)-[:MODIFIES]->(s:Service)
WHERE c.day > $day - $window
MATCH (p)-[:MEMBER_OF]->(t:Team)
WITH s, t, count(c) AS n
WITH s, collect({team: t.uid, n: n}) AS by, sum(n) AS total
UNWIND by AS x
WITH s, x.team AS team, x.n AS n, total
WHERE toFloat(n) / total >= 0.5
MATCH (t:Team {uid: team}) WHERE NOT (t)-[:OWNS]->(s)
CREATE (t)-[:OWNS {declared: false, share: toFloat(n) / total, changes: n, uid: 'own-de-facto:' + t.uid + '->' + s.uid}]->(s)
"""

DERIVE_COLLAB = """
MATCH (a:Person)-[:AUTHORED|REVIEWED]->(c:Change)<-[:AUTHORED|REVIEWED]-(b:Person)
WHERE a.uid < b.uid AND c.day > $day - 365
WITH a, b, sum(2.0 * exp(-$k * ($day - c.day))) AS w, count(c) AS shared
WHERE w >= $min
CREATE (a)-[:COLLABORATES {w: w, weight: w, inv: 1.0 / w, cost: 1.0 + 3.0 / w, shared: shared}]->(b),
       (b)-[:COLLABORATES {w: w, weight: w, inv: 1.0 / w, cost: 1.0 + 3.0 / w, shared: shared}]->(a)
"""

# collaboration that crosses team lines; WCC over it finds the groups the org chart doesn't show
DERIVE_BRIDGES = """
MATCH (a:Person)-[r:COLLABORATES]->(b:Person)
MATCH (a)-[:MEMBER_OF]->(ta:Team)
MATCH (b)-[:MEMBER_OF]->(tb:Team)
WHERE ta.uid <> tb.uid
CREATE (a)-[:BRIDGES {w: r.w}]->(b)
"""

# who people work with now: each person's two strongest ties over the last 120 days of shared changes. Working
# groups are found in this sparse, recent graph, so a group that formed this summer shows up as one
DERIVE_CLOSE = """
MATCH (a:Person)-[:AUTHORED|REVIEWED]->(c:Change)<-[:AUTHORED|REVIEWED]-(b:Person)
WHERE a <> b AND c.day > $day - 120
WITH a, b, count(c) AS n ORDER BY n DESC
WITH a, collect(b)[0..2] AS top
UNWIND top AS b
MERGE (a)-[:CLOSE]->(b)
"""

# what it costs to walk each kind of link when asking how two things are connected: structure is cheap
COSTS = [
    "MATCH ()-[r:DEPENDS_ON|OWNS|MEMBER_OF]->() SET r.cost = 1.0",
    "MATCH ()-[r:OWNS]->() WHERE r.declared IS NULL SET r.declared = true",
    "MATCH ()-[r:KNOWS]->() SET r.cost = 1.0 + 3.0 / r.n",
    "MATCH ()-[r:WORKED_ON|TOUCHES|USES]->() SET r.cost = 2.0",
]


def stamp(version: int, on: str, mode: str, today: bool = False) -> str:
    """What an epoch was built from; a stored stamp that matches means the graph can be reused."""
    return f"{version}|{on[:10] if today else on}|{mode}"


def name_for(tenant: str, on: str, mode: str) -> str:
    return dbm.epoch(tenant, on, mode)


def build(db: dbm.DB, tenant: str, on: str, mode: str = "true", name: str | None = None) -> dict:
    """Copy the org graph and prune it to `on`. mode 'known' also drops facts recorded after the date: the company
    as Corvane understood it that day, not as it really was. Returns the snapshot record the API shows."""
    t0 = time.perf_counter()
    name = name or name_for(tenant, on, mode)
    v = dbm.version(db, tenant)
    copy_ms = db.copy(dbm.org(tenant), name)
    t1 = time.perf_counter()
    params = {"d": on}
    for q in PRUNE:
        db.q(name, q, params)
    if mode == "known":
        db.q(name, "MATCH ()-[r]->() WHERE r.recorded_at IS NOT NULL AND r.recorded_at > $d DELETE r", params)
    prune_ms = (time.perf_counter() - t1) * 1000
    day = day_index(on)
    db.q(name, DERIVE_KNOWS, {"day": day, "window": KNOWS_WINDOW, "min": KNOWS_MIN})
    db.q(name, DERIVE_COLLAB, {"day": day, "k": LN2 / COLLAB_HALF_LIFE, "min": COLLAB_MIN})
    db.q(name, DERIVE_BRIDGES)
    db.q(name, DERIVE_CLOSE, {"day": day})
    for q in COSTS:
        db.q(name, q)
    db.q(name, DEFACTO, {"day": day, "window": KNOWS_WINDOW})
    groups = _groups(db, name)
    derived = {r["t"]: r["n"] for r in db.ro(name, """MATCH ()-[r]->() WHERE type(r) IN ['KNOWS', 'COLLABORATES', 'BRIDGES']
                                                     OR (type(r) = 'OWNS' AND r.declared = false)
                                                     RETURN CASE WHEN type(r) = 'OWNS' THEN 'OWNS_DE_FACTO'
                                                            ELSE type(r) END AS t, count(r) AS n""")}
    derived["groups"] = groups
    db.q(name, "MATCH (c:Company) SET c.on = $d, c.mode = $m, c.version = $v", {"d": on, "m": mode, "v": v})
    snap = {"asof": on, "version": v, "copy_ms": round(copy_ms, 1), "prune_ms": round(prune_ms, 1),
            "total_ms": round((time.perf_counter() - t0) * 1000, 1), "graph": name, "cached": False,
            "derived": derived, "mode": mode}
    db.set(f"orion:epoch:{name}", f"{v}|{on}|{mode}")
    db.set(f"orion:snap:{name}", json.dumps(snap))
    return snap


def _groups(db: dbm.DB, g: str, runs: int = 7) -> int:
    """The groups people actually work in: label propagation over COLLABORATES, run several times, pairs that land
    together in most runs joined. Each person gets `group` (a small integer), which the Teams screen colours by."""
    from collections import Counter

    together: Counter = Counter()
    people: set[str] = set()
    for _ in range(runs):
        by: dict[int, list[str]] = {}
        for r in db.ro(g, """CALL algo.labelPropagation({nodeLabels: ['Person'], relationshipTypes: ['CLOSE'],
                                                          maxIterations: 20}) YIELD node, communityId
                             RETURN communityId AS c, node.uid AS uid"""):
            by.setdefault(r["c"], []).append(r["uid"])
        for members in by.values():
            people.update(members)
            members.sort()
            for i, a in enumerate(members):
                for b in members[i + 1:]:
                    together[(a, b)] += 1
    parent = {p: p for p in people}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for (a, b), n in together.items():
        if n > runs / 2:
            parent[find(a)] = find(b)
    roots: dict[str, int] = {}
    rows = []
    for p in sorted(people):
        r = find(p)
        if r not in roots:
            roots[r] = len(roots)
        rows.append({"u": p, "g": roots[r]})
    if rows:
        db.q(g, "UNWIND $rows AS r MATCH (p:Person {uid: r.u}) SET p.group = r.g", {"rows": rows})
    return len(roots)


def snapshot(db: dbm.DB, name: str) -> dict:
    raw = db.get(f"orion:snap:{name}")
    return json.loads(raw) if raw else {"graph": name}


def ensure(db: dbm.DB, tenant: str, on: str = "now", mode: str = "true") -> str:
    """The epoch graph for a date, rebuilt only if the org graph changed since it was built."""
    return checkout(db, tenant, None if on == "now" else on, mode)["graph"]


def checkout(db: dbm.DB, tenant: str, on: str | None = None, mode: str = "true") -> dict:
    """The snapshot record for the company now (on=None) or on a date, building it if the org graph moved."""
    m = dbm.memo()
    if m is not None:
        key = ("checkout", tenant, on, mode)
        # claims checked side by side ask at the same moment: one builds, the rest wait here, not on the database lock
        with m.setdefault(("lock", *key), threading.Lock()):
            if key not in m:
                m[key] = _checkout(db, tenant, on, mode)
        return dict(m[key])
    return _checkout(db, tenant, on, mode)


def _checkout(db: dbm.DB, tenant: str, on: str | None, mode: str) -> dict:
    if on is None:
        name, on_date = dbm.epoch(tenant), dbm.clock(db, tenant)
    else:
        on_date = on if len(on) > 10 else on[:10]
        name = name_for(tenant, on_date[:10], mode)
    # today's epoch is rebuilt when the record moves or the day turns, not every minute the clock advances
    want = stamp(dbm.version(db, tenant), on_date, mode, today=on is None)
    if db.get(f"orion:epoch:{name}") == want and db.exists(name):
        return snapshot(db, name) | {"cached": True}
    with db.lock("epoch:" + name, ttl=120):
        if db.get(f"orion:epoch:{name}") == want and db.exists(name):
            return snapshot(db, name) | {"cached": True}
        return build(db, tenant, on_date, mode, name)


def now(db: dbm.DB, tenant: str) -> str:
    return checkout(db, tenant)["graph"]
