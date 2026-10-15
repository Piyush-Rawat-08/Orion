"""A change of fact re-checks the answers that relied on it, and only those. The Sentinel weighs who said it.
No model calls: the Cartographer is bypassed and changes go straight to the Sentinel."""

import json

from orion import claims as cl
from orion import db as dbm
from orion import deck, memory, ops as opsm, security, watch
from orion import universe as uv
from orion.agents import sentinel
from orion.tools import Ctx


def _answer(db, t, user, claims_in):
    ctx = Ctx(db, t, user)
    checked = []
    for c in claims_in:
        c = {"sentence": "", "type": "knows", "subject": "", "objects": [], "exhaustive": False, "value": None,
             "metric": None, "scenario": None, "evidence": []} | c
        r = cl.check(ctx, c)
        checked.append({"claim": c, "result": r, "about": cl.about(ctx, c, r)})
    return watch.store(db, t, user=user, question="q", text="a", checked=checked, evidence=[], session="s", meta={})


def _message(db, t, author, text):
    uid = "msg:test-" + str(abs(hash(text)) % 10**6)
    db.q(dbm.org(t), """MATCH (p:Person {uid: $a}) CREATE (:Source:Message {uid: $u, kind: 'message', channel: '#billing',
                        at: $at, text: $text, title: '#billing'})-[:POSTED_BY]->(p)""",
         {"a": author, "u": uid, "at": dbm.clock(db, t), "text": text})
    return uid


def test_moving_invoice_render_off_sso_legacy_outdates_exactly_the_claims_that_relied_on_it(db, tenant):
    priya = "person:priya-raman"
    rec = uv.fork(db, tenant, [opsm.parse("retire_service:service=sso-legacy")], by=priya)
    ans = _answer(db, tenant, priya, [
        {"sentence": "It breaks invoice-render and reports-legacy.", "type": "breaks",
         "objects": ["invoice-render", "reports-legacy"], "exhaustive": True, "scenario": rec["uid"]},
        {"sentence": "Ines Okafor knows the ledger.", "subject": "ledger", "objects": ["Ines Okafor"]},
    ])
    msg = _message(db, tenant, "person:tomasz-nowak", "invoice-render no longer calls sso-legacy")
    out = sentinel.handle(db, tenant, msg, "person:tomasz-nowak",
                          {"op": "remove_dependency", "service": "svc:invoice-render", "on": "svc:sso-legacy"})
    assert out["result"] == "applied" and out["authority"] >= 0.8
    changed = {c["sentence"]: c for c in out["rechecked"]}
    assert set(changed) == {"It breaks invoice-render and reports-legacy."}
    c = changed["It breaks invoice-render and reports-legacy."]
    assert c["before"] == "verified" and c["after"] == "outdated" and c["now"] == ["reports-legacy"]
    a = watch.answer(db, tenant, ans)
    assert a["status"] == "changed"
    assert {x["sentence"]: x["status"] for x in a["claims"]}["Ines Okafor knows the ledger."] == "verified"
    # the fact is closed, not deleted, and points at the message that closed it
    row = db.one(dbm.org(tenant), """MATCH (:Service {name: 'invoice-render'})-[r:DEPENDS_ON]->(:Service {name: 'sso-legacy'})
                                     RETURN r.valid_to AS vt, r.closed_by AS by""")
    assert row["vt"] != "9999-12-31" and row["by"] == msg
    # the asker is told
    notes = db.ro(dbm.deck(tenant), "MATCH (n:Notification {user: $u}) RETURN n.sentence AS s", {"u": priya})
    assert [n["s"] for n in notes] == ["It breaks invoice-render and reports-legacy."]


def test_someone_outside_the_owning_team_goes_to_review_and_only_the_owners_can_accept(db, tenant):
    msg = _message(db, tenant, "person:sam-okoro", "ledger depends on warehouse now")
    out = sentinel.handle(db, tenant, msg, "person:sam-okoro",
                          {"op": "add_dependency", "service": "svc:ledger", "on": "svc:warehouse", "kind": "data"})
    assert out["result"] == "review" and out["authority"] < 0.8
    try:
        sentinel.review(db, tenant, out["review"], "person:sam-okoro", accept=True)
        raise AssertionError("Console accepted a Billing change")
    except PermissionError:
        pass
    assert sentinel.review(db, tenant, out["review"], "person:ines-okafor", accept=True)["result"] == "applied"


def test_hedged_statements_lose_authority(db, tenant):
    msg = _message(db, tenant, "person:tomasz-nowak", "I think invoice-render might not need the ledger anymore")
    out = sentinel.handle(db, tenant, msg, "person:tomasz-nowak",
                          {"op": "remove_dependency", "service": "svc:invoice-render", "on": "svc:ledger", "hedged": True})
    assert out["result"] == "review"


def test_memory_is_per_person(db, tenant):
    memory.remember(db, tenant, "person:priya-raman", "s1", "remember that I care about sso-legacy", "noted", "ans:1",
                    ["svc:sso-legacy"])
    memory.remember(db, tenant, "person:daniel-osei", "s2", "who owns the ledger?", "Billing", "ans:2", ["svc:ledger"])
    priya = memory.timeline(db, tenant, "person:priya-raman")
    daniel = memory.timeline(db, tenant, "person:daniel-osei")
    assert [b["text"] for b in priya["beliefs"]] == ["I care about sso-legacy"]
    assert daniel["beliefs"] == [] and "ledger" not in json.dumps(priya["sessions"])
    assert dbm.mem(tenant, "person:priya-raman") != dbm.mem(tenant, "person:daniel-osei")
    # recall brings back the earlier exchange about the same entity, from another session
    r = memory.recall(db, tenant, "person:priya-raman", "what breaks if we retire sso-legacy?", "s9")
    assert any(i["kind"] == "belief" for i in r["items"])


def test_tokens_name_one_person_and_one_tenant():
    tok = security.mint("corvane", "person:priya-raman")
    assert security.read(tok)["u"] == "person:priya-raman"
    s = security.session("corvane", authorization=f"Bearer {tok}")
    assert s.user == "person:priya-raman"
    for bad in (lambda: security.session("other", authorization=f"Bearer {tok}"),
                lambda: security.read(tok[:-2] + "00")):
        try:
            bad()
            raise AssertionError("accepted a bad token")
        except Exception as e:
            assert getattr(e, "status_code", 0) in (401, 403)


def test_a_task_is_claimed_once_even_by_racing_workers(db, tenant):
    from concurrent.futures import ThreadPoolExecutor

    uids = [deck.post(db, tenant, "fork", {"i": i}) for i in range(12)]
    with ThreadPoolExecutor(8) as pool:
        got = list(pool.map(lambda _: deck.claim(db, tenant, "Simulator", kind="fork"), range(30)))
    claimed = [g["uid"] for g in got if g]
    assert sorted(claimed) == sorted(uids) and len(set(claimed)) == len(claimed)
