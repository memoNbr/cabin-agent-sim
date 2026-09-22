"""Pure world state: clamps always hold, the schema constants never drift."""

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