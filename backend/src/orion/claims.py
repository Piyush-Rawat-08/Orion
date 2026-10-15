"""Typed claims, checked by the graph instead of by a model.

Most of what an answer asserts is a set or a number: "switching off sso-legacy breaks invoice-render and
reports-legacy", "only Ines Okafor knows the ledger", "the risk is 65". The Navigator submits each claim with its kind,
subject and objects, and this module checks it: the claimed set must equal (or, for a non-exhaustive claim, be
contained in) the set the graph returns; the claimed number must equal the number a query returns. "verified" means
the graph returned exactly that, and every check carries its receipt: the graph, the query and what it returned.

    kind         subject          objects / value                          check
    breaks       universe id      services that would break                walk from :Retired in that universe
    knows        service          people                                   (Person)-[:KNOWS]->(service)
    owns         service          teams                                    OWNS, declared or de facto
    depends_on   service          services (measure 'dependents' flips it) walk over DEPENDS_ON, any depth
    decided      decision key     value = status; objects = what it affects
    count        entity           value; measure = knowers | owners | dependents | dependencies | broken
    metric       entity/universe  value; measure = risk | bus_factor | tier
    free         -                -                                        no structured check: a model judges it

A sentence is held to its claim: "only", "all", "alone" make a set claim exhaustive whatever the model typed, a set
claim that names nothing is refused, and a sentence that names something the check didn't cover is at most 'partial'.
A name that matches nothing (or several things) gives 'unsupported' (couldn't confirm), never 'contradicted'.
"""

from __future__ import annotations

import json
import re

from orion import db as dbm
from orion import epoch as ep
from orion import impact
from orion import ops as opsm
from orion.queries import cypher

KINDS = ["breaks", "knows", "owns", "depends_on", "decided", "count", "metric", "free"]
MEASURES = ["knowers", "owners", "dependents", "dependencies", "broken", "risk", "bus_factor", "tier"]
SET_KINDS = ("breaks", "knows", "owns", "depends_on")
EXHAUSTIVE_WORDS = re.compile(r"\b(only|just|all|every|exactly|sole|solely|alone|nobody else|no one else|none other|"
                              r"the whole|entire)\b", re.I)
MENTION_LABELS = ("Service", "Person", "Customer", "Decision")


class CheckError(Exception):
    """The claim can't be checked as typed."""

    def __init__(self, message: str, verdict: str = "unverified"):
        super().__init__(message)
        self.verdict = verdict


def _uid(db: dbm.DB, graph: str, label: str, ref: str) -> str:
    try:
        return opsm.resolve(db, graph, label, ref)
    except opsm.ResolveError as e:
        raise CheckError(str(e), "unsupported") from None


def _any_uid(db: dbm.DB, graph: str, ref: str) -> str | None:
    for label in ("Service", "Person", "Team", "Customer", "Decision", "Project"):
        try:
            return opsm.resolve(db, graph, label, ref)
        except opsm.ResolveError:
            continue
    return None


def mentioned(db: dbm.DB, t: str, text: str, labels: tuple[str, ...] | None = None) -> list[dict]:
    res = opsm.resolver(db, dbm.org(t))
    uids = res.mentions(text or "")
    rows = db.ro(dbm.org(t), "MATCH (n) WHERE n.uid IN $u RETURN n.uid AS uid, coalesce(n.name, n.key) AS name, labels(n)[0] AS label",
                 {"u": uids}) if uids else []
    return [r for r in rows if labels is None or r["label"] in labels]


def _universe(db: dbm.DB, t: str, ref: str, need_graph: bool = True) -> dict:
    from orion.universe import deck

    ref = (ref or "").strip()
    row = db.one(deck(db, t), "MATCH (u:Universe) WHERE u.uid = $r OR u.graph = $r RETURN properties(u) AS u", {"r": ref})
    if not row:
        raise CheckError(f"no universe {ref}", "unverified")
    u = row["u"]
    if need_graph and not db.exists(u["graph"]):
        raise CheckError(f"universe {u['uid']} was {u['status']}; its graph is gone", "expired")
    return u


def _covered(db: dbm.DB, t: str, graph: str, claim: dict) -> set[str]:
    out: set[str] = set()
    for ref in [claim.get("subject")] + list(claim.get("objects") or []):
        if ref and (u := _any_uid(db, graph, ref)):
            out.add(u)
    subject = (claim.get("subject") or "").strip()
    if subject:
        try:
            u = _universe(db, t, subject, need_graph=False)
            out |= {v for o in json.loads(u["ops_json"]) for k, v in o.items() if k != "op" and isinstance(v, str)}
        except CheckError:
            pass
    return out


