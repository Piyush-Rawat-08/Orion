"""Universes: fork the company, change it, see what happens, and make it real only when the right people agree.

    fork     GRAPH.COPY of epoch:<t>:now (or of the company on a past date) -> universe:<t>:<id>; ops applied in place
    diff     the same traversal, queries and algorithms in the universe and its base: what breaks and how badly,
             which customers would notice, what nobody would know any more, what loses every path to a team, which
             groups of people fall apart, whose central role moves; a risk score that is a sum of named terms; and
             the teams that have to agree, derived from the diff
    approve  one approval per required team; a stale base is rebased first; a merge that would leave running
             services relying on something switched off is blocked unless forced
    merge    the ops replay into the org graph as closed and opened facts, with a Decision as their source
    discard  reject an open universe; the record and its ops stay

The registry (:Universe), approvals and risk terms live in the deck graph.
"""

from __future__ import annotations

import json
import secrets
import time
from datetime import date as _date
from datetime import timedelta

from orion import db as dbm
from orion import epoch as ep
from orion import impact
from orion import ops as opsm
from orion.queries import cypher

TIER_POINTS = {1: 30, 2: 15, 3: 6}
EFFECT_WEIGHT = {"break": 1.0, "degrade": 0.5, "stale": 0.33}
TIER_WORD = {1: "business-critical", 2: "important", 3: "supporting"}
EFFECT_WORD = {"break": "stop working", "degrade": "slow down or partly fail", "stale": "run on out-of-date data"}
FAR_HOP_FACTOR = 0.5
CUSTOMER_POINTS = {"enterprise": 8, "growth": 4, "starter": 2}
ORPHAN_POINTS = {1: 20, 2: 12, 3: 12}
STRANDED_POINTS = 15
SPLIT_POINTS = 15
BOTTLENECK_POINTS = 8
CUSTOMER_WINDOW_DAYS = 365
MEDIUM_FROM, HIGH_FROM = 1, 40
DETAIL = 200
DECIDABLE = ("open", "merge_failed")


class Busy(ValueError):
    pass


class MergeBlocked(ValueError):
    def __init__(self, message: str, detail: dict):
        super().__init__(message)
        self.detail = detail


def deck(db: dbm.DB, t: str) -> str:
    g = dbm.deck(t)
    if not db.exists(g):
        db.q(g, "CREATE INDEX FOR (u:Universe) ON (u.uid)")
    return g


_deck = deck


# ---------------------------------------------------------------- fork

def next_uid(db: dbm.DB, t: str) -> str:
    return f"u{db.incr(f'orion:{t}:universe_seq')}"


def fork(db: dbm.DB, t: str, ops: list[dict], kind: str = "whatif", title: str | None = None,
         created_by: str = "cli", uid: str | None = None, task: str | None = None, rebased_from: str | None = None,
         asof: str | None = None, known: bool = True, diff_now: bool = True) -> dict:
    """Copy the company (now, or as it was on `asof`) and apply the ops. `uid` makes a retried fork idempotent."""
    if uid:
        done = db.one(deck(db, t), "MATCH (u:Universe {uid: $u}) RETURN properties(u) AS u", {"u": uid})
        if done and done["u"].get("diff_json") and db.exists(done["u"]["graph"]):
            rec = done["u"]
            return {**{k: v for k, v in rec.items() if k != "diff_json"}, "applied": [], "fork_ms": 0.0,
                    "idempotent": True, "diff": json.loads(rec["diff_json"])}
    base = ep.checkout(db, t, asof, "known" if (asof and known) else "true")
    resolved = opsm.resolve_ops(db, base["graph"], ops)
    names = opsm.names_of(db, base["graph"], resolved)
    uid = uid or next_uid(db, t)
    graph = dbm.universe(t, uid)
    t0 = time.perf_counter()
    copy_ms = db.copy(base["graph"], graph)
    t1 = time.perf_counter()
    try:
        applied = opsm.apply_physical(db, graph, resolved, uid)
    except Exception:
        db.delete(graph)
        raise
    apply_ms = (time.perf_counter() - t1) * 1000
    if not title:
        title = "; ".join(opsm.describe(o, names) for o in resolved)
    if any(not opsm.OPS[o["op"]].mergeable for o in resolved) and kind == "whatif":
        kind = "outage"
    record = {
        "uid": uid, "graph": graph, "base": base["graph"], "kind": "backtest" if asof else kind, "title": title,
        "ops_json": json.dumps(resolved), "ops_named_json": json.dumps(opsm.named(resolved, names)),
        "created_by": created_by, "created_at": asof or dbm.clock(db, t), "status": "open",
        "base_version": base["version"], "copy_ms": round(copy_ms, 1), "apply_ms": round(apply_ms, 1),
        "seq": int(uid[1:]) if uid[1:].isdigit() else 0, "asof": asof, "known": bool(asof and known),
        "task": task, "rebased_from": rebased_from,
    }
    db.q(deck(db, t), "MERGE (u:Universe {uid: $u}) SET u += $r",
         {"u": uid, "r": {k: v for k, v in record.items() if v is not None}})
    out = {**record, "applied": applied, "fork_ms": round((time.perf_counter() - t0) * 1000, 1)}
    if diff_now:
        out["diff"] = diff(db, t, uid)
        out["risk"] = out["diff"]["risk"]["score"]
        out["risk_level"] = out["diff"]["risk"]["level"]
    return out


