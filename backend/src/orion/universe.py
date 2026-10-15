"""Universes: fork the company, change it, see what happens, and make it real only when the right people agree.

    fork     GRAPH.COPY epoch:<t>:now -> universe:<t>:<id>, then apply the ops physically
    diff     the same Cypher and algorithms in both graphs: what breaks and how badly, who is exposed, what nobody
             would know any more, what loses every path to a team, which collaboration groups split, which
             bottlenecks move; plus a risk score that is a sum of named terms
    approve  every team the diff says is affected has to approve; a stale universe is rebased first
    merge    the ops replay into the org graph as closed and opened facts, with a Decision as their source
    discard  drop the universe graph, keep the record

The registry, approvals and findings' index live in the deck graph, which every agent and every user shares.
"""

from __future__ import annotations

import json
import time
from collections import defaultdict

from orion import algos, impact
from orion import db as dbm
from orion import epoch as ep
from orion import ops as opsm

# ---------------------------------------------------------------- risk weights
# Points per term. Tiers come from the catalog: tier 1 is customer-facing and paged, tier 3 internal.
BREAK_POINTS = {1: 25, 2: 12, 3: 5}
EFFECT_SCALE = {"break": 1.0, "degrade": 0.5, "stale": 0.25}
CUSTOMER_POINTS = {"enterprise": 6, "growth": 3, "starter": 1}
ORPHAN_POINTS = {1: 22, 2: 12, 3: 6}
STRANDED_POINTS = 12
SPLIT_POINTS = 10
BOTTLENECK_POINTS = 6
LEVELS = [(0, "clear"), (1, "watch"), (35, "danger")]


def level(score: int) -> str:
    out = "clear"
    for lo, name in LEVELS:
        if score >= lo:
            out = name
    return out


# ---------------------------------------------------------------- the deck graph

def _deck(db: dbm.DB, t: str) -> str:
    g = dbm.deck(t)
    if not db.exists(g):
        db.q(g, "CREATE INDEX FOR (u:Universe) ON (u.uid)")
        db.q(g, "CREATE INDEX FOR (a:Approval) ON (a.universe)")
    return g


def who(db: dbm.DB, t: str, user: str) -> dict:
    """A person and the team they are on now."""
    row = db.one(ep.now(db, t), """MATCH (p:Person {uid: $u}) OPTIONAL MATCH (p)-[:MEMBER_OF]->(t:Team)
                                    RETURN p.uid AS uid, p.name AS name, p.role AS role, t.uid AS team, t.name AS team_name""",
                 {"u": user})
    if not row:
        raise PermissionError(f"{user} is not a current member of the company")
    return row


# ---------------------------------------------------------------- fork

def fork(db: dbm.DB, t: str, ops: list[dict], *, by: str, kind: str = "whatif", title: str | None = None,
         uid: str | None = None, question: str | None = None, on: str | None = None, mode: str = "true") -> dict:
    """Copy the company as it is now (or as it was on `on`, as it really was or as it was known) and apply the ops,
    then diff. `uid` makes a retried fork rebuild the same universe. A fork of the past is a backtest: it can't
    be merged."""
    t0 = time.perf_counter()
    base = ep.ensure(db, t, on, mode) if on else ep.now(db, t)
    if on:
        kind = "backtest"
    res = opsm.resolver(db, base)
    ops = [opsm.resolve(db, base, op, res) for op in ops]
    if not ops:
        raise opsm.OpError("a universe needs at least one change")
    opsm.check_sequence(ops)
    uid = uid or f"u{db.incr(f'orion:{t}:universe_seq')}"
    graph = dbm.universe(t, uid)
    db.copy(base, graph)
    copied = time.perf_counter()
    try:
        opsm.apply_physical(db, graph, ops, dbm.clock(db, t))
    except Exception:
        db.delete(graph)
        raise
    d = diff(db, t, base, graph, ops)
    title = title or "; ".join(opsm.title(db, base, o) for o in ops)
    if any(not opsm.OPS[o["op"]].mergeable for o in ops):
        kind = "outage"
    rec = {
        "uid": uid, "graph": graph, "kind": kind, "title": title, "ops": ops, "by": by, "question": question,
        "created_at": dbm.clock(db, t), "base_version": dbm.version(db, t), "status": "open",
        "on": on, "mode": mode if on else None,
        "risk": d["risk"]["score"], "level": d["risk"]["level"],
        "ms": {"copy": round((copied - t0) * 1000, 1), "total": round((time.perf_counter() - t0) * 1000, 1)},
    }
    _save(db, t, rec, d)
    _finding(db, t, rec, d)
    return rec | {"diff": d}


