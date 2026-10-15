"""Typed claims are checked by the graph, and a sentence is held to its claim. No model calls."""

from orion import claims as cl
from orion import ops as opsm
from orion import universe as uv
from orion.tools import Ctx


def claim(**kw):
    base = {"sentence": "", "type": "knows", "subject": "", "objects": [], "exhaustive": False, "value": None,
            "metric": None, "scenario": None, "evidence": []}
    return base | kw


def test_a_true_set_claim_verifies_and_a_false_one_is_contradicted(db, tenant):
    ctx = Ctx(db, tenant)
    ok = cl.check(ctx, claim(sentence="Ines Okafor knows the ledger.", subject="ledger", objects=["Ines Okafor"]))
    assert ok["status"] == "verified"
    bad = cl.check(ctx, claim(sentence="Tomasz knows the ledger.", subject="ledger", objects=["Tomasz Nowak"]))
    assert bad["status"] == "contradicted" and "Tomasz Nowak" in bad["why"]


def test_only_makes_a_set_claim_exhaustive_whatever_the_model_typed(db, tenant):
    ctx = Ctx(db, tenant)
    # three people know identity; "only Yusuf" is false even though Yusuf does know it
    r = cl.check(ctx, claim(sentence="Only Yusuf Demir knows identity.", subject="identity", objects=["Yusuf Demir"],
                            exhaustive=False))
    assert r["status"] == "contradicted" and r["exhaustive"]
    assert cl.check(ctx, claim(sentence="Yusuf Demir knows identity.", subject="identity",
                               objects=["Yusuf Demir"]))["status"] == "verified"


def test_a_sentence_that_names_more_than_its_claim_is_only_partly_checked(db, tenant):
    ctx = Ctx(db, tenant)
    r = cl.check(ctx, claim(sentence="Ines Okafor knows the ledger, and Helio Robotics depends on it.", subject="ledger",
                            objects=["Ines Okafor"]))
    assert r["status"] == "partial" and "Helio Robotics" in r["why"]


def test_names_that_match_nothing_are_unconfirmed_never_contradicted(db, tenant):
    ctx = Ctx(db, tenant)
    r = cl.check(ctx, claim(sentence="Zed knows the ledger.", subject="ledger", objects=["Zed Zebedee"]))
    assert r["status"] == "unconfirmed"
    r = cl.check(ctx, claim(sentence="Someone knows the quantum mainframe.", subject="quantum mainframe", objects=["Ines"]))
    assert r["status"] == "unconfirmed"


def test_a_set_claim_that_names_nothing_is_refused(db, tenant):
    ctx = Ctx(db, tenant)
    assert cl.check(ctx, claim(sentence="People know the ledger.", subject="ledger"))["status"] == "unconfirmed"
    # ...unless it says there is nobody, and there is nobody
    r = cl.check(ctx, claim(sentence="Nobody knows reports-legacy.", subject="reports-legacy", exhaustive=True))
    assert r["status"] == "verified"


def test_scenario_claims_are_checked_against_the_universe(db, tenant):
    ctx = Ctx(db, tenant)
    rec = uv.fork(db, tenant, [opsm.parse("retire_service:service=sso-legacy")], by="person:priya-raman")
    u = rec["uid"]
    assert cl.check(ctx, claim(sentence="Retiring sso-legacy breaks invoice-render and reports-legacy.", type="breaks",
                               objects=["invoice-render", "reports-legacy"], exhaustive=True, scenario=u))["status"] == "verified"
    assert cl.check(ctx, claim(sentence="Billing, Console, Data and Platform must approve.", type="approvers",
                               objects=["Billing", "Console", "Data", "Platform"], exhaustive=True,
                               scenario=u))["status"] == "verified"
    assert cl.check(ctx, claim(sentence=f"It scores {rec['risk']}.", type="count", value=rec["risk"],
                               scenario=u))["status"] == "verified"
    assert cl.check(ctx, claim(sentence="It scores 3.", type="count", metric="risk", value=3,
                               scenario=u))["status"] == "contradicted"


def test_decision_status(db, tenant):
    ctx = Ctx(db, tenant)
    assert cl.check(ctx, claim(sentence="ADR-011 was reversed.", type="decision", subject="ADR-011",
                               value="reversed"))["status"] == "verified"
    assert cl.check(ctx, claim(sentence="ADR-011 is in force.", type="decision", subject="ADR-011",
                               value="accepted"))["status"] == "contradicted"
