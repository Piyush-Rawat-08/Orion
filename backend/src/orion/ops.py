"""Typed changes to a company, each with two interpreters.

  physical  edits a universe graph in place (relationships deleted, nodes relabelled) so that plain Cypher and the
            graph algorithms see the changed company directly;
  temporal  replays the same change into the org graph at a moment: facts are closed (valid_to) and opened
            (valid_from), never deleted, and every new fact points at the Decision that made it.

The two must agree: merging a universe and then building the epoch for that moment gives back the universe
(tests/test_equivalence.py checks it on random op lists).
"""

from __future__ import annotations

from dataclasses import dataclass

from orion import db as dbm
from orion.aliases import Resolver

OPEN = "9999-12-31"


@dataclass(frozen=True)
class Spec:
    args: tuple[str, ...]
    kinds: dict  # arg -> node label it must resolve to
    title: str
    mergeable: bool = True
    optional: tuple[str, ...] = ()


OPS: dict[str, Spec] = {
    "retire_service": Spec(("service",), {"service": "Service", "replacement": "Service"},
                           "Retire {service}", optional=("replacement",)),
    "outage": Spec(("service",), {"service": "Service"}, "{service} goes down", mergeable=False),
    "remove_person": Spec(("person",), {"person": "Person"}, "{person} leaves"),
    "merge_teams": Spec(("team", "into"), {"team": "Team", "into": "Team"}, "Merge {team} into {into}"),
    "move_ownership": Spec(("service", "team"), {"service": "Service", "team": "Team"}, "{team} takes over {service}"),
    "add_dependency": Spec(("service", "on"), {"service": "Service", "on": "Service"}, "{service} starts depending on {on}",
                           optional=("kind",)),
    "remove_dependency": Spec(("service", "on"), {"service": "Service", "on": "Service"},
                              "{service} stops depending on {on}"),
}


class OpError(ValueError):
    pass


def parse(text: str) -> dict:
    """'retire_service:service=sso-legacy,replacement=identity' -> {'op': 'retire_service', ...} (names, not uids)."""
    name, _, rest = text.partition(":")
    op = {"op": name.strip()}
    for part in filter(None, rest.split(",")):
        k, _, v = part.partition("=")
        op[k.strip()] = v.strip()
    return op


def resolver(db: dbm.DB, graph: str) -> Resolver:
    rows = db.ro(graph, "MATCH (a:Alias)-[:NAMES]->(n) RETURN a.text AS t, n.uid AS u, labels(n)[0] AS k")
    return Resolver([(r["t"], r["u"], r["k"]) for r in rows])


def resolve(db: dbm.DB, graph: str, op: dict, res: Resolver | None = None) -> dict:
    """Names or uids -> uids, checked against the kind each argument must be. Raises OpError on anything unclear."""
    if op.get("op") not in OPS:
        raise OpError(f"unknown change '{op.get('op')}'. Known: {', '.join(OPS)}")
    spec = OPS[op["op"]]
    res = res or resolver(db, graph)
    out = {"op": op["op"]}
    for arg in spec.args + spec.optional:
        v = op.get(arg)
        if v in (None, ""):
            if arg in spec.args:
                raise OpError(f"{op['op']} needs {arg}")
            continue
        if arg == "kind":
            if v not in ("sync", "async", "data"):
                raise OpError("kind must be sync, async or data")
            out[arg] = v
            continue
        want = spec.kinds[arg]
        if ":" in v:
            row = db.one(graph, "MATCH (n {uid: $u}) RETURN labels(n) AS l, n.name AS name", {"u": v})
            if row and want in row["l"]:
                out[arg] = v
                continue
            if row:
                gone = {"Retired": "has been retired", "Former": "has left", "FormerTeam": "no longer exists"}
                why = next((m for k, m in gone.items() if k in row["l"]), f"isn't a {want.lower()}")
                raise OpError(f"{row['name']} {why}")
        hits = [u for u in res.resolve(v) if res.kind.get(u) == want]
        if len(hits) != 1:
            raise OpError(f"'{v}' doesn't name exactly one {want.lower()}" + (f" ({len(hits)} match)" if hits else ""))
        out[arg] = hits[0]
    return out


