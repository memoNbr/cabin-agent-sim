"""The car interior: pure state, no drawing, no reasoning.

The agent can only change the interior through actions (actions.py), and
every change is clamped to a safe range right here. Nothing an agent says
or asks for can ever put the cabin out of bounds.
"""

from dataclasses import dataclass, field


def _clamp(value, lo, hi):
    return max(lo, min(hi, value))


@dataclass
class Seat:
    # "as found" position - the previous driver left it turned toward the door
    # and at the bottom of its travel, so the persona has a real settling job.
    slider_mm: int = 390        # forward/back position (mm from rearmost)
    height_mm: int = 380        # cushion height: 38 cm = bottom of 38..46 cm
    recline_deg: int = 103      # backrest angle from the seat pan
    rotation_deg: int = 90      # full swivel heading, 0 = facing forward/road

    SLIDER_MIN, SLIDER_MAX = 260, 460
    HEIGHT_MIN, HEIGHT_MAX = 380, 460        # mm  (38..46 cm, as in cognitive.js)
    RECLINE_MIN, RECLINE_MAX = 80, 110
    ROT_MIN, ROT_MAX = 0, 359                # deg, absolute swivel (clamped, no wrap)

    def move(self, attr, delta):
        limits = {
            "slider_mm": (self.SLIDER_MIN, self.SLIDER_MAX),
            "height_mm": (self.HEIGHT_MIN, self.HEIGHT_MAX),
            "recline_deg": (self.RECLINE_MIN, self.RECLINE_MAX),
            "rotation_deg": (self.ROT_MIN, self.ROT_MAX),
        }
        lo, hi = limits[attr]
        old = getattr(self, attr)
        new = _clamp(old + delta, lo, hi)
        setattr(self, attr, new)
        return new - old

    def as_dict(self):
        return {
            "slider_mm": self.slider_mm,
            "height_mm": self.height_mm,
            "recline_deg": self.recline_deg,
            "rotation_deg": self.rotation_deg,
        }


@dataclass
class VendingMachine:
    PRODUCTS = ["snack", "water", "coffee"]

    stock: dict = field(default_factory=lambda: {"snack": 5, "water": 5, "coffee": 5})
    last_dispensed: str | None = None

    def vend(self, product):
        if product not in self.PRODUCTS:
            return False, "unknown product"
        if self.stock[product] <= 0:
            return False, "out of stock"
        self.stock[product] -= 1
        self.last_dispensed = product
        return True, f"{product} dispensed"

    def as_dict(self):
        return dict(self.stock)


@dataclass
class Table:
    folded: bool = True

    def as_dict(self):
        return {"folded": self.folded}


@dataclass
class Cabin:
    seat: Seat = field(default_factory=Seat)
    vending: VendingMachine = field(default_factory=VendingMachine)
    table: Table = field(default_factory=Table)

    def apply(self, attr, delta):
        return self.seat.move(attr, delta)

    def to_dict(self):
        return {
            "seat": self.seat.as_dict(),
            "vending": self.vending.as_dict(),
            "table": self.table.as_dict(),
        }