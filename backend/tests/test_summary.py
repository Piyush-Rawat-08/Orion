"""A sentence's wording of an effect, and the summary, are held to what the graph verified."""

from orion import claims
from orion import universe as uv

SSO = [{"op": "deprecate_service", "service": "sso-legacy"}]
EFFECTS = {"invoice-render": "break", "reports-legacy": "break", "billing-api": "degrade", "onboarding": "degrade",
           "web-console": "degrade"}


def test_the_effect_word_nearest_each_system_must_match():
    assert claims.effect_mismatch("Switching off sso-legacy stops invoice-render and slows billing-api.", EFFECTS) == []
    assert claims.effect_mismatch("billing-api and onboarding would slow down or partly fail.", EFFECTS) == []
    wrong = claims.effect_mismatch("Five systems stop working: invoice-render, billing-api and web-console.", EFFECTS)
    assert wrong == ["billing-api slows down, it doesn't stop working", "web-console slows down, it doesn't stop working"]
    # the verb before a list governs it; "slow down" later in the sentence belongs to what follows it
    showcase = ("Switching off sso-legacy would stop invoice-render and reports-legacy outright and slow down billing-api, "
                "onboarding and web-console, touching 16 customers.")
    assert claims.effect_mismatch(showcase, EFFECTS) == []
    assert claims.effect_mismatch("invoice-render stops and billing-api slows.", EFFECTS) == []
    # no effect word: nothing said about severity, nothing to get wrong
    assert claims.effect_mismatch("invoice-render and billing-api are affected.", EFFECTS) == []


def test_a_breaks_claim_that_overstates_an_effect_is_only_partly_checked(db, tenant):
    u = uv.fork(db, tenant, SSO, title="t")
    ok = claims.check(db, tenant, {"kind": "breaks", "subject": u["uid"], "objects": ["billing-api"],
                                   "text": "billing-api would slow down."})
    assert ok["verdict"] == "verified"
    over = claims.check(db, tenant, {"kind": "breaks", "subject": u["uid"], "objects": ["billing-api"],
                                     "text": "billing-api would stop working."})
    assert over["verdict"] == "partial" and "slows down, it doesn't stop working" in over["reason"]


def test_the_summary_can_only_say_what_a_verified_point_says(db, tenant):
    u = uv.fork(db, tenant, SSO, title="t")
    texts = ["Switching off sso-legacy stops invoice-render and reports-legacy.",
             "billing-api, onboarding and web-console slow down.",
             "Sixteen customers would notice."]
    claim = [{"kind": "breaks", "subject": u["uid"], "objects": ["invoice-render", "reports-legacy"], "text": texts[0]},
             {"kind": "breaks", "subject": u["uid"], "objects": ["billing-api", "onboarding", "web-console"], "text": texts[1]},
             {"kind": "count", "subject": u["uid"], "measure": "broken", "value": 5, "text": "Five systems are affected."}]
    verdicts = [{**c, **claims.check(db, tenant, c)} for c in claim]
    assert [v["verdict"] for v in verdicts] == ["verified", "verified", "verified"]

    good = claims.summary_check(db, tenant, "It stops invoice-render and slows billing-api: five systems in all.", verdicts)
    assert good == {"covered": True, "issues": []}
    bad = claims.summary_check(db, tenant, "It stops billing-api and ledger, seven systems in all.", verdicts)
    assert not bad["covered"]
    assert any("ledger" in i for i in bad["issues"])
    assert any("7" in i for i in bad["issues"])
    assert any("billing-api slows down" in i for i in bad["issues"])
    nothing = claims.summary_check(db, tenant, "All fine.", [{**v, "verdict": "unsupported"} for v in verdicts])
    assert not nothing["covered"]
