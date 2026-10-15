"""One change, two interpreters. For random op lists: fork a universe (the physical interpreter edits a copy),
merge it into the org graph (the temporal interpreter closes and opens facts), rebuild today's company from the
org graph, and compare. It must be the same company, down to what the algorithms say about it."""

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
        "owns": rows("MATCH (t:Team)-[r:OWNS]->(s) WHERE r.declared = true RETURN t.uid, s.uid"),
        "members": rows("MATCH (p:Person)-[:MEMBER_OF]->(t) RETURN p.uid, t.uid"),
        "knows": rows("MATCH (p:Person)-[:KNOWS]->(s:Service) RETURN p.uid, s.uid"),
        "collab": rows("MATCH (a:Person)-[:COLLABORATES]->(b:Person) RETURN a.uid, b.uid"),
        "stranded": algos.stranded(db, g),
        "groups": algos.collab_groups(db, g),
        "bottlenecks": [p["uid"] for p in algos.bottlenecks(db, g)],
        "pagerank": {r["uid"]: round(r["score"], 3) for r in algos.influence(db, g)},
        "impact": {k: (v.effect, v.hops) for k, v in impact.walk(db, g, retired).items()} if retired else {},
    }


def random_ops(rng: random.Random, base: dict) -> list[dict]:
    services = [s for (s,) in base["services"]]
    people = [p for (p,) in base["people"]]
    teams = [t for (t,) in base["teams"]]
    makers = [
        lambda: {"op": "deprecate_service", "service": rng.choice(services)},
        lambda: {"op": "remove_person", "person": rng.choice(people)},
        lambda: {"op": "move_person", "person": rng.choice(people), "team": rng.choice(teams)},
        lambda: {"op": "merge_teams", "team": rng.choice(teams), "into": rng.choice(teams)},
        lambda: {"op": "reassign_owner", "service": rng.choice(services), "team": rng.choice(teams)},
        lambda: {"op": "add_dependency", "source": rng.choice(services), "target": rng.choice(services),
                 "kind": rng.choice(["sync", "async", "data"])},
        lambda: {"op": "remove_dependency", "source": rng.choice(services), "target": rng.choice(services)},
    ]
    while True:
        ops = [rng.choice(makers)() for _ in range(rng.randint(1, 4))]
        if any(o.get("team") == o.get("into") or (o.get("source") and o["source"] == o.get("target")) for o in ops):
            continue
        try:
            opsm.check_sequence(ops)
            return ops
        except opsm.OpError:
            continue


@pytest.mark.parametrize("seed", range(CASES))
def test_merge_then_rebuild_is_the_universe(db, seed):
    t = fresh_tenant(db)
    try:
        rng = random.Random(seed)
        ops = random_ops(rng, state(db, ep.now(db, t)))
        try:
            rec = uv.fork(db, t, ops, created_by="person:priya-raman")
        except opsm.OpError:
            pytest.skip(f"not applicable on this company: {ops}")
        universe = state(db, rec["graph"])
        uv.merge(db, t, rec["uid"], "person:priya-raman", force=True)
        merged = state(db, ep.now(db, t))
        for key in universe:
            assert merged[key] == universe[key], f"{key} differs after {ops}"
    finally:
        drop(db, t)