def replay(db: dbm.DB, t: str, ops: list[dict]) -> dict:
    """The diff the same ops would give on today's company, on a throwaway copy: no record, no finding."""
    import secrets

    base = ep.now(db, t)
    graph = dbm.universe(t, "replay-" + secrets.token_hex(4))
    db.copy(base, graph)
    try:
        opsm.apply_physical(db, graph, ops, dbm.clock(db, t))
        return diff(db, t, base, graph, ops)
    finally:
        db.delete(graph)


def _save(db: dbm.DB, t: str, rec: dict, d: dict) -> None:
    g = _deck(db, t)
    db.q(g, """MERGE (u:Universe {uid: $uid})
               SET u.graph = $graph, u.kind = $kind, u.title = $title, u.ops = $ops, u.by = $by, u.question = $question,
                   u.created_at = $created_at, u.base_version = $base_version, u.status = $status, u.risk = $risk,
                   u.level = $level, u.diff = $diff, u.ms = $ms, u.required = $required, u.on = $on, u.mode = $mode""",
         rec | {"ops": json.dumps(rec["ops"]), "diff": json.dumps(d), "ms": json.dumps(rec["ms"]),
                "required": [r["team"] for r in d["approvals"]]})


def _finding(db: dbm.DB, t: str, rec: dict, d: dict) -> None:
    """Leave what was learned in the org graph, attached to the entities it is about, so the next question about
    any of them (from any person or agent) starts from it."""
    about = {o[k] for o in rec["ops"] for k in o if k != "op" and isinstance(o[k], str) and ":" in o[k]}
    about |= {b["uid"] for b in d["breaks"]}
    summary = d["summary"]
    db.q(dbm.org(t), """CREATE (f:Finding {uid: $uid, universe: $u, title: $title, risk: $risk, level: $level,
                                         at: $at, summary: $summary, ops: $ops, by: $by})
                        WITH f UNWIND $about AS a MATCH (n {uid: a}) CREATE (f)-[:ABOUT]->(n)""",
         {"uid": "finding:" + rec["uid"], "u": rec["uid"], "title": rec["title"], "risk": rec["risk"],
          "level": rec["level"], "at": rec["created_at"], "summary": summary, "ops": json.dumps(rec["ops"]),
          "by": rec["by"], "about": sorted(about)})


# ---------------------------------------------------------------- diff

def _dangling(db: dbm.DB, g: str) -> list[dict]:
    """Running services that still depend on something switched off."""
    return db.ro(g, """MATCH (d:Service)-[r:DEPENDS_ON]->(s:Retired)
                       RETURN d.uid AS dependent, d.name AS dependent_name, s.uid AS on, s.name AS on_name,
                              r.kind AS kind, r.uid AS fact ORDER BY dependent""")


def _services(db: dbm.DB, g: str) -> dict[str, dict]:
    return {r["uid"]: r for r in db.ro(g, """MATCH (s:Service) OPTIONAL MATCH (t:Team)-[:OWNS]->(s)
                                             RETURN s.uid AS uid, s.name AS name, s.tier AS tier, t.uid AS owner,
                                                    t.name AS owner_name""")}


def _orphans(db: dbm.DB, g: str) -> set[str]:
    return {r["uid"] for r in db.ro(g, "MATCH (s:Service) WHERE NOT ()-[:KNOWS]->(s) RETURN s.uid AS uid")}


