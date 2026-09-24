"""Action whitelist: the single validation gate never lets the world out of bounds."""

from cabin_sim import actions
from cabin_sim.world import Cabin


def test_unknown_action_blocked():
    ok, why = actions.apply(Cabin(), "fly_to_the_moon")
    assert not ok and "blocked" in why


def test_every_whitelisted_action_is_safe():
    c = Cabin()
    for action in actions.ALL_ACTIONS:
        ok, detail = actions.apply(c, action)
        assert isinstance(ok, bool)
        assert isinstance(detail, str)


def test_seat_at_end_of_travel_reports_blocked():
    c = Cabin()
    c.seat.slider_mm = c.seat.SLIDER_MAX
    ok, why = actions.apply(c, "seat_forward")
    assert not ok and "end of travel" in why


def test_bounds_respected_after_burst():
    c = Cabin()
    for _ in range(50):
        actions.apply(c, "seat_up")
        actions.apply(c, "rotate_ccw")
    assert c.seat.height_mm == c.seat.HEIGHT_MAX
    assert c.seat.rotation_deg == c.seat.ROT_MIN


def test_table_toggle_is_idempotent():
    c = Cabin()
    ok, _ = actions.apply(c, "deploy_table")
    assert ok and not c.table.folded
    ok, why = actions.apply(c, "deploy_table")
    assert not ok and "already" in why


# ---- the LLM door: model-chosen values, world-clamped ---------------------


def test_llm_action_uses_the_models_own_delta():
    c = Cabin()
    ok, detail, name = actions.apply_llm_action(
        c, {"kind": "seat", "axis": "slider_mm", "delta": 37})
    assert ok and c.seat.slider_mm == 390 + 37      # not a fixed step table
    assert name == "seat_move" and "390 \u2192 427" in detail


def test_llm_action_refuses_unknown_axis_or_kind():
    c = Cabin()
    before = c.seat.as_dict()
    ok, why, _ = actions.apply_llm_action(
        c, {"kind": "seat", "axis": "doors", "delta": 5})
    assert not ok and "refused" in why
    ok, why, _ = actions.apply_llm_action(c, {"kind": "teleport"})
    assert not ok and "unknown" in why
    assert c.seat.as_dict() == before               # nothing moved


def test_llm_action_non_numeric_delta_refused():
    ok, why, _ = actions.apply_llm_action(
        Cabin(), {"kind": "seat", "axis": "height_mm", "delta": "lots"})
    assert not ok and "number" in why


def test_llm_action_giant_delta_is_clamped_and_reported():
    c = Cabin()
    ok, why, _ = actions.apply_llm_action(
        c, {"kind": "seat", "axis": "slider_mm", "delta": 5000})
    assert ok and c.seat.slider_mm == c.seat.SLIDER_MAX
    assert "clamped" in why                        # the outcome tells the model


def test_llm_rotation_wraps_through_the_seam():
    """A turntable folds through 0/359 — every heading stays reachable."""
    c = Cabin()
    c.seat.rotation_deg = 350
    ok, detail, name = actions.apply_llm_action(
        c, {"kind": "seat", "axis": "rotation_deg", "delta": 20})
    assert ok and c.seat.rotation_deg == 10 and name == "seat_move"
    assert "wrapped" in detail                      # the outcome says so
    ok, detail, _ = actions.apply_llm_action(
        c, {"kind": "seat", "axis": "rotation_deg", "delta": -30})
    assert ok and c.seat.rotation_deg == 340 and "wrapped" in detail
    assert 0 <= c.seat.rotation_deg <= 359          # schema bounds still hold


def test_llm_rotation_plain_turn_reads_like_any_axis():
    c = Cabin()                                     # rotation 90 by default
    ok, detail, _ = actions.apply_llm_action(
        c, {"kind": "seat", "axis": "rotation_deg", "delta": 15})
    assert ok and c.seat.rotation_deg == 105 and "wrapped" not in detail


def test_llm_rotation_zero_delta_is_honest_about_not_moving():
    ok, why, _ = actions.apply_llm_action(
        Cabin(), {"kind": "seat", "axis": "rotation_deg", "delta": 0})
    assert not ok and "did not move" in why


def test_llm_action_vending_and_table():
    c = Cabin()
    ok, _, name = actions.apply_llm_action(
        c, {"kind": "vending", "item": "water"})
    assert ok and name == "get_water" and c.vending.stock["water"] == 4
    ok, _, name = actions.apply_llm_action(c, {"kind": "table", "folded": False})
    assert ok and not c.table.folded
    ok, why, _ = actions.apply_llm_action(c, {"kind": "table", "folded": False})
    assert not ok and "already" in why


def test_llm_action_none_kind_is_not_an_action():
    c = Cabin()
    ok, why, name = actions.apply_llm_action(c, {"kind": "none"})
    assert not ok and why == "no action" and name is None