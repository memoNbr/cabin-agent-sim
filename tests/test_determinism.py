"""Determinism is the point of the Python-authoritative phase."""

from cabin_sim.provider import create_provider
from cabin_sim.session import Session
from cabin_sim.sim import SimEngine

from conftest import PERSONA, make_session


def _steps(seed, count):
    session = Session(PERSONA, create_provider("scripted"),
                      max_steps=40, seed=seed)
    for _ in range(count):
        session.step_once()
    return session.state()


def test_session_log_reproducible_same_seed():
    a = [_steps(1, i) for i in range(1, 21)]
    b = [_steps(1, i) for i in range(1, 21)]
    assert a == b
    assert [o["step"] for o in a] == list(range(1, 21))


def test_different_seed_changes_trajectory():
    a = _steps(1, 20)
    b = _steps(2, 20)
    assert a["cabin"] != b["cabin"]
    assert a["mood"] != b["mood"]


def test_engine_run_reproducible_snapshots():
    e1 = SimEngine(make_session(seed=7)).run()
    e2 = SimEngine(make_session(seed=7)).run()
    assert e1.snapshot() == e2.snapshot()
    assert e1.t == e2.t


def test_snapshot_is_pure_and_repeatable():
    e = SimEngine(make_session(seed=7)).run()
    s1 = e.snapshot()
    s2 = e.snapshot()
    assert s1 == s2
    before = e.t, e.session.step
    e.snapshot()
    assert (e.t, e.session.step) == before  # snapshot consumes nothing