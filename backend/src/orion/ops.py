"""Typed changes to a company, each with two interpreters.

  physical  edits a universe graph in place (relationships deleted or retyped, nodes relabelled) so that plain
            Cypher and the graph algorithms see the changed company directly;
  temporal  replays the same change into the org graph at a moment: facts are closed (valid_to) and opened
            (valid_from), never deleted, and every new fact points at the Decision that made it.

The two must agree: merging a universe and then building the epoch for that moment gives back the universe
(tests/test_equivalence.py checks it on random op lists).

    deprecate_service {service}              switch a service off; what still depends on it breaks
    remove_person {person}                   someone leaves
    move_person {person, team}               someone changes team
    reassign_owner {service, team}           a team takes over a service
    add_dependency {source, target, kind}    a service starts depending on another (kind: sync | async | data)
    remove_dependency {source, target}       ...or stops
    declare_dependency {source, target}      a dependency found in conversation goes on the official list
    reverse_decision {decision}              a decision is reversed
    merge_teams {team, into}                 a team is absorbed by another
    create_ticket {title, service, priority, body}
    outage {service}                         like deprecate, but only ever a what-if: it can't be merged
"""

from __future__ import annotations

from dataclasses import dataclass

from orion import db as dbm
from orion.aliases import Resolver, fold

OPEN = "9999-12-31"


@dataclass(frozen=True)
class Spec:
    args: tuple[str, ...]
    kinds: dict  # arg -> node label it must resolve to
    mergeable: bool = True
    optional: tuple[str, ...] = ()


OPS: dict[str, Spec] = {
    "deprecate_service": Spec(("service",), {"service": "Service"}),
    "outage": Spec(("service",), {"service": "Service"}, mergeable=False),
    "remove_person": Spec(("person",), {"person": "Person"}),
    "move_person": Spec(("person", "team"), {"person": "Person", "team": "Team"}),
    "reassign_owner": Spec(("service", "team"), {"service": "Service", "team": "Team"}),
    "add_dependency": Spec(("source", "target"), {"source": "Service", "target": "Service"}, optional=("kind",)),
    "remove_dependency": Spec(("source", "target"), {"source": "Service", "target": "Service"}),
    "declare_dependency": Spec(("source", "target"), {"source": "Service", "target": "Service"}),
    "reverse_decision": Spec(("decision",), {"decision": "Decision"}),
    "merge_teams": Spec(("team", "into"), {"team": "Team", "into": "Team"}),
    "create_ticket": Spec(("title", "service"), {"service": "Service"}, optional=("priority", "body")),
}
TEXT_ARGS = {"title", "priority", "body", "kind"}


class ResolveError(ValueError):
    pass


OpError = ResolveError


def parse(text: str) -> dict:
    """'deprecate_service:service=sso-legacy' -> {'op': 'deprecate_service', 'service': 'sso-legacy'}."""
    name, _, rest = text.partition(":")
    op = {"op": name.strip()}
    for part in filter(None, rest.split(",")):
        k, _, v = part.partition("=")
        op[k.strip()] = v.strip()
    return op


_resolvers: dict[tuple[str, int], Resolver] = {}


def resolver(db: dbm.DB, graph: str) -> Resolver:
    """Names as people write them. Kept in memory until the tenant's records change."""
    parts = graph.split(":")
    key = (graph, dbm.version(db, parts[1]) if len(parts) > 1 else 0)
    if key not in _resolvers:
        rows = db.ro(graph, "MATCH (a:Alias)-[:NAMES]->(n) RETURN a.text AS t, n.uid AS u, labels(n)[0] AS k")
        if len(_resolvers) > 64:
            _resolvers.clear()
        _resolvers[key] = Resolver([(r["t"], r["u"], r["k"]) for r in rows])
    return _resolvers[key]


LABEL_ALIASES = {"Service": ("Service", "Retired"), "Person": ("Person", "Former"), "Team": ("Team", "FormerTeam"),
                 "Decision": ("Decision",), "Customer": ("Customer",), "Project": ("Project",)}


