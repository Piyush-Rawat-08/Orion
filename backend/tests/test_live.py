"""A change of fact re-checks the answers that relied on it, and only those. The Sentinel weighs who said it.
No model calls: the Cartographer is bypassed and changes go straight to the Sentinel."""

import json

from orion import blackboard, memory, security
from orion import db as dbm
from orion import universe as uv
from orion.agents import navigator, sentinel
from orion.agents.verifier import verify

PRIYA, DANIEL, TOMASZ, SAM, INES = ("person:priya-raman", "person:daniel-osei", "person:tomasz-nowak",
                                    "person:sam-okoro", "person:ines-okafor")


def _answer(db, t, user, claims):
    """Store an answer the way the Navigator does, without a model: typed claims, checked by the graph."""
    verdicts = verify(db, claims, [], tenant=t, use_llm=False)
    uid = f"answer:test{abs(hash(json.dumps(claims))) % 10**6}"
    rows = [{"uid": f"{uid}:c{v['index']}", "text": v["text"], "verdict": v["verdict"], "reason": v["reason"],
             "evidence": "[]", "facts": [], "nodes": "[]", "reads": sorted(navigator._typed_reads(db, t, c)),
             "kind": c["kind"], "typed": json.dumps(c), "check": None} for v, c in zip(verdicts, claims)]
    navigator.persist(db, t, uid, "q", user, dbm.clock(db, t), "a", rows)
    payload = {"summary": "a", "claims": [v | {"uid": r["uid"], "typed": c} for v, r, c in zip(verdicts, rows, claims)],
               "follow_ups": [], "evidence": [], "universes": []}
    db.q(dbm.org(t), "MATCH (a:Answer {uid: $a}) SET a.payload = $p", {"a": uid, "p": json.dumps(payload)})
    return uid, verdicts


def _message(db, t, author, text):
    uid = "msg:test-" + str(abs(hash(text)) % 10**6)
    db.q(dbm.org(t), """MATCH (p:Person {uid: $a}) CREATE (:Source:Message {uid: $u, kind: 'message', channel: '#billing',
                        at: $at, text: $text, title: '#billing'})-[:POSTED_BY]->(p)""",
         {"a": author, "u": uid, "at": dbm.clock(db, t), "text": text})
    return uid


def _change(db, t, op, **kw):
    return sentinel.change_from_op(db, t, op) | kw


def test_moving_invoice_render_off_sso_legacy_outdates_exactly_the_claims_that_relied_on_it(db, tenant):
    u = uv.fork(db, tenant, [{"op": "deprecate_service", "service": "sso-legacy"}], created_by=PRIYA)["uid"]
    ans, verdicts = _answer(db, tenant, PRIYA, [
        {"text": "It breaks invoice-render and reports-legacy.", "kind": "breaks", "subject": u,
         "objects": ["invoice-render", "reports-legacy"], "exhaustive": False, "evidence": []},
        {"text": "Ines Okafor knows the ledger.", "kind": "knows", "subject": "ledger", "objects": ["Ines Okafor"],
         "exhaustive": False, "evidence": []},
    ])
    assert [v["verdict"] for v in verdicts] == ["verified", "verified"]
    msg = _message(db, tenant, TOMASZ, "invoice-render no longer calls sso-legacy")
    out = sentinel.apply_changes(db, tenant, msg, [_change(db, tenant, {"op": "remove_dependency", "source": "svc:invoice-render",
                                                                        "target": "svc:sso-legacy"})],
                                 [], dbm.tick(db, tenant), author_uid=TOMASZ)
    assert out["closed"] == ["dep:invoice-render->sso-legacy@2024-06-10"]
    notes = [n for n in out["notifications"] if n["user"] == PRIYA]
    assert len(notes) == 1 and notes[0]["broken_claims"] == ["It breaks invoice-render and reports-legacy."]
    marks = {r["t"]: r["v"] for r in db.ro(dbm.org(tenant), """MATCH (:Answer {uid: $a})-[:MAKES]->(c:Claim)
                                                               RETURN c.text AS t, c.verdict AS v""", {"a": ans})}
    assert marks == {"It breaks invoice-render and reports-legacy.": "contradicted", "Ines Okafor knows the ledger.": "verified"}
    # the fact is closed, not deleted, and points at the message that closed it
    row = db.one(dbm.org(tenant), """MATCH (:Service {name: 'invoice-render'})-[r:DEPENDS_ON]->(:Service {name: 'sso-legacy'})
                                     RETURN r.valid_to AS vt, r.closed_by AS by""")
    assert row["vt"] != "9999-12-31" and row["by"] == msg
    assert [n["question"] for n in sentinel.inbox(db, tenant, PRIYA)] == ["q"]


def test_someone_outside_the_owning_team_goes_to_review_and_only_the_owners_can_accept(db, tenant):
    msg = _message(db, tenant, SAM, "ledger reads from warehouse now")
    out = sentinel.apply_changes(db, tenant, msg, [_change(db, tenant, {"op": "add_dependency", "source": "svc:ledger",
                                                                        "target": "svc:warehouse", "kind": "data"})],
                                 [], dbm.tick(db, tenant), author_uid=SAM)
    assert not out["opened"] and len(out["review"]) == 1 and out["review"][0]["confidence"] < sentinel.APPLY_AT
    rid = out["review"][0]["uid"]
    try:
        sentinel.decide_review(db, tenant, rid, SAM, accept=True)
        raise AssertionError("Console accepted a change to a Billing system")
    except PermissionError:
        pass
    done = sentinel.decide_review(db, tenant, rid, INES, accept=True)
    assert done["status"] == "accepted" and len(done["opened"]) == 1