def _edges(db: dbm.DB, g: str) -> set[tuple]:
    rows = db.ro(g, """MATCH (a)-[r:DEPENDS_ON|OWNS|MEMBER_OF]->(b) WHERE NOT b:Retired
                       RETURN type(r) AS rel, a.uid AS a, b.uid AS b, r.kind AS kind""")
    return {(r["rel"], r["a"], r["b"], r["kind"]) for r in rows}


def diff(db: dbm.DB, t: str, base: str, uni: str, ops: list[dict]) -> dict:
    t0 = time.perf_counter()
    sb, su = _services(db, base), _services(db, uni)
    retired = sorted(set(sb) - set(su))
    dangling = _dangling(db, uni)
    roots = sorted({r["on"] for r in dangling})
    before = impact.walk(db, base, sorted({r["on"] for r in _dangling(db, base)}))
    after = impact.walk(db, uni, roots)
    breaks = []
    for uid, b in after.items():
        prev = before.get(uid)
        if prev and impact.SEVERITY[prev["effect"]] >= impact.SEVERITY[b["effect"]]:
            continue
        info = sb.get(uid, {})
        breaks.append(b | {"owner": info.get("owner"), "owner_name": info.get("owner_name")})
    breaks.sort(key=lambda b: (-impact.SEVERITY[b["effect"]], b["depth"], b["tier"], b["name"]))
    names = impact.names(db, base, {u for b in breaks for u in b["path"]} | set(retired))
    for b in breaks:
        b["path_names"] = [names.get(u, u) for u in b["path"]]

    # who is exposed: customers using something that breaks (or degrades within two hops), and customers who raised
    # a ticket in the past year about a service that would break
    felt = {b["uid"]: b["effect"] for b in breaks if b["effect"] == "break" or b["depth"] <= 2}
    felt |= {r: "break" for r in retired}
    broken = [b["uid"] for b in breaks if b["effect"] == "break"]
    hit = felt | {u: "break" for u in broken}
    since = _year_before(dbm.clock(db, t) if base == dbm.epoch(t) else _base_date(db, base))
    cust_rows = db.ro(base, """MATCH (c:Customer)-[:USES]->(s:Service) WHERE s.uid IN $u
                               RETURN c.uid AS uid, c.name AS name, c.tier AS tier, s.uid AS via, null AS ticket
                               UNION
                               MATCH (c:Customer)<-[:RAISED_BY]-(k:Ticket)-[:ABOUT]->(s:Service)
                               WHERE s.uid IN $b AND k.at >= $since
                               RETURN c.uid AS uid, c.name AS name, c.tier AS tier, s.uid AS via, k.key AS ticket""",
                      {"u": list(felt), "b": broken, "since": since})
    customers: dict[str, dict] = {}
    for r in cust_rows:
        c = customers.setdefault(r["uid"], {"uid": r["uid"], "name": r["name"], "tier": r["tier"], "via": set(),
                                            "tickets": set(), "effect": "stale"})
        c["via"].add(r["via"])
        if r["ticket"]:
            c["tickets"].add(r["ticket"])
        if impact.SEVERITY[hit[r["via"]]] > impact.SEVERITY[c["effect"]]:
            c["effect"] = hit[r["via"]]
    customers_out = sorted(({**c, "via": sorted(names.get(v, v) for v in c["via"]), "tickets": sorted(c["tickets"])}
                            for c in customers.values()),
                           key=lambda c: (-impact.SEVERITY[c["effect"]], ["enterprise", "growth", "starter"].index(c["tier"]), c["name"]))

    orphans = sorted(_orphans(db, uni) - _orphans(db, base) - set(retired))
    orphan_rows = [{"uid": u, "name": su[u]["name"], "tier": su[u]["tier"], "owner_name": su[u]["owner_name"],
                    "knew": [r["name"] for r in db.ro(base, "MATCH (p:Person)-[:KNOWS]->(:Service {uid: $s}) RETURN p.name AS name",
                                                      {"s": u})]}
                   for u in orphans if u in su]

    stranded_before = {tuple(s["uid"] for s in c["services"]) for c in algos.stranded(db, base)}
    stranded = [c for c in algos.stranded(db, uni) if tuple(s["uid"] for s in c["services"]) not in stranded_before]

    gone = {r["uid"] for r in db.ro(uni, "MATCH (p:Former) RETURN p.uid AS uid")}
    groups_after = algos.collab_groups(db, uni)
    where = {p: i for i, grp in enumerate(groups_after) for p in grp}
    splits = []
    for grp in algos.collab_groups(db, base):
        left = [p for p in grp if p not in gone]
        parts = {where.get(p, ("alone", p)) for p in left}
        if len(left) > 1 and len(parts) > 1:
            splits.append({"before": len(grp), "parts": len(parts), "people": left})

    top_before = algos.bottlenecks(db, base)
    top_after = algos.bottlenecks(db, uni)
    shifted = {p["uid"] for p in top_before} != {p["uid"] for p in top_after}

    # what changed in the graph itself
    eb, eu = _edges(db, base), _edges(db, uni)
    changed = {"removed": sorted(eb - eu), "added": sorted(eu - eb)}

    # who has to approve: the teams that own what changes, breaks or loses its last expert
    need: dict[str, set[str]] = defaultdict(set)

    def owner_of(svc: str, why: str):
        o = sb.get(svc, {}).get("owner")
        if o:
            need[o].add(why)

    for r in retired:
        owner_of(r, f"owns {sb[r]['name']}")
    for b in breaks:
        if b["effect"] in ("break", "degrade"):
            owner_of(b["uid"], f"{b['name']} would {'break' if b['effect'] == 'break' else 'degrade'}")
    for o in orphan_rows:
        owner_of(o["uid"], f"nobody would know {o['name']}")
    for op in ops:
        if op["op"] in ("move_ownership",):
            owner_of(op["service"], "gives up " + sb[op["service"]]["name"])
            need[op["team"]].add("takes over " + sb[op["service"]]["name"])
        if op["op"] in ("add_dependency", "remove_dependency"):
            owner_of(op["service"], f"owns {sb[op['service']]['name']}")
        if op["op"] == "merge_teams":
            need[op["team"]].add("is merged away")
            need[op["into"]].add("absorbs a team")
        if op["op"] == "remove_person":
            row = db.one(base, "MATCH (:Person {uid: $p})-[:MEMBER_OF]->(t:Team) RETURN t.uid AS t", {"p": op["person"]})
            if row:
                need[row["t"]].add("loses a member")
    team_names = {r["uid"]: r["name"] for r in db.ro(base, "MATCH (t:Team) RETURN t.uid AS uid, t.name AS name")}
    approvals = [{"team": k, "team_name": team_names.get(k, k), "why": sorted(v)} for k, v in sorted(need.items())]

    risk = score(breaks, customers_out, orphan_rows, stranded, splits, shifted, top_before, top_after)
    summary = _summary(retired, sb, breaks, customers_out, orphan_rows, risk)
    return {"retired": [{"uid": r, "name": sb[r]["name"], "tier": sb[r]["tier"]} for r in retired],
            "breaks": breaks, "customers": customers_out, "orphans": orphan_rows, "stranded": stranded,
            "splits": splits, "bottlenecks": {"before": top_before, "after": top_after, "shifted": shifted},
            "dangling": dangling, "changed": changed, "approvals": approvals, "risk": risk, "summary": summary,
            "ms": round((time.perf_counter() - t0) * 1000, 1)}


