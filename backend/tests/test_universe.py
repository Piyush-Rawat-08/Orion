"""Forks, diffs, approvals and merges on the Corvane storylines."""

import pytest

from orion import epoch as ep
from orion import ops as opsm
from orion import universe as uv

PRIYA, DANIEL, CHLOE, ARJUN, SVEN = ("person:priya-raman", "person:daniel-osei", "person:chloe-dubois",
                                     "person:arjun-mehta", "person:sven-lindqvist")


def test_retiring_sso_legacy_breaks_invoices_through_the_ghost_dependency(db, tenant):
    rec = uv.fork(db, tenant, [opsm.parse("retire_service:service=sso-legacy")], by=PRIYA)
    d = rec["diff"]
    effects = {b["name"]: b["effect"] for b in d["breaks"]}
    assert effects == {"invoice-render": "break", "reports-legacy": "break", "billing-api": "degrade",
                       "web-console": "degrade", "onboarding": "degrade"}
    ghost = next(b for b in d["breaks"] if b["name"] == "invoice-render")
    assert ghost["facts"] == ["dep:invoice-render->sso-legacy@2024-06-10"]
    assert {c["name"] for c in d["customers"]} >= {"Helio Robotics", "Pinecrest Bank", "Northgate Retail"}
    assert {a["team_name"] for a in d["approvals"]} == {"Platform", "Billing", "Console", "Data"}
    assert d["risk"]["level"] == "danger"
    # the score is the sum of its terms, capped at 100
    assert d["risk"]["score"] == min(100, round(sum(t["points"] for t in d["risk"]["terms"])))


def test_what_was_known_that_day_hides_the_ghost(db, tenant):
    known = uv.fork(db, tenant, [opsm.parse("retire_service:service=sso-legacy")], by=PRIYA, on="2026-03-02",
                    mode="known")
    true = uv.fork(db, tenant, [opsm.parse("retire_service:service=sso-legacy")], by=PRIYA, on="2026-03-02",
                   mode="true")
    assert "invoice-render" not in {b["name"] for b in known["diff"]["breaks"]}
    assert "invoice-render" in {b["name"] for b in true["diff"]["breaks"]}
    assert known["risk"] < 35 <= true["risk"]
    with pytest.raises(ValueError):
        uv.approve(db, tenant, known["uid"], PRIYA)


def test_ines_leaving_leaves_nobody_who_knows_the_ledger(db, tenant):
    d = uv.fork(db, tenant, [opsm.parse("remove_person:person=Ines Okafor")], by=DANIEL)["diff"]
    assert [o["name"] for o in d["orphans"]] == ["ledger"]
    assert d["orphans"][0]["knew"] == ["Ines Okafor"]


def test_only_required_teams_approve_and_dangling_dependencies_block_the_merge(db, tenant):
    rec = uv.fork(db, tenant, [opsm.parse("retire_service:service=sso-legacy")], by=PRIYA)
    with pytest.raises(PermissionError):
        uv.approve(db, tenant, rec["uid"], SVEN)  # Runtime isn't affected
    for who in (PRIYA, DANIEL, CHLOE):
        assert uv.approve(db, tenant, rec["uid"], who)["result"] == "approved"
    out = uv.approve(db, tenant, rec["uid"], ARJUN)
    assert out["result"] == "blocked" and out["status"] == "open"
    merged = uv.approve(db, tenant, rec["uid"], ARJUN, force=True)
    assert merged["result"] == "merged"
    # forced: the breakage stays visible on the main graph
    now = ep.now(db, tenant)
    assert db.ro(now, "MATCH (:Service {name: 'invoice-render'})-[:DEPENDS_ON]->(s:Retired) RETURN s.name AS n") == \
        [{"n": "sso-legacy"}]


def test_a_merged_migration_becomes_facts_with_a_decision_as_source(db, tenant):
    rec = uv.fork(db, tenant, [opsm.parse("retire_service:service=sso-legacy,replacement=identity")], by=PRIYA)
    assert rec["diff"]["breaks"] == []
    out = uv.approve(db, tenant, rec["uid"], PRIYA)
    assert out["result"] == "merged"
    org = f"org:{tenant}"
    rows = db.ro(org, """MATCH (d:Service {name: 'invoice-render'})-[r:DEPENDS_ON]->(s:Service)
                         WHERE s.name IN ['sso-legacy', 'identity'] RETURN s.name AS s, r.valid_to AS vt, r.src AS src,
                         r.closed_by AS closed ORDER BY s""")
    assert rows[0]["s"] == "identity" and rows[0]["src"] == out["decision"]
    assert rows[1]["s"] == "sso-legacy" and rows[1]["closed"] == out["decision"] and rows[1]["vt"] != "9999-12-31"
    # nothing was deleted from the org graph: the old fact is closed, still there
    assert db.one(org, "MATCH (d:Decision {uid: $d})-[:DECIDED_BY]->(p) RETURN p.name AS n", {"d": out["decision"]})


def test_a_stale_plan_is_rebased_or_closed(db, tenant):
    a = uv.fork(db, tenant, [opsm.parse("retire_service:service=sso-legacy")], by=PRIYA)
    b = uv.fork(db, tenant, [opsm.parse("retire_service:service=sso-legacy,replacement=identity")], by=PRIYA)
    c = uv.fork(db, tenant, [opsm.parse("remove_person:person=Ines Okafor")], by=DANIEL)
    uv.approve(db, tenant, b["uid"], PRIYA)  # merges, the company moves on
    assert uv.approve(db, tenant, a["uid"], PRIYA)["result"] == "obsolete"
    out = uv.approve(db, tenant, c["uid"], DANIEL)
    assert out["result"] == "rebased" and out["approvals"] == []


def test_ops_can_not_use_what_an_earlier_op_removed(db, tenant):
    with pytest.raises(opsm.OpError):
        uv.fork(db, tenant, [opsm.parse("merge_teams:team=Signals,into=Platform"),
                             opsm.parse("move_ownership:service=ledger,team=Signals")], by=PRIYA)


def test_only_an_open_universe_can_be_discarded(db, tenant):
    rec = uv.fork(db, tenant, [opsm.parse("retire_service:service=sso-legacy,replacement=identity")], by=PRIYA)
    uv.approve(db, tenant, rec["uid"], PRIYA)
    with pytest.raises(ValueError):
        uv.discard(db, tenant, rec["uid"], PRIYA)