def _strings(v) -> set[str]:
    if isinstance(v, str):
        return {v}
    if isinstance(v, dict):
        return set().union(*(_strings(x) for x in v.values())) if v else set()
    if isinstance(v, (list, tuple, set)):
        return set().union(*(_strings(x) for x in v)) if v else set()
    return set()


def _consistency(db: dbm.DB, t: str, graph: str, claim: dict, shown: set[str]) -> str | None:
    """Entities the sentence names that neither the claim nor the check's own result accounts for."""
    covered = _covered(db, t, graph, claim)
    extra = [m["name"] for m in mentioned(db, t, claim.get("text") or "", MENTION_LABELS)
             if m["uid"] not in covered and m["name"] not in shown]
    return ", ".join(sorted(set(extra))) if extra else None


def check(db: dbm.DB, t: str, claim: dict, today: bool = False, asof: str | None = None) -> dict:
    """{verdict, reason, check} for one typed claim. `today`: a claim about a universe forked before the company
    last changed is replayed on today's company. `asof`: check it against the company as it was on a date."""
    kind = claim.get("kind") or "free"
    if kind == "free":
        raise CheckError("free-text claim", "free")
    claim = dict(claim)
    text = claim.get("text") or ""
    if kind in SET_KINDS:
        if EXHAUSTIVE_WORDS.search(text):
            claim["exhaustive"] = True
        if not [o for o in claim.get("objects") or [] if o] and not claim.get("exhaustive"):
            raise CheckError("it names nothing that can be checked", "unverified")
    out = _check(db, t, claim, today, asof)
    if text and out["verdict"] == "verified":
        g = (out.get("check") or {}).get("graph") or ""
        g = g if g.startswith(("epoch:", "universe:")) else ep.checkout(db, t, asof, "known" if asof else "true")["graph"]
        extra = _consistency(db, t, g, claim, _strings((out.get("check") or {}).get("result")))
        if extra:
            out = {**out, "verdict": "partial",
                   "reason": f"{out['reason']}; the sentence also names {extra}, which this check didn't cover"}
    return out


def _names(db: dbm.DB, graph: str, uids) -> list[str]:
    got = impact.names(db, graph, list(uids))
    return sorted(got.get(u, u) for u in uids)


def _set_verdict(claimed: set, actual: set, exhaustive: bool, names) -> tuple[str, str]:
    extra, missing = claimed - actual, actual - claimed
    if extra:
        return "contradicted", f"the records don't show {', '.join(names(extra))}"
    if exhaustive and missing:
        return "partial", f"the records also show {', '.join(names(missing))}"
    if not claimed and actual and exhaustive:
        return "contradicted", f"the records show {', '.join(names(actual))}"
    return "verified", ("the records show exactly this" if exhaustive else "the records show each of these")


def _num(v) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def receipt(graph: str, query: str, params: dict, result, text: str | None = None) -> dict:
    return {"graph": graph, "query": query, "cypher": text or cypher(query), "params": params, "result": result}


