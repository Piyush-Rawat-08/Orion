"""Slow is not dead: a busy worker keeps its task, a silent one loses it, and a released task can't be overwritten."""

import threading
import time

from orion import blackboard
from orion import db as dbm


def _task_status(db, t, uid):
    return db.one(dbm.deck(t), "MATCH (x:Task {uid: $u}) RETURN x.status AS s, x.claimed_by AS w", {"u": uid})


def test_a_healthy_worker_busy_past_the_dead_line_keeps_its_task(db, tenant, monkeypatch):
    monkeypatch.setattr(blackboard, "DEAD_AFTER_S", 1)
    monkeypatch.setattr(blackboard, "HEARTBEAT_S", 0.2)
    started, release = threading.Event(), threading.Event()

    def slow(db_, t, task, payload, agent):
        started.set()
        release.wait(5)
        return {"uid": "done"}, "slow but fine"

    monkeypatch.setitem(blackboard.EXECUTORS, "test_slow", slow)
    blackboard.register(db, "sim-slow", "simulator", ["test_slow"])
    uid = blackboard.post(db, tenant, "test_slow", {})
    task = blackboard.claim(db, tenant, "sim-slow", ["test_slow"])
    worker = threading.Thread(target=blackboard.run_task, args=(db, tenant, task, "sim-slow"))
    worker.start()
    started.wait(5)
    time.sleep(2.2)  # more than twice the dead line; the heartbeat thread keeps beating
    assert blackboard.release_dead(db, tenant) == 0
    release.set()
    worker.join(5)
    assert _task_status(db, tenant, uid)["s"] == "done"


def test_a_worker_that_went_silent_loses_its_task_and_cant_record_over_the_next_one(db, tenant, monkeypatch):
    monkeypatch.setattr(blackboard, "DEAD_AFTER_S", 1)
    blackboard.register(db, "sim-ghost", "simulator", ["test_ghost"])
    blackboard.register(db, "sim-next", "simulator", ["test_ghost"])
    uid = blackboard.post(db, tenant, "test_ghost", {})
    first = blackboard.claim(db, tenant, "sim-ghost", ["test_ghost"])
    db.q(blackboard.POOL, "MATCH (a:Agent {name: 'sim-ghost'}) SET a.heartbeat_at = 0")
    blackboard.heartbeat(db, "sim-next")
    assert blackboard.release_dead(db, tenant) == 1 and _task_status(db, tenant, uid)["s"] == "open"
    second = blackboard.claim(db, tenant, "sim-next", ["test_ghost"])
    assert second["lease"] == first["lease"] + 1
    # the first worker wakes up and tries to finish: its lease is gone
    assert not blackboard.complete(db, tenant, uid, {}, "late", agent="sim-ghost", lease=first["lease"])
    assert _task_status(db, tenant, uid) == {"s": "claimed", "w": "sim-next"}
    assert blackboard.complete(db, tenant, uid, {}, "on time", agent="sim-next", lease=second["lease"])
    assert _task_status(db, tenant, uid)["s"] == "done"