REMOVES = {"retire_service": "service", "outage": "service", "remove_person": "person", "merge_teams": "team"}


def check_sequence(ops: list[dict]) -> None:
    """Ops apply in order; a later op can't use something an earlier one removed."""
    gone: set[str] = set()
    for op in ops:
        used = {v for k, v in op.items() if k != "op" and isinstance(v, str) and ":" in v}
        if used & gone:
            raise OpError(f"{op['op']} uses something an earlier change removes")
        if op["op"] in REMOVES:
            gone.add(op[REMOVES[op["op"]]])


def title(db: dbm.DB, graph: str, op: dict) -> str:
    uids = [v for k, v in op.items() if k != "op" and isinstance(v, str) and ":" in v]
    names = {r["uid"]: r["name"] for r in db.ro(graph, "MATCH (n) WHERE n.uid IN $u RETURN n.uid AS uid, n.name AS name",
                                                 {"u": uids})}
    t = OPS[op["op"]].title.format(**{k: names.get(v, v) for k, v in op.items() if k != "op"})
    if op.get("replacement"):
        t += f", moving its dependents to {names.get(op['replacement'], op['replacement'])}"
    return t


# ---------------------------------------------------------------- physical: edit a universe

def _rederive_bridges(db: dbm.DB, g: str) -> None:
    from orion.epoch import DERIVE_BRIDGES

    db.q(g, "MATCH ()-[r:BRIDGES]->() DELETE r")
    db.q(g, DERIVE_BRIDGES)


def apply_physical(db: dbm.DB, g: str, ops: list[dict], at: str) -> None:
    for i, op in enumerate(ops):
        _PHYSICAL[op["op"]](db, g, op, f"{at}#{i}")
    _rederive_bridges(db, g)


def _p_retire(db, g, op, stamp):
    s = op["service"]
    if op.get("replacement"):
        db.q(g, """MATCH (d:Service)-[r:DEPENDS_ON]->(:Service {uid: $s})
                   MATCH (n:Service {uid: $n}) WHERE d.uid <> $n
                   MERGE (d)-[x:DEPENDS_ON]->(n)
                   ON CREATE SET x.uid = 'dep:' + substring(d.uid, 4) + '->' + substring(n.uid, 4) + '@' + $at,
                                 x.kind = r.kind, x.cost = 1.0
                   DELETE r""", {"s": s, "n": op["replacement"], "at": stamp})
    db.q(g, "MATCH (:Service {uid: $s})-[r:DEPENDS_ON]->() DELETE r", {"s": s})
    db.q(g, "MATCH (:Team)-[r:OWNS]->(:Service {uid: $s}) DELETE r", {"s": s})
    db.q(g, "MATCH (:Person)-[r:KNOWS]->(:Service {uid: $s}) DELETE r", {"s": s})
    db.q(g, "MATCH (n:Service {uid: $s}) SET n:Retired REMOVE n:Service", {"s": s})


def _p_remove_person(db, g, op, stamp):
    p = op["person"]
    for rel in ("MEMBER_OF", "KNOWS", "WORKED_ON"):
        db.q(g, f"MATCH (:Person {{uid: $p}})-[r:{rel}]->() DELETE r", {"p": p})
    db.q(g, "MATCH (:Person {uid: $p})-[r:COLLABORATES|BRIDGES]-() DELETE r", {"p": p})
    db.q(g, "MATCH (n:Person {uid: $p}) SET n:Former REMOVE n:Person", {"p": p})


def _p_merge_teams(db, g, op, stamp):
    a, b = op["team"], op["into"]
    if a == b:
        raise OpError("a team can't merge into itself")
    db.q(g, """MATCH (p:Person)-[r:MEMBER_OF]->(:Team {uid: $a}) MATCH (t:Team {uid: $b})
               CREATE (p)-[:MEMBER_OF {uid: 'mem:' + substring(p.uid, 7) + '->' + substring($b, 5) + '@' + $at, cost: 1.0}]->(t)
               DELETE r""", {"a": a, "b": b, "at": stamp})
    db.q(g, """MATCH (:Team {uid: $a})-[r:OWNS]->(s:Service) MATCH (t:Team {uid: $b})
               CREATE (t)-[:OWNS {uid: 'own:' + substring($b, 5) + '->' + substring(s.uid, 4) + '@' + $at, cost: 1.0}]->(s)
               DELETE r""", {"a": a, "b": b, "at": stamp})
    db.q(g, "MATCH (t:Team {uid: $a}) SET t:FormerTeam REMOVE t:Team", {"a": a})


