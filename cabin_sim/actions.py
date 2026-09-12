"""The action vocabulary the agent is allowed to use.

A safety whitelist: the reasoner (LLM or scripted fallback) may only ever
request one of these actions, and every one is validated and clamped by the
Cabin before it changes anything. The interior can never go out of bounds.
"""

from .world import Cabin

DEFAULT_STEP = {
    "seat_forward": ("slider_mm", 20),
    "seat_back": ("slider_mm", -20),
    "seat_up": ("height_mm", 10),
    "seat_down": ("height_mm", -10),
    "recline_more": ("recline_deg", 3),
    "recline_less": ("recline_deg", -3),
    "rotate_cw": ("rotation_deg", 2),
    "rotate_ccw": ("rotation_deg", -2),
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