def score(breaks, customers, orphans, stranded, splits, shifted, top_before, top_after) -> dict:
    terms = []
    for b in breaks:
        pts = BREAK_POINTS[b["tier"]] * EFFECT_SCALE[b["effect"]] / b["depth"]
        terms.append({"term": "breaks", "entity": b["uid"], "points": round(pts, 1),
                      "label": f"{b['name']} {_verb(b['effect'])} (tier {b['tier']}, {b['depth']} hop{'s' if b['depth'] > 1 else ''})"})
    for c in customers:
        pts = CUSTOMER_POINTS[c["tier"]] * EFFECT_SCALE[c["effect"]]
        terms.append({"term": "customer", "entity": c["uid"], "points": round(pts, 1),
                      "label": f"{c['name']} ({c['tier']}) exposed through {', '.join(c['via'])}"})
    for o in orphans:
        terms.append({"term": "orphan", "entity": o["uid"], "points": ORPHAN_POINTS[o["tier"]],
                      "label": f"nobody would know {o['name']}"})
    for s in stranded:
        terms.append({"term": "stranded", "entity": s["services"][0]["uid"], "points": STRANDED_POINTS,
                      "label": "lose every path to a team: " + ", ".join(x["name"] for x in s["services"])})
    for s in splits:
        terms.append({"term": "split", "entity": None, "points": SPLIT_POINTS,
                      "label": f"a group of {s['before']} who work together falls into {s['parts']}"})
    if shifted:
        terms.append({"term": "bottleneck", "entity": None, "points": BOTTLENECK_POINTS,
                      "label": "the people everything flows through change"})
    total = min(100, round(sum(t["points"] for t in terms)))
    return {"score": total, "level": level(total), "terms": sorted(terms, key=lambda t: -t["points"])}