def _check(db: dbm.DB, t: str, claim: dict, today: bool, asof: str | None) -> dict:
    kind = claim.get("kind") or "free"
    snap = ep.checkout(db, t, asof, "known" if asof else "true")
    g = snap["graph"]
    subject = claim.get("subject") or ""
    objects = [o for o in claim.get("objects") or [] if o]
    exhaustive = bool(claim.get("exhaustive"))
    measure, value = claim.get("measure"), claim.get("value")

    def names(uids):
        return _names(db, g, uids)

    if kind == "breaks":
        from orion.universe import broken_in

        u = _universe(db, t, subject, need_graph=not (asof or today))
        if asof:
            return _breaks_on(db, t, u, objects, exhaustive, asof)
        if today and u.get("base_version") != dbm.version(db, t):
            return _breaks_on(db, t, u, objects, exhaustive)
        ug = u["graph"]
        customers = _customers_of(db, ug, objects)
        if customers is not None:
            return _customers_verdict(u, customers, exhaustive, ug)
        if not db.exists(ug):
            return _breaks_on(db, t, u, objects, exhaustive)
        reach = broken_in(db, ug)
        claimed = {_uid(db, ug, "Service", o) for o in objects}
        verdict, why = _set_verdict(claimed, set(reach), exhaustive, lambda x: _names(db, ug, x))
        return {"verdict": verdict, "reason": why,
                "check": receipt(ug, "broken_detail", {"edges": sorted({e for r in reach.values() for e in r.edges})},
                                 {"broken": _names(db, ug, set(reach))},
                                 "breadth-first over DEPENDS_ON from every :Retired service; each witness path re-runs as:\n"
                                 + cypher("broken_detail"))}

    if kind in ("knows", "owns"):
        s = _uid(db, g, "Service", subject)
        if kind == "knows":
            row = db.ro(g, cypher("knowers"), {"s": s})[0]
            actual = set(row["uids"])
            claimed = {_uid(db, g, "Person", o) for o in objects}
            query, result = "knowers", {"knowers": row["knowers"], "people": sorted(row["people"])}
        else:
            row = db.ro(g, cypher("owners"), {"s": s})[0]
            actual = {x for x in row["declared"] + row["de_facto"] if x}
            claimed = {_uid(db, g, "Team", o) for o in objects}
            query, result = "owners", {"declared": names([x for x in row["declared"] if x]),
                                       "de_facto": names([x for x in row["de_facto"] if x])}
        verdict, why = _set_verdict(claimed, actual, exhaustive, names)
        return {"verdict": verdict, "reason": why, "check": receipt(g, query, {"s": s}, result)}

    if kind == "depends_on":
        s = _uid(db, g, "Service", subject)
        flip = measure == "dependents"
        reach = impact.walk(db, g, [s], direction="up" if flip else "down")
        claimed = {_uid(db, g, "Service", o) for o in objects}
        verdict, why = _set_verdict(claimed, set(reach), exhaustive, names)
        return {"verdict": verdict, "reason": why,
                "check": receipt(g, "broken_detail", {"edges": sorted({e for r in reach.values() for e in r.edges})},
                                 {"dependents" if flip else "dependencies": names(set(reach))},
                                 f"breadth-first over DEPENDS_ON {'backwards' if flip else 'forwards'} from {subject}, any "
                                 "depth; every relationship on the paths re-runs as:\n" + cypher("broken_detail"))}

    if kind == "decided":
        rows = db.ro(g, cypher("decision_status"), {"k": subject})
        if not rows:
            raise CheckError(f"no decision {subject}", "unsupported")
        r = rows[0]
        rec = receipt(g, "decision_status", {"k": subject}, {"status": r["status"], "affects": r["affects_names"]})
        if value and str(value).lower() != (r["status"] or "").lower():
            return {"verdict": "contradicted", "reason": f"{r['key']} is {r['status']}, not {value}", "check": rec}
        if objects:
            claimed = set()
            for o in objects:
                try:
                    claimed.add(opsm.resolve(db, g, "Service", o))
                except opsm.ResolveError:
                    claimed.add(o)
            verdict, why = _set_verdict(claimed, set(r["affects"]), exhaustive, names)
            return {"verdict": verdict, "reason": why, "check": rec}
        return {"verdict": "verified", "reason": f"{r['key']} is {r['status']}", "check": rec}

    if kind in ("count", "metric"):
        if asof and measure in ("risk", "broken"):
            raise CheckError("a what-if's score belongs to the day it was tested, not to a date", "unverified")
        want = _num(value)
        if want is None:
            raise CheckError(f"no number in the claim ({value!r})", "unverified")
        got, rec = _measure(db, t, g, measure, subject)
        verdict = "verified" if abs(got - want) < 1e-9 else "contradicted"
        return {"verdict": verdict, "reason": f"the records say {got:g}" + ("" if verdict == "verified" else f", not {want:g}"),
                "check": rec}

    raise CheckError(f"unknown claim kind {kind}")


def _customers_of(db: dbm.DB, graph: str, objects: list[str]) -> set[str] | None:
    """When every object of a 'breaks' claim is a customer, the claim is about who would notice."""
    if not objects:
        return None
    out = set()
    for o in objects:
        try:
            out.add(opsm.resolve(db, graph, "Customer", o))
        except opsm.ResolveError:
            return None
    return out


def _customers_verdict(u: dict, claimed: set[str], exhaustive: bool, graph: str) -> dict:
    found = {c["uid"]: c["customer"] for c in json.loads(u.get("diff_json") or "{}").get("customers", [])}
    verdict, why = _set_verdict(claimed, set(found), exhaustive, lambda x: sorted(found.get(i, i.split(":", 1)[-1]) for i in x))
    return {"verdict": verdict, "reason": why.replace("records don't show", "list doesn't show").replace("records also show", "list also shows")
                       .replace("records show", "list shows").replace("the list", "the what-if's customer list"),
            "check": receipt(graph, "customers_affected", {"universe": u["uid"]}, {"customers": sorted(found.values())})}