def get_universe(db: dbm.DB, t: str, uid: str) -> dict:
    row = db.one(deck(db, t), "MATCH (u:Universe {uid: $u}) RETURN properties(u) AS u", {"u": uid})
    if not row:
        raise KeyError(f"universe {uid} not found")
    return row["u"]


def list_universes(db: dbm.DB, t: str) -> list[dict]:
    return [r["u"] for r in db.ro(deck(db, t), "MATCH (u:Universe) RETURN properties(u) AS u ORDER BY u.seq DESC")]


HIDDEN_FIELDS = ("diff_json", "ops_json", "required_json", "ops_named_json")


def summary(u: dict) -> dict:
    """A universe as the list shows it: the record, with its changes by name."""
    return {**{k: v for k, v in u.items() if k not in HIDDEN_FIELDS}, "ops": json.loads(u.get("ops_named_json") or "[]")}


def detail(db: dbm.DB, t: str, uid: str) -> dict:
    """One universe: the record, its changes by name, the diff and who has approved."""
    u = get_universe(db, t, uid)
    if u["status"] == "merged" and u.get("decision") and "opened_facts" not in u:
        for key, prop in (("opened_facts", "src"), ("closed_facts", "closed_by")):
            u[key] = [r["uid"] for r in db.ro(dbm.org(t), f"MATCH ()-[r]->() WHERE r.{prop} = $d RETURN r.uid AS uid ORDER BY uid",
                                              {"d": u["decision"]})]
    return {**summary(u), "diff": json.loads(u["diff_json"]) if u.get("diff_json") else None,
            **approval_state(db, t, uid, u), "browser": f"http://localhost:3000/?graph={u['graph']}"}


# ---------------------------------------------------------------- diff

def evidence(eid: str, graph: str, query: str, params: dict, node_uids: list, fact_uids: list, asof: str | None,
             summary: str = "", text: str | None = None) -> dict:
    """A receipt: which graph, which named query and its Cypher, the parameters, and the uids it touched."""
    return {"eid": eid, "graph": graph, "query": query, "cypher": text or cypher(query), "params": params,
            "node_uids": sorted({u for u in node_uids if u}), "fact_uids": sorted({u for u in fact_uids if u}),
            "asof": asof, "summary": summary}


def broken_in(db: dbm.DB, graph: str) -> dict[str, impact.Reach]:
    """Every running service that still depends, at any depth, on a switched-off one."""
    retired = [r["uid"] for r in db.ro(graph, "MATCH (:Service)-[:DEPENDS_ON]->(r:Retired) RETURN DISTINCT r.uid AS uid")]
    return impact.walk(db, graph, retired) if retired else {}


def _since(asof: str, days: int) -> str:
    return (_date.fromisoformat(asof[:10]) - timedelta(days=days)).isoformat()


def customers_affected(db: dbm.DB, graph: str, services: list[str], asof: str) -> list[dict]:
    if not services:
        return []
    rows = db.ro(graph, cypher("customers_affected"), {"services": services, "since": _since(asof, CUSTOMER_WINDOW_DAYS)})
    by: dict[str, dict] = {}
    for r in sorted(rows, key=lambda r: (r["customer"], r["service"])):
        c = by.setdefault(r["uid"], {"uid": r["uid"], "customer": r["customer"], "tier": r["tier"], "services": [],
                                     "service_uids": [], "tickets": [], "uses": []})
        if r["service_uid"] not in c["service_uids"]:
            c["services"].append(r["service"])
            c["service_uids"].append(r["service_uid"])
        c["tickets"] += [k for k in r["tickets"] if k and k not in c["tickets"]]
        if r["uses"] and r["service"] not in c["uses"]:
            c["uses"].append(r["service"])
    return sorted(by.values(), key=lambda c: (-CUSTOMER_POINTS.get(c["tier"], 2), c["customer"]))


def _owner_teams(db: dbm.DB, graph: str, services: list[str]) -> list[dict]:
    if not services:
        return []
    return [r for label in ("Service", "Retired") for r in db.ro(graph, f"""MATCH (x:{label}) WHERE x.uid IN $s
                                 MATCH (t:Team)-[o:OWNS]->(x) WHERE o.declared = true
                                 RETURN t.uid AS team_uid, t.name AS team, x.name AS service""", {"s": services})]


