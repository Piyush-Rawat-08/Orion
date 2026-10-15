"""Forks, diffs, approvals and merges on the Corvane storylines. No model calls."""

import pytest

from orion import db as dbm
from orion import epoch as ep
from orion import ops as opsm
from orion import universe as uv
from orion.agents import sentinel

PRIYA, DANIEL, CHLOE, ARJUN, SVEN, GRACE, TOMASZ = (
    "person:priya-raman", "person:daniel-osei", "person:chloe-dubois", "person:arjun-mehta", "person:sven-lindqvist",
    "person:grace-liu", "person:tomasz-nowak")
SSO_OFF = [{"op": "deprecate_service", "service": "sso-legacy"}]
GHOST = "dep:invoice-render->sso-legacy@2024-06-10"


def test_switching_off_sso_legacy_breaks_invoices_through_the_ghost_dependency(db, tenant):
    d = uv.fork(db, tenant, SSO_OFF, created_by=PRIYA)["diff"]
    effects = {b["service"]: b["effect"] for b in d["broken"]}
    assert effects["invoice-render"] == "break" and effects["reports-legacy"] == "break"
    assert {"billing-api", "web-console", "onboarding"} <= set(effects)
    ghost = next(b for b in d["broken"] if b["service"] == "invoice-render")
    assert GHOST in ghost["fact_uids"] and ghost["via_undeclared"]
    assert {c["customer"] for c in d["customers"]} >= {"Helio Robotics", "Pinecrest Bank", "Northgate Retail"}
    assert {a["team"] for a in d["required_approvers"]} == {"Platform", "Billing", "Console", "Data"}
    assert d["risk"]["level"] == "high"
    # the score is the sum of its terms, capped at 100
    assert d["risk"]["score"] == min(100, round(sum(t["points"] for t in d["risk"]["terms"])))


def test_what_was_written_down_that_day_hides_the_ghost(db, tenant):
    known = uv.fork(db, tenant, SSO_OFF, created_by=PRIYA, asof="2026-03-02", known=True)
    true = uv.fork(db, tenant, SSO_OFF, created_by=PRIYA, asof="2026-03-02", known=False)
    assert "invoice-render" not in {b["service"] for b in known["diff"]["broken"]}
    assert "invoice-render" in {b["service"] for b in true["diff"]["broken"]}
    assert known["risk"] < true["risk"]
    with pytest.raises(ValueError):
        uv.approve(db, tenant, known["uid"], PRIYA)  # a backtest is about the past: nothing to apply


def test_ines_leaving_leaves_nobody_who_knows_the_ledger(db, tenant):
    d = uv.fork(db, tenant, [{"op": "remove_person", "person": "Ines Okafor"}], created_by=DANIEL)["diff"]
    assert "ledger" in {o["service"] for o in d["new_orphans"]}


def test_a_merge_that_would_strand_dependents_is_blocked_unless_forced(db, tenant):
    rec = uv.fork(db, tenant, SSO_OFF, created_by=PRIYA)
    out = uv.approve(db, tenant, rec["uid"], PRIYA)
    assert out["status"] == "blocked" and "invoice-render" in out["needs_migration"]
    for who in (PRIYA, DANIEL, CHLOE):
        assert uv.approve(db, tenant, rec["uid"], who, force=True)["status"] == "waiting"
    assert uv.approve(db, tenant, rec["uid"], ARJUN, force=True)["status"] == "merged"
    now = ep.now(db, tenant)
    assert db.ro(now, "MATCH (:Service {name: 'invoice-render'})-[:DEPENDS_ON]->(s:Retired) RETURN s.name AS n") == \
        [{"n": "sso-legacy"}]


def test_someone_on_no_required_team_does_not_count(db, tenant):
    rec = uv.fork(db, tenant, [{"op": "reassign_owner", "service": "alert-router", "team": "Platform"}], created_by=PRIYA)
    out = uv.approve(db, tenant, rec["uid"], SVEN)  # Runtime has nothing to do with it
    assert out["status"] == "waiting" and len(out["missing"]) == 2


def test_a_merged_change_closes_the_old_fact_and_opens_one_with_the_decision_as_source(db, tenant):
    rec = uv.fork(db, tenant, [{"op": "reassign_owner", "service": "alert-router", "team": "Platform"}],
                  kind="dryrun", created_by=PRIYA)
    assert uv.approve(db, tenant, rec["uid"], PRIYA)["status"] == "waiting"
    out = uv.approve(db, tenant, rec["uid"], GRACE)
    assert out["status"] == "merged"
    rows = db.ro(dbm.org(tenant), """MATCH (t:Team)-[r:OWNS]->(:Service {name: 'alert-router'}) WHERE r.declared = true
                                     RETURN t.name AS team, r.valid_to AS vt, r.src AS src, r.closed_by AS closed
                                     ORDER BY team""")
    by = {r["team"]: r for r in rows}
    assert by["Platform"]["src"] == out["decision"] and by["Platform"]["vt"] == "9999-12-31"
    assert by["Signals"]["closed"] == out["decision"] and by["Signals"]["vt"] != "9999-12-31"


def test_a_plan_whose_outcome_changed_is_rebased_before_anyone_approves_it(db, tenant):
    rec = uv.fork(db, tenant, SSO_OFF, created_by=PRIYA)
    change = sentinel.change_from_op(db, tenant, {"op": "remove_dependency", "source": "svc:invoice-render",
                                                  "target": "svc:sso-legacy"})
    db.q(dbm.org(tenant), """MATCH (p:Person {uid: $a}) CREATE (:Source:Message {uid: 'msg:t1', kind: 'message',
                             channel: '#billing', at: $at, text: 'moved off'})-[:POSTED_BY]->(p)""",
         {"a": TOMASZ, "at": dbm.clock(db, tenant)})
    sentinel.apply_changes(db, tenant, "msg:t1", [change], [], dbm.tick(db, tenant), author_uid=TOMASZ)
    out = uv.approve(db, tenant, rec["uid"], PRIYA)
    assert out["status"] == "rebase_needed" and "invoice-render" in out["broken"]["no_longer"]


def test_ops_can_not_use_what_an_earlier_op_removed(db, tenant):
    with pytest.raises(opsm.OpError):
        uv.fork(db, tenant, [{"op": "merge_teams", "team": "Signals", "into": "Platform"},
                             {"op": "reassign_owner", "service": "ledger", "team": "Signals"}], created_by=PRIYA)


def test_only_an_open_universe_can_be_rejected(db, tenant):
    rec = uv.fork(db, tenant, SSO_OFF, created_by=PRIYA)
    assert uv.discard(db, tenant, rec["uid"], PRIYA)["status"] == "discarded"
    with pytest.raises(ValueError):
        uv.discard(db, tenant, rec["uid"], PRIYA)