def _breaks_on(db: dbm.DB, t: str, u: dict, objects: list[str], exhaustive: bool, asof: str | None = None) -> dict:
    """What the universe's changes break on today's company (or the company on `asof`): replayed on a scratch copy,
    compared with the claim. This is how an answer about a what-if learns the company moved on."""
    from orion.universe import broken_in, replay

    when = f"the company on {asof[:10]}" if asof else "today's company"
    try:
        r = replay(db, t, json.loads(u["ops_json"]), asof)
    except opsm.ResolveError as e:
        raise CheckError(f"{e} on {when}", "unsupported") from None
    actual = set(r["broken"])
    g = r["graph"]
    claimed = set()
    for o in objects:
        claimed.add(_any_uid(db, g, o) or _any_uid(db, dbm.org(t), o) or o)
    verdict, why = _set_verdict(claimed, actual, exhaustive, lambda x: sorted(r["broken"].get(i) or impact.names(db, dbm.org(t), [i]).get(i, i) for i in x))
    then = set(broken_in(db, u["graph"])) if db.exists(u["graph"]) else set(json.loads(u.get("diff_json") or "{}").get("broken_uids", []))
    if not then and u.get("diff_json"):
        then = {b["uid"] for b in json.loads(u["diff_json"])["broken"]}
    nm = impact.names(db, dbm.org(t), list(actual | then))
    now_also, gone = sorted(nm.get(x, x) for x in actual - then), sorted(nm.get(x, x) for x in then - actual)
    moved = "; ".join(x for x in (f"now also breaks {', '.join(now_also)}" if now_also else "",
                                  f"no longer breaks {', '.join(gone)}" if gone else "") if x)
    return {"verdict": verdict, "reason": why + (f" (on {when}: {moved})" if moved else f" (re-run on {when})"),
            "check": {"graph": g, "query": "breaks_today", "params": {"universe": u["uid"]},
                      "cypher": f"the changes of {u['uid']} replayed on a copy of {when}, then breadth-first over "
                                "DEPENDS_ON from every :Retired service",
                      "result": {"broken": sorted(nm.get(x, x) for x in actual), "now_also": now_also, "no_longer": gone}}}


def _measure(db: dbm.DB, t: str, g: str, measure: str | None, subject: str) -> tuple[float, dict]:
    from orion.universe import broken_in, deck

    if measure == "risk":
        u = _universe(db, t, subject, need_graph=False)
        row = db.ro(deck(db, t), cypher("universe_risk"), {"u": u["uid"]})[0]
        return float(row["risk_score"]), receipt(dbm.deck(t), "universe_risk", {"u": u["uid"]},
                                                 {"risk_score": row["risk_score"], "terms": row["terms"]})
    if measure == "broken":
        u = _universe(db, t, subject)
        reach = broken_in(db, u["graph"])
        n = len(reach)
        return float(n), receipt(u["graph"], "broken", {}, {"broken": n, "services": sorted(r.name for r in reach.values())},
                                 "breadth-first over DEPENDS_ON from every :Retired service")
    s = _uid(db, g, "Service", subject)
    if measure == "bus_factor":
        rows = db.ro(g, cypher("bus_factor"), {"s": s})[0]["per_service"]
        bf = min((x["knowers"] for x in rows if x["knowers"] > 0), default=0)
        return float(bf), receipt(g, "bus_factor", {"s": s}, {"bus_factor": bf, "per_service": rows[:10]})
    if measure == "knowers":
        row = db.ro(g, cypher("knowers"), {"s": s})[0]
        return float(row["knowers"]), receipt(g, "knowers", {"s": s}, {"knowers": row["knowers"], "people": row["people"]})
    if measure == "owners":
        row = db.ro(g, cypher("owners"), {"s": s})[0]
        return float(row["owners"]), receipt(g, "owners", {"s": s}, {"owners": row["owners"], "names": row["names"]})
    if measure == "tier":
        row = db.ro(g, cypher("service_tier"), {"s": s})[0]
        return float(row["tier"]), receipt(g, "service_tier", {"s": s}, row)
    if measure in ("dependents", "dependencies"):
        reach = impact.walk(db, g, [s], direction="up" if measure == "dependents" else "down")
        return float(len(reach)), receipt(g, measure, {"s": s}, {measure: len(reach), "services": _names(db, g, set(reach))},
                                          f"breadth-first over DEPENDS_ON ({measure}), any depth")
    raise CheckError(f"unknown measure {measure!r}", "unverified")
