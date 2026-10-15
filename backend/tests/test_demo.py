"""Every visitor gets a copy of their own: the story plays out in the copy and the template never moves."""

import time

from orion import db as dbm
from orion import demo, showcase
from orion import universe as uv
from orion.agents import sentinel

PRIYA, TOMASZ = "person:priya-raman", "person:tomasz-nowak"


def _bill_207(db, t):
    msg = "msg:test-bill-207"
    db.q(dbm.org(t), """MATCH (p:Person {uid: $a}) CREATE (:Source:Message {uid: $u, kind: 'message', channel: '#billing',
                        at: $at, text: 'BILL-207 is merged', title: '#billing'})-[:POSTED_BY]->(p)""",
         {"a": TOMASZ, "u": msg, "at": dbm.clock(db, t)})
    change = sentinel.change_from_op(db, t, {"op": "remove_dependency", "source": "svc:invoice-render",
                                             "target": "svc:sso-legacy"})
    sentinel.apply_changes(db, t, msg, [change], [], dbm.tick(db, t), author_uid=TOMASZ)


def test_a_visitors_copy_tells_the_story_without_touching_the_template_or_another_copy(db, tenant, monkeypatch):
    uid = showcase.seed(db, tenant)
    monkeypatch.setattr(demo, "TEMPLATE", tenant)
    mine, theirs = demo.create(db)["tenant"], demo.create(db)["tenant"]
    try:
        assert demo.is_demo(mine) and set(demo.active(db)) >= {mine, theirs}
        # the copy has its own what-if and answer, naming its own graphs
        u = uv.list_universes(db, mine)[0]
        assert u["graph"] == f"universe:{mine}:u1" and db.exists(u["graph"])
        payload = db.one(dbm.org(mine), "MATCH (a:Answer {uid: $a}) RETURN a.payload AS p", {"a": uid})["p"]
        assert f"universe:{mine}:u1" in payload and f":{tenant}:" not in payload
        version = dbm.version(db, tenant)

        _bill_207(db, mine)
        assert [n["answer_uid"] for n in sentinel.inbox(db, mine, PRIYA)] == [uid]
        # the template and the other visitor's copy still have the story to tell
        assert sentinel.inbox(db, tenant, PRIYA) == [] and sentinel.inbox(db, theirs, PRIYA) == []
        assert dbm.version(db, tenant) == version
        assert db.one(dbm.org(theirs), "MATCH (a:Answer {uid: $a}) RETURN a.status AS s", {"a": uid})["s"] == "fresh"
    finally:
        for t in (mine, theirs):
            demo.remove(db, t)
    assert demo.graphs_of(db, mine) == [] and mine not in demo.seen(db)


def test_idle_copies_and_copies_past_the_cap_are_cleaned_up(db, tenant, monkeypatch):
    monkeypatch.setattr(demo, "TEMPLATE", tenant)
    made = [demo.create(db)["tenant"] for _ in range(3)]
    try:
        db.set(demo.SEEN + made[0], "0")  # idle for decades
        gone = demo.gc(db, keep=10)
        assert made[0] in gone and not demo.graphs_of(db, made[0])
        gone = demo.gc(db, keep=1)
        assert len([t for t in made[1:] if t in gone]) >= 1
    finally:
        for t in made:
            if demo.graphs_of(db, t) or t in demo.seen(db):
                demo.remove(db, t)


def test_a_full_server_evicts_idle_copies_first_and_refuses_when_every_copy_is_in_use(db, tenant, monkeypatch):
    import pytest

    monkeypatch.setattr(demo, "TEMPLATE", tenant)
    old = demo.create(db)["tenant"]
    try:
        db.set(demo.SEEN + old, str(time.time() - 5 * 60))  # idle long enough to be evicted, not yet to expire
        cap = 100 * 2 ** 20
        usage = iter([95 * 2 ** 20, 30 * 2 ** 20])  # full, then room once the idle copy is gone
        monkeypatch.setattr(demo, "memory", lambda db_: (next(usage), cap))
        new = demo.create(db)["tenant"]
        assert not demo.graphs_of(db, old) and demo.graphs_of(db, new)
        # every copy in use and still no room: refuse rather than take someone's copy away
        monkeypatch.setattr(demo, "memory", lambda db_: (95 * 2 ** 20, cap))
        with pytest.raises(demo.Full):
            demo.create(db)
        assert demo.graphs_of(db, new)
    finally:
        for t in list(demo.seen(db)):
            if t in (old,) or demo.graphs_of(db, t):
                demo.remove(db, t)
