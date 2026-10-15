"""The answer a visitor finds on the Ask screen is an ordinary answer: filed as Priya's last conversation, its what-if
forked again, and made stale by BILL-207 like any answer asked live. Also: what FalkorDB did for an answer is counted."""

from orion import db as dbm
from orion import memory, showcase
from orion import universe as uv
from orion.agents import navigator, sentinel

PRIYA, TOMASZ = "person:priya-raman", "person:tomasz-nowak"


def test_the_showcase_is_priyas_last_conversation_and_goes_stale_when_bill_207_lands(db, tenant):
    uid = showcase.seed(db, tenant)
    turns = memory.history(db, tenant, PRIYA)
    assert any(x.get("answer_uid") == uid for x in turns)
    # the what-if it cites exists again, under this tenant
    assert [u["title"] for u in uv.list_universes(db, tenant)] == ["Switch off sso-legacy"]
    assert db.exists(dbm.universe(tenant, "u1"))

    msg = "msg:test-bill-207"
    db.q(dbm.org(tenant), """MATCH (p:Person {uid: $a}) CREATE (:Source:Message {uid: $u, kind: 'message', channel: '#billing',
                             at: $at, text: 'BILL-207 is merged', title: '#billing'})-[:POSTED_BY]->(p)""",
         {"a": TOMASZ, "u": msg, "at": dbm.clock(db, tenant)})
    change = sentinel.change_from_op(db, tenant, {"op": "remove_dependency", "source": "svc:invoice-render",
                                                  "target": "svc:sso-legacy"})
    sentinel.apply_changes(db, tenant, msg, [change], [], dbm.tick(db, tenant), author_uid=TOMASZ)
    assert [n["answer_uid"] for n in sentinel.inbox(db, tenant, PRIYA)] == [uid]


def test_work_done_for_a_task_and_the_tasks_it_handed_on_is_counted_once_read(db, tenant):
    db.follows("task:child", "task:parent")
    with dbm.tagged("task:task:parent"):
        db.ro(dbm.org(tenant), "MATCH (n:Service) RETURN count(n) AS n")
    with dbm.tagged("task:task:child"):
        db.ro(dbm.org(tenant), "MATCH (n:Person) RETURN count(n) AS n")
    with dbm.tagged("board"):
        db.ro(dbm.org(tenant), "RETURN 1")
    w = db.work("task:parent")
    assert w["queries"] == 2 and w["graphs"] == [dbm.org(tenant)]
    assert db.work("task:parent") is None


def test_a_call_written_into_the_summary_is_taken_back_out():
    s = 'Two systems break.</summary>\n<parameter name="claims">[{"text": "a", "evidence": ["e1"]}]'
    out = navigator._unfold({"summary": s, "claims": [], "follow_ups": []})
    assert out["summary"] == "Two systems break." and out["claims"] == [{"text": "a", "evidence": ["e1"]}]
