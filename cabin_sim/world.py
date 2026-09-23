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

    # ---- hard travel limits, checked against the drawn interior -----------
    # Interior reference (shell + updateSeat in src/cabin.js): inner walls
    # x +/-0.90, z +/-1.30, floor top 0.12, roofline 1.41, dash box z
    # 0.775..1.225 (rear face 0.775, top 0.52). View mapping: slide
    # z = 0.38 + (slider_mm - 360) / 1000 (centre 360 = mount rest z,
    # 1 unit = 1 mm), height y = height_mm / 1000 - 0.28.
    #
    # slider_mm 260..440 - forward is the binding end: at the foremost mount
    #   z 0.46 the seated occupant's toes (+0.311) reach 0.771 and the
    #   cushion's swivel-swept corner (+0.275, the 0.46 x 0.40 cushion centred
    #   0.05 rear of the mount) 0.735 - both behind the 0.775 dash face, and
    #   knees (+0.17) at 0.63 (145 mm clear). The old 460 put the toes at
    #   0.791: INSIDE the dash box, i.e. out of the free cabin. Rearward
    #   nothing binds - rearmost mount z 0.28 leaves the reclined seatback
    #   sweep (0.466) at z -0.19, over 1 m off the rear wall. Residual: with
    #   the seat swiveled aft at full travel the backrest bottom edge grazes
    #   the dash TOP (y 0.48..0.52); clearing that would cap travel at 370,
    #   below the seat's own 390 default, so cushion/toe clearance is the
    #   limit that is enforced here.
    # height_mm 380..460 - the cabin's own 38..46 cm rail (index.html seatHgt
    #   / cognitive.js setHgt): mount y 0.10..0.18 keeps the cushion above the
    #   0.12 floor (pedestal still reaches it) and the seated head at mount
    #   +1.16 = 1.34 m, under the 1.41 roofline even at the top.
    # recline_deg 80..110 - worst case (SLIDER_MIN + RECLINE_MAX, seat at the
    #   top of its height travel) puts the backrest top at z -0.19 / y 1.17:
    #   ~1 m off the rear wall, well under the roof.
    # rotation_deg 0..359 - full swivel, clamped, never wrapped: the 0/359
    #   seam stops travel instead of folding round; the 0.466 m sweep from
    #   mount x -0.42 stays inside the +/-0.90 walls (14 mm clear at the
    #   worst angle).
    SLIDER_MIN, SLIDER_MAX = 260, 440
    HEIGHT_MIN, HEIGHT_MAX = 380, 460        # mm  (38..46 cm, as in cognitive.js)
    RECLINE_MIN, RECLINE_MAX = 80, 110
    ROT_MIN, ROT_MAX = 0, 359                # deg, absolute swivel (clamped, no wrap)

    # axis -> (min attr, max attr): one table feeds every clamping path, so
    # an axis can never end up constrained on one path and free on another.
    _AXES = (
        ("slider_mm", "SLIDER_MIN", "SLIDER_MAX"),
        ("height_mm", "HEIGHT_MIN", "HEIGHT_MAX"),
        ("recline_deg", "RECLINE_MIN", "RECLINE_MAX"),
        ("rotation_deg", "ROT_MIN", "ROT_MAX"),
    )

    def _limits(self):
        return {axis: (getattr(self, lo), getattr(self, hi))
                for axis, lo, hi in self._AXES}

    def __post_init__(self):
        # construction is clamped too: no path can seed an out-of-bounds seat
        for axis, (lo, hi) in self._limits().items():
            setattr(self, axis, _clamp(getattr(self, axis), lo, hi))

    def move(self, attr, delta):
        limits = self._limits()
        if attr not in limits:
            raise ValueError(f"unknown seat axis {attr!r}; "
                             f"expected one of {sorted(limits)}")
        if isinstance(delta, bool) or not isinstance(delta, (int, float)):
            raise TypeError(f"seat delta must be a number, got {type(delta).__name__}")
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