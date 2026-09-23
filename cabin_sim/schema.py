"""Canonical external state schema for the Python-authoritative phase.

This module is the single contract for everything the simulation publishes.
A snapshot produced here is the delivered unit: the future transport (WebSocket)
and the three.js view consume exactly this shape and nothing else. The shape is
versioned so the contract can never drift silently across the boundary.

Units are the canonical cabin_sim units: millimetres for slide/height, degrees
for recline/rotation. See MIGRATION.md for how the drawn three.js rig converts
these for display — the view never redefines state.

Fields marked PORT were slots for the JavaScript ride/BDI logic (cognitive.js);
they are now filled from cabin_sim.cognition.Mind, which is the ported mind.
`empty_snapshot()` keeps neutral defaults (the template before any producer
runs), `build_snapshot()` fills them.

Layer ownership (see MIGRATION.md):
    view  <--  transport (not built)  <--  SimEngine (cabin_sim.sim)
        <--  session / world / agent / questionnaire  --  authoritative
"""

from __future__ import annotations

SCHEMA_VERSION = 1
SCHEMA_NAME = "cabin-agent.v1"

# Canonical seat axes and their hard clamps. These MUST mirror the constants on
# cabin_sim.world.Seat; tests/test_world.py guards against drift.
SEAT_AXES = ("slider_mm", "height_mm", "recline_deg", "rotation_deg")
SEAT_LIMITS = {
    "slider_mm": (260, 440),
    "height_mm": (380, 460),
    "recline_deg": (80, 110),
    "rotation_deg": (0, 359),
}


def empty_snapshot() -> dict:
    """A neutral, JSON-serializable snapshot template.

    `None` means "this producer has not provided the value yet" (PORT fields
    and anything a session has not reached, e.g. trust before the end of the
    ride). `version`/`schema` are always present.
    """
    return {
        "version": SCHEMA_VERSION,
        "schema": SCHEMA_NAME,
        "t": 0.0,
        "phase": "setup",
        "step": 0,
        "running": True,
        "done": False,
        "world": {
            "seat": {"slider_mm": None, "height_mm": None,
                     "recline_deg": None, "rotation_deg": None},
            "vending": {"snack": None, "water": None, "coffee": None},
            "table": {"folded": None},
        },
        "ride": {"speed": 0.0, "g": 0.0, "jolt": 0.0, "rain": 0.0,
                 "kind": ""},  # filled by mind
        "agent": {
            "mood": {"comfort": None, "energy": None, "suspicion": None},
            "trust": {"score": None, "live": None},  # live: filled by mind
            "intention": None,  # filled by mind (BDI goal)
            "intentionSince": None,  # sim time the intention was chosen
            "speech": "",
            "thoughts": [],  # filled by mind
            "memory": [],    # associative traces: [{id,label,act,age,rehearsed}]
            "forgot": [],    # ring of forgotten traces: [{label,age}]
            "forgotCount": 0,
            "module": "",    # active module: perceive|memorize|think|speak|...
            "chat": [],      # experimenter chat history
            "log": [],       # mind log lines (newest first)
            "reasoning": "", # "rules" or "llm:<provider>" — who is reasoning
            "samples": [],   # mood/trust samples every ~3 s (summary charts)
            "trail": [],     # live-trust trail [{t, v}]
            "prefs": {"rot": None, "hgt": None, "tolRot": None, "tolHgt": None},
            "traits": [],  # persona trait strings, e.g. ["introvert", "suspicious"]
        },
        "priors": {"rides": 0, "trust": None},  # filled by engine priors JSON
        "log": [],
    }


def _mdmt_score(questionnaire) -> float | None:
    """Map the end-of-session MDMT factors (0..7) onto the sim's 0..1 trust score.

    Returns None before the questionnaire has run or if it produced no factors.
    """
    if not questionnaire:
        return None
    factors = questionnaire.get("factors") or {}
    vals = [v for v in factors.values() if v is not None]
    if not vals:
        return None
    return round(sum(vals) / len(vals) / 7.0, 4)


