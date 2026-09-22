"""SimEngine: the clock owns time, the phase machine owns transitions."""

from cabin_sim.sim import SimEngine

from conftest import make_session


def test_tick_advances_clock_and_steps():
    e = SimEngine(make_session(max_steps=1000), seed=3, tick_dt=2.0)
    e.tick(4)
    assert e.t == 8.0
    assert e.session.step == 4


def test_tick_stops_at_done():
    e = SimEngine(make_session(max_steps=4), seed=3, tick_dt=1.0)
    e.tick(50)
    assert e.session.step == 4
    assert e.done is True
    t_after_done = e.t
    e.tick(10)
    assert e.t == t_after_done  # no advancement past completion


def test_phases_setup_ride_done():
    e = SimEngine(make_session(max_steps=1000), seed=3, tick_dt=1.0,
                  ride_start=10.0)
    assert e.phase == "setup"
    e.tick(10)
    assert e.phase == "ride"
    for _ in range(200):
        e.tick(10)
    e.session.finish()
    assert e.phase == "done"


def test_run_finishes_from_anywhere():
    e = SimEngine(make_session(max_steps=50), seed=2, tick_dt=1.0)
    e.run()
    assert e.done is True
    assert e.session.questionnaire is not None
    assert e.phase == "done"
    assert e.t == 50.0


def test_run_obeys_max_steps_cap():
    e = SimEngine(make_session(max_steps=50), seed=2, tick_dt=1.0)
    e.run(max_steps=5)
    assert e.session.step == 5
    assert e.done is True
    assert e.t == 5.0


def test_snapshot_before_any_step_is_setup():
    e = SimEngine(make_session(max_steps=40), seed=1, tick_dt=1.0)
    s = e.snapshot()
    assert s["phase"] == "setup"
    assert s["step"] == 0
    assert s["running"] is True
    assert s["done"] is False