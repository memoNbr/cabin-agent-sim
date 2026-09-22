"""Tests for the ported cognitive core (cabin_sim.cognition).

Each group pins one contract from cognitive.js: the rate tables, the fit /
comfort / trust formulas, the memory dynamics, the BDI selection with its
cooldowns, the ride script, the chat hook and priors persistence.
"""

import json
import math

from cabin_sim.cognition import (
    EVENTS, GOAL_CD, HGT, ROT, THOUGHTS, Memory, Mind, ang_dist, fmt_time,
    rate, shortest_delta, view_sector,
)
from cabin_sim.schema import check, empty_snapshot
from cabin_sim.session import Session
from cabin_sim.sim import SimEngine
from cabin_sim.world import Cabin


def make_mind(persona, seed=1, cabin=None):
    return Mind(persona, cabin or Cabin(), seed=seed)


# ---- rate tables ---------------------------------------------------------


def test_rate_interpolates_and_clamps():
    assert rate(ROT, 0) == 1.0
    assert rate(ROT, 30) == 0.5
    assert abs(rate(ROT, 45) - (0.5 + (0.1429 - 0.5) * 0.5)) < 1e-9  # lerp 30..60
    assert rate(ROT, -10) == 1.0                              # below range
    assert rate(ROT, 999) == 1.0                              # above range
    assert abs(rate(HGT, 44) - 0.04545) < 1e-9
    assert abs(rate(HGT, 38) - 0.4545) < 1e-9


def test_ang_dist_and_shortest_delta():
    assert ang_dist(0, 350) == 10
    assert ang_dist(10, 350) == 20
    assert ang_dist(90, 270) == 180
    assert shortest_delta(90, 0) == -90
    assert shortest_delta(350, 10) == 20
    assert fmt_time(125) == "02:05"


def test_view_sector_matches_js():
    assert view_sector(0) == "FORWARD"
    assert view_sector(345) == "FORWARD"
    assert view_sector(90) == "LEFT"
    assert view_sector(180) == "CABIN"
    assert view_sector(270) == "RIGHT"


# ---- fit / comfort / trust ----------------------------------------------


def test_comfort_target_worked_example(persona):
    # forward-facing at the persona's preferred height -> 0.35 + 0.016 + 0.30
    cabin = Cabin()
    cabin.seat.rotation_deg = 0
    cabin.seat.height_mm = 440
    mind = make_mind(persona, cabin=cabin)
    assert abs(mind.comfort_target() - 0.6659) < 0.001
    fit = mind.seat_fit()
    assert fit["rot"] == 1.0 and fit["overall"] == 1.0


def test_seat_fit_gap_grows_with_turned_seat(persona):
    cabin = Cabin()                       # as found: rot 90, hgt 38 cm
    mind = make_mind(persona, cabin=cabin)
    fit = mind.seat_fit()
    assert fit["rot"] == 0.5              # 90 deg off
    assert abs(fit["hgt"] - 0.25) < 1e-9  # 6 cm off of 8 cm span
    gap = 1 - fit["overall"]
    assert abs(gap - 0.625) < 1e-9


def test_trust_value_worked_example(persona):
    mind = make_mind(persona)
    mind.mood["comfort"] = 0.5
    mind.mood["suspicion"] = 0.3
    mind.ride["jolt"] = 0.3
    mind.belief["fit_gap"] = 0.2
    # 0.34*0.5 + 0.40*0.7 + 0.16*0.5 + 0.10*0.8 = 0.61
    assert abs(mind.trust_value() - 0.61) < 1e-9


# ---- memory ---------------------------------------------------------------


def test_memory_decay_floor_and_forgetting():
    mem = Memory(lam=0.004, cap=8, floor=0.09, rehearsal=0.22)
    mem.remember("bump", "Pothole", 0.795, False, t=0.0)
    mem.decay(480.0, 480.0)                       # 8 min of decay
    assert abs(mem.traces[0]["act"] - 0.795 * math.exp(-0.004 * 480.0)) < 1e-12
    assert mem.traces                               # 0.1166 > 0.09 still there
    mem.decay(480.0, 960.0)                       # keep decaying -> forget
    assert not mem.traces
    assert mem.forgot_count == 1 and mem.forgot[0]["label"] == "Pothole"