def resolve(db: dbm.DB, graph: str, label: str, ref: str, res: Resolver | None = None) -> str:
    """A uid, a name, a nickname, a handle or a key -> the uid of exactly one node of that label in `graph`.
    Raises ResolveError when nothing or more than one thing matches."""
    ref = (ref or "").strip()
    if not ref:
        raise ResolveError(f"no {label.lower()} given")
    row = db.one(graph, "MATCH (n {uid: $u}) RETURN labels(n) AS l, n.name AS name", {"u": ref})
    if row:
        if label in row["l"]:
            return ref
        gone = {"Retired": "has been retired", "Former": "has left", "FormerTeam": "no longer exists"}
        why = next((m for k, m in gone.items() if k in row["l"]), f"isn't a {label.lower()}")
        raise ResolveError(f"{row['name']} {why}")
    rows = db.ro(graph, f"""MATCH (n:{label}) WHERE toLower(n.name) = toLower($r) OR toLower(n.key) = toLower($r)
                             OR toLower(n.handle) = toLower($r) RETURN n.uid AS uid LIMIT 2""", {"r": ref})
    if len(rows) == 1:
        return rows[0]["uid"]
    res = res or resolver(db, dbm.org(graph.split(":")[1]))
    hits = [u for u in res.resolve(ref) if res.kind.get(u) == label]
    if len(hits) == 1:
        here = db.one(graph, "MATCH (n {uid: $u}) RETURN labels(n) AS l, n.name AS name", {"u": hits[0]})
        if here and label in here["l"]:
            return hits[0]
        if here:
            raise ResolveError(f"{here['name']} isn't a current {label.lower()} here")
    # last resort: the full-text alias index (typos, partial names)
    words = " ".join(w + "*" for w in fold(ref).split() if len(w) > 2)
    if words:
        org = dbm.org(graph.split(":")[1])
        found = db.ro(org, """CALL db.idx.fulltext.queryNodes('Alias', $q) YIELD node, score
                               MATCH (node)-[:NAMES]->(n) RETURN DISTINCT n.uid AS uid, labels(n)[0] AS l, n.name AS name,
                               score ORDER BY score DESC LIMIT 4""", {"q": words})
        found = [f for f in found if f["l"] == label]
        if len(found) == 1 or (len(found) > 1 and found[0]["score"] >= 2 * found[1]["score"]):
            return resolve(db, graph, label, found[0]["uid"], res)
        if found:
            raise ResolveError(f"no single {label.lower()} matches '{ref}' (did you mean "
                               f"{' or '.join(f['name'] for f in found[:2])}?)")
    raise ResolveError(f"no {label.lower()} matches '{ref}'")


def resolve_op(db: dbm.DB, graph: str, op: dict, res: Resolver | None = None) -> dict:
    """Names -> uids, checked against the kind each argument must be."""
    name = op.get("op")
    if name not in OPS:
        raise ResolveError(f"unknown change '{name}'. Known: {', '.join(OPS)}")
    spec = OPS[name]
    out = {"op": name}
    for arg in spec.args + spec.optional:
        v = op.get(arg)
        if v in (None, ""):
            if arg in spec.args:
                raise ResolveError(f"{name} needs {arg}")
            continue
        if arg in TEXT_ARGS:
            if arg == "kind" and v not in ("sync", "async", "data"):
                raise ResolveError("kind must be sync, async or data")
            out[arg] = str(v)
            continue
        out[arg] = resolve(db, graph, spec.kinds[arg], str(v), res)
    if name == "add_dependency":
        out.setdefault("kind", "sync")
    if name == "create_ticket":
        out.setdefault("priority", "P3")
        out.setdefault("body", "")
    return out


def resolve_ops(db: dbm.DB, graph: str, ops: list[dict]) -> list[dict]:
    res = resolver(db, dbm.org(graph.split(":")[1]))
    out = [resolve_op(db, graph, o, res) for o in ops]
    check_sequence(out)
    return out


REMOVES = {"deprecate_service": "service", "outage": "service", "remove_person": "person", "merge_teams": "team"}


def check_sequence(ops: list[dict]) -> None:
    """Ops apply in order; a later op can't use something an earlier one removed."""
    gone: set[str] = set()
    for op in ops:
        used = {v for k, v in op.items() if k not in TEXT_ARGS and k != "op" and isinstance(v, str)}
        if used & gone:
            raise ResolveError(f"{op['op']} uses something an earlier change removes")
        if op["op"] in REMOVES:
            gone.add(op[REMOVES[op["op"]]])
        if op["op"] == "merge_teams" and op["team"] == op["into"]:
            raise ResolveError("a team can't merge into itself")
        if op["op"] in ("add_dependency", "remove_dependency", "declare_dependency") and op["source"] == op["target"]:
            raise ResolveError("a service can't depend on itself")