def required_approvers(db: dbm.DB, base: str, ops: list[dict], broken_uids: list[str]) -> list[dict]:
    """Who has to agree: the declared owners of every service the change breaks, and of every service, person or
    team it directly changes. One approval from a member of each team unblocks the merge."""
    touched, teams_direct, people, decisions = [], set(), [], []
    for op in ops:
        o = op["op"]
        if o in ("deprecate_service", "reassign_owner", "create_ticket", "outage"):
            touched.append(op["service"])
        if o in ("add_dependency", "remove_dependency", "declare_dependency"):
            touched.append(op["source"])
        if o in ("remove_person", "move_person"):
            people.append(op["person"])
        if o == "reverse_decision":
            decisions.append(op["decision"])
        if o == "merge_teams":
            teams_direct |= {op["team"], op["into"]}
        if o in ("reassign_owner", "move_person"):
            teams_direct.add(op["team"])
    need: dict[str, dict] = {}

    def add(team_uid: str, team: str, why: str) -> None:
        r = need.setdefault(team_uid, {"team_uid": team_uid, "team": team, "because": []})
        if why not in r["because"]:
            r["because"].append(why)

    for r in _owner_teams(db, base, broken_uids):
        add(r["team_uid"], r["team"], f"owns {r['service']}, which would break")
    for r in _owner_teams(db, base, touched):
        add(r["team_uid"], r["team"], f"owns {r['service']}, which the change touches")
    if people:
        for r in db.ro(base, """MATCH (p:Person)-[:MEMBER_OF]->(t:Team) WHERE p.uid IN $p
                                RETURN t.uid AS tu, t.name AS tn, p.name AS pn""", {"p": people}):
            add(r["tu"], r["tn"], f"{r['pn']} is on the team")
    if decisions:
        for r in db.ro(base, """MATCH (d:Decision)-[:MADE_BY]->(t:Team) WHERE d.uid IN $d
                                RETURN DISTINCT t.uid AS tu, t.name AS tn, d.key AS k""", {"d": decisions}):
            add(r["tu"], r["tn"], f"made {r['k']}")
        affected = [r["uid"] for r in db.ro(base, "MATCH (d:Decision)-[:AFFECTS]->(x) WHERE d.uid IN $d RETURN DISTINCT x.uid AS uid",
                                            {"d": decisions})]
        for r in _owner_teams(db, base, affected):
            add(r["team_uid"], r["team"], f"owns {r['service']}, which the decision governs")
    if teams_direct:
        for r in db.ro(base, "MATCH (t) WHERE t.uid IN $t RETURN t.uid AS tu, t.name AS tn", {"t": sorted(teams_direct)}):
            add(r["tu"], r["tn"], "the change moves work to or from the team")
    return sorted(need.values(), key=lambda r: r["team"])


def _top(rows: list[dict], n: int = 5) -> list[dict]:
    return [{"uid": r["uid"], "name": r["name"], "score": round(r["score"], 4)} for r in rows[:n]]


def _components(db: dbm.DB, graph: str):
    comps, of, nm = [], {}, {}
    for r in db.ro(graph, cypher("collab_components")):
        comps.append(r["uids"])
        for u, n in zip(r["uids"], r["names"]):
            of[u], nm[u] = r["cid"], n
    return comps, of, nm


def _names_of_label(db: dbm.DB, g: str, label: str) -> set[str]:
    return {r["name"] for r in db.ro(g, f"MATCH (x:{label}) RETURN x.name AS name")}