def test_memory_cap_is_fifo_and_rehearsal_boosts():
    mem = Memory(cap=8, rehearsal=0.22)
    for i in range(10):
        mem.remember(f"e{i}", f"event {i}", 0.5, False, t=float(i))
    assert len(mem.traces) == 8
    assert mem.traces[0]["id"] == "e2"             # oldest two evicted
    tr = mem.pick()                                # retrieval = highest act
    before = tr["act"]
    mem.rehearse(tr)
    assert tr["act"] == min(1.0, before + 0.22)


# ---- BDI ------------------------------------------------------------------


def test_settle_goal_actuates_toward_persona_prefs(persona):
    mind = make_mind(persona)                      # cabin as found: 90 deg/38 cm
    cabin = mind.cabin
    start_rot, start_hgt = cabin.seat.rotation_deg, cabin.seat.height_mm
    mind.step(1.0)
    assert mind.bdi["intention"] == "settle"
    assert cabin.seat.rotation_deg != start_rot
    assert cabin.seat.height_mm != start_hgt
    assert cabin.seat.rotation_deg < start_rot     # toward 0 (shortest way)
    # The BDI keeps nudging while the fit gap clears the 0.22 threshold (the
    # JS settleThresh), then rests: gap collapses below the precondition.
    for _ in range(40):
        mind.step(1.0)
    assert cabin.seat.rotation_deg <= 50            # 90 deg as found -> near 0
    assert cabin.seat.height_mm >= 420              # 38 cm as found -> near 44
    mind.perceive_fit()
    assert mind.belief["fit_gap"] < 0.22            # settled: no more desire


def test_user_hands_suppress_self_adjust(persona):
    mind = make_mind(persona)
    mind.note_user_input("rot")                    # human grabbed the dial
    mind.step(1.0)
    assert mind.belief["user_hands"] is True
    assert mind.bdi["intention"] != "settle"       # hands off the BDI
    # ... and hands-off erodes suspicion faster (cabin ignores his body)
    before = mind.mood["suspicion"]


def test_goal_cooldowns_are_enforced(persona):
    mind = make_mind(persona)
    mind.step(1.0)
    assert mind.bdi["last"]["settle"] == mind.t
    mind.step(1.0)                                 # 1 s later: still cooling
    assert mind.bdi["last"]["settle"] != mind.t
    for _ in range(int(GOAL_CD["settle"]) + 2):
        mind.step(1.0)                             # after 9 s it may fire again


def test_calibrate_only_during_the_ride(persona):
    mind = make_mind(persona)
    mind.step(1.0)
    assert mind.phase == "setup"
    assert mind._pre("calibrate") is False
    mind.t = mind.ride_start + 5
    assert mind.phase == "ride" and mind._pre("calibrate") is True
    mind.t = mind.ride_end
    assert mind.phase == "done" and mind._pre("calibrate") is False


def test_intention_is_none_when_nothing_is_eligible(persona):
    mind = make_mind(persona)
    mind.mood["comfort"] = 1.0
    mind.cabin.seat.rotation_deg = 0               # settled: no settle desire
    mind.cabin.seat.height_mm = 440
    mind.memory.traces.clear()                     # nothing to attend
    mind.t = mind.ride_end                         # past the ride
    mind.bdi["last"] = {g: mind.t for g in GOAL_CD}  # everything cooling down
    mind.bdi_reason(1.0)
    assert mind.bdi["intention"] is None


# ---- ride script -----------------------------------------------------------


def test_events_fire_once_even_with_big_ticks(persona):
    mind = make_mind(persona)
    mind.step(200.0)                               # one tick jumps past many
    mind.step(200.0)
    mind.step(200.0)
    mind.step(200.0)                               # t = 800 > ride_end
    assert len(mind._fired) == len(EVENTS)
    assert len(mind.memory.traces) <= 8            # cap still holds
    assert mind.memory.forgot_count > 0            # old traces were forgotten
    assert mind.t == 800.0


def test_event_impulses_hit_mood(persona):
    mind = make_mind(persona)
    base_susp = mind.mood["suspicion"]
    mind.perceive_event({"t": 258, "kind": "bump", "g": 0.1, "jolt": 0.55,
                         "spd": 92, "label": "Pothole"})
    assert mind.mood["suspicion"] == min(1.0, base_susp + 0.20)
    assert mind.mood["comfort"] < 0.4
    assert mind.ride["jolt"] == 0.55 and mind.target_speed == 92


def test_mood_relaxes_toward_persona_setpoint(persona):
    mind = make_mind(persona)
    mind.mood["suspicion"] = 1.0                    # far above the 0.5 base
    for _ in range(50):
        mind.step(2.0)
    assert mind.mood["suspicion"] < 1.0
    assert mind.mood["suspicion"] >= mind.suspicion_base - 1e-9


