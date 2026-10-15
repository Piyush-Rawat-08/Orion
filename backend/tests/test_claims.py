"""Typed claims are checked by the graph, and a sentence is held to its claim. No model calls."""

import pytest

from orion import claims as cl
from orion import universe as uv


def check(db, t, **kw):
    return cl.check(db, t, {"text": "", "kind": "knows", "subject": "", "objects": [], "exhaustive": False} | kw)


def test_a_true_set_claim_verifies_and_a_false_one_is_contradicted(db, tenant):
    assert check(db, tenant, text="Ines Okafor knows the ledger.", subject="ledger", objects=["Ines Okafor"])["verdict"] == "verified"
    bad = check(db, tenant, text="Tomasz knows the ledger.", subject="ledger", objects=["Tomasz Nowak"])
    assert bad["verdict"] == "contradicted" and "Tomasz Nowak" in bad["reason"]


def test_only_makes_a_set_claim_exhaustive_whatever_the_model_typed(db, tenant):
    # three people know identity: "only Yusuf" leaves two out
    r = check(db, tenant, text="Only Yusuf Demir knows identity.", subject="identity", objects=["Yusuf Demir"])
    assert r["verdict"] == "partial" and "Kofi Mensah" in r["reason"]
    assert check(db, tenant, text="Yusuf Demir knows identity.", subject="identity",
                 objects=["Yusuf Demir"])["verdict"] == "verified"


def test_a_sentence_that_names_more_than_its_claim_is_only_partly_checked(db, tenant):
    r = check(db, tenant, text="Ines Okafor knows the ledger, and Helio Robotics relies on it.", subject="ledger",
              objects=["Ines Okafor"])
    assert r["verdict"] == "partial" and "Helio Robotics" in r["reason"]


def test_names_that_match_nothing_are_unsupported_never_contradicted(db, tenant):
    with pytest.raises(cl.CheckError) as e:
        check(db, tenant, text="Zed knows the ledger.", subject="ledger", objects=["Zed Zebedee"])
    assert e.value.verdict == "unsupported"


def test_a_set_claim_that_names_nobody_is_refused_unless_it_says_nobody(db, tenant):
    with pytest.raises(cl.CheckError):
        check(db, tenant, text="People know the ledger.", subject="ledger")
    assert check(db, tenant, text="Nobody knows reports-legacy.", subject="reports-legacy",
                 exhaustive=True)["verdict"] == "verified"


def test_what_if_claims_are_checked_against_the_universe(db, tenant):
    rec = uv.fork(db, tenant, [{"op": "deprecate_service", "service": "sso-legacy"}], created_by="person:priya-raman")
    u = rec["uid"]
    assert check(db, tenant, kind="breaks", subject=u, text="Switching off sso-legacy breaks invoice-render.",
                 objects=["invoice-render"])["verdict"] == "verified"
    assert check(db, tenant, kind="breaks", subject=u, text="Helio Robotics and Pinecrest Bank would notice.",
                 objects=["Helio Robotics", "Pinecrest Bank"])["verdict"] == "verified"
    assert check(db, tenant, kind="metric", subject=u, measure="risk", value=str(rec["risk"]),
                 text=f"It scores {rec['risk']}.")["verdict"] == "verified"
    assert check(db, tenant, kind="metric", subject=u, measure="risk", value="3", text="It scores 3.")["verdict"] == "contradicted"
    names = [b["service"] for b in rec["diff"]["broken"]]
    r = check(db, tenant, kind="count", subject=u, measure="broken", value=str(len(names)),
              text=f"{len(names)} systems would break: {', '.join(names)}.")
    assert r["verdict"] == "verified"  # the names it lists are the ones the check returned


def test_decision_status(db, tenant):
    assert check(db, tenant, kind="decided", subject="ADR-011", value="reversed", text="ADR-011 was reversed.")["verdict"] == "verified"
    assert check(db, tenant, kind="decided", subject="ADR-011", value="accepted", text="ADR-011 is in force.")["verdict"] == "contradicted"


def test_orphan_and_approver_claims_are_checked_against_what_the_what_if_found(db, tenant):
    rec = uv.fork(db, tenant, [{"op": "remove_person", "person": "Ines Okafor"}], created_by="person:daniel-osei")
    u = rec["uid"]
    assert check(db, tenant, kind="orphans", subject=u, objects=["ledger"],
                 text="If Ines Okafor left, nobody would know the ledger.")["verdict"] == "verified"
    assert check(db, tenant, kind="orphans", subject=u, objects=["identity"],
                 text="Nobody would know identity.")["verdict"] == "contradicted"
    sso = uv.fork(db, tenant, [{"op": "deprecate_service", "service": "sso-legacy"}], created_by="person:priya-raman")
    r = check(db, tenant, kind="approvers", subject=sso["uid"], objects=["Billing", "Console", "Data", "Platform"],
              exhaustive=True, text="Billing, Console, Data and Platform must all agree.")
    assert r["verdict"] == "verified"
    assert check(db, tenant, kind="count", subject=sso["uid"], measure="approvers", value="4",
                 text="Four teams must agree.")["verdict"] == "verified"
