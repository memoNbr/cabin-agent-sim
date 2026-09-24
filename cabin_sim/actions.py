"""The action vocabulary the agent is allowed to use.

Two doors into the cabin, both safety gates:

  apply()             the named whitelist the scripted/rules path walks
                      (fixed human-sized steps — the deterministic suite);
  apply_llm_action()  the structured actions the LLM proposes ITSELF:
                      seat axis + the model's own delta, vending item,
                      table state. Python checks only the vocabulary and
                      lets the world clamp to physical travel — no step
                      table picks a value for the model. The swivel (LLM
                      door only) additionally WRAPS through the 0/359
                      seam like a real turntable, so every heading stays
                      reachable; every other axis clamps to its limits.

Every change is validated and clamped by the Cabin before it touches
anything: the interior can never go out of bounds, whatever the reasoner
asks for.
"""

from .world import Cabin

DEFAULT_STEP = {
    "seat_forward": ("slider_mm", 20),
    "seat_back": ("slider_mm", -20),
    "seat_up": ("height_mm", 10),
    "seat_down": ("height_mm", -10),
    "recline_more": ("recline_deg", 3),
    "recline_less": ("recline_deg", -3),
    # the swivel now spans 0..359 deg, so it moves in 10 deg steps - the same
    # human-sized step cognitive.js used for its self-settle actuation.
    "rotate_cw": ("rotation_deg", 10),
    "rotate_ccw": ("rotation_deg", -10),
}

VENDING_ACTIONS = ("get_snack", "get_water", "get_coffee")

TABLE_ACTIONS = {
    "deploy_table": False,
    "stow_table": True,
}

ALL_ACTIONS = tuple(DEFAULT_STEP) + VENDING_ACTIONS + tuple(TABLE_ACTIONS)

LABELS = {
    "seat_forward": "slide the seat forward",
    "seat_back": "slide the seat back",
    "seat_up": "raise the seat",
    "seat_down": "lower the seat",
    "recline_more": "recline the backrest more",
    "recline_less": "bring the backrest up",
    "rotate_cw": "rotate the seat inward",
    "rotate_ccw": "rotate the seat outward",
    "get_snack": "get a snack from the machine",
    "get_water": "get a bottle of water",
    "get_coffee": "get a coffee",
    "deploy_table": "fold the table down",
    "stow_table": "fold the table away",
}


def apply(cabin: Cabin, action: str):
    """Apply one whitelisted action to the cabin. Returns (ok, detail)."""
    if action not in ALL_ACTIONS:
        return False, f"unknown action '{action}' blocked by the whitelist"

    if action in DEFAULT_STEP:
        attr, step = DEFAULT_STEP[action]
        actual = cabin.apply(attr, step)
        if actual == 0:
            return False, "already at the end of travel"
        return True, f"{attr.replace('_', ' ')} changed by {actual:+d}"

    if action in VENDING_ACTIONS:
        product = action.split("_", 1)[1]
        return cabin.vending.vend(product)

    target = TABLE_ACTIONS[action]
    if cabin.table.folded == target:
        return False, "table already in that state"
    cabin.table.folded = target
    return True, "table " + ("folded down" if not target else "folded away")


def describe(action: str) -> str:
    return LABELS.get(action, action)


# the seat axes a model may address — everything else is refused
AXES = ("slider_mm", "height_mm", "recline_deg", "rotation_deg")


def _rotate(cabin: Cabin, delta: float):
    """Swivel with wrap-around: a turntable folds through the 0/359 seam.

    Only the LLM door does this — the rules/world paths keep their
    clamped, no-wrap contract. The model's angular intent ("face the
    window" from 350° means −20°, not +340°) then always lands on the
    real heading instead of being refused at the seam, so every swivel
    position stays reachable. Whole degrees, like the world's rotation
    field; `detail` reports what actually happened for the OUTCOME line.
    """
    if delta == 0:
        return False, "delta 0: the seat did not move", "seat_move"
    before = float(cabin.seat.rotation_deg)
    raw = before + delta
    new = int(round(raw % 360.0)) % 360
    cabin.seat.rotation_deg = new
    detail = f"rotation_deg {before:g} \u2192 {new:g}"
    if raw < 0.0 or raw >= 360.0:
        detail += " (wrapped through the 0/359 seam)"
    return True, detail, "seat_move"


def apply_llm_action(cabin: Cabin, action):
    """Validate and apply ONE model-proposed action. Returns (ok, detail, name).

    The safety referee only: `kind`/`axis` must come from the whitelisted
    vocabulary and `delta` must be a number — WHICH axis, HOW far and WHEN
    are the model's own values (nothing here picks a step for it). The world
    clamps to its travel limits, and `detail` reports what ACTUALLY happened
    (clamped, refused or as asked) so the mind can feed the real outcome
    back for the model to examine.
    """
    if not isinstance(action, dict):
        return False, "action must be an object", None
    kind = action.get("kind")
    if kind in (None, "none", "wait"):
        return False, "no action", None
    if kind == "seat":
        axis, delta = action.get("axis"), action.get("delta")
        if axis not in AXES:
            return False, (f"axis {axis!r} refused: only {', '.join(AXES)}"), \
                "seat_move"
        if isinstance(delta, bool) or not isinstance(delta, (int, float)):
            return False, "delta refused: not a number", "seat_move"
        if axis == "rotation_deg":
            return _rotate(cabin, float(delta))    # swivel wraps, see above
        before = getattr(cabin.seat, axis)
        actual = cabin.seat.move(axis, delta)   # world clamps to travel limits
        if actual == 0:
            return False, f"{axis} at the end of travel ({float(before):g})", \
                "seat_move"
        detail = f"{axis} {float(before):g} \u2192 {float(before + actual):g}"
        if abs(actual - float(delta)) > 1e-9:
            detail += (f" (requested {float(delta):+g} \u2014 clamped by the "
                       "travel limit)")
        return True, detail, "seat_move"
    if kind == "vending":
        item = action.get("item")
        if item not in cabin.vending.PRODUCTS:
            return False, f"unknown vending item {item!r}", None
        ok, detail = cabin.vending.vend(item)
        return ok, detail, f"get_{item}"
    if kind == "table":
        folded = action.get("folded")
        if not isinstance(folded, bool):
            return False, "folded must be true or false", "table"
        if cabin.table.folded == folded:
            return False, "table already in that state", "table"
        cabin.table.folded = folded
        return True, "table " + ("folded away" if folded else "folded down"), \
            "table"
    return False, f"unknown action kind {kind!r}", None