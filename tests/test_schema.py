"""The canonical snapshot contract: shape, JSON purity, bounds, validator."""

import json

from cabin_sim import schema
from cabin_sim.sim import SimEngine

from conftest import make_session


def test_empty_snapshot_is_json_and_versioned():
    s = schema.empty_snapshot()
    json.dumps(s)  # must never raise: pure JSON types only
    assert s["version"] == schema.SCHEMA_VERSION
    assert s["schema"] == schema.SCHEMA_NAME
    assert (s["version"], s["schema"]) == (1, "cabin-agent.v1")


def test_required_top_level_keys():
    s = schema.empty_snapshot()
    assert set(s) == {"version", "schema", "t", "phase", "step", "running",
                      "done", "world", "ride", "agent", "priors", "log"}


def test_snapshot_after_run_is_conformant():
    e = SimEngine(make_session(seed=1, max_steps=40)).run()
    s = e.snapshot()
    assert s["done"] is True and s["running"] is False and s["phase"] == "done"
    assert json.dumps(s)
    assert schema.check(s) == []


def test_seat_bounds_hold_after_full_run():
    e = SimEngine(make_session(seed=1, max_steps=400)).run()
    s = e.snapshot()
    for axis, (lo, hi) in schema.SEAT_LIMITS.items():
        assert lo <= s["world"]["seat"][axis] <= hi


def test_mood_bounds_hold_after_full_run():
    e = SimEngine(make_session(seed=1, max_steps=400)).run()
    mood = e.snapshot()["agent"]["mood"]
    for k, v in mood.items():
        assert v is None or 0.0 <= v <= 1.0


def test_trust_score_lands_after_questionnaire():
    e = SimEngine(make_session(seed=1, max_steps=40)).run()
    score = e.snapshot()["agent"]["trust"]["score"]
    assert score is not None and 0.0 <= score <= 1.0


def test_port_slots_are_neutral_before_implementation():
    s = schema.empty_snapshot()
    assert s["agent"]["trust"]["live"] is None
    assert s["agent"]["intention"] is None
    assert s["agent"]["thoughts"] == []
    assert s["ride"] == {"speed": 0.0, "g": 0.0, "jolt": 0.0, "rain": 0.0}


def test_check_reports_contract_violations():
    s = schema.empty_snapshot()
    s["world"]["seat"]["slider_mm"] = 9999
    s["agent"]["mood"]["comfort"] = 7
    s["version"] = 99
    issues = schema.check(s)
    assert any("slider_mm" in i for i in issues)
    assert any("comfort" in i for i in issues)
    assert any("version" in i for i in issues)