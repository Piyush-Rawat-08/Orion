"""Typed claims, checked by the graph.

An answer is a list of sentences, each with a claim the graph can check:

    knows        subject: service      objects: people        who knows it now
    owns         subject: team         objects: services      (or subject: service, objects: [team])
    depends_on   subject: service      objects: services      direct dependencies
    dependents   subject: service      objects: services      everything that depends on it, any depth
    breaks       scenario: universe    objects: services      what would break in that universe
    approvers    scenario: universe    objects: teams         who must approve that change
    exposed      scenario: universe    objects: customers     which customers it would reach
    decision     subject: decision     value: status          accepted / superseded / reversed
    count        subject + metric      value: number          knowers, dependents, members, risk
    text         anything else, judged by the fast model on the rows it cites; never "verified"

Statuses: verified (the graph returned exactly that), partial (true, but the sentence names things the claim
doesn't check), contradicted (the graph says otherwise), outdated (it was true when it was said, and the company
has changed since; set by watch.py), unconfirmed (a name matches nothing or several things), judged / unsupported
(free text, by the model).

The sentence is held to its claim: "only", "all", "alone", "nobody else" make a set claim exhaustive whatever the
model typed, and a set claim that names nothing is refused.
"""

from __future__ import annotations

import json
import re

from orion import db as dbm
from orion import impact, llm
from orion.tools import Ctx

TYPES = ["knows", "owns", "depends_on", "dependents", "breaks", "approvers", "exposed", "decision", "count", "text"]
METRICS = ["knowers", "dependents", "members", "risk"]
EXHAUSTIVE = re.compile(r"\b(only|alone|all|every|nobody else|no one else|the last|sole|solely|just)\b", re.I)

SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["sentence", "type", "subject", "objects", "exhaustive", "value", "scenario", "evidence"],
    "properties": {
        "sentence": {"type": "string"},
        "type": {"type": "string", "enum": TYPES},
        "subject": {"type": "string", "description": "the entity the claim is about (name or uid); '' for text"},
        "objects": {"type": "array", "items": {"type": "string"}},
        "exhaustive": {"type": "boolean", "description": "true when the sentence says these are all of them"},
        "value": {"type": ["string", "number", "null"], "description": "decision status, or the number of a count"},
        "metric": {"anyOf": [{"type": "string", "enum": METRICS}, {"type": "null"}]},
        "scenario": {"type": ["string", "null"], "description": "universe id for 'breaks' and risk counts"},
        "evidence": {"type": "array", "items": {"type": "string"}, "description": "evidence ids (e1, e2...)"},
    },
}


class Unresolved(Exception):
    pass


def _resolve(ctx: Ctx, name: str, label: str | None = None) -> str:
    try:
        return ctx.one(name, label)["uid"]
    except LookupError as e:
        raise Unresolved(str(e)) from e


