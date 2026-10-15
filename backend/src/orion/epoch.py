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
WITH p, s, count(c) AS n
WHERE n >= $min
CREATE (p)-[:KNOWS {n: n}]->(s)
"""

DERIVE_COLLAB = """
MATCH (a:Person)-[:AUTHORED|REVIEWED]->(c:Change)<-[:AUTHORED|REVIEWED]-(b:Person)
WHERE a.uid < b.uid AND c.day > $day - 365
WITH a, b, sum(2.0 * exp(-$k * ($day - c.day))) AS w, count(c) AS shared
WHERE w >= $min
CREATE (a)-[:COLLABORATES {w: w, inv: 1.0 / w, cost: 1.0 + 3.0 / w, shared: shared}]->(b),
       (b)-[:COLLABORATES {w: w, inv: 1.0 / w, cost: 1.0 + 3.0 / w, shared: shared}]->(a)
"""

# collaboration that crosses team lines; WCC over it finds the groups the org chart doesn't show
DERIVE_BRIDGES = """
MATCH (a:Person)-[r:COLLABORATES]->(b:Person)
MATCH (a)-[:MEMBER_OF]->(ta:Team)
MATCH (b)-[:MEMBER_OF]->(tb:Team)
WHERE ta.uid <> tb.uid
CREATE (a)-[:BRIDGES {w: r.w}]->(b)
"""

# what it costs to walk each kind of link when asking how two things are connected: structure is cheap
COSTS = [
    "MATCH ()-[r:DEPENDS_ON|OWNS|MEMBER_OF]->() SET r.cost = 1.0",
    "MATCH ()-[r:KNOWS]->() SET r.cost = 1.0 + 3.0 / r.n",
    "MATCH ()-[r:WORKED_ON|TOUCHES|USES]->() SET r.cost = 2.0",
]


def name_for(tenant: str, on: str, mode: str) -> str:
    return dbm.epoch(tenant, on, mode)


def build(db: dbm.DB, tenant: str, on: str, mode: str = "true", name: str | None = None) -> dict:
    """Copy the org graph and prune it to `on`. mode 'known' also drops facts recorded after the date: the company
    as Corvane understood it that day, not as it really was."""
    t0 = time.perf_counter()
    name = name or name_for(tenant, on, mode)
    v = dbm.version(db, tenant)
    db.copy(dbm.org(tenant), name)
    params = {"d": on}
    for q in PRUNE:
        db.q(name, q, params)
    if mode == "known":
        db.q(name, "MATCH ()-[r]->() WHERE r.recorded_at IS NOT NULL AND r.recorded_at > $d DELETE r", params)
    day = day_index(on)
    db.q(name, DERIVE_KNOWS, {"day": day, "window": KNOWS_WINDOW, "min": KNOWS_MIN})
    db.q(name, DERIVE_COLLAB, {"day": day, "k": LN2 / COLLAB_HALF_LIFE, "min": COLLAB_MIN})
    db.q(name, DERIVE_BRIDGES)
    for q in COSTS:
        db.q(name, q)
    db.q(name, "MATCH (c:Company) SET c.on = $d, c.mode = $m, c.version = $v", {"d": on, "m": mode, "v": v})
    db.set(f"orion:epoch:{name}", f"{v}|{on}|{mode}")
    return {"graph": name, "on": on, "mode": mode, "ms": round((time.perf_counter() - t0) * 1000, 1)}


def ensure(db: dbm.DB, tenant: str, on: str = "now", mode: str = "true") -> str:
    """The epoch graph for a date, rebuilt only if the org graph changed since it was built."""
    if on == "now":
        name, on_date = dbm.epoch(tenant), dbm.clock(db, tenant)
    else:
        name, on_date = name_for(tenant, on, mode), on
    stamp = db.get(f"orion:epoch:{name}")
    want = f"{dbm.version(db, tenant)}|{on_date}|{mode}"
    if stamp != want or not db.exists(name):
        with db.lock("epoch:" + name, ttl=120):
            if db.get(f"orion:epoch:{name}") != want or not db.exists(name):
                build(db, tenant, on_date, mode, name)
    return name


def now(db: dbm.DB, tenant: str) -> str:
    return ensure(db, tenant, "now")
