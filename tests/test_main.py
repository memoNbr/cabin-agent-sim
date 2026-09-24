"""CLI argument semantics: the --steps cap resolution.

The regression these tests pin down: browser sessions used to inherit the
headless default (300 steps) and silently stopped ticking ~6 wall-minutes
into a conversation, which read as "the sim randomly stops working". The
browser default must therefore be unlimited; headless keeps 300 (the full
ride); an explicit --steps always wins.
"""

from cabin_sim.main import UNLIMITED_STEPS, _resolve_steps


def test_browser_sessions_default_to_unlimited():
    assert _resolve_steps(False, None) == UNLIMITED_STEPS
    assert _resolve_steps(False, 0) == UNLIMITED_STEPS
    assert _resolve_steps(False, -5) == UNLIMITED_STEPS


def test_headless_sessions_keep_the_full_ride_default():
    assert _resolve_steps(True, None) == 300
    assert _resolve_steps(True, 0) == 300


def test_explicit_steps_win_in_both_modes():
    assert _resolve_steps(False, 300) == 300
    assert _resolve_steps(True, 40) == 40