def _p_move_ownership(db, g, op, stamp):
    db.q(g, "MATCH (:Team)-[r:OWNS]->(:Service {uid: $s}) DELETE r", {"s": op["service"]})
    db.q(g, """MATCH (t:Team {uid: $t}), (s:Service {uid: $s})
               CREATE (t)-[:OWNS {uid: 'own:' + substring($t, 5) + '->' + substring($s, 4) + '@' + $at, cost: 1.0}]->(s)""",
         {"t": op["team"], "s": op["service"], "at": stamp})


def _p_add_dep(db, g, op, stamp):
    if op["service"] == op["on"]:
        raise OpError("a service can't depend on itself")
    db.q(g, """MATCH (a:Service {uid: $a}), (b:Service {uid: $b})
               MERGE (a)-[r:DEPENDS_ON]->(b)
               ON CREATE SET r.uid = 'dep:' + substring($a, 4) + '->' + substring($b, 4) + '@' + $at, r.cost = 1.0
               SET r.kind = $k""", {"a": op["service"], "b": op["on"], "k": op.get("kind", "sync"), "at": stamp})


def _p_remove_dep(db, g, op, stamp):
    db.q(g, "MATCH (:Service {uid: $a})-[r:DEPENDS_ON]->(:Service {uid: $b}) DELETE r", {"a": op["service"], "b": op["on"]})


_PHYSICAL = {"retire_service": _p_retire, "outage": _p_retire, "remove_person": _p_remove_person,
             "merge_teams": _p_merge_teams, "move_ownership": _p_move_ownership, "add_dependency": _p_add_dep,
             "remove_dependency": _p_remove_dep}


# ---------------------------------------------------------------- temporal: replay into the org graph

def apply_temporal(db: dbm.DB, g: str, op: dict, at: str, decision: str) -> None:
    if not OPS[op["op"]].mergeable:
        raise OpError(f"'{op['op']}' is a what-if only; it can't be merged")
    _TEMPORAL[op["op"]](db, g, op, at, decision)


def _close(db, g, match: str, params: dict, at: str, decision: str) -> None:
    db.q(g, f"{match} WHERE r.valid_to = '{OPEN}' AND r.valid_from <= $at SET r.valid_to = $at, r.closed_by = $dec",
         params | {"at": at, "dec": decision})


def _open(db, g, rel: str, a: str, b: str, alabel: str, blabel: str, prefix: str, at: str, decision: str,
          extra: str = "", params: dict | None = None) -> None:
    held = db.q(g, f"""MATCH (:{alabel} {{uid: $a}})-[o:{rel}]->(:{blabel} {{uid: $b}})
                       WHERE o.valid_to = '{OPEN}' RETURN count(o) AS n""", {"a": a, "b": b})
    if held and held[0]["n"]:
        return
    uid = f"{prefix}:{a.split(':', 1)[1]}->{b.split(':', 1)[1]}@{at}"
    db.q(g, f"""MATCH (x:{alabel} {{uid: $a}}), (y:{blabel} {{uid: $b}})
                CREATE (x)-[:{rel} {{uid: $uid, valid_from: $at, valid_to: '{OPEN}', recorded_at: $at,
                                    src: $dec{extra}}}]->(y)""",
         {"a": a, "b": b, "at": at, "dec": decision, "uid": uid} | (params or {}))


