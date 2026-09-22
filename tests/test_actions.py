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