def _verb(effect: str) -> str:
    return {"break": "breaks", "degrade": "degrades", "stale": "goes stale"}[effect]


def _summary(retired, sb, breaks, customers, orphans, risk) -> str:
    parts = []
    if retired:
        parts.append("without " + ", ".join(sb[r]["name"] for r in retired))
    hard = [b["name"] for b in breaks if b["effect"] == "break"]
    soft = [b["name"] for b in breaks if b["effect"] != "break"]
    if hard:
        parts.append("breaks " + ", ".join(hard))
    if soft:
        parts.append("degrades " + ", ".join(soft))
    if customers:
        parts.append(f"{len(customers)} customer{'s' if len(customers) != 1 else ''} exposed")
    if orphans:
        parts.append("nobody would know " + ", ".join(o["name"] for o in orphans))
    if not parts:
        parts.append("nothing breaks")
    return f"risk {risk['score']} ({risk['level']}): " + "; ".join(parts)


def _base_date(db: dbm.DB, g: str) -> str:
    row = db.one(g, "MATCH (c:Company) RETURN c.on AS on")
    return row["on"] if row and row["on"] else "2026-10-01"


def _year_before(now: str) -> str:
    return f"{int(now[:4]) - 1}{now[4:10]}"


# ---------------------------------------------------------------- registry

def get(db: dbm.DB, t: str, uid: str) -> dict | None:
    row = db.one(_deck(db, t), "MATCH (u:Universe {uid: $u}) RETURN u", {"u": uid})
    if not row:
        return None
    u = row["u"]
    approvals = db.ro(_deck(db, t), """MATCH (a:Approval {universe: $u}) RETURN a.team AS team, a.by AS by,
                                       a.by_name AS by_name, a.at AS at ORDER BY a.at""", {"u": uid})
    return {k: v for k, v in u.items() if k not in ("diff", "ops", "ms", "_labels")} | {
        "ops": json.loads(u["ops"]), "diff": json.loads(u["diff"]), "ms": json.loads(u.get("ms") or "{}"),
        "approvals": approvals, "required": u.get("required") or []}


def listing(db: dbm.DB, t: str, limit: int = 50) -> list[dict]:
    rows = db.ro(_deck(db, t), """MATCH (u:Universe) RETURN u.uid AS uid, u.title AS title, u.kind AS kind,
                                  u.status AS status, u.risk AS risk, u.level AS level, u.by AS by,
                                  u.created_at AS created_at, u.required AS required
                                  ORDER BY u.created_at DESC, u.uid DESC LIMIT $n""", {"n": limit})
    return rows