def describe(op: dict, names: dict | None = None) -> str:
    """One line a person can read: 'Switch off sso-legacy', 'Ines Okafor leaves'."""
    n = names or {}

    def nm(k):
        v = op.get(k, "")
        return n.get(v, v.split(":", 1)[-1] if isinstance(v, str) and ":" in v else v)

    return {
        "deprecate_service": lambda: f"Switch off {nm('service')}",
        "outage": lambda: f"{nm('service')} goes down",
        "remove_person": lambda: f"{nm('person')} leaves the company",
        "move_person": lambda: f"Move {nm('person')} to {nm('team')}",
        "reassign_owner": lambda: f"Make {nm('team')} responsible for {nm('service')}",
        "add_dependency": lambda: f"{nm('source')} starts relying on {nm('target')}",
        "remove_dependency": lambda: f"{nm('source')} stops relying on {nm('target')}",
        "declare_dependency": lambda: f"Write down that {nm('source')} relies on {nm('target')}",
        "reverse_decision": lambda: f"Reverse {nm('decision')}",
        "merge_teams": lambda: f"Combine {nm('team')} into {nm('into')}",
        "create_ticket": lambda: f"Open a ticket on {nm('service')}: {op.get('title', '')}",
    }.get(op["op"], lambda: op["op"])()


def names_of(db: dbm.DB, graph: str, ops: list[dict]) -> dict:
    uids = sorted({v for o in ops for k, v in o.items() if k not in TEXT_ARGS and k != "op" and isinstance(v, str)})
    rows = db.ro(graph, "MATCH (n) WHERE n.uid IN $u RETURN n.uid AS uid, coalesce(n.name, n.key) AS name", {"u": uids})
    return {r["uid"]: r["name"] for r in rows}


def named(ops: list[dict], names: dict) -> list[dict]:
    """The ops as people wrote them: names instead of uids (what the UI lists)."""
    return [{k: (names.get(v, v) if k not in TEXT_ARGS and k != "op" and isinstance(v, str) else v) for k, v in o.items()}
            for o in ops]


# ---------------------------------------------------------------- physical: edit a universe

def _rederive_bridges(db: dbm.DB, g: str) -> None:
    from orion.epoch import DERIVE_BRIDGES

    db.q(g, "MATCH ()-[r:BRIDGES]->() DELETE r")
    db.q(g, DERIVE_BRIDGES)


def apply_physical(db: dbm.DB, g: str, ops: list[dict], universe_uid: str) -> list[dict]:
    """Apply resolved ops to a universe by editing it. Returns a log of what each op did."""
    log = []
    for i, op in enumerate(ops):
        log.append({"op": op["op"], **_PHYSICAL[op["op"]](db, g, op, f"{universe_uid}#{i}")})
    _rederive_bridges(db, g)
    return log


def _count(rows: list[dict]) -> int:
    return rows[0]["n"] if rows else 0


def _p_deprecate(db, g, op, stamp):
    s = op["service"]
    closed = _count(db.q(g, """MATCH (x:Service {uid: $s})-[r:DEPENDS_ON]->(b)
                              CREATE (x)-[:DEPENDS_ON_CLOSED {uid: r.uid, kind: r.kind}]->(b) DELETE r
                              RETURN count(*) AS n""", {"s": s}))
    db.q(g, "MATCH (:Team)-[r:OWNS]->(:Service {uid: $s}) DELETE r", {"s": s})
    db.q(g, "MATCH (:Person)-[r:KNOWS]->(:Service {uid: $s}) DELETE r", {"s": s})
    db.q(g, "MATCH (n:Service {uid: $s}) SET n:Retired REMOVE n:Service", {"s": s})
    return {"retired": s, "closed_dependencies": closed}


def _p_remove_person(db, g, op, stamp):
    p = op["person"]
    for rel in ("MEMBER_OF", "KNOWS", "WORKED_ON"):
        db.q(g, f"MATCH (:Person {{uid: $p}})-[r:{rel}]->() DELETE r", {"p": p})
    db.q(g, "MATCH (:Person {uid: $p})-[r:COLLABORATES|BRIDGES|CLOSE]-() DELETE r", {"p": p})
    db.q(g, "MATCH (n:Person {uid: $p}) SET n:Former REMOVE n:Person", {"p": p})
    return {"former": p}