def truth(ctx: Ctx, claim: dict, replay_cache: dict | None = None) -> tuple[set | str | float | None, dict]:
    """What the graph says, for the claim's subject: a set of uids, a status, or a number. Plus how it found out."""
    t, g = claim["type"], ctx.now
    db = ctx.db
    if t == "knows":
        s = _resolve(ctx, claim["subject"], "Service")
        rows = db.ro(g, "MATCH (p:Person)-[:KNOWS]->(:Service {uid: $s}) RETURN p.uid AS uid", {"s": s})
        return {r["uid"] for r in rows}, {"subject": s, "query": "MATCH (p:Person)-[:KNOWS]->(:Service {uid: $s})"}
    if t == "owns":
        s = _resolve(ctx, claim["subject"])
        if s.startswith("team:"):
            rows = db.ro(g, "MATCH (:Team {uid: $s})-[:OWNS]->(x:Service) RETURN x.uid AS uid", {"s": s})
        else:
            rows = db.ro(g, "MATCH (x:Team)-[:OWNS]->(:Service {uid: $s}) RETURN x.uid AS uid", {"s": s})
        return {r["uid"] for r in rows}, {"subject": s, "query": "OWNS"}
    if t == "depends_on":
        s = _resolve(ctx, claim["subject"], "Service")
        rows = db.ro(g, "MATCH (:Service {uid: $s})-[:DEPENDS_ON]->(x) RETURN x.uid AS uid", {"s": s})
        return {r["uid"] for r in rows}, {"subject": s, "query": "MATCH (s)-[:DEPENDS_ON]->(x)"}
    if t == "dependents":
        s = _resolve(ctx, claim["subject"], "Service")
        return set(impact.walk(db, g, [s])), {"subject": s, "query": "breadth-first walk up DEPENDS_ON"}
    if t == "breaks":
        d = scenario_diff(ctx, claim["scenario"], replay_cache)
        return {b["uid"] for b in d["breaks"] if b["effect"] == "break"}, {"scenario": claim["scenario"],
                                                                           "query": "fork + diff"}
    if t == "approvers":
        d = scenario_diff(ctx, claim["scenario"], replay_cache)
        return {a["team"] for a in d["approvals"]}, {"scenario": claim["scenario"], "query": "fork + diff: approvals"}
    if t == "exposed":
        d = scenario_diff(ctx, claim["scenario"], replay_cache)
        return {c["uid"] for c in d["customers"]}, {"scenario": claim["scenario"], "query": "fork + diff: customers"}
    if t == "decision":
        s = _resolve(ctx, claim["subject"], "Decision")
        row = db.one(ctx.org, "MATCH (d:Decision {uid: $s}) RETURN d.status AS status", {"s": s})
        return row["status"], {"subject": s, "query": "MATCH (d:Decision {uid: $s}) RETURN d.status"}
    if t == "count":
        m = claim.get("metric") or ("risk" if claim.get("scenario") else None)
        if m == "risk":
            return scenario_diff(ctx, claim["scenario"], replay_cache)["risk"]["score"], {"scenario": claim["scenario"]}
        sub = dict(claim, type={"knowers": "knows", "dependents": "dependents", "members": "members"}.get(m, ""))
        if m == "members":
            s = _resolve(ctx, claim["subject"], "Team")
            rows = db.ro(g, "MATCH (p:Person)-[:MEMBER_OF]->(:Team {uid: $s}) RETURN p.uid AS uid", {"s": s})
            return len(rows), {"subject": s}
        if m in ("knowers", "dependents"):
            got, how = truth(ctx, sub, replay_cache)
            return len(got), how
        raise Unresolved(f"unknown metric {m}")
    raise ValueError(t)


def scenario_diff(ctx: Ctx, uid: str | None, cache: dict | None = None) -> dict:
    """A universe's diff, on today's company: the stored one if nothing changed since it was forked, otherwise the
    same ops replayed on a throwaway copy of today's company."""
    from orion import universe as uv

    if not uid:
        raise Unresolved("a 'breaks' claim needs the universe it was simulated in")
    rec = uv.get(ctx.db, ctx.tenant, uid)
    if not rec:
        raise Unresolved(f"no universe {uid}")
    if rec.get("on"):
        return rec["diff"]  # a backtest is about its date, not about today
    if rec["base_version"] == dbm.version(ctx.db, ctx.tenant) and rec["status"] == "open":
        return rec["diff"]
    key = uid + "@" + str(dbm.version(ctx.db, ctx.tenant))
    if cache is not None and key in cache:
        return cache[key]
    d = uv.replay(ctx.db, ctx.tenant, rec["ops"])
    if cache is not None:
        cache[key] = d
    return d


def check(ctx: Ctx, claim: dict, rows_by_evidence: dict | None = None, cache: dict | None = None) -> dict:
    """Check one claim now. Returns {status, expected, missing, extra, why} and never raises on bad input."""
    t = claim.get("type", "text")
    out = {"checked_at": dbm.clock(ctx.db, ctx.tenant)}
    if t == "text":
        return out | _judge(claim, rows_by_evidence or {})
    sentence = claim.get("sentence", "")
    exhaustive = bool(claim.get("exhaustive")) or bool(EXHAUSTIVE.search(sentence))
    try:
        got, how = truth(ctx, claim, cache)
    except Unresolved as e:
        return out | {"status": "unconfirmed", "why": f"couldn't confirm: {e}"}
    except Exception as e:  # a malformed claim never counts as checked
        return out | {"status": "unconfirmed", "why": f"couldn't check: {e}"}
    names = _names(ctx)
    if isinstance(got, set):
        if not claim.get("objects"):
            if exhaustive and not got:
                return out | {"status": "verified", "expected": [], "why": "the graph returns nothing, as claimed", **how}
            return out | {"status": "unconfirmed", "why": "a set claim has to name what it is about"}
        try:
            label = {"knows": "Person", "dependents": "Service", "depends_on": None, "breaks": "Service",
                     "approvers": "Team", "exposed": "Customer"}.get(t)
            objs = {_resolve(ctx, o, label) for o in claim["objects"]}
        except Unresolved as e:
            return out | {"status": "unconfirmed", "why": f"couldn't confirm: {e}"}
        missing, extra = sorted(got - objs), sorted(objs - got)
        ok = (not missing and not extra) if exhaustive else not extra
        res = {"expected": sorted(names.get(u, u) for u in got), "missing": [names.get(u, u) for u in missing],
               "extra": [names.get(u, u) for u in extra], "exhaustive": exhaustive, **how}
        if not ok:
            why = []
            if extra:
                why.append("not true of " + ", ".join(names.get(u, u) for u in extra))
            if exhaustive and missing:
                why.append("also " + ", ".join(names.get(u, u) for u in missing))
            return out | res | {"status": "contradicted", "why": "; ".join(why)}
        covered = objs | {how.get("subject")} | _scenario_entities(ctx, claim)
        return out | res | _sentence_scope(ctx, sentence, covered, names)
    want = claim.get("value")
    if isinstance(got, (int, float)):
        try:
            ok = float(want) == float(got)
        except (TypeError, ValueError):
            ok = False
    else:
        ok = str(want).lower() == str(got).lower()
    if not ok:
        return out | {"status": "contradicted", "expected": got, "why": f"the graph says {got}", **how}
    covered = {how.get("subject")} | _scenario_entities(ctx, claim)
    if t == "decision":
        # a decision's sentence may name what it governs
        covered |= {r["uid"] for r in ctx.db.ro(ctx.org, "MATCH (:Decision {uid: $d})-[:AFFECTS]->(s) RETURN s.uid AS uid",
                                                {"d": how.get("subject")})}
    return out | {"expected": got, **how} | _sentence_scope(ctx, sentence, covered, names)