def diff(db: dbm.DB, t: str, uid: str) -> dict:
    """Run the same queries and algorithms in the universe and its base; report what changed."""
    u = get_universe(db, t, uid)
    ug, bg = u["graph"], u["base"]
    asof = u["created_at"]
    t0 = time.perf_counter()
    ev: list[dict] = []

    # what breaks: every running service that still reaches a switched-off one, with a witness path each
    reach = broken_in(db, ug)
    info = {r["uid"]: r for r in db.ro(ug, """MATCH (s:Service) WHERE s.uid IN $s
        OPTIONAL MATCH (t:Team)-[o:OWNS]->(s) WHERE o.declared = true
        OPTIONAL MATCH (p:Person)-[:KNOWS]->(s)
        RETURN s.uid AS uid, s.tier AS tier, collect(DISTINCT t.name) AS owners, collect(DISTINCT p.name) AS people""",
                                           {"s": list(reach)})}
    roots = impact.names(db, ug, {x.root for x in reach.values()})
    broken = []
    for n, x in enumerate(sorted(reach.values(), key=lambda r: (r.hops, r.name))):
        eid = f"{uid}.broken.{x.name}" if n < DETAIL else f"{uid}.broken.rest"
        if n < DETAIL:
            path = impact.names(db, ug, x.nodes)
            ev.append(evidence(eid, ug, "broken_detail", {"edges": x.edges}, x.nodes, x.edges, asof,
                               f"{x.name} still relies on {roots.get(x.root, x.root)} in what-if {uid} ({x.hops} step(s)): "
                               + " -> ".join(path.get(p, p) for p in reversed(x.nodes))))
        i = info.get(x.uid, {})
        broken.append({"uid": x.uid, "service": x.name, "because_of": roots.get(x.root, x.root), "hops": x.hops,
                       "tier": i.get("tier") or x.tier or 3, "owners": i.get("owners", []),
                       "people_who_know_it": i.get("people", []), "effect": x.effect, "path": x.nodes[::-1],
                       "kinds": x.kinds[::-1], "fact_uids": x.edges, "via_undeclared": x.undeclared, "evidence": eid})

    effect_of = {b["uid"]: b["effect"] for b in broken}
    customers = customers_affected(db, ug, [b["uid"] for b in broken], asof)
    if customers:
        ev.append(evidence(f"{uid}.customers", ug, "customers_affected",
                           {"services": [b["uid"] for b in broken], "since": _since(asof, CUSTOMER_WINDOW_DAYS)},
                           [c["uid"] for c in customers], [], asof, f"customers tied to the services that break in what-if {uid}"))

    # services nobody would know
    before = {r["uid"]: r for r in db.ro(bg, cypher("knowledge_orphans"))}
    after = {r["uid"]: r for r in db.ro(ug, cypher("knowledge_orphans"))}
    new_orphans = []
    for s in sorted(set(after) - set(before)):
        eid = f"{uid}.orphan.{after[s]['name']}"
        ev.append(evidence(eid, ug, "knowledge_orphans", {}, [s], [], asof, f"nobody left in what-if {uid} knows {after[s]['name']}"))
        new_orphans.append({"uid": s, "service": after[s]["name"], "tier": after[s]["tier"] or 3, "evidence": eid})

    # services that lose every path to a team
    stranded_before = {x for r in db.ro(bg, cypher("stranded_clusters")) for x in r["uids"]}
    stranded = []
    for r in db.ro(ug, cypher("stranded_clusters")):
        if set(r["uids"]) - stranded_before:
            eid = f"{uid}.stranded.{len(stranded)}"
            ev.append(evidence(eid, ug, "stranded_clusters", {}, r["uids"], [], asof,
                               f"systems with no team left responsible in what-if {uid}"))
            stranded.append({"services": sorted(r["names"]), "uids": r["uids"], "evidence": eid})

    # who the work flows through (betweenness) and who has influence (PageRank), in both graphs
    b_before, b_after = db.ro(bg, cypher("betweenness")), db.ro(ug, cypher("betweenness"))
    p_before, p_after = db.ro(bg, cypher("pagerank")), db.ro(ug, cypher("pagerank"))
    bb = {r["uid"]: r["score"] for r in b_before}
    pb = {r["uid"]: r["score"] for r in p_before}
    top_before, top_after = [r["uid"] for r in b_before[:5]], [r["uid"] for r in b_after[:5]]
    b_shift = sorted(({"uid": r["uid"], "name": r["name"], "before": round(bb.get(r["uid"], 0.0), 2),
                       "after": round(r["score"], 2), "delta": round(r["score"] - bb.get(r["uid"], 0.0), 2)}
                      for r in b_after if abs(r["score"] - bb.get(r["uid"], 0.0)) >= 1.0), key=lambda x: -abs(x["delta"]))
    i_shift = sorted(({"uid": r["uid"], "name": r["name"], "before": round(pb.get(r["uid"], 0.0), 4),
                       "after": round(r["score"], 4), "delta": round(r["score"] - pb.get(r["uid"], 0.0), 4)}
                      for r in p_after if abs(r["score"] - pb.get(r["uid"], 0.0)) >= 0.002), key=lambda x: -abs(x["delta"]))

    # groups of people that would fall apart
    comps_before, _, _ = _components(db, bg)
    _, of_after, names_after = _components(db, ug)
    splits = []
    for members in comps_before:
        live = [m for m in members if m in of_after]
        parts = {of_after[m] for m in live}
        if len(parts) > 1:
            groups = [[names_after[m] for m in live if of_after[m] == p] for p in parts]
            eid = f"{uid}.split.{len(splits)}"
            ev.append(evidence(eid, ug, "collab_components", {}, live, [], asof, f"the groups people work in, in what-if {uid}"))
            splits.append({"groups": sorted(groups, key=len, reverse=True), "evidence": eid})

    structural = {
        "retired": sorted(_names_of_label(db, ug, "Retired") - _names_of_label(db, bg, "Retired")),
        "former": sorted(_names_of_label(db, ug, "Former") - _names_of_label(db, bg, "Former")),
        "closed_dependencies": db.ro(ug, "MATCH (a)-[r:DEPENDS_ON_CLOSED]->(b) RETURN r.uid AS uid, a.name AS source, b.name AS target"),
        "proposed_tickets": db.ro(ug, "MATCH (k:Ticket {proposed: true})-[:ABOUT]->(s) RETURN k.key AS key, k.title AS title, s.name AS service"),
    }
    if b_shift:
        ev.append(evidence(f"{uid}.bottlenecks", ug, "betweenness", {}, [b["uid"] for b in b_shift[:5]], [], asof,
                           f"the people most work flows through in what-if {uid}; before: "
                           + ", ".join(f"{b['name']} {b['before']}" for b in b_shift[:5])))
    approvers = required_approvers(db, bg, json.loads(u["ops_json"]), [b["uid"] for b in broken])
    risk = score_risk(broken, new_orphans, top_before, top_after, splits, customers, stranded, effect_of)
    result = {
        "universe": uid, "base": bg, "title": u["title"], "asof": asof, "broken": broken, "customers": customers,
        "new_orphans": new_orphans, "stranded": stranded, "collaboration_splits": splits,
        "bottlenecks": {"before": _top(b_before), "after": _top(b_after), "shift": b_shift[:8]},
        "influence": {"shift": i_shift[:8]}, "structural": structural, "required_approvers": approvers,
        "risk": risk, "evidence": ev, "diff_ms": round((time.perf_counter() - t0) * 1000, 1),
    }
    ev.append(evidence(f"{uid}.risk", dbm.deck(t), "universe_risk", {"u": uid}, [uid], [], asof,
                       f"risk of what-if {uid}: {risk['level']} {risk['score']}, the sum of {len(risk['terms'])} terms"))
    _store_risk(db, t, uid, risk)
    from orion import findings

    findings.record(db, t, u, result)
    db.q(deck(db, t), """MATCH (u:Universe {uid: $u}) SET u.risk = $r, u.risk_level = $l, u.diff_json = $d,
                         u.required_json = $req""",
         {"u": uid, "r": risk["score"], "l": risk["level"], "d": json.dumps(result), "req": json.dumps(approvers)})
    return result