def _t_retire(db, g, op, at, dec):
    s = op["service"]
    if op.get("replacement"):
        rows = db.q(g, f"""MATCH (d:Service)-[r:DEPENDS_ON]->(:Service {{uid: $s}})
                          WHERE r.valid_to = '{OPEN}' AND d.uid <> $n AND d.retired = '{OPEN}'
                          RETURN d.uid AS d, r.kind AS kind""", {"s": s, "n": op["replacement"]})
        for r in rows:
            _close(db, g, "MATCH (:Service {uid: $d})-[r:DEPENDS_ON]->(:Service {uid: $s})", {"d": r["d"], "s": s}, at, dec)
            _open(db, g, "DEPENDS_ON", r["d"], op["replacement"], "Service", "Service", "dep", at, dec,
                  ", kind: $kind", {"kind": r["kind"]})
    _close(db, g, "MATCH (:Service {uid: $s})-[r:DEPENDS_ON]->()", {"s": s}, at, dec)
    _close(db, g, "MATCH (:Team)-[r:OWNS]->(:Service {uid: $s})", {"s": s}, at, dec)
    db.q(g, "MATCH (n:Service {uid: $s}) SET n.retired = $at, n.retired_by = $dec", {"s": s, "at": at, "dec": dec})


def _t_remove_person(db, g, op, at, dec):
    p = op["person"]
    _close(db, g, "MATCH (:Person {uid: $p})-[r:MEMBER_OF|WORKED_ON]->()", {"p": p}, at, dec)
    db.q(g, "MATCH (n:Person {uid: $p}) SET n.left = $at, n.left_by = $dec", {"p": p, "at": at, "dec": dec})


def _t_merge_teams(db, g, op, at, dec):
    a, b = op["team"], op["into"]
    people = db.q(g, f"""MATCH (p:Person)-[r:MEMBER_OF]->(:Team {{uid: $a}})
                        WHERE r.valid_to = '{OPEN}' AND r.valid_from <= $at RETURN p.uid AS p""", {"a": a, "at": at})
    services = db.q(g, f"""MATCH (:Team {{uid: $a}})-[r:OWNS]->(s:Service)
                          WHERE r.valid_to = '{OPEN}' AND r.valid_from <= $at RETURN s.uid AS s""", {"a": a, "at": at})
    _close(db, g, "MATCH (:Person)-[r:MEMBER_OF]->(:Team {uid: $a})", {"a": a}, at, dec)
    _close(db, g, "MATCH (:Team {uid: $a})-[r:OWNS]->()", {"a": a}, at, dec)
    for r in people:
        _open(db, g, "MEMBER_OF", r["p"], b, "Person", "Team", "mem", at, dec)
    for r in services:
        _open(db, g, "OWNS", b, r["s"], "Team", "Service", "own", at, dec, ", declared: true")
    db.q(g, "MATCH (t:Team {uid: $a}) SET t.dissolved = $at, t.dissolved_by = $dec", {"a": a, "at": at, "dec": dec})


def _t_move_ownership(db, g, op, at, dec):
    _close(db, g, "MATCH (:Team)-[r:OWNS]->(:Service {uid: $s})", {"s": op["service"]}, at, dec)
    _open(db, g, "OWNS", op["team"], op["service"], "Team", "Service", "own", at, dec, ", declared: true")


def _t_add_dep(db, g, op, at, dec):
    kind = op.get("kind", "sync")
    cur = db.q(g, f"""MATCH (:Service {{uid: $a}})-[r:DEPENDS_ON]->(:Service {{uid: $b}})
                     WHERE r.valid_to = '{OPEN}' RETURN r.kind AS kind""", {"a": op["service"], "b": op["on"]})
    if cur and cur[0]["kind"] == kind:
        return
    _close(db, g, "MATCH (:Service {uid: $a})-[r:DEPENDS_ON]->(:Service {uid: $b})", {"a": op["service"], "b": op["on"]},
           at, dec)
    _open(db, g, "DEPENDS_ON", op["service"], op["on"], "Service", "Service", "dep", at, dec, ", kind: $kind",
          {"kind": kind})


def _t_remove_dep(db, g, op, at, dec):
    _close(db, g, "MATCH (:Service {uid: $a})-[r:DEPENDS_ON]->(:Service {uid: $b})", {"a": op["service"], "b": op["on"]},
           at, dec)


_TEMPORAL = {"retire_service": _t_retire, "remove_person": _t_remove_person, "merge_teams": _t_merge_teams,
             "move_ownership": _t_move_ownership, "add_dependency": _t_add_dep, "remove_dependency": _t_remove_dep}