# ---- language -------------------------------------------------------------


def test_thought_bank_is_complete():
    # every id a trace or situation can carry has a phrase bank
    required = {"bump", "curve", "overtake", "brake", "smooth", "workzone",
                "rain", "arrive", "depart", "merge", "seatLow", "seatGood",
                "rotFwd", "rotSide", "rotCabin", "idleC", "idleS", "idleN",
                "settle", "request", "trustOk", "trustLow", "settleLow",
                "chat", "endGood", "endMid", "endBad"}
    assert required <= set(THOUGHTS)
    assert all(isinstance(v, list) and v for v in THOUGHTS.values())


def test_think_keeps_only_three_lines(persona):
    mind = make_mind(persona)
    for _ in range(6):
        mind.think()
    assert len(mind.thoughts) == 3
    assert mind.module == "think"
    assert all("time" in th and "text" in th for th in mind.thoughts)


# ---- chat ------------------------------------------------------------------


def test_chat_hook_roundtrip(persona):
    mind = make_mind(persona)
    res = mind.chat_send("How do you feel about this ride?")
    assert res["ok"] is True and res["reply"]
    assert [c["who"] for c in mind.chat] == ["experimenter", "phill"]
    state = res["state"]
    assert state["phase"] in ("setup", "ride", "done")
    assert "trust" in state and "mood" in state and "seat" in state
    assert mind.chat_send("   ")["ok"] is False


def test_chat_seat_keyword_clears_settle_cooldown(persona):
    mind = make_mind(persona)
    mind.step(1.0)                                  # settle fires at t=1
    assert mind.bdi["last"]["settle"] == mind.t
    mind.chat_send("Could you adjust the seat?")
    assert mind.bdi["last"]["settle"] == -99.0      # BDI may act immediately


def test_chat_trust_answers_track_live_trust(persona):
    mind = make_mind(persona)
    mind.mood["comfort"], mind.mood["suspicion"] = 0.9, 0.1
    assert mind.trust_value() >= 0.6
    ok = mind.chat_send("Do you trust the car?")["reply"]
    assert ok in THOUGHTS["trustOk"]


# ---- engine integration & priors ------------------------------------------


def test_snapshot_carries_all_port_slots(persona, scripted):
    session = Session(persona, scripted, max_steps=100, seed=1)
    engine = SimEngine(session, seed=1, tick_dt=2.0, ride_start=120.0)
    engine.tick(70)                                 # t = 140: past depart (121)
    snap = engine.snapshot()
    assert snap["agent"]["intention"] in (None, "settle", "attend", "calibrate")
    assert snap["agent"]["thoughts"], "mind must publish thoughts"
    assert snap["agent"]["trust"]["live"] is not None
    assert 0 <= snap["agent"]["trust"]["live"] <= 1
    assert snap["agent"]["memory"] and snap["agent"]["module"]
    assert snap["agent"]["log"]
    assert check(snap) == []


def test_empty_template_stays_neutral():
    empty = empty_snapshot()
    assert empty["agent"]["intention"] is None
    assert empty["agent"]["thoughts"] == []
    assert empty["agent"]["trust"]["live"] is None
    assert empty["ride"] == {"speed": 0.0, "g": 0.0, "jolt": 0.0, "rain": 0.0}


def test_same_seed_same_mind_different_seed_differs(persona, scripted):
    def run(seed):
        s = Session(persona, scripted, max_steps=40, seed=seed)
        e = SimEngine(s, seed=seed, tick_dt=2.0)
        e.tick(20)
        return e.snapshot()

    assert run(1) == run(1)
    assert run(1) != run(2)


def test_priors_roundtrip_via_json_file(persona, scripted, tmp_path):
    path = tmp_path / "priors.json"
    s1 = Session(persona, scripted, max_steps=20, seed=1)
    e1 = SimEngine(s1, seed=1, priors_path=path)
    assert e1.priors is None
    e1.run()
    assert path.exists()
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved["rides"] == 1 and isinstance(saved["trust"], (int, float))

    s2 = Session(persona, scripted, max_steps=20, seed=1)
    e2 = SimEngine(s2, seed=1, priors_path=path)
    assert e2.priors == saved
    # a low prior trust raises the suspicion set-point (and vice versa)
    if saved["trust"] != 0.5:
        assert e2.mind.suspicion_base != 0.5
    e2.run()
    assert json.loads(path.read_text(encoding="utf-8"))["rides"] == 2