def _store_risk(db: dbm.DB, t: str, uid: str, risk: dict) -> None:
    g = deck(db, t)
    db.q(g, "MATCH (:Universe {uid: $u})-[:SCORED]->(x:RiskTerm) DETACH DELETE x", {"u": uid})
    if risk["terms"]:
        db.q(g, """MATCH (u:Universe {uid: $u}) UNWIND $terms AS term
                   CREATE (u)-[:SCORED]->(:RiskTerm {kind: term.kind, subject: term.subject, points: term.points,
                                                     why: term.why})""",
             {"u": uid, "terms": [{k: x[k] for k in ("kind", "subject", "points", "why")} for x in risk["terms"]]})


def score_risk(broken: list, orphans: list, top_before: list, top_after: list, splits: list | None = None,
               customers: list | None = None, stranded: list | None = None, effect_of: dict | None = None) -> dict:
    """The risk score as a sum of named terms, so anyone can see where every point comes from."""
    terms = []

    def term(kind: str, subject: str, points: float, why: str, ev: str | None = None) -> None:
        terms.append({"kind": kind, "subject": subject, "points": round(points, 1), "why": why, "evidence": ev})

    for b in broken:
        effect = b.get("effect", "break")
        pts = TIER_POINTS.get(b["tier"], 6) * EFFECT_WEIGHT[effect] * (1 if b["hops"] == 1 else FAR_HOP_FACTOR)
        via = "directly" if b["hops"] == 1 else f"{b['hops']} steps away"
        term("break", b["service"], pts,
             f"{TIER_WORD.get(b['tier'], 'supporting')} system would {EFFECT_WORD[effect]} ({via} from "
             f"{b['because_of']}): {TIER_POINTS.get(b['tier'], 6)} points"
             + (f" × {EFFECT_WEIGHT[effect]} for how badly" if EFFECT_WEIGHT[effect] != 1 else "")
             + (f" × {FAR_HOP_FACTOR} for being further away" if b["hops"] > 1 else ""), b.get("evidence"))
    effect_of = effect_of or {}
    for c in customers or []:
        sev = max((impact.SEVERITY[effect_of.get(s, "break")] for s in c.get("service_uids", [])), default=3)
        w = EFFECT_WEIGHT[next(k for k, v in impact.SEVERITY.items() if v == sev)]
        base = CUSTOMER_POINTS.get(c["tier"], 2)
        how = (f"raised {', '.join(c['tickets'][:3])} about" if c["tickets"] else "uses") + f" {', '.join(c['services'][:3])}"
        term("customer", c["customer"], base * w, f"{c['tier']} customer ({base} points) who {how}")
    for o in orphans:
        term("orphan", o["service"], ORPHAN_POINTS.get(o["tier"], 12),
             f"nobody left would know how this {TIER_WORD.get(o['tier'], 'supporting')} system works", o.get("evidence"))
    for s in stranded or []:
        term("stranded", ", ".join(s["services"][:3]), STRANDED_POINTS,
             "no team would be responsible for these systems any more", s.get("evidence"))
    for sp in splits or []:
        term("split", " | ".join(", ".join(g[:3]) for g in sp["groups"]), SPLIT_POINTS,
             "a group that works together would fall apart", sp.get("evidence"))
    if top_before[:5] != top_after[:5]:
        term("bottleneck", "collaboration", BOTTLENECK_POINTS, "the people most work flows through would change")
    total = sum(x["points"] for x in terms)
    score = min(100, int(round(total)))
    lvl = "low" if score < MEDIUM_FROM else "medium" if score < HIGH_FROM else "high"
    return {"score": score, "level": lvl, "auto_approve": lvl == "low",
            "reasons": [f"{x['subject']}: {x['why']} (+{x['points']:g})" for x in terms], "terms": terms,
            "uncapped": round(total, 1)}


def replay(db: dbm.DB, t: str, ops: list[dict], asof: str | None = None) -> dict:
    """What the same ops break on today's company (or the company on `asof`), on a throwaway copy."""
    base = ep.checkout(db, t, asof, "known" if asof else "true")
    scratch = f"scratch:{t}:{secrets.token_hex(4)}"
    db.copy(base["graph"], scratch)
    try:
        resolved = [opsm.resolve_op(db, scratch, o) for o in ops]
        opsm.apply_physical(db, scratch, resolved, "replay")
        reach = broken_in(db, scratch)
        return {"broken": {k: v.name for k, v in reach.items()}, "graph": base["graph"]}
    finally:
        db.delete(scratch)