def discard(db: dbm.DB, t: str, uid: str, by: str) -> dict:
    rec = get(db, t, uid)
    if not rec:
        raise KeyError(uid)
    if rec["status"] != "open":
        raise ValueError(f"universe {uid} is {rec['status']}; only an open universe can be discarded")
    db.delete(rec["graph"])
    db.q(_deck(db, t), "MATCH (u:Universe {uid: $u}) SET u.status = 'discarded', u.closed_by = $by, u.closed_at = $at",
         {"u": uid, "by": by, "at": dbm.clock(db, t)})
    return get(db, t, uid)


# ---------------------------------------------------------------- approve, rebase, merge

def stale(db: dbm.DB, t: str, rec: dict) -> bool:
    return rec["base_version"] != dbm.version(db, t)


def rebase(db: dbm.DB, t: str, uid: str) -> dict:
    """The company changed since this universe was forked: fork again from now with the same ops and the same
    uid, and report how the diff moved. Approvals given against the old diff are dropped."""
    rec = get(db, t, uid)
    old_risk, old_summary = rec["risk"], rec["diff"]["summary"]
    if rec.get("on"):
        raise ValueError("a backtest is pinned to its date; it can't be rebased")
    try:
        fresh = fork(db, t, rec["ops"], by=rec["by"], kind=rec["kind"], title=rec["title"], uid=uid,
                     question=rec.get("question"))
    except opsm.OpError as e:
        # the company moved on under this plan (what it changes is already gone): close it, keep the record
        db.delete(rec["graph"])
        db.q(_deck(db, t), "MATCH (u:Universe {uid: $u}) SET u.status = 'obsolete', u.closed_at = $at, u.reason = $r",
             {"u": uid, "at": dbm.clock(db, t), "r": str(e)})
        return get(db, t, uid) | {"result": "obsolete", "message": f"This plan no longer applies to the company: {e}"}
    db.q(_deck(db, t), "MATCH (a:Approval {universe: $u}) DELETE a", {"u": uid})
    db.q(_deck(db, t), "MATCH (u:Universe {uid: $u}) SET u.rebased_from = $r, u.rebased_summary = $s",
         {"u": uid, "r": old_risk, "s": old_summary})
    return get(db, t, uid) | {"rebased": {"from": old_risk, "to": fresh["risk"], "before": old_summary}}


def approve(db: dbm.DB, t: str, uid: str, user: str, *, force: bool = False) -> dict:
    """Record an approval for the approver's team. When every required team has approved, merge. A universe that
    would leave running services depending on something switched off is refused unless forced."""
    me = who(db, t, user)
    with db.lock(f"universe:{t}:{uid}", ttl=120):
        rec = get(db, t, uid)
        if not rec:
            raise KeyError(uid)
        if rec["status"] != "open":
            raise ValueError(f"universe {uid} is {rec['status']}")
        if rec["kind"] in ("outage", "backtest"):
            raise ValueError(f"a{'n' if rec['kind'] == 'outage' else ''} {rec['kind']} is a what-if; there is nothing to merge")
        if stale(db, t, rec):
            out = rebase(db, t, uid)
            if out.get("result") == "obsolete":
                return out
            return out | {"result": "rebased", "message": f"The company changed since this was forked. Rebased: risk "
                                                          f"{out['rebased']['from']} -> {out['rebased']['to']}. Approve again."}
        required = rec["required"]
        if me["team"] not in required:
            raise PermissionError(f"{me['team_name']} isn't one of the teams this change needs "
                                  f"({', '.join(a['team_name'] for a in rec['diff']['approvals'])})")
        if not any(a["team"] == me["team"] for a in rec["approvals"]):
            db.q(_deck(db, t), """CREATE (:Approval {universe: $u, team: $team, by: $by, by_name: $name, at: $at})""",
                 {"u": uid, "team": me["team"], "by": me["uid"], "name": me["name"], "at": dbm.clock(db, t)})
        rec = get(db, t, uid)
        missing = [a for a in rec["diff"]["approvals"] if a["team"] not in {x["team"] for x in rec["approvals"]}]
        if missing:
            return rec | {"result": "approved", "waiting_for": missing}
        if rec["diff"]["dangling"] and not force:
            return rec | {"result": "blocked", "message": "Every team approved, but running services would still depend "
                                                          "on something switched off: " + ", ".join(
                f"{d['dependent_name']} -> {d['on_name']}" for d in rec["diff"]["dangling"])}
        return merge(db, t, rec, me, forced=bool(rec["diff"]["dangling"]))


