"""One change, two interpreters. For random op lists: fork a universe (physical edits), merge it into the org graph
(temporal facts), build the epoch for the moment of the merge, and compare. They must be the same company, down to
what the algorithms say about it."""

import random

import pytest

from orion import algos, impact
from orion import epoch as ep
from orion import ops as opsm
from orion import universe as uv
from tests.conftest import drop, fresh_tenant

CASES = 30


def state(db, g: str) -> dict:
    def rows(q):
        return sorted(tuple(r.values()) for r in db.ro(g, q))

    retired = [r[0] for r in rows("MATCH (s:Retired) RETURN s.uid")]
    return {
        "services": rows("MATCH (s:Service) RETURN s.uid"),
        "retired": retired,
        "people": rows("MATCH (p:Person) RETURN p.uid"),
        "former": rows("MATCH (p:Former) RETURN p.uid"),
        "teams": rows("MATCH (t:Team) RETURN t.uid"),
        "deps": rows("MATCH (a:Service)-[r:DEPENDS_ON]->(b) RETURN a.uid, b.uid, r.kind"),
        "owns": rows("MATCH (t:Team)-[:OWNS]->(s) RETURN t.uid, s.uid"),
        "members": rows("MATCH (p:Person)-[:MEMBER_OF]->(t) RETURN p.uid, t.uid"),
        "knows": rows("MATCH (p:Person)-[:KNOWS]->(s:Service) RETURN p.uid, s.uid"),
        "collab": rows("MATCH (a:Person)-[:COLLABORATES]->(b:Person) RETURN a.uid, b.uid"),
        "bridges": rows("MATCH (a:Person)-[:BRIDGES]->(b:Person) RETURN a.uid, b.uid"),
        "stranded": algos.stranded(db, g),
        "groups": algos.collab_groups(db, g),
        "bottlenecks": [p["uid"] for p in algos.bottlenecks(db, g)],
        "hidden": [[p["uid"] for p in h["people"]] for h in algos.hidden_teams(db, g)],
        "pagerank": {r["uid"]: round(r["score"], 3) for r in algos.influence(db, g)},
        "impact": {k: (v["effect"], v["depth"]) for k, v in impact.walk(db, g, retired).items()},
    }


def random_ops(rng: random.Random, base: dict) -> list[dict]:
    services = [s for (s,) in base["services"]]
    people = [p for (p,) in base["people"]]
    teams = [t for (t,) in base["teams"]]
    makers = [
        lambda: {"op": "retire_service", "service": rng.choice(services)},
        lambda: {"op": "retire_service", "service": rng.choice(services), "replacement": rng.choice(services)},
        lambda: {"op": "remove_person", "person": rng.choice(people)},
        lambda: {"op": "merge_teams", "team": rng.choice(teams), "into": rng.choice(teams)},
        lambda: {"op": "move_ownership", "service": rng.choice(services), "team": rng.choice(teams)},
        lambda: {"op": "add_dependency", "service": rng.choice(services), "on": rng.choice(services),
                 "kind": rng.choice(["sync", "async", "data"])},
        lambda: {"op": "remove_dependency", "service": rng.choice(services), "on": rng.choice(services)},
    ]
    while True:
        ops = [rng.choice(makers)() for _ in range(rng.randint(1, 4))]
        bad = any(o.get("replacement") == o.get("service") or o.get("team") == o.get("into") or
                  o.get("on") == o.get("service") for o in ops)
        if bad:
            continue
        try:
            opsm.check_sequence(ops)
            return ops
        except opsm.OpError:
            continue


@pytest.mark.parametrize("seed", range(CASES))
def test_merge_then_checkout_is_the_universe(db, seed):
    t = fresh_tenant(db)
    try:
        rng = random.Random(seed)
        base = state(db, ep.now(db, t))
        ops = random_ops(rng, base)
        me = uv.who(db, t, "person:priya-raman")
        rec = uv.fork(db, t, ops, by=me["uid"])
        universe = state(db, rec["graph"])
        uv.merge(db, t, uv.get(db, t, rec["uid"]), me, forced=True)
        merged = state(db, ep.now(db, t))
        for key in universe:
            assert merged[key] == universe[key], f"{key} differs after {ops}"
    finally:
        drop(db, t)