# ---------------------------------------------------------------- approvals, rebase, merge

def person_teams(db: dbm.DB, t: str, person: str) -> list[dict]:
    return db.ro(ep.now(db, t), "MATCH (:Person {uid: $p})-[:MEMBER_OF]->(t:Team) RETURN t.uid AS team_uid, t.name AS team",
                 {"p": person})


def approvals(db: dbm.DB, t: str, uid: str) -> list[dict]:
    return db.ro(deck(db, t), """MATCH (:Universe {uid: $u})-[:NEEDS]->(a:Approval)
                                 RETURN a.by AS by, a.team_uid AS team_uid, a.team AS team, a.verdict AS verdict,
                                        a.at AS at, a.reason AS reason ORDER BY a.at""", {"u": uid})


def approval_state(db: dbm.DB, t: str, uid: str, u: dict | None = None) -> dict:
    u = u or get_universe(db, t, uid)
    required = json.loads(u.get("required_json") or "[]")
    got = approvals(db, t, uid)
    approved = {a["team_uid"] for a in got if a["verdict"] == "approved" and a.get("team_uid")}
    for r in required:
        r["approved_by"] = [a["by"] for a in got if a["verdict"] == "approved" and a.get("team_uid") == r["team_uid"]]
    return {"required": required, "missing": [r for r in required if r["team_uid"] not in approved], "approvals": got}


class _Lock:
    """A short lock per universe, so two people deciding at the same moment are taken one at a time."""

    def __init__(self, db: dbm.DB, t: str, uid: str, ttl: int = 120):
        self.lock = db.lock(f"{t}:universe:{uid}", ttl=ttl, wait=5)

    def __enter__(self):
        try:
            self.lock.__enter__()
        except dbm.LockTimeout:
            raise Busy("someone else is deciding on this right now; try again in a moment") from None
        return self

    def __exit__(self, *exc):
        self.lock.__exit__(*exc)


def rebase(db: dbm.DB, t: str, uid: str) -> dict:
    """The company changed since this universe was forked: fork the same ops from now and compare."""
    u = get_universe(db, t, uid)
    old = json.loads(u["diff_json"]) if u.get("diff_json") else diff(db, t, uid)
    ob = sorted(b["service"] for b in old["broken"])
    try:
        new = fork(db, t, json.loads(u["ops_json"]), kind=u["kind"], title=u["title"],
                   created_by=u.get("created_by", "rebase"), rebased_from=uid)
    except opsm.ResolveError as e:  # what it changes is gone: there is nothing left to rebase
        db.q(deck(db, t), "MATCH (u:Universe {uid: $u}) SET u.status = 'discarded', u.reason = $r",
             {"u": uid, "r": f"no longer applies: {e}"})
        db.delete(u["graph"])
        return {"from": uid, "to": None, "changed": True, "obsolete": str(e),
                "risk": {"before": old["risk"]["score"], "after": 0, "level_before": old["risk"]["level"], "level_after": "low"},
                "broken": {"before": ob, "after": [], "no_longer": ob, "newly": []}}
    nd = new["diff"]
    nb = sorted(b["service"] for b in nd["broken"])
    changed = old["risk"]["score"] != nd["risk"]["score"] or ob != nb
    out = {"from": uid, "to": new["uid"], "changed": changed,
           "risk": {"before": old["risk"]["score"], "after": nd["risk"]["score"], "level_before": old["risk"]["level"],
                    "level_after": nd["risk"]["level"]},
           "broken": {"before": ob, "after": nb, "no_longer": sorted(set(ob) - set(nb)), "newly": sorted(set(nb) - set(ob))},
           "base_version": {"before": u["base_version"], "after": new["base_version"]}}
    if changed:
        db.q(deck(db, t), "MATCH (u:Universe {uid: $u}) SET u.status = 'rebased', u.rebased_to = $n", {"u": uid, "n": new["uid"]})
        db.delete(u["graph"])
    else:  # same outcome on today's company: keep the original and its approvals, drop the check
        db.q(deck(db, t), "MATCH (u:Universe {uid: $u}) SET u.base_version = $v", {"u": uid, "v": new["base_version"]})
        db.q(deck(db, t), "MATCH (u:Universe {uid: $u}) SET u.status = 'discarded', u.reason = $r",
             {"u": new["uid"], "r": f"rebase check for {uid}: unchanged"})
        db.delete(new["graph"])
    return {**out, "old_diff": old, "new_diff": nd if changed else None}


def migration_gaps(ops: list[dict]) -> list[str]:
    """Services cut off from something the change switches off, with no replacement in the same change."""
    retired = {o["service"] for o in ops if o["op"] == "deprecate_service"}
    added = {o["source"] for o in ops if o["op"] == "add_dependency" and o["target"] not in retired}
    return sorted({o["source"] for o in ops if o["op"] == "remove_dependency" and o["target"] in retired
                   and o["source"] not in added})