def merge(db: dbm.DB, t: str, rec: dict, me: dict, forced: bool = False) -> dict:
    """Replay the ops into the org graph as facts with a Decision as their source. Resumable: the index of the
    last applied op is stored, so a merge that fails partway continues where it stopped and never applies an op
    twice."""
    g, deck = dbm.org(t), _deck(db, t)
    row = db.one(deck, "MATCH (u:Universe {uid: $u}) RETURN u.status AS s, u.applied AS applied, u.decision AS dec",
                 {"u": rec["uid"]})
    if row["s"] == "open":
        db.q(deck, "MATCH (u:Universe {uid: $u}) WHERE u.status = 'open' SET u.status = 'merging', u.applied = 0",
             {"u": rec["uid"]})
        row = {"s": "merging", "applied": 0, "dec": None}
    if row["s"] != "merging":
        raise ValueError(f"universe {rec['uid']} is {row['s']}")
    at = dbm.tick(db, t)
    dec = row["dec"] or f"dec:{rec['uid']}"
    if not row["dec"]:
        affects = sorted({o[k] for o in rec["ops"] for k in ("service", "replacement", "on") if o.get(k)})
        db.q(g, """MERGE (d:Decision {uid: $uid})
                   ON CREATE SET d.key = $key, d.title = $title, d.status = 'accepted', d.at = $at, d.day = $day,
                                 d.summary = $summary, d.universe = $u, d.forced = $forced
                   WITH d UNWIND $approvers AS a MATCH (p:Person {uid: a}) MERGE (d)-[:DECIDED_BY]->(p)""",
             {"uid": dec, "key": f"ORN-{rec['uid'][1:]}", "title": rec["title"], "at": at,
              "day": _day(at), "summary": rec["diff"]["summary"], "u": rec["uid"], "forced": forced,
              "approvers": [a["by"] for a in rec["approvals"]] + [me["uid"]]})
        db.q(g, "MATCH (d:Decision {uid: $d}) UNWIND $s AS s MATCH (x:Service {uid: s}) MERGE (d)-[:AFFECTS]->(x)",
             {"d": dec, "s": affects})
        db.q(g, "MATCH (d:Decision {uid: $d}) UNWIND $t AS t MATCH (x:Team {uid: t}) MERGE (d)-[:MADE_BY]->(x)",
             {"d": dec, "t": rec["required"]})
        db.q(deck, "MATCH (u:Universe {uid: $u}) SET u.decision = $d", {"u": rec["uid"], "d": dec})
    for i, op in enumerate(rec["ops"]):
        if i < (row["applied"] or 0):
            continue
        opsm.apply_temporal(db, g, op, at, dec)
        db.q(deck, "MATCH (u:Universe {uid: $u}) SET u.applied = $i", {"u": rec["uid"], "i": i + 1})
    dbm.bump(db, t)
    db.q(deck, """MATCH (u:Universe {uid: $u}) SET u.status = 'merged', u.merged_at = $at, u.merged_by = $by""",
         {"u": rec["uid"], "at": at, "by": me["uid"]})
    db.delete(rec["graph"])
    from orion import watch

    rechecked = watch.after_change(db, t, _touched(rec), cause=dec)
    return get(db, t, rec["uid"]) | {"result": "merged", "decision": dec, "rechecked": rechecked}


def _touched(rec: dict) -> list[str]:
    out = {o[k] for o in rec["ops"] for k in o if k != "op" and isinstance(o[k], str) and ":" in o[k]}
    out |= {b["uid"] for b in rec["diff"]["breaks"]}
    return sorted(out)


def _day(at: str) -> int:
    from orion.world.corvane import day_index

    return day_index(at)
