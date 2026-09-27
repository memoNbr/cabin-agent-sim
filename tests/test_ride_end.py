"""The end of the ride is an END, not a timeout.

Regression cover for a defect that made the whole experiment silent: nothing
stopped the session when the scripted ride window elapsed. With the server's
"unlimited" max_steps the clock ran forever, `done` never became true, the
snapshot's phase stayed "ride", and - worst - the MDMT questionnaire, the only
trust measure the rig has, was never administered. A run that cannot end cannot
produce a result.
"""

from cabin_sim.sim import SimEngine

from conftest import make_session


def _short_ride(max_steps: int = 100000, ride_end: float = 20.0):
    """A session whose ride window closes early, so the test is fast."""
    sess = make_session(max_steps=max_steps)
    sess.mind.ride_end = ride_end
    return sess


def test_phase_reports_done_from_the_clock_alone():
    """The phase must follow the ride window, not wait to be told.

    This is the regression: `phase` used to have no ride_end branch at all, so
    only the Mind knew the ride had ended and the view's RIDE chip read "ride"
    forever.
    """
    e = SimEngine(_short_ride(ride_end=20.0), seed=1, tick_dt=1.0, ride_start=5.0)
    assert e.phase == "setup"
    e.tick(5)
    assert e.phase == "ride"
    e.tick(20)                      # t = 25, past ride_end = 20
    assert e.t >= 20.0
    assert e.phase == "done"        # with nobody having called finish()


def test_ride_complete_is_false_before_the_window_closes():
    sess = _short_ride(ride_end=20.0)
    e = SimEngine(sess, seed=1, tick_dt=1.0)
    e.tick(5)
    assert sess.ride_complete() is False


def test_ride_end_finishes_the_session_and_administers_the_questionnaire():
    """Ending the ride must produce the outcome measure, exactly once."""
    sess = _short_ride(ride_end=20.0)
    e = SimEngine(sess, seed=1, tick_dt=1.0)
    e.tick(5)
    assert sess.ride_complete() is False
    assert sess.done is False
    assert sess.questionnaire is None

    e.tick(20)                      # t = 25 > ride_end = 20
    assert sess.ride_complete() is True

    # this is what the server ticker now does, and what nothing used to do
    sess.finish()

    assert sess.done is True
    assert sess.questionnaire is not None, \
        "the MDMT is the only trust measure; a finished ride must produce it"
    assert sess.questionnaire.get("factors") is not None


def test_finish_is_idempotent_so_the_ticker_cannot_double_run_it():
    """The ticker checks every pass, so finish() must be safe to re-enter."""
    sess = _short_ride(ride_end=20.0)
    e = SimEngine(sess, seed=1, tick_dt=1.0)
    e.tick(25)
    sess.finish()
    first = sess.questionnaire
    sess.finish()                   # would re-run the questionnaire without the guard
    sess.finish()
    assert sess.questionnaire == first
    assert sess.done is True


def test_engine_keeps_no_time_after_the_ride_ends():
    """Once finished, the clock must stop, not coast on forever."""
    sess = _short_ride(ride_end=20.0)
    e = SimEngine(sess, seed=1, tick_dt=1.0)
    e.tick(25)
    sess.finish()
    t_end = e.t
    e.tick(50)
    assert e.t == t_end