def _gate(u: dict, d: dict) -> dict | None:
    if d["broken"]:
        retired = sorted({b["because_of"] for b in d["broken"]})
        direct = sorted({b["service"] for b in d["broken"] if b["hops"] == 1})
        return {"universe": u["uid"], "retired": retired, "broken": [b["service"] for b in d["broken"]],
                "needs_migration": direct,
                "message": (f"Applying this now would leave {len(d['broken'])} system(s) relying on {', '.join(retired)} "
                            f"after it is switched off. Move {', '.join(direct)} onto a replacement first, or apply "
                            "anyway and accept that they break.")}
    gaps = migration_gaps(json.loads(u["ops_json"]))
    if gaps:
        return {"universe": u["uid"], "retired": [], "broken": [], "needs_migration": gaps,
                "message": f"{', '.join(gaps)} would stop relying on a switched-off system with nothing to replace it. "
                           "Add a change that moves it onto the replacement, or apply anyway."}
    return None


def approve(db: dbm.DB, t: str, uid: str, by: str, note: str = "", force: bool = False) -> dict:
    with _Lock(db, t, uid):
        return _approve(db, t, uid, by, note, force)


def _approve(db: dbm.DB, t: str, uid: str, by: str, note: str, force: bool) -> dict:
    """In order: a stale base is rebased (a changed outcome refuses the approval: look at the new diff first); a
    merge that leaves services relying on something it switches off is blocked unless forced; the approval counts
    for every required team the person is on; when every required team has approved, it merges.
    {status: rebase_needed | blocked | waiting | merged}."""
    u = get_universe(db, t, uid)
    if u["kind"] in ("outage", "backtest"):
        raise ValueError(f"this is a what-if about {'an outage' if u['kind'] == 'outage' else 'the past'}; there is nothing to apply")
    if u["status"] not in DECIDABLE:
        raise ValueError(f"universe {uid} is {u['status']}")
    if u["status"] == "merge_failed":
        return {"status": "merged", **merge(db, t, uid, by, note, force=force), **approval_state(db, t, uid)}
    if u["base_version"] != dbm.version(db, t):
        rb = rebase(db, t, uid)
        if rb["changed"]:
            return {"status": "rebase_needed", **rb}
        u = get_universe(db, t, uid)
    d = json.loads(u["diff_json"]) if u.get("diff_json") else diff(db, t, uid)
    blocked = _gate(u, d)
    if blocked and not force:
        return {"status": "blocked", **blocked}
    teams = person_teams(db, t, by)
    required = {r["team_uid"]: r for r in json.loads(u.get("required_json") or "[]")}
    now = dbm.clock(db, t)
    counted = [x for x in teams if x["team_uid"] in required] or [{"team_uid": None, "team": None}]
    for x in counted:
        db.q(deck(db, t), """MATCH (u:Universe {uid: $u})
                             CREATE (u)-[:NEEDS]->(:Approval {by: $by, team_uid: $tu, team: $tn, verdict: 'approved',
                                                              at: $at, reason: $r, forced: $f})""",
             {"u": uid, "by": by, "tu": x["team_uid"], "tn": x["team"], "at": now, "r": note, "f": force})
    state = approval_state(db, t, uid, u)
    if state["missing"]:
        return {"status": "waiting", "universe": uid, **state, "counted_for": [x["team"] for x in counted if x["team"]]}
    return {"status": "merged", **merge(db, t, uid, by, note, force=force), **state}


def merge(db: dbm.DB, t: str, uid: str, approved_by: str, note: str = "", force: bool = False) -> dict:
    """Replay the universe's ops into the org graph. Resumable: the number of ops already applied is stored, so a
    merge that fails partway continues where it stopped and never applies an op twice."""
    u = get_universe(db, t, uid)
    if u["status"] not in DECIDABLE:
        raise ValueError(f"universe {uid} is {u['status']}")
    d = json.loads(u["diff_json"]) if u.get("diff_json") else diff(db, t, uid)
    blocked = _gate(u, d)
    if blocked and not force:
        raise MergeBlocked(blocked["message"], blocked)
    if not db.q(deck(db, t), """MATCH (u:Universe {uid: $u}) WHERE u.status IN $ok SET u.status = 'merging'
                                RETURN u.uid AS uid""", {"u": uid, "ok": list(DECIDABLE)}):
        raise ValueError(f"universe {uid} is already being applied")
    try:
        return _merge(db, t, u, d, approved_by, note, force)
    except Exception as e:
        db.q(deck(db, t), "MATCH (u:Universe {uid: $u}) SET u.status = 'merge_failed', u.merge_error = $e",
             {"u": uid, "e": f"{type(e).__name__}: {e}"[:500]})
        raise