def build_snapshot(engine) -> dict:
    """Build the canonical state snapshot from a SimEngine (cabin_sim.sim).

    Pure: reads engine/session only, consumes no randomness, does not mutate.
    Two calls with the same engine state return identical dicts.
    """
    snapshot = empty_snapshot()
    st = engine.session.state()

    snapshot["t"] = engine.t
    snapshot["step"] = st["step"]
    snapshot["done"] = st["done"]
    snapshot["running"] = bool(getattr(engine, "running", True)) and not st["done"]
    snapshot["phase"] = engine.phase

    snapshot["world"]["seat"].update(st["cabin"]["seat"])
    snapshot["world"]["vending"].update(st["cabin"]["vending"])
    snapshot["world"]["table"].update(st["cabin"]["table"])

    mood = st.get("mood") or {}
    snapshot["agent"]["mood"]["comfort"] = mood.get("comfort")
    snapshot["agent"]["mood"]["energy"] = mood.get("energy")
    snapshot["agent"]["mood"]["suspicion"] = mood.get("suspicion")
    snapshot["agent"]["trust"]["score"] = _mdmt_score(st.get("questionnaire"))

    # ---- the ported mind fills every PORT slot ---------------------------
    mind = getattr(engine, "mind", None)
    if mind is not None:
        snap_agent = snapshot["agent"]
        snap_agent["mood"] = {k: round(float(v), 4)
                              for k, v in mind.mood.items()}
        snap_agent["trust"]["live"] = round(mind.trust_value(), 4)
        snap_agent["intention"] = mind.bdi["intention"]
        snap_agent["intentionSince"] = mind.bdi["since"]
        snap_agent["thoughts"] = list(mind.thoughts)
        snap_agent["speech"] = mind.speech or st.get("say") or ""
        snap_agent["memory"] = mind.memory.view(mind.t)
        snap_agent["forgot"] = mind.memory.forgot_view()
        snap_agent["forgotCount"] = mind.memory.forgot_count
        snap_agent["module"] = mind.module
        snap_agent["chat"] = list(mind.chat)
        snap_agent["log"] = list(mind.log)
        snap_agent["reasoning"] = (mind.reasoner.kind
                                   if mind.reasoner else "rules")
        snap_agent["samples"] = [{k: (round(v, 4) if isinstance(v, float) else v)
                                  for k, v in s.items()} for s in mind.samples]
        snap_agent["trail"] = [{"t": round(s["t"], 2), "v": round(s["v"], 4)}
                               for s in mind.trail]
        snap_agent["prefs"] = {"rot": mind.target_rot, "hgt": mind.target_hgt_cm,
                               "tolRot": mind.tol_rot, "tolHgt": mind.tol_hgt_cm}
        snapshot["ride"].update({k: round(float(v), 4)
                                 for k, v in mind.ride.items() if k != "kind"})
        snapshot["ride"]["kind"] = str(mind.ride.get("kind", "") or "")
        snap_agent["traits"] = list(
            getattr(getattr(engine, "mind", None), "persona", {}).get("traits", []))
        snapshot["priors"] = mind.priors or {"rides": 0, "trust": None}
    else:
        snapshot["agent"]["speech"] = st.get("say") or ""
        snapshot["ride"].update(engine.ride)

    snapshot["log"] = list(st.get("activity", []))
    return snapshot


def check(snapshot) -> list[str]:
    """Validate a snapshot against the contract; return a list of issues.

    An empty list means the snapshot is conformant. Used by tests now and by
    the transport later as a last line of defence.
    """
    issues = []
    if snapshot.get("version") != SCHEMA_VERSION:
        issues.append(f"version must be {SCHEMA_VERSION}, got {snapshot.get('version')!r}")
    if snapshot.get("schema") != SCHEMA_NAME:
        issues.append(f"schema must be {SCHEMA_NAME!r}, got {snapshot.get('schema')!r}")
    if snapshot.get("phase") not in ("setup", "ride", "done"):
        issues.append(f"unrecognised phase {snapshot.get('phase')!r}")

    seat = (snapshot.get("world") or {}).get("seat") or {}
    for axis, (lo, hi) in SEAT_LIMITS.items():
        v = seat.get(axis)
        if v is not None and not (lo <= v <= hi):
            issues.append(f"seat.{axis}={v} out of bounds [{lo}, {hi}]")

    mood = ((snapshot.get("agent") or {}).get("mood")) or {}
    for k in ("comfort", "energy", "suspicion"):
        v = mood.get(k)
        if v is not None and not (0.0 <= v <= 1.0):
            issues.append(f"agent.mood.{k}={v} outside [0, 1]")

    score = ((snapshot.get("agent") or {}).get("trust") or {}).get("score")
    if score is not None and not (0.0 <= score <= 1.0):
        issues.append(f"agent.trust.score={score} outside [0, 1]")

    agent = snapshot.get("agent") or {}
    live = (agent.get("trust") or {}).get("live")
    if live is not None and not (0.0 <= live <= 1.0):
        issues.append(f"agent.trust.live={live} outside [0, 1]")

    intention = agent.get("intention")
    if intention is not None and intention not in ("settle", "attend", "calibrate"):
        issues.append(f"unrecognised intention {intention!r}")

    for tr in agent.get("memory") or []:
        act = tr.get("act")
        if act is None or not (0.0 <= act <= 1.0):
            issues.append(f"memory trace act={act!r} outside [0, 1]")

    for axis, v in (snapshot.get("ride") or {}).items():
        if axis == "kind":
            if not isinstance(v, str):
                issues.append(f"ride.kind={v!r} must be an event-kind string")
            continue
        if not isinstance(v, (int, float)) or v < 0:
            issues.append(f"ride.{axis}={v!r} must be a non-negative number")

    t = snapshot.get("t")
    if not isinstance(t, (int, float)):
        issues.append(f"t must be a number, got {type(t).__name__}")
    return issues