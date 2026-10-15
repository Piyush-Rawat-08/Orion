"""The safe path and hindsight, on the Corvane storylines. No model calls."""

from orion import hindsight, planner

SSO_OFF = [{"op": "deprecate_service", "service": "sso-legacy"}]


def test_the_safe_path_moves_invoice_render_onto_identity_before_switching_sso_legacy_off(db, tenant):
    seen = []
    r = planner.plan(db, tenant, SSO_OFF, emit=lambda e: seen.append(e["type"]))
    assert r["baseline"]["risk"] == 100 and r["best"]["risk"] == 0 and r["best"]["broken"] == []
    labels = [s["label"] for s in r["steps"]]
    assert labels[0] == "Move invoice-render onto identity" and labels[-1] == "Switch off sso-legacy"
    # every company explored was streamed, the winning branch is a path from the root
    assert seen.count("universe") == r["explored"] and r["path"][0] == r["universes"][0]["id"]
    # the moves add the new dependency before they drop the old one, and the switch-off comes last
    ops = [o["op"] for o in r["plan_ops"]]
    assert ops.index("add_dependency") < ops.index("remove_dependency") and ops[-1] == "deprecate_service"
    assert [p["risk"] for p in r["curve"]] == sorted((p["risk"] for p in r["curve"]), reverse=True)


def test_assess_matches_the_what_if_risk(db, tenant):
    from orion import universe as uv

    fork = uv.fork(db, tenant, SSO_OFF, created_by="person:priya-raman")
    assert planner.assess(db, tenant, SSO_OFF)["risk"] == fork["diff"]["risk"]["score"]


def test_hindsight_finds_the_blind_spot_behind_inc_311(db, tenant):
    inc = {i["key"]: i for i in hindsight.incidents(db, tenant)}
    assert inc["INC-311"]["decision"]["key"] == "ADR-011" and inc["INC-311"]["lead_days"] == 15
    assert not inc["INC-301"]["replayable"]
    r = hindsight.replay(db, tenant, "INC-311")
    assert r["known"]["risk"] < r["true"]["risk"] == 100
    assert "invoice-render" not in [b["service"] for b in r["known"]["broken"]]
    spot = r["blind_spot"][0]
    assert (spot["source"], spot["target"], spot["recorded_by"]) == ("invoice-render", "sso-legacy", "Tomasz Nowak")
    assert spot["after_incident_days"] == 6
    assert r["fix"]["label"] == "Move invoice-render onto identity" and r["fix_waiting"]["key"] == "BILL-207"
