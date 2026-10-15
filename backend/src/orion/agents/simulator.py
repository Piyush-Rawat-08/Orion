"""The Simulator: turns a what-if written in plain words into typed changes, forks the company and diffs it.

"Ines Okafor leaves the company" becomes remove_person; "switch off sso-legacy next quarter" deprecate_service;
"combine Signals into Platform" merge_teams. Anything it had to assume is returned with the result.
"""

from __future__ import annotations

from orion import db as dbm
from orion import epoch as ep
from orion import llm

SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["title", "ops", "assumptions"],
    "properties": {
        "title": {"type": "string", "description": "short, in plain words"},
        "ops": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "required": ["op", "service", "person", "team", "into", "source", "target", "kind", "decision"],
            "properties": {
                "op": {"type": "string", "enum": ["deprecate_service", "remove_person", "move_person", "reassign_owner",
                                                  "add_dependency", "remove_dependency", "reverse_decision", "merge_teams"]},
                "service": {"type": ["string", "null"]}, "person": {"type": ["string", "null"]},
                "team": {"type": ["string", "null"]}, "into": {"type": ["string", "null"]},
                "source": {"type": ["string", "null"]}, "target": {"type": ["string", "null"]},
                "kind": {"anyOf": [{"type": "string", "enum": ["sync", "async", "data"]}, {"type": "null"}]},
                "decision": {"type": ["string", "null"]}}}},
        "assumptions": {"type": "array", "items": {"type": "string"}},
    },
}

SYSTEM = """You turn a what-if about a company into typed changes. Changes:
deprecate_service{{service}} (switch a system off), remove_person{{person}} (someone leaves), move_person{{person, team}},
reassign_owner{{service, team}}, add_dependency{{source, target, kind}}, remove_dependency{{source, target}},
reverse_decision{{decision}}, merge_teams{{team, into}} (team is absorbed into into).
Fill only the fields a change uses; the rest are null. Use these names exactly.
Services: {services}. People: {people}. Teams: {teams}.
If you had to guess something, say what in assumptions."""


def to_ops(db: dbm.DB, t: str, scenario: str) -> dict:
    g = ep.now(db, t)
    services = ", ".join(r["n"] for r in db.ro(g, "MATCH (s:Service) RETURN s.name AS n ORDER BY n"))
    people = ", ".join(r["n"] for r in db.ro(g, "MATCH (p:Person) RETURN p.name AS n ORDER BY n"))
    teams = ", ".join(r["n"] for r in db.ro(g, "MATCH (x:Team) RETURN x.name AS n ORDER BY n"))
    out = llm.json_call(SYSTEM.format(services=services, people=people, teams=teams), scenario, SCHEMA)
    out["ops"] = [{k: v for k, v in o.items() if v not in (None, "")} for o in out["ops"]]
    return out


def simulate(db: dbm.DB, t: str, scenario: str, user: str | None, uid: str | None = None, task: str | None = None) -> dict:
    from orion import universe as uv

    plan = to_ops(db, t, scenario)
    if not plan["ops"]:
        raise ValueError(f"couldn't turn '{scenario}' into a change")
    res = uv.fork(db, t, plan["ops"], kind="whatif", title=plan["title"] or scenario, created_by=user or "simulator",
                  uid=uid, task=task)
    return res | {"assumptions": plan["assumptions"], "scenario": scenario}