def _p_move_person(db, g, op, stamp):
    db.q(g, "MATCH (:Person {uid: $p})-[r:MEMBER_OF]->() DELETE r", {"p": op["person"]})
    db.q(g, """MATCH (p:Person {uid: $p}), (t:Team {uid: $t})
               CREATE (p)-[:MEMBER_OF {uid: 'mem:' + substring($p, 7) + '->' + substring($t, 5) + '@' + $at, cost: 1.0}]->(t)""",
         {"p": op["person"], "t": op["team"], "at": stamp})
    return {"moved": op["person"]}


def _p_merge_teams(db, g, op, stamp):
    a, b = op["team"], op["into"]
    db.q(g, """MATCH (p:Person)-[r:MEMBER_OF]->(:Team {uid: $a}) MATCH (t:Team {uid: $b})
               CREATE (p)-[:MEMBER_OF {uid: 'mem:' + substring(p.uid, 7) + '->' + substring($b, 5) + '@' + $at, cost: 1.0}]->(t)
               DELETE r""", {"a": a, "b": b, "at": stamp})
    db.q(g, """MATCH (:Team {uid: $a})-[r:OWNS]->(s:Service) WHERE r.declared = true MATCH (t:Team {uid: $b})
               CREATE (t)-[:OWNS {uid: 'own:' + substring($b, 5) + '->' + substring(s.uid, 4) + '@' + $at, cost: 1.0,
                                   declared: true}]->(s)
               DELETE r""", {"a": a, "b": b, "at": stamp})
    db.q(g, "MATCH (:Team {uid: $a})-[r:OWNS]->() DELETE r", {"a": a})
    db.q(g, "MATCH (t:Team {uid: $a}) SET t:FormerTeam REMOVE t:Team", {"a": a})
    return {"merged": a}


def _p_reassign(db, g, op, stamp):
    db.q(g, "MATCH (:Team)-[r:OWNS]->(:Service {uid: $s}) WHERE r.declared = true DELETE r", {"s": op["service"]})
    db.q(g, "MATCH (t:Team {uid: $t})-[r:OWNS]->(:Service {uid: $s}) DELETE r", {"t": op["team"], "s": op["service"]})
    db.q(g, """MATCH (t:Team {uid: $t}), (s:Service {uid: $s})
               CREATE (t)-[:OWNS {uid: 'own:' + substring($t, 5) + '->' + substring($s, 4) + '@' + $at, cost: 1.0,
                                   declared: true}]->(s)""", {"t": op["team"], "s": op["service"], "at": stamp})
    return {"owner": op["team"]}


def _p_add_dep(db, g, op, stamp):
    db.q(g, """MATCH (a:Service {uid: $a}), (b:Service {uid: $b})
               MERGE (a)-[r:DEPENDS_ON]->(b)
               ON CREATE SET r.uid = 'dep:' + substring($a, 4) + '->' + substring($b, 4) + '@' + $at, r.cost = 1.0
               SET r.kind = $k, r.declared = true""",
         {"a": op["source"], "b": op["target"], "k": op.get("kind", "sync"), "at": stamp})
    return {"added": f"{op['source']}->{op['target']}"}


def _p_remove_dep(db, g, op, stamp):
    n = _count(db.q(g, """MATCH (a:Service {uid: $a})-[r:DEPENDS_ON]->(b:Service {uid: $b})
                         CREATE (a)-[:DEPENDS_ON_CLOSED {uid: r.uid, kind: r.kind}]->(b) DELETE r RETURN count(*) AS n""",
                    {"a": op["source"], "b": op["target"]}))
    return {"closed": n}


def _p_declare_dep(db, g, op, stamp):
    db.q(g, "MATCH (:Service {uid: $a})-[r:DEPENDS_ON]->(:Service {uid: $b}) SET r.declared = true",
         {"a": op["source"], "b": op["target"]})
    return {"declared": f"{op['source']}->{op['target']}"}


def _p_reverse(db, g, op, stamp):
    db.q(g, "MATCH (d:Decision {uid: $d}) SET d.status = 'reversed'", {"d": op["decision"]})
    return {"reversed": op["decision"]}


def _p_ticket(db, g, op, stamp):
    db.q(g, """MATCH (s:Service {uid: $s})
               CREATE (t:Source:Ticket {uid: 'tkt:new-' + $at, key: 'NEW', kind: 'task', title: $title, text: $title,
                                       priority: $p, status: 'open', proposed: true, body: $body})-[:ABOUT]->(s)""",
         {"s": op["service"], "title": op["title"], "p": op.get("priority", "P3"), "body": op.get("body", ""),
          "at": stamp.replace("#", "-")})
    return {"ticket": op["title"]}