def _sentence_scope(ctx: Ctx, sentence: str, covered: set, names: dict) -> dict:
    """Verified only if the sentence doesn't name something the check didn't cover."""
    named = set(ctx.resolver().mentions(sentence))
    beyond = sorted(u for u in named - covered if not u.startswith(("tkt:", "dec:")))
    if beyond:
        return {"status": "partial", "why": "the sentence also names " + ", ".join(names.get(u, u) for u in beyond)
                + ", which this check doesn't cover"}
    return {"status": "verified", "why": "the graph returned exactly this"}


def _scenario_entities(ctx: Ctx, claim: dict) -> set:
    from orion import universe as uv

    if not claim.get("scenario"):
        return set()
    rec = uv.get(ctx.db, ctx.tenant, claim["scenario"])
    if not rec:
        return set()
    return {v for o in rec["ops"] for k, v in o.items() if k != "op" and isinstance(v, str)}


_NAMES: dict[str, dict] = {}


def _names(ctx: Ctx) -> dict:
    key = f"{ctx.tenant}:{dbm.version(ctx.db, ctx.tenant)}"
    if key not in _NAMES:
        rows = ctx.db.ro(ctx.org, "MATCH (n) WHERE n.uid IS NOT NULL AND (n:Person OR n:Service OR n:Team OR n:Customer "
                                  "OR n:Decision) RETURN n.uid AS uid, coalesce(n.name, n.key) AS name")
        _NAMES.clear()
        _NAMES[key] = {r["uid"]: r["name"] for r in rows}
    return _NAMES[key]


JUDGE = {"type": "object", "additionalProperties": False, "required": ["supported", "why"],
         "properties": {"supported": {"type": "boolean"}, "why": {"type": "string"}}}


def _judge(claim: dict, rows_by_evidence: dict) -> dict:
    cited = {e: rows_by_evidence.get(e) for e in claim.get("evidence") or [] if e in rows_by_evidence}
    if not cited:
        return {"status": "unsupported", "why": "cites no evidence"}
    if not llm.available():
        return {"status": "unsupported", "why": "no model to judge free text"}
    try:
        r = llm.json_call("You check one sentence against the database rows it cites. Supported means every part of "
                          "the sentence follows from the rows. Be strict; answer briefly.",
                          f"Sentence: {claim['sentence']}\n\nRows:\n{json.dumps(cited, default=str)[:12000]}", JUDGE)
    except Exception as e:
        return {"status": "unsupported", "why": f"couldn't judge: {e}"}
    return {"status": "judged" if r["supported"] else "unsupported", "why": r["why"]}


def about(ctx: Ctx, claim: dict, result: dict) -> list[str]:
    """The entities a claim depends on: when any of them changes, the claim is re-checked."""
    out = set(_scenario_entities(ctx, claim))
    if result.get("subject"):
        out.add(result["subject"])
    for o in claim.get("objects") or []:
        try:
            out.add(ctx.one(o)["uid"])
        except LookupError:
            pass
    names = {v: k for k, v in _names(ctx).items()}
    expected = result.get("expected")
    for n in expected if isinstance(expected, list) else []:
        if n in names:
            out.add(names[n])
    return sorted(u for u in out if u)