def _merge(db: dbm.DB, t: str, u: dict, d: dict, by: str, note: str, force: bool) -> dict:
    uid = u["uid"]
    ops = json.loads(u["ops_json"])
    resumed = int(u.get("merge_done") or 0)
    now = u.get("merge_at") or dbm.tick(db, t)
    db.q(deck(db, t), "MATCH (u:Universe {uid: $u}) SET u.merge_at = $now", {"u": uid, "now": now})
    g = dbm.org(t)
    record, dec = f"doc:merge-{uid}", f"dec:merge-{uid}"
    approvers = sorted({a["by"] for a in approvals(db, t, uid) if a["verdict"] == "approved"} | {by})
    db.q(g, """MERGE (src:Source:Doc {uid: $src})
               ON CREATE SET src.kind = 'merge', src.title = $title, src.at = $now, src.text = $text, src.day = $day
               MERGE (d:Decision {uid: $dec})
               ON CREATE SET d.key = $key, d.title = $title, d.status = 'accepted', d.at = $now, d.decided_at = $now,
                             d.summary = $text, d.day = $day, d.universe = $u, d.forced = $forced
               MERGE (d)-[:EVIDENCED_BY]->(src)""",
         {"src": record, "dec": dec, "key": f"MERGE-{uid}", "title": u["title"], "now": now, "u": uid,
          "forced": force and bool(d["broken"]), "day": _day(now),
          "text": note or f"Applied what-if {uid} after review (risk {u.get('risk_level', '?')} {u.get('risk', '?')})."})
    db.q(g, "MATCH (d:Decision {uid: $dec}) UNWIND $p AS a MATCH (p:Person {uid: a}) MERGE (d)-[:DECIDED_BY]->(p)",
         {"dec": dec, "p": approvers})
    db.q(g, "MATCH (d:Decision {uid: $dec}) UNWIND $teams AS x MATCH (tm:Team {uid: x}) MERGE (d)-[:MADE_BY]->(tm)",
         {"dec": dec, "teams": [r["team_uid"] for r in json.loads(u.get("required_json") or "[]")]})
    t0 = time.perf_counter()
    closed, log, touched = [], [], set()
    for i, op in enumerate(ops):
        for f in ("service", "source", "target", "decision", "person", "team", "into"):
            if op.get(f):
                touched.add(op[f])
        target = op.get("service") or op.get("source") or op.get("decision")
        if target:
            db.q(g, "MATCH (d:Decision {uid: $dec}), (x {uid: $x}) MERGE (d)-[:AFFECTS]->(x)", {"dec": dec, "x": target})
        if i < resumed:
            continue
        got = opsm.apply_temporal(db, g, op, now, dec)
        closed += got
        log.append({"op": op["op"], "closed": got})
        db.q(deck(db, t), "MATCH (u:Universe {uid: $u}) SET u.merge_done = $i", {"u": uid, "i": i + 1})
    v = dbm.bump(db, t)
    opened = [r["uid"] for r in db.ro(g, "MATCH ()-[r]->() WHERE r.src = $dec RETURN r.uid AS uid ORDER BY uid", {"dec": dec})]
    all_closed = [r["uid"] for r in db.ro(g, "MATCH ()-[r]->() WHERE r.closed_by = $dec RETURN r.uid AS uid ORDER BY uid",
                                          {"dec": dec})]
    db.q(deck(db, t), """MATCH (u:Universe {uid: $u}) SET u.status = 'merged', u.merged_at = $now, u.merged_by = $by,
                         u.forced = $f, u.decision = $dec, u.opened_facts = $o, u.closed_facts = $c""",
         {"u": uid, "now": now, "by": by, "f": force and bool(d["broken"]), "dec": dec, "o": opened, "c": all_closed})
    db.delete(u["graph"])
    from orion.agents import sentinel

    expired = sentinel.after_change(db, t, closed, sorted(touched), record, now)
    return {"universe": uid, "decision": dec, "merged_at": now, "version": v, "log": log,
            "forced": force and bool(d["broken"]), "expired_answers": len(expired),
            "merge_ms": round((time.perf_counter() - t0) * 1000, 1)}


def discard(db: dbm.DB, t: str, uid: str, by: str = "cli", reason: str = "") -> dict:
    """Reject an open universe. Anything else is refused: rejecting a merged one would rewrite what happened."""
    with _Lock(db, t, uid):
        u = get_universe(db, t, uid)
        if u["status"] != "open":
            raise ValueError(f"universe {uid} is {u['status']}; only an open one can be rejected")
        now = dbm.clock(db, t)
        db.q(deck(db, t), """MATCH (u:Universe {uid: $u}) WHERE u.status = 'open'
                             SET u.status = 'discarded', u.discarded_at = $now
                             CREATE (u)-[:NEEDS]->(:Approval {by: $by, verdict: 'rejected', at: $now, reason: $r})""",
             {"u": uid, "now": now, "by": by, "r": reason})
        db.delete(u["graph"])
        return {"universe": uid, "status": "discarded"}


def gc(db: dbm.DB, t: str, keep: int = 30) -> int:
    """Discard the oldest open what-ifs beyond `keep`. Proposals awaiting approval are never collected."""
    if not db.exists(dbm.deck(t)):
        return 0
    every = [u for u in list_universes(db, t) if u["status"] == "open" and u["kind"] != "dryrun"]
    n = 0
    for u in every[keep:]:
        try:
            discard(db, t, u["uid"], by="janitor", reason="garbage-collected")
            n += 1
        except Exception:
            pass
    return n


def _day(at: str) -> int:
    from orion.world.corvane import day_index

    return day_index(at)