def test_hedged_statements_lose_authority(db, tenant):
    msg = _message(db, tenant, TOMASZ, "I think invoice-render might not need the ledger anymore")
    out = sentinel.apply_changes(db, tenant, msg, [_change(db, tenant, {"op": "remove_dependency", "source": "svc:invoice-render",
                                                                        "target": "svc:ledger"}, stated="hedged")],
                                 [], dbm.tick(db, tenant), author_uid=TOMASZ)
    assert not out["closed"] and len(out["review"]) == 1


def test_memory_is_per_person_and_recall_finds_earlier_talk_about_the_same_thing(db, tenant):
    now = dbm.clock(db, tenant)
    s1 = memory.start_session(db, tenant, PRIYA, now)
    memory.add_turn(db, tenant, PRIYA, s1, "user", "what breaks if we switch off sso-legacy?", now,
                    entities=[{"uid": "svc:sso-legacy", "name": "sso-legacy"}])
    memory.remember(db, tenant, PRIYA, "cares-about", "sso-legacy", now)
    memory.remember(db, tenant, DANIEL, "team", "Billing", now)
    assert [b["text"] for b in memory.beliefs(db, tenant, PRIYA, now)] == ["sso-legacy"]
    assert [b["text"] for b in memory.beliefs(db, tenant, DANIEL, now)] == ["Billing"]
    assert dbm.mem(tenant, PRIYA) != dbm.mem(tenant, DANIEL)
    r = memory.recall(db, tenant, PRIYA, question="is sso-legacy still needed?", session="session:other", now=now)
    assert [x["text"] for x in r["relevant_turns"]] == ["what breaks if we switch off sso-legacy?"]
    # a new value for the same key supersedes the old one, which stays in the history
    assert memory.remember(db, tenant, PRIYA, "cares-about", "ledger", now)["status"] == "changed"
    hist = memory.belief_history(db, tenant, PRIYA)
    assert [h["text"] for h in hist] == ["sso-legacy", "ledger"] and hist[0]["valid_to"]


def test_tokens_name_one_person_and_one_tenant():
    tok = security.mint("corvane", PRIYA)
    assert security.read(tok)["u"] == PRIYA
    assert security.session("corvane", authorization=f"Bearer {tok}").user == PRIYA
    for bad in (lambda: security.session("other", authorization=f"Bearer {tok}"),
                lambda: security.read(tok[:-2] + "00")):
        try:
            bad()
            raise AssertionError("accepted a bad token")
        except Exception as e:
            assert getattr(e, "status_code", 0) in (401, 403)


def test_a_task_is_claimed_once_even_by_racing_workers(db, tenant):
    from concurrent.futures import ThreadPoolExecutor

    uids = [blackboard.post(db, tenant, "fork", {"i": i}) for i in range(12)]
    with ThreadPoolExecutor(8) as pool:
        got = list(pool.map(lambda i: blackboard.claim(db, tenant, f"simulator-{i % 3}", ["fork"]), range(30)))
    claimed = [g["uid"] for g in got if g]
    assert sorted(claimed) == sorted(uids) and len(set(claimed)) == len(claimed)


def test_a_worker_does_the_fork_and_the_poster_reads_the_result_off_the_board(db, tenant):
    import threading

    stop = threading.Event()
    worker = threading.Thread(target=blackboard.agent_loop,
                              args=("simulator-test", "simulator", ["fork"], stop, lambda: [tenant]), daemon=True)
    worker.start()
    try:
        res = blackboard.run(db, tenant, "fork", {"ops": [{"op": "deprecate_service", "service": "sso-legacy"}],
                                                  "created_by": PRIYA}, posted_by=PRIYA)
    finally:
        stop.set()
        worker.join(5)
    # any worker may take it (an API running next to the tests has its own simulators); the poster never ran it
    assert res["_worker"] not in (None, "inline") and res["diff"]["risk"]["level"] == "high"
    done = db.ro(dbm.deck(tenant), "MATCH (x:Task {uid: $u}) RETURN x.status AS s", {"u": res["_task"]})
    assert done == [{"s": "done"}]


def test_counters_and_locks_live_in_a_graph_and_hold_under_races(db, tenant):
    from concurrent.futures import ThreadPoolExecutor

    key = f"orion:{tenant}:race"
    with ThreadPoolExecutor(8) as pool:
        got = list(pool.map(lambda _: db.incr(key), range(40)))
    assert sorted(got) == list(range(1, 41))
    first = db.lock(f"{tenant}:x", ttl=30, wait=0)
    with first:
        try:
            with db.lock(f"{tenant}:x", ttl=30, wait=0.3):
                raise AssertionError("two holders at once")
        except dbm.LockTimeout:
            pass
    with db.lock(f"{tenant}:x", ttl=30, wait=0.3):
        pass  # free again once released
    db.set(f"orion:{tenant}:gone", "1", ex=-1)
    assert db.get(f"orion:{tenant}:gone") is None  # expired
