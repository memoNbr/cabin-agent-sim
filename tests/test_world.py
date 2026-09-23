"""Pure world state: clamps always hold, the schema constants never drift."""

import pytest

from cabin_sim import schema
from cabin_sim.world import Cabin, Seat, VendingMachine, Table


def test_defaults_within_limits():
    s = Seat()
    assert s.SLIDER_MIN <= s.slider_mm <= s.SLIDER_MAX
    assert s.HEIGHT_MIN <= s.height_mm <= s.HEIGHT_MAX
    assert s.RECLINE_MIN <= s.recline_deg <= s.RECLINE_MAX
    assert s.ROT_MIN <= s.rotation_deg <= s.ROT_MAX


def test_move_clamps_to_lower_bound():
    s = Seat()
    actual = s.move("slider_mm", -100_000)
    assert s.slider_mm == s.SLIDER_MIN
    assert actual == s.SLIDER_MIN - 390


def test_move_clamps_to_upper_bound():
    s = Seat()
    start = s.rotation_deg
    actual = s.move("rotation_deg", 100_000)
    assert s.rotation_deg == s.ROT_MAX
    assert actual == s.ROT_MAX - start


def test_move_returns_applied_delta():
    s = Seat()
    old = s.height_mm
    actual = s.move("height_mm", 10)
    assert s.height_mm == old + 10
    assert actual == 10


def test_move_clamps_every_axis_at_both_ends():
    """All four axes, both directions: no adjustment can leave the cabin."""
    s = Seat()
    for axis in schema.SEAT_AXES:
        lo, hi = schema.SEAT_LIMITS[axis]
        start = getattr(s, axis)
        assert s.move(axis, -1_000_000) == lo - start
        assert getattr(s, axis) == lo
        assert s.move(axis, 1_000_000) == hi - lo
        assert getattr(s, axis) == hi


def test_move_rejects_unknown_axis_and_non_numeric_delta():
    s = Seat()
    before = s.as_dict()
    with pytest.raises(ValueError):
        s.move("warp_drive", 10)
    with pytest.raises(TypeError):
        s.move("slider_mm", "20")
    assert s.as_dict() == before


def test_seat_construction_is_clamped():
    """No path can seed an out-of-bounds seat (world.Seat.__post_init__)."""
    s = Seat(slider_mm=9_999, height_mm=-1, recline_deg=1_000, rotation_deg=45)
    for axis in schema.SEAT_AXES:
        lo, hi = schema.SEAT_LIMITS[axis]
        assert lo <= getattr(s, axis) <= hi
    assert s.rotation_deg == 45          # in range to begin with: untouched


# ---- the drawn interior (src/cabin.js), metres ---------------------------
DASH_Z, REAR_WALL_Z, FLOOR_Y, ROOF_Y, WALL_X = 0.775, -1.30, 0.12, 1.41, 0.90
TOES, CUSHION_SWEEP, BACK_SWEEP = 0.311, 0.275, 0.466
SEAT_X = -0.42                      # mount: fixed driver post, no lateral axis


def mount_z(slider_mm):
    """Slide -> seat-mount z (cognitive.js centre 360 = the mount's rest z)."""
    return 0.38 + (slider_mm - 360) / 1000


def mount_y(height_mm):
    """Height -> seat-mount y (src/cabin.js updateSeat)."""
    return height_mm / 1000 - 0.28


def test_slide_extremes_keep_the_seat_inside_the_cabin():
    s = Seat()
    s.move("slider_mm", 10_000)                   # slam forward
    z = mount_z(s.slider_mm)
    assert z + TOES <= DASH_Z                     # occupant's feet off the dash
    assert z + CUSHION_SWEEP <= DASH_Z            # cushion too, at any swivel

    s.move("slider_mm", -10_000)                  # slam back
    z = mount_z(s.slider_mm)
    assert z - BACK_SWEEP > REAR_WALL_Z           # seatback off the rear wall


def test_height_extremes_stay_between_floor_and_roof():
    s = Seat()
    s.move("height_mm", 10_000)                   # slam to the top
    assert mount_y(s.height_mm) + 1.16 < ROOF_Y   # seated head under the roof

    s.move("height_mm", -10_000)                  # slam to the floor
    assert mount_y(s.height_mm) + 0.26 > FLOOR_Y  # cushion above the floor


def test_recline_and_rotation_stay_inside_the_shell():
    s = Seat()
    s.move("slider_mm", -10_000)                  # as far back as it goes
    s.move("height_mm", 10_000)                   # as high as it goes
    s.move("recline_deg", 10_000)                 # laid all the way back
    y, z = mount_y(s.height_mm), mount_z(s.slider_mm)
    assert y + 0.99 < ROOF_Y                      # backrest top under the roof
    assert z - BACK_SWEEP > REAR_WALL_Z           # ...and clear of the rear wall

    s.move("rotation_deg", 10_000)                # full swivel: the seat's
    assert SEAT_X - BACK_SWEEP > -WALL_X          # sweep stays inside both
    assert SEAT_X + BACK_SWEEP < WALL_X           # side walls at any angle


def test_vending_stock_drains_and_blocks():
    v = VendingMachine()
    for _ in range(5):
        ok, _ = v.vend("water")
        assert ok
    ok, why = v.vend("water")
    assert not ok and "out of stock" in why


def test_vending_rejects_unknown_product():
    ok, why = VendingMachine().vend("jetpack")
    assert not ok and "unknown" in why


def test_table_toggle():
    t = Table()
    assert t.folded is True
    t.folded = False
    assert t.folded is False


def test_cabin_to_dict_shape():
    c = Cabin()
    d = c.to_dict()
    assert set(d["seat"]) == {"slider_mm", "height_mm", "recline_deg", "rotation_deg"}
    assert set(d["vending"]) == {"snack", "water", "coffee"}


def test_schema_limits_match_world_constants():
    """Canonical schema clamps MUST mirror world.Seat — drift is a contract break."""
    name_to_attrs = {
        "slider_mm": ("SLIDER_MIN", "SLIDER_MAX"),
        "height_mm": ("HEIGHT_MIN", "HEIGHT_MAX"),
        "recline_deg": ("RECLINE_MIN", "RECLINE_MAX"),
        "rotation_deg": ("ROT_MIN", "ROT_MAX"),
    }
    for axis in schema.SEAT_AXES:
        lo_attr, hi_attr = name_to_attrs[axis]
        assert schema.SEAT_LIMITS[axis] == (getattr(Seat, lo_attr), getattr(Seat, hi_attr)), (
            f"schema.SEAT_LIMITS[{axis!r}] drifted from world.Seat"
        )