_PHYSICAL = {"deprecate_service": _p_deprecate, "outage": _p_deprecate, "remove_person": _p_remove_person,
             "move_person": _p_move_person, "merge_teams": _p_merge_teams, "reassign_owner": _p_reassign,
             "add_dependency": _p_add_dep, "remove_dependency": _p_remove_dep, "declare_dependency": _p_declare_dep,
             "reverse_decision": _p_reverse, "create_ticket": _p_ticket}


# ---------------------------------------------------------------- temporal: replay into the org graph

def apply_temporal(db: dbm.DB, g: str, op: dict, at: str, source: str) -> list[str]:
    """Replay one op into the org graph at `at`; new facts point at `source` (a Decision or a message).
    Returns the uids of the facts it closed."""
    if not OPS[op["op"]].mergeable:
        raise ResolveError(f"'{op['op']}' is a what-if only; it can't be merged")
    return _TEMPORAL[op["op"]](db, g, op, at, source) or []


def _close(db, g, match: str, params: dict, at: str, source: str) -> list[str]:
    rows = db.q(g, f"""{match} WHERE r.valid_to = '{OPEN}' AND r.valid_from <= $at
                       SET r.valid_to = $at, r.closed_by = $src RETURN r.uid AS uid""",
                params | {"at": at, "src": source})
    return [r["uid"] for r in rows]


def _open(db, g, rel: str, a: str, b: str, alabel: str, blabel: str, prefix: str, at: str, source: str,
          props: dict | None = None) -> str | None:
    held = db.q(g, f"""MATCH (:{alabel} {{uid: $a}})-[o:{rel}]->(:{blabel} {{uid: $b}})
                       WHERE o.valid_to = '{OPEN}' RETURN count(o) AS n""", {"a": a, "b": b})
    if held and held[0]["n"]:
        return None
    uid = f"{prefix}:{a.split(':', 1)[1]}->{b.split(':', 1)[1]}@{at}"
    db.q(g, f"""MATCH (x:{alabel} {{uid: $a}}), (y:{blabel} {{uid: $b}})
                CREATE (x)-[r:{rel}]->(y)
                SET r += $props, r.uid = $uid, r.valid_from = $at, r.valid_to = '{OPEN}', r.recorded_at = $at,
                    r.src = $src""",
         {"a": a, "b": b, "at": at, "src": source, "uid": uid, "props": props or {}})
    return uid


def _t_deprecate(db, g, op, at, src):
    s = op["service"]
    closed = _close(db, g, "MATCH (:Service {uid: $s})-[r:DEPENDS_ON]->()", {"s": s}, at, src)
    closed += _close(db, g, "MATCH (:Team)-[r:OWNS]->(:Service {uid: $s})", {"s": s}, at, src)
    db.q(g, "MATCH (n:Service {uid: $s}) SET n.retired = $at, n.retired_by = $src", {"s": s, "at": at, "src": src})
    return closed


def _t_remove_person(db, g, op, at, src):
    p = op["person"]
    closed = _close(db, g, "MATCH (:Person {uid: $p})-[r:MEMBER_OF|WORKED_ON]->()", {"p": p}, at, src)
    db.q(g, "MATCH (n:Person {uid: $p}) SET n.left = $at, n.left_by = $src", {"p": p, "at": at, "src": src})
    return closed


def _t_move_person(db, g, op, at, src):
    closed = _close(db, g, "MATCH (:Person {uid: $p})-[r:MEMBER_OF]->()", {"p": op["person"]}, at, src)
    _open(db, g, "MEMBER_OF", op["person"], op["team"], "Person", "Team", "mem", at, src)
    return closed


def _t_merge_teams(db, g, op, at, src):
    a, b = op["team"], op["into"]
    people = db.q(g, f"""MATCH (p:Person)-[r:MEMBER_OF]->(:Team {{uid: $a}})
                        WHERE r.valid_to = '{OPEN}' AND r.valid_from <= $at RETURN p.uid AS p""", {"a": a, "at": at})
    services = db.q(g, f"""MATCH (:Team {{uid: $a}})-[r:OWNS]->(s:Service)
                          WHERE r.valid_to = '{OPEN}' AND r.valid_from <= $at RETURN s.uid AS s""", {"a": a, "at": at})
    closed = _close(db, g, "MATCH (:Person)-[r:MEMBER_OF]->(:Team {uid: $a})", {"a": a}, at, src)
    closed += _close(db, g, "MATCH (:Team {uid: $a})-[r:OWNS]->()", {"a": a}, at, src)
    for r in people:
        _open(db, g, "MEMBER_OF", r["p"], b, "Person", "Team", "mem", at, src)
    for r in services:
        _open(db, g, "OWNS", b, r["s"], "Team", "Service", "own", at, src, {"declared": True})
    db.q(g, "MATCH (t:Team {uid: $a}) SET t.dissolved = $at, t.dissolved_by = $src", {"a": a, "at": at, "src": src})
    return closed


def _t_reassign(db, g, op, at, src):
    closed = _close(db, g, "MATCH (:Team)-[r:OWNS]->(:Service {uid: $s})", {"s": op["service"]}, at, src)
    _open(db, g, "OWNS", op["team"], op["service"], "Team", "Service", "own", at, src, {"declared": True})
    return closed


def _t_add_dep(db, g, op, at, src):
    kind = op.get("kind", "sync")
    cur = db.q(g, f"""MATCH (:Service {{uid: $a}})-[r:DEPENDS_ON]->(:Service {{uid: $b}})
                     WHERE r.valid_to = '{OPEN}' RETURN r.kind AS kind, r.declared AS declared""",
               {"a": op["source"], "b": op["target"]})
    if cur and cur[0]["kind"] == kind:
        if not cur[0]["declared"]:
            _t_declare(db, g, op, at, src)
        return []
    closed = _close(db, g, "MATCH (:Service {uid: $a})-[r:DEPENDS_ON]->(:Service {uid: $b})",
                    {"a": op["source"], "b": op["target"]}, at, src)
    _open(db, g, "DEPENDS_ON", op["source"], op["target"], "Service", "Service", "dep", at, src,
          {"kind": kind, "declared": True})
    return closed


def _t_remove_dep(db, g, op, at, src):
    return _close(db, g, "MATCH (:Service {uid: $a})-[r:DEPENDS_ON]->(:Service {uid: $b})",
                  {"a": op["source"], "b": op["target"]}, at, src)


def _t_declare(db, g, op, at, src):
    db.q(g, f"""MATCH (:Service {{uid: $a}})-[r:DEPENDS_ON]->(:Service {{uid: $b}}) WHERE r.valid_to = '{OPEN}'
                SET r.declared = true, r.declared_at = $at, r.declared_by = $src""",
         {"a": op["source"], "b": op["target"], "at": at, "src": src})
    return []


def _t_reverse(db, g, op, at, src):
    db.q(g, "MATCH (d:Decision {uid: $d}) SET d.status = 'reversed', d.reversed_at = $at, d.reversed_by = $src",
         {"d": op["decision"], "at": at, "src": src})
    db.q(g, "MATCH (n:Decision {uid: $src}), (d:Decision {uid: $d}) MERGE (n)-[:SUPERSEDES {how: 'reverses', at: $at}]->(d)",
         {"d": op["decision"], "src": src, "at": at})
    return []


def _t_ticket(db, g, op, at, src):
    n = db.one(g, "MATCH (t:Ticket) WHERE t.key STARTS WITH 'ORN-' RETURN count(t) AS n")["n"] + 1
    db.q(g, """MATCH (s:Service {uid: $s})
               CREATE (t:Source:Ticket {uid: $uid, key: $key, kind: 'task', title: $title, text: $title, priority: $p,
                                       status: 'open', at: $at, opened: $at, closed: '9999-12-31', body: $body,
                                       src: $src})-[:ABOUT]->(s)""",
         {"s": op["service"], "uid": f"tkt:orn-{n}", "key": f"ORN-{n}", "title": op["title"],
          "p": op.get("priority", "P3"), "body": op.get("body", ""), "at": at, "src": src})
    return []


_TEMPORAL = {"deprecate_service": _t_deprecate, "remove_person": _t_remove_person, "move_person": _t_move_person,
             "merge_teams": _t_merge_teams, "reassign_owner": _t_reassign, "add_dependency": _t_add_dep,
             "remove_dependency": _t_remove_dep, "declare_dependency": _t_declare, "reverse_decision": _t_reverse,
             "create_ticket": _t_ticket}
