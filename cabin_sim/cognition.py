"""The cognitive core, ported from src/cognitive.js into Python.

This is the authoritative mind: BDI deliberation, associative memory, the
mood/trust dynamics, the ride script and the experimenter chat all live here
now. The three.js/canvas page is a *view* - it polls the snapshot produced by
cabin_sim.schema and draws what it is told, it no longer reasons.

    world/cabin  -->  Mind.step(dt)  -->  schema snapshot  -->  view (JS)

Port fidelity: every constant, table and formula below is the one from
cognitive.js (see docs in cabin-agent-sim/tutorial-cognitive.html):

    seat fit      fitGap = (dr + dh + ds)/3, dr = |rot - target|/180,
                            dh = |hgt - target|/8, ds = |slider - target|/80
    comfort       0.35*rate(ROT,rot) + 0.35*rate(HGT,hgt) + 0.30*fit
    trust         0.34*comfort + 0.40*(1-susp) + 0.16*ev + 0.10*(1-fitGap)
    memory        act *= exp(-lambda*dt), lambda = 0.004/s, floor 0.09, cap 8
    BDI           settle / attend / calibrate, cooldowns 9 / 3.2 / 10 s

Reasoning modes (who picks the next action):

    rules  (reasoner is None)  the ported BDI above — Python computes
           desires/cooldowns and the argmax acts (what the deterministic
           suite pins).
    llm    (reasoner present)  the MODEL reasons: every allowed beat
           _llm_cycle() hands it the state plus the REAL outcome of its
           last action, it examines that outcome, reconsiders from its
           persona and proposes the next action WITH ITS OWN VALUES —
           Python keeps only the body (the dynamics above) and the safety
           clamps inside actions.apply_llm_action(). Chat orders are
           interpreted by the model too (chat_act: obey now, or keep a
           standing order until it reports order_done); the regex directive
           table below is the rules-mode/degrade path only.

Determinism: the ONLY randomness is self.rng (a seeded random.Random), so two
engines built with the same seed produce byte-identical snapshots.
"""

from __future__ import annotations

import math
import random
import re
import sys

from . import actions
from .world import Seat      # entry reset: back to the "as found" parked pose

# --------------------------------------------------------------------------
# reference data (thesis)
# --------------------------------------------------------------------------

ROT = [(0, 1.0), (30, 0.5), (60, 0.1429), (90, 0.4286), (120, 0.2143),
       (150, 0.4286), (180, 0.6071), (210, 0.4286), (240, 0.5333),
       (270, 0.6), (300, 0.2857), (330, 0.8462), (360, 1.0)]
HGT = [(38, 0.4545), (40, 0.2955), (42, 0.1818), (44, 0.04545), (46, 0.02273)]

RIDE_START = 120.0
RIDE_END = 600.0

EVENTS = [
    {"t": 121, "kind": "depart",   "g": 0.15, "jolt": 0.00, "spd": 60,
     "label": "Departing \u2014 auto-pilot engaged"},
    {"t": 158, "kind": "merge",    "g": 0.20, "jolt": 0.00, "spd": 105,
     "label": "Merging onto the motorway"},
    {"t": 200, "kind": "curve",    "g": 0.38, "jolt": 0.00, "spd": 115,
     "label": "Long left-hand curve"},
    {"t": 258, "kind": "bump",     "g": 0.10, "jolt": 0.55, "spd": 92,
     "label": "Pothole \u00b7 thump!"},
    {"t": 292, "kind": "overtake", "g": 0.45, "jolt": 0.25, "spd": 135,
     "label": "Overtaking a truck"},
    {"t": 340, "kind": "smooth",   "g": 0.08, "jolt": 0.00, "spd": 120,
     "label": "Cruising steadily"},
    {"t": 386, "kind": "curve",    "g": 0.32, "jolt": 0.00, "spd": 112,
     "label": "Right-hand curve"},
    {"t": 425, "kind": "brake",    "g": 0.25, "jolt": 0.18, "spd": 40,
     "label": "Traffic ahead \u2014 slowing"},
    {"t": 470, "kind": "workzone", "g": 0.12, "jolt": 0.22, "spd": 70,
     "label": "Roadworks \u00b7 rumble strip"},
    {"t": 520, "kind": "smooth",   "g": 0.06, "jolt": 0.00, "spd": 128,
     "label": "Clear road again"},
    {"t": 550, "kind": "rain",     "g": 0.14, "jolt": 0.10, "spd": 105,
     "label": "Light rain on the glass"},
    {"t": 575, "kind": "brake",    "g": 0.20, "jolt": 0.10, "spd": 30,
     "label": "Slowing for the destination"},
    {"t": 590, "kind": "arrive",   "g": 0.05, "jolt": 0.00, "spd": 0,
     "label": "Arrived \u2014 parked"},
]

IMPORTANT_KINDS = {"bump", "arrive", "workzone"}

# language (Phill, English, dry) - phrase banks keyed by memory/trace id
THOUGHTS = {
    "bump": ["That was a proper thump.", "The road's had better days.",
             "It handled that. Fine, so far."],
    "curve": ["Laying over into this one.", "It holds its line on the bends.",
              "Round it goes, no fuss."],
    "overtake": ["Big truck beside us, gone past.", "Wash of air as it rushed by.",
                 "It overtook without a wobble."],
    "brake": ["Whoa, slowing for something up ahead.", "Traffic's stacking up again.",
              "Braking by itself now."],
    "smooth": ["Nice and quiet when it just cruises.",
               "No steering wheel and I don't miss it. Yet.", "Smooth stretch. Easy."],
    "workzone": ["Rumble strip. Bump bump bump.", "Roadworks again, it's taking them slow.",
                 "That strip rattles the spine on purpose."],
    "rain": ["Starting to spit on the glass.", "Wipers on, steady.", "Rain. It's handling it."],
    "arrive": ["There we are, parked up.", "Made it. Right on time, it seems."],
    "depart": ["Here we go.", "It's driving itself out.", "Off we go then."],
    "greet": ["In we go — I'll get settled.", "Door's shut. Ready when you are.",
              "Sitting in, getting comfortable. Let's ride."],
    "merge": ["Gliding onto the motorway on its own.", "No drama joining the traffic."],
    "seatLow": ["Sits a bit low, this. Can't see much bonnet.",
                "Lowering again. My legs are bunching."],
    "seatGood": ["That's more like it.", "Better height. I can see over the dash now.",
                 "Yes, this is the position."],
    "rotFwd": ["Facing forward. Normal driving.", "Back to the road ahead."],
    "rotSide": ["Now I'm looking out the side.", "Sideways view. Neighbourhood rolling past."],
    "rotCabin": ["Turned round to face the cabin.", "Odd, but the view backwards is clear."],
    "rotOther": ["A bit turned from the road.", "Tilted off true, that."],
    "idleC": ["Not bad, honestly.", "I could get used to this.",
              "It rides smoothly at least.", "Plenty of room now."],
    "idleS": ["It decides things before I've even looked.",
              "Right\u2026 it moves by itself. Taking my time.", "No wheel. Of course."],
    "idleN": ["Weekend commute.", "Home in about an hour, probably.",
              "Hope the week stays quiet.", "A bit of quiet before the week starts."],
    "settle": ["Let me settle that properly.", "There \u2014 a seat to sit tall in.",
               "Give it a nudge, that's it."],
    "request": ["I'd sit a touch taller, if it's being adjusted anyway.",
                "A little more upright and I'm comfortable.",
                "Could it raise me an inch? I build my own height in."],
    "trustOk": ["The car earns trust, mile by mile.", "It reads the road and I read it back. Alright.",
                "Starting to relax into this."],
    "trustLow": ["I'm not sure it sees everything.", "The more it twitches, the less I trust it.",
                 "It handles things, but I stay awake."],
    "trustMid": ["It's done right so far, mostly.", "Cautious is the sensible way to ride.",
                 "Ask me again when we park."],
    "settleLow": ["Lower again. Maybe I came back wrong.", "I keep wanting to sit up straighter."],
    "chat": ["Someone's asking me things again.", "Experimenter on the line \u2014 I'll answer straight.",
             "That question's still sitting with me."],
    "endGood": ["I'd take another ride.", "That's a keeper, honestly."],
    "endMid": ["Mostly fine. A few minutes were iffy.", "Decent enough ride."],
    "endBad": ["I'd rather drive myself next time.", "Got out a little wary."],
}

CHAT_SEAT = re.compile(r"(seat|height|tall|lower|raise|rotate|rotation|adjust|settle)")
CHAT_TRUST = re.compile(r"(trust|safe|confidence|rely|sure)")
CHAT_WELLBEING = re.compile(r"(feel|how|you|ok|okay|alright|comfort|fine|doing)")

# ---- experimenter DIRECTIVES -------------------------------------------
# This is an EXPERIMENT: the experimenter dictates, the agent obeys.
# Imperative messages ("slide back", "raise the seat", "settle", "say …")
# are executed — not discussed. A preference question ("would you like …?")
# is conversational and returns None below.
DIR_QUESTION = re.compile(
    r"\b(?:would you (?:like|want)|do you (?:want|like|feel|prefer)|"
    r"are you (?:okay|comfortable|happy)|how (?:do you feel|are you|is your)|"
    r"should (?:i|we)|shall (?:i|we)|what (?:do you want|would you))\b")
DIR_RULES = (
    (re.compile(r"\b(?:more legroom|leg\s?room|space for (?:your|my) legs|"
                r"slide (?:further )?back|move (?:further )?back|further back|"
                r"more space|scoot back)\b"), "sl+"),
    (re.compile(r"\b(?:less legroom|slide (?:further )?(?:forward|ahead)|"
                r"move (?:further )?(?:forward|ahead)|further (?:forward|ahead)|"
                r"scoot (?:forward|ahead))\b"), "sl-"),
    (re.compile(r"\b(?:raise|lift|up) (?:the |your )?seat\b"
                r"|\b(?:seat|height) (?:go(?:es)? )?up\b"
                r"|\b(?:sit (?:a )?(?:bit )?higher|go (?:a )?bit higher)\b"), "up"),
    (re.compile(r"\b(?:lower|drop|down) (?:the |your )?seat\b"
                r"|\b(?:seat|height) (?:go(?:es)? )?down\b"
                r"|\b(?:sit (?:a )?(?:bit )?lower|go (?:a )?bit lower)\b"), "down"),
    (re.compile(r"\b(?:lean (?:further |a bit )?back|recline(?: (?:more|further|back))?|"
                r"backrest (?:back|down))\b"), "rec+"),
    (re.compile(r"\b(?:sit (?:up|straight|upright)|more upright|less recline|"
                r"backrest (?:up|forward))\b"), "upr"),
    (re.compile(r"\b(?:face|turn|swivel) (?:to (?:the )?)?"
                r"(?:forward|straight|the road)\b"), "fwd"),
    (re.compile(r"\b(?:face|turn|swivel) (?:to (?:the )?)?"
                r"(?:me|around|the back|the rear)\b"), "about"),
    (re.compile(r"\b(?:turn|swivel|face) (?:to (?:the )?)?(left|right)\b"), "side"),
    (re.compile(r"\b(?:settle|adjust (?:your|the|this) seat|get comfortable|"
                r"make yourself comfortable|get settled|find (?:your|a) "
                r"(?:better )?(?:position|comfort))\b"), "settle"),
)
# deterministic confirmations — also the fallback when the LLM fails
DIR_CONFIRM = {
    "sl+": "Consider it done \u2014 sliding back for more legroom.",
    "sl-": "Sure \u2014 moving forward a touch.",
    "up": "On it \u2014 raising the seat.",
    "down": "Right \u2014 lowering the seat.",
    "rec+": "Reclining back a little.",
    "upr": "Sitting up straighter.",
    "fwd": "Turning to face the road.",
    "about": "Turning round to face the cabin.",
    "side": "Swivelling that way a touch.",
    "settle": "Settling in \u2014 one moment.",
    "say": "Understood.",
}

GOAL_CD = {"settle": 2.0, "attend": 3.2, "calibrate": 10.0}
# settle re-engages fast: he keeps nudging the seat until the fit closes


# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------

def clamp01(x: float) -> float:
    return max(0.0, min(1.0, float(x)))


def ang_dist(a: float, b: float) -> float:
    """Smallest absolute angle between two headings, in degrees."""
    return abs(((a - b) % 360 + 540) % 360 - 180)


def shortest_delta(a: float, b: float) -> float:
    """Signed shortest rotation taking heading a to heading b (in [-180, 180])."""
    return ((b - a + 540) % 360) - 180


def fmt_time(t: float) -> str:
    m, s = int(t // 60), int(t % 60)
    return f"{m:02d}:{s:02d}"


def view_sector(rot: float) -> str:
    r = rot % 360
    if r < 30 or r >= 330:
        return "FORWARD"
    if 150 <= r < 210:
        return "CABIN"
    return "LEFT" if r < 150 else "RIGHT"


def rate(tbl, x: float) -> float:
    """Clamped piecewise-linear lookup (the JS rate() function)."""
    first, last = tbl[0], tbl[-1]
    if x <= first[0]:
        return first[1]
    if x >= last[0]:
        return last[1]
    for i in range(len(tbl) - 1):
        a, b = tbl[i], tbl[i + 1]
        if a[0] <= x <= b[0]:
            return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0])
    return first[1]


# --------------------------------------------------------------------------
# memory
# --------------------------------------------------------------------------

class Memory:
    """Associative traces with exponential decay (ACT*-flavoured, as in JS)."""

    def __init__(self, lam=0.004, cap=8, floor=0.09, rehearsal=0.22):
        self.lam = lam
        self.cap = cap
        self.floor = floor
        self.rehearsal = rehearsal
        self.traces = []          # dicts: id, label, salience, act, born, rehearsed
        self.forgot = []          # ring of the last few forgotten traces
        self.forgot_count = 0

    def remember(self, trace_id, label, salience, important, t):
        act = min(1.0, salience + (0.1 if important else 0.0))
        self.traces.append({"id": trace_id, "label": label, "salience": salience,
                            "act": act, "born": t, "rehearsed": 0})
        if len(self.traces) > self.cap:
            del self.traces[: len(self.traces) - self.cap]      # FIFO evict
        return act

    def decay(self, dt, t):
        """Exponential decay; returns the traces that died this tick."""
        dead = []
        for tr in self.traces:
            tr["act"] *= math.exp(-self.lam * dt)
            if tr["act"] < self.floor:
                dead.append(tr)
        for tr in dead:
            self.traces.remove(tr)
            if len(self.forgot) > 5:
                self.forgot.pop(0)
            self.forgot.append({"label": tr["label"],
                                "age": int(round(t - tr["born"]))})
            self.forgot_count += 1
        return dead

    def pick(self):
        """Retrieval: highest activation wins."""
        if not self.traces:
            return None
        return max(self.traces, key=lambda tr: tr["act"])

    def rehearse(self, tr):
        tr["rehearsed"] += 1
        tr["act"] = min(1.0, tr["act"] + self.rehearsal)

    def view(self, t):
        return [{"id": tr["id"], "label": tr["label"], "act": round(tr["act"], 4),
                 "age": int(t - tr["born"]), "rehearsed": tr["rehearsed"]}
                for tr in self.traces]

    def forgot_view(self):
        return list(self.forgot)


# --------------------------------------------------------------------------
# the mind
# --------------------------------------------------------------------------

class Mind:
    """BDI agent state: perceive -> desire -> intention -> act, per tick."""

    def __init__(self, persona, cabin, seed=1, reasoner=None):
        self.persona = persona
        self.cabin = cabin
        # reasoning mode: None = deterministic rules (the port as shipped);
        # an LLMReasoner picks the intention/wording among Python-legal
        # options (see cabin_sim/reasoning.py)
        self.reasoner = reasoner

        self.apply_persona(persona)   # prefs, tolerances, talkativeness,
        self.energy_drain = 0.00018   # suspicion set-point, cog tunables

        self.rng = random.Random(seed)
        self.memory = Memory(lam=self.memory_lambda, cap=self.memory_cap,
                             floor=self.forget_floor, rehearsal=self.rehearsal_boost)

        # time & lifecycle
        self.t = 0.0
        self.finished = False

        # affect
        mood = persona.get("mood", {})
        self.mood = {
            "comfort": 0.4,
            "energy": float(mood.get("energy", 0.6)),
            "suspicion": float(mood.get("suspicion", 0.5)),
        }

        # ride dynamics
        self.ride = {"speed": 0.0, "g": 0.0, "jolt": 0.0, "rain": 0.0,
                     "kind": ""}
        self.target_speed = 0.0

        # BDI
        self.belief = {"fit_gap": 0.0, "fit_rot": 0.0, "fit_hgt": 0.0,
                       "fit_sl": 0.0, "user_hands": False}
        self.bdi = {"intention": None, "since": 0.0, "last": {}}
        self.self_act = 0

        # outputs
        self.thoughts = []
        self.speech = ""
        self.module = ""
        self.log = []
        self.chat = []
        self.samples = []
        self.trail = []

        # the LLM decide loop (llm mode; inert in rules mode)
        self.last_outcome = None   # what the cabin ACTUALLY did last — the
                                   # OUTCOME line the model examines next
        self.instruction = None    # standing order from the experimenter, or None
        self.cycle = None          # last cycle {examine, reconsider, say,
                                   # action, name, ok} for the session log
        self._action_result = None # queued {name, ok, detail} for observe()

        # bookkeeping
        self._fired = set()
        self._last_user_input = -99.0
        self._last_sample_t = -1.0
        self._rot_changed = False
        self._pending_thought = None     # LLM thought from this tick's choice
        self.priors = None

    def apply_persona(self, persona):
        """(Re)derive everything in the mind that comes from the persona.

        Called once from __init__, and again on a LIVE persona switch (the
        sim UI's [persona] button): seat preferences + tolerances,
        talkativeness, the suspicion set-point and the cognition
        tunables. Mid-run the clock, the mood values and the memory
        traces are KEPT — only the person behind them changes (the live
        memory picks up the new decay rate in place).
        """
        self.persona = persona
        cog = persona.get("cognition", {})

        # persona-derived preferences (mm/deg canonical, converted where the
        # formulas want cm like the JS original)
        seat_pref = persona.get("seat", {})
        tol = persona.get("tolerance", {})
        self.target_rot = float(seat_pref.get("rotation_deg", 0))
        self.target_hgt_cm = float(seat_pref.get("height_mm", 440)) / 10.0
        self.target_slider_mm = float(seat_pref.get("slider_mm", 330))  # legroom
        self.tol_rot = float(tol.get("rotation_deg", 20))
        self.tol_hgt_cm = float(tol.get("height_mm", 20)) / 10.0
        self.tol_sl_mm = float(tol.get("slider_mm", 90))

        mood = persona.get("mood", {})
        self.talkativeness = float(persona.get("talkativeness", 0.55))
        self.suspicion_base = float(mood.get("suspicion", 0.5))

        # tunables (cognition block, with JS defaults)
        self.memory_lambda = float(cog.get("memory_lambda", 0.004))
        self.memory_cap = int(cog.get("memory_cap", 8))
        self.forget_floor = float(cog.get("forget_floor", 0.09))
        self.rehearsal_boost = float(cog.get("rehearsal_boost", 0.22))
        self.settle_thresh = float(cog.get("settle_thresh", 0.22))
        self.settle_step_mm = int(cog.get("settle_step_mm", 10))
        self.settle_step_deg = int(cog.get("settle_step_deg", 10))
        self.ride_start = float(cog.get("ride_start", RIDE_START))
        self.ride_end = float(cog.get("ride_end", RIDE_END))

        if getattr(self, "memory", None) is not None:   # live persona switch:
            self.memory.lam = self.memory_lambda        # keep traces, new rate

    # ---- derived state ---------------------------------------------------

    @property
    def phase(self) -> str:
        if self.finished:
            return "done"
        if self.t >= self.ride_end:
            return "done"
        return "ride" if self.t >= self.ride_start else "setup"

    def seat_fit(self):
        seat = self.cabin.seat
        rot = seat.rotation_deg % 360
        hgt_cm = seat.height_mm / 10.0
        dr = min(1.0, abs(rot - self.target_rot) / 180.0)
        dh = min(1.0, abs(hgt_cm - self.target_hgt_cm) / 8.0)
        # legroom is part of the fit: 80 mm of slide counts like 8 cm of
        # height (same 0..1 full-scale), so "he wants more space for his
        # legs" shows up in fit_gap and drives the settle desire
        ds = min(1.0, abs(seat.slider_mm - self.target_slider_mm) / 80.0)
        return {"rot": 1 - dr, "hgt": 1 - dh, "sl": 1 - ds,
                "overall": 1 - (dr + dh + ds) / 3}

    def comfort_target(self) -> float:
        seat = self.cabin.seat
        a_r = rate(ROT, seat.rotation_deg % 360)
        a_h = rate(HGT, seat.height_mm / 10.0)
        f = self.seat_fit()["overall"]
        return clamp01(0.35 * a_r + 0.35 * a_h + 0.30 * f)

    def trust_value(self) -> float:
        ev = clamp01(1 - self.ride["jolt"] / 0.6)
        s = 1 - self.mood["suspicion"]
        return clamp01(0.34 * self.mood["comfort"] + 0.40 * s
                       + 0.16 * ev + 0.10 * (1 - self.belief["fit_gap"]))

    def set_module(self, name):
        self.module = name

    def log_line(self, kind, text):
        self.log.insert(0, {"t": fmt_time(self.t), "kind": kind, "text": text})
        del self.log[60:]

    # ---- input from the view (human hands on the controls) ---------------

    def note_user_input(self, axis=None):
        self._last_user_input = self.t
        if axis == "rot":
            self._rot_changed = True

    # ---- memory / language ------------------------------------------------

    def remember(self, trace_id, label, salience, important=False):
        self.memory.remember(trace_id, label, salience, important, self.t)
        self.set_module("memorize")

    def decay_memory(self, dt):
        for tr in self.memory.decay(dt, self.t):
            self.set_module("forget")   # last dead trace lights the module

    def ambient_mood(self) -> str:
        if self.mood["suspicion"] > 0.6:
            return "idleS"
        if self.mood["comfort"] > 0.55:
            return "idleC"
        return "idleN"

    def pick_line(self, lines, exclude=None):
        candidates = [ln for ln in lines if ln != exclude] or list(lines)
        return candidates[int(self.rng.random() * len(candidates)) % len(candidates)]

    def think(self, in_phrase=None):
        phrase = in_phrase
        top = self.memory.pick()
        if not phrase:
            if self._rot_changed:
                sector = view_sector(self.cabin.seat.rotation_deg)
                key = ("rotFwd" if sector == "FORWARD"
                       else "rotCabin" if sector == "CABIN" else "rotSide")
                phrase = self.pick_line(THOUGHTS[key])
                self._rot_changed = False
            elif top:
                phrase = self.pick_line(THOUGHTS.get(top["id"], THOUGHTS["idleN"]))
                self.memory.rehearse(top)
        if not phrase:
            phrase = self.pick_line(THOUGHTS[self.ambient_mood()])
        # LLM voice: the thought worded during deliberation overrides the
        # phrase-bank line (memory side effects above — rehearse, _rot_changed
        # — already happened and stay Python-owned).
        if self.reasoner and self._pending_thought:
            phrase = self._pending_thought
        self._pending_thought = None
        self.thoughts.insert(0, {"time": fmt_time(self.t), "text": phrase})
        del self.thoughts[3:]
        self.set_module("think")
        return phrase

    def speak(self, text):
        self.speech = text
        self.set_module("speak")
        self.log_line("say", f"\u201c{text}\u201d")
        return text

    def maybe_speak(self, text):
        freq = self.talkativeness * (0.4
                                     + (0.3 if self.mood["suspicion"] > 0.62 else 0)
                                     + (0.25 if self.mood["comfort"] < 0.35 else 0))
        if self.rng.random() < freq:
            self.speak(text)

    def _spoken(self, situation, bank, force=False):
        """LLM line for this situation; the phrase bank always answers."""
        line = (self.reasoner.speak_line(self, situation, force=force)
                if self.reasoner else None)
        return line or self.pick_line(THOUGHTS.get(bank, THOUGHTS["idleN"]))

    def greet(self):
        """The avatar just climbed in and sat down: the seat is still in its
        parked "as found" pose for this ride — put it back so the settling
        (swivel, height, legroom) happens in front of the viewer, then say
        hello like a human."""
        if not self.belief.get("user_hands"):
            self.cabin.seat = Seat()            # parked pose, world-clamped
            self.bdi["last"]["settle"] = -99.0  # he may adjust immediately
            self.perceive_fit()
        return self.speak(self._spoken(
            "You just climbed into the cabin, sat down in the driver's seat "
            "and the ride is about to begin. Greet the experimenter briefly.",
            "greet", force=True))

    # ---- perception: the ride script --------------------------------------

    def perceive_event(self, ev):
        impact = max(ev["g"], ev["jolt"])
        salience = max(0.35, 0.42 + impact * 0.5)
        important = ev["kind"] in IMPORTANT_KINDS
        self.remember(ev["kind"], ev["label"], salience, important)

        self.target_speed = float(ev["spd"])
        self.ride["g"] = ev["g"]
        self.ride["jolt"] = ev["jolt"]
        self.ride["kind"] = ev["kind"]

        if ev["jolt"] > 0.3:
            self.mood["suspicion"] = min(1.0, self.mood["suspicion"] + 0.20)
            self.mood["comfort"] = max(0.0, self.mood["comfort"] - ev["jolt"] * 0.12)
        if ev["kind"] == "brake":
            self.mood["suspicion"] = min(1.0, self.mood["suspicion"] + 0.07)
        if ev["kind"] == "overtake":
            self.mood["suspicion"] = min(1.0, self.mood["suspicion"] + 0.05)
        if ev["kind"] == "rain":
            self.mood["suspicion"] = min(1.0, self.mood["suspicion"] + 0.04)

        self.log_line("evt", f"{ev['label']}  ({ev['spd']} km/h)")
        self.set_module("perceive")

        if ev["jolt"] > 0.2 or (ev["g"] > 0.25 and self.rng.random() < 0.5):
            self.maybe_speak(self._spoken(
                f"Ride event just happened: {ev['label']} at {ev['spd']} km/h "
                f"(g={ev['g']:.2f}, jolt={ev['jolt']:.2f}) — react out loud "
                "as a passenger.", ev["kind"]))
        return ev

    def _fire_events(self):
        for ev in EVENTS:
            key = ev["t"]
            if key not in self._fired and self.t >= ev["t"]:
                self._fired.add(key)
                self.perceive_event(ev)

    # ---- BDI --------------------------------------------------------------

    def perceive_fit(self):
        f = self.seat_fit()
        self.belief["fit_rot"] = 1 - f["rot"]
        self.belief["fit_hgt"] = 1 - f["hgt"]
        self.belief["fit_sl"] = 1 - f["sl"]
        self.belief["fit_gap"] = 1 - f["overall"]
        self.belief["user_hands"] = (self.t - self._last_user_input) < 3

    def _desire(self, goal):
        b = self.belief
        if goal == "settle":
            if not self.seat_pending():
                return 0.0
            ph = 1.3 if self.phase == "setup" else 0.9
            # (0.35 + gap) keeps settle the argmax WHILE any axis is off —
            # the averaged fit_gap alone goes quiet ~30° of swivel early
            # (rotation is 1/180 of the average and barely dents it)
            g = self.belief["fit_gap"]
            return min(2.0, ph * (0.35 + g)
                       * (0.15 if b["user_hands"] else 1.0))
        if goal == "attend":
            top = self.memory.pick()
            base = 0.3 + top["act"] * 0.7 if top else 0.15
            return base + (0.4 if self.mood["suspicion"] > 0.6 else 0.0)
        if goal == "calibrate":
            if self.phase != "ride":
                return 0.0
            k = 0.85 if (self.mood["suspicion"] > 0.62 or b["fit_gap"] > 0.35) else 0.5
            ramp = min(0.6, (self.t - self.ride_start)
                       / max(1e-9, (self.ride_end - self.ride_start)))
            return 0.35 + ramp * k
        return 0.0

    def seat_pending(self) -> bool:
        """Any axis still more than 35% of its tolerance off his preference?

        Settle lives/dies on this, not on the averaged fit_gap: rotation is
        only 1/180 of that average, so a 30°-still-swiveled seat would look
        'settled' to the average and never finish turning forward.
        """
        seat = self.cabin.seat
        return (abs(seat.height_mm - self.target_hgt_cm * 10)
                > self.tol_hgt_cm * 10 * 0.35
                or ang_dist(seat.rotation_deg, self.target_rot)
                > self.tol_rot * 0.35
                or abs(seat.slider_mm - self.target_slider_mm)
                > self.tol_sl_mm * 0.35)

    def _pre(self, goal):
        b = self.belief
        if goal == "settle":
            return self.seat_pending() and not b["user_hands"]
        if goal == "attend":
            return True
        if goal == "calibrate":
            return self.phase == "ride"
        return False

    def self_adjust(self):
        """Pull his own seat toward where his body says it goes (whitelisted).

        Each axis is driven while it sits more than 35% of its tolerance off
        target — the same convergence rule as the scripted walker, so both
        actuators land on the EXACT preference instead of the mind's coarse
        fit gates stalling short (rot30 / h430 / sl330)."""
        seat = self.cabin.seat
        changed = False

        if abs(seat.height_mm - self.target_hgt_cm * 10) > self.tol_hgt_cm * 10 * 0.35:
            if seat.height_mm < self.target_hgt_cm * 10:
                ok, _ = actions.apply(self.cabin, "seat_up")
            else:
                ok, _ = actions.apply(self.cabin, "seat_down")
            changed = changed or ok

        d = ang_dist(seat.rotation_deg, self.target_rot)
        if d > self.tol_rot * 0.35:
            delta = shortest_delta(seat.rotation_deg, self.target_rot)
            ok, _ = actions.apply(self.cabin,
                                  "rotate_cw" if delta > 0 else "rotate_ccw")
            if ok:
                self._rot_changed = True
            changed = changed or ok

        dsl = seat.slider_mm - self.target_slider_mm
        if abs(dsl) > self.tol_sl_mm * 0.35:
            ok, _ = actions.apply(self.cabin,
                                  "seat_back" if dsl > 0 else "seat_forward")
            changed = changed or ok

        if changed:
            self.self_act += 1
            self.log_line("adj", f"self-settle \u2192 {int(seat.rotation_deg % 360)}\u00b0 / "
                                 f"{seat.height_mm // 10} cm / sl {seat.slider_mm} mm")
        return changed

    # ---- the LLM decide cycle (llm mode; see the module docstring) -------

    def _perform(self, action, source="llm"):
        """Apply ONE model-proposed action and record the REAL outcome.

        The value choices are the model's (which axis, how far, when);
        Python only runs the vocabulary whitelist and lets the world clamp
        to its physical travel limits. Whatever actually happened — as
        asked, clamped, or refused — lands in `last_outcome`, the OUTCOME
        line the next decide() call examines, and in `_action_result` for
        the session to narrate and count.
        """
        ok, detail, name = actions.apply_llm_action(self.cabin, action)
        seat = self.cabin.seat
        self.last_outcome = {
            "action": dict(action), "ok": ok, "detail": detail, "name": name,
            "seat": {"rotation_deg": seat.rotation_deg % 360,
                     "height_mm": seat.height_mm,
                     "slider_mm": seat.slider_mm,
                     "recline_deg": seat.recline_deg},
            "t": self.t,
        }
        self._action_result = {"name": name, "ok": ok, "detail": detail}
        self.log_line("adj", f"{source} \u00b7 {name or 'action'} \u2014 {detail}")
        if name:
            # HUD label only — schema.check() knows just these three words.
            # The choice itself was the model's; this is how it is DISPLAYED.
            label = "attend" if action.get("kind") == "vending" else "settle"
            if self.bdi["intention"] != label:
                self.bdi["intention"] = label
                self.bdi["since"] = self.t
        return ok, detail, name

    def _llm_cycle(self):
        """One reasoning beat: examine the real outcome -> reconsider -> act.

        Everything the model decides — whether to move, which axis, how far,
        what to say — arrives as its own values from decide(). Python
        contributes only safety: the vocabulary whitelist and the world's
        travel clamps, whose effect is written into last_outcome for the
        model to examine on the next beat. A throttled or failed beat stays
        quiet: no rule fallback, no invented behaviour.
        """
        try:
            decision = self.reasoner.decide(self)
        except Exception as exc:                # noqa: BLE001 - never crash a tick
            print(f"cognition: llm cycle failed ({exc})", file=sys.stderr)
            decision = None
        if not decision:
            return                              # quiet beat (throttle/failure)
        self.set_module("intend")
        # his inner monologue, newest on top: what the outcome meant, then
        # what he wants now
        if decision.get("reconsider"):
            self.think(decision["reconsider"])
        if decision.get("examine"):
            self.think(decision["examine"])
        name, ok = None, False
        action = decision.get("action")
        if (isinstance(action, dict)
                and action.get("kind") not in (None, "none")):
            ok, _, name = self._perform(action, source="llm")
        if decision.get("say"):
            self.speak(decision["say"])
        if self.instruction and decision.get("order_done"):
            self.log_line("dir", f"order done \u00b7 {self.instruction[:60]}")
            self.instruction = None
        self.cycle = {"t": self.t,
                      "examine": decision.get("examine"),
                      "reconsider": decision.get("reconsider"),
                      "say": decision.get("say"),
                      "action": action, "name": name, "ok": ok}

    def consume_cycle(self):
        """Pop this step's LLM cycle for the session log (None = quiet beat)."""
        cycle, self.cycle = self.cycle, None
        return cycle

    def consume_action_result(self):
        """Pop the {name, ok, detail} of an action applied this step."""
        res, self._action_result = self._action_result, None
        return res

    def bdi_reason(self, dt):
        self.perceive_fit()

        # a persistent fit gap erodes trust: the cabin ignores his body
        gap = self.belief["fit_gap"]
        gb = (gap - 0.3) * 2.4 if gap > 0.3 else 0.0
        if gb > 0:
            hands = 1.6 if self.belief["user_hands"] else 1.0
            self.mood["suspicion"] = min(1.0, self.mood["suspicion"]
                                         + dt * 0.006 * gb * hands)

        if self.reasoner is not None:
            # llm mode: the MODEL reasons — examine the real outcome of its
            # last action, reconsider from its persona, pick the next action
            # (values and all). Python contributes only the body (the
            # dynamics above) and the safety clamps in actions.py; a
            # throttled or failed beat simply stays quiet.
            self._llm_cycle()
            return

        best, best_v = None, 0.0
        for goal in GOAL_CD:
            if self.t - self.bdi["last"].get(goal, -99.0) < GOAL_CD[goal]:
                continue                                   # cooldown
            if not self._pre(goal):
                continue                                   # precondition
            v = self._desire(goal)
            if v > best_v:
                best, best_v = goal, v                      # argmax = rule pick

        if best:
            self.bdi["intention"] = best
            self.bdi["since"] = self.t
            self.bdi["last"][best] = self.t
        else:
            self.bdi["intention"] = None

        if best == "settle":
            if self.self_adjust():
                if self.self_act % 2 == 0:
                    self.speak(self._spoken(
                        "You are adjusting the seat to fit yourself — "
                        "settling in. Say one short line out loud.", "settle"))
                else:
                    self.think(self.pick_line(THOUGHTS["settle"]))
            else:
                self.think(self.pick_line(THOUGHTS["settleLow"]))
                self.set_module("intend")
        elif best == "attend":
            self.maybe_speak(self.think())
        elif best == "calibrate":
            tw = self.trust_value()
            if tw >= 0.6:
                self.think(self.pick_line(THOUGHTS["trustOk"]))
            elif tw <= 0.38:
                line = self.pick_line(THOUGHTS["trustLow"])
                self.think(line)
                self.maybe_speak(self._spoken(
                    "Your trust in the cabin is low and you are "
                    "recalibrating — say one short line about it.", "trustLow"))
            else:
                self.set_module("intend")

    # ---- sampling (summary charts) -----------------------------------------

    def sample(self):
        if self.t - self._last_sample_t >= 3 or self.t < 3:
            self._last_sample_t = self.t
            tw = self.trust_value()
            self.samples.append({"t": self.t, "c": self.mood["comfort"],
                                 "s": self.mood["suspicion"],
                                 "e": self.mood["energy"], "trust": tw})
            self.trail.append({"t": self.t, "v": tw})

    # ---- one tick -----------------------------------------------------------

    def step(self, dt):
        """Advance the mind by dt sim-seconds. Called once per decision step."""
        if dt <= 0:
            return
        self.t += dt
        self._fire_events()

        # speed coasts toward the event's target
        k = min(1.0, dt * 0.05)
        self.ride["speed"] += (self.target_speed - self.ride["speed"]) * k

        # mood relaxation
        ct = self.comfort_target()
        self.mood["comfort"] += (ct - self.mood["comfort"]) * min(1.0, dt * 0.06)
        self.ride["g"] *= math.exp(-dt * 0.3)
        self.ride["jolt"] *= math.exp(-dt * 0.35)
        if self.ride["g"] < 0.12 and self.ride["jolt"] < 0.1:
            self.ride["kind"] = ""
        if 540 < self.t < 570:
            self.ride["rain"] = min(1.0, self.ride["rain"] + dt * 0.08)
        else:
            self.ride["rain"] *= math.exp(-dt * 0.18)
        self.mood["energy"] = max(0.05, self.mood["energy"] - dt * self.energy_drain)

        bs = self.suspicion_base
        if self.mood["suspicion"] > bs:
            self.mood["suspicion"] = max(bs, self.mood["suspicion"] - dt * 0.004)
        else:
            self.mood["suspicion"] = min(bs, self.mood["suspicion"] + dt * 0.003)

        # cognition
        self.decay_memory(dt)
        self.bdi_reason(dt)
        self.sample()

    # ---- experimenter chat ---------------------------------------------------

    def chat_state(self):
        top = self.memory.pick()
        seat = self.cabin.seat
        return {
            "t": self.t, "phase": self.phase, "done": self.finished,
            "mood": dict(self.mood),
            "trust": self.trust_value(),
            "belief": dict(self.belief),
            "intention": self.bdi["intention"], "since": self.bdi["since"],
            "seat": {"rot": int(seat.rotation_deg % 360),
                     "hgt": seat.height_mm / 10.0,
                     "sl": round((seat.slider_mm - 360) / 10.0, 1)},
            "memory": {"count": len(self.memory.traces),
                       "top": top["label"] if top else None,
                       "forgot": self.memory.forgot_count},
            "ride": dict(self.ride),
        }

    def _directive(self, raw):
        """An ORDER from the experimenter — he obeys (it's an experiment).

        Seat orders re-aim the settle TARGETS, so the change plays out
        visibly through the settling walk and then STICKS: the experimenter's
        word overrides his own persona prefs (he treats the ordered position
        as his liking). Preference questions return None → normal chat.
        Never raises: any failure degrades to the conversational path."""
        text = str(raw or "").strip()
        q = text.lower()
        if DIR_QUESTION.search(q):
            return None
        m = re.match(r"^(?:please\s+)?say[:,]?\s+(.+)$", text, re.I)
        if m:                                    # "say …" → speak that line
            line = m.group(1).strip()
            if line:
                return line[:160]
        hit = None
        for pat, code in DIR_RULES:
            m = pat.search(q)
            if m:
                hit = (code, m)
                break
        if not hit:
            return None
        code, m = hit
        try:
            seat = self.cabin.seat
            # slider mm counts from the REARMOST mount: LOWER = seat further
            # back = MORE legroom. Every changed target is also written back
            # into the SHARED persona dict — the legacy session walker reads
            # it live, so both actuators converge on the order instead of
            # fighting it: the experimenter's word becomes his preference.
            pref = self.persona.setdefault("seat", {})
            if code in ("sl+", "sl-"):
                step = max(60.0, self.tol_sl_mm) * (1 if code == "sl-" else -1)
                self.target_slider_mm = min(Seat.SLIDER_MAX,
                                            max(Seat.SLIDER_MIN,
                                                self.target_slider_mm + step))
                pref["slider_mm"] = int(self.target_slider_mm)
            elif code in ("up", "down"):
                step = 4.0 * (1 if code == "up" else -1)      # cm
                self.target_hgt_cm = min(Seat.HEIGHT_MAX / 10.0,
                                         max(Seat.HEIGHT_MIN / 10.0,
                                             self.target_hgt_cm + step))
                pref["height_mm"] = int(round(self.target_hgt_cm * 10))
            elif code == "rec+":
                seat.move("recline_deg", 6)
            elif code == "upr":
                seat.move("recline_deg", -6)
            elif code == "fwd":
                self.target_rot = 0.0
            elif code == "about":
                self.target_rot = 180.0
            elif code == "side":
                self.target_rot = ((self.target_rot
                                    + (45.0 if m.group(1) == "right" else -45.0))
                                   % 360.0)
            if code in ("fwd", "about", "side"):
                pref["rotation_deg"] = int(self.target_rot) % 360
            if code in ("rec+", "upr"):
                pref["recline_deg"] = int(seat.recline_deg)
            # "settle" needs no state change — only permission below
            self.perceive_fit()
            self.bdi["last"]["settle"] = -99.0   # he may act on it NOW
            self.log_line("dir", f"directive \u00b7 {code}")
            self.remember("directive", f"Experimenter ordered: {text}", 0.5, True)
            rule = DIR_CONFIRM[code]
            if self.reasoner:                    # LLM words it, rule always answers
                prompt = f"{text} [you already obeyed: {rule}]"
                return (self.reasoner.chat(self, prompt[:300], rule) or rule)
            return rule
        except Exception as exc:                 # noqa: BLE001 - degrade, never crash
            print(f"cognition: directive failed ({exc}) — chat used.",
                  file=sys.stderr)
            return None

    def _chat_reply(self, text):
        self.perceive_fit()                   # answer from the CURRENT seat,
        q = text.lower()                      # even between ticks
        tw = self.trust_value()
        # rule path runs first — its SIDE EFFECTS (settle-cooldown clear on
        # seat questions, rng draws) stay authoritative in every mode
        if CHAT_SEAT.search(q):
            if self.belief["fit_gap"] >= self.settle_thresh:
                self.bdi["last"]["settle"] = -99.0      # let the BDI act now
                rule = self.pick_line(THOUGHTS["request"])
            else:
                rule = self.pick_line(THOUGHTS["seatGood"])
        elif CHAT_TRUST.search(q):
            if tw >= 0.6:
                rule = self.pick_line(THOUGHTS["trustOk"])
            elif tw <= 0.38:
                rule = self.pick_line(THOUGHTS["trustLow"])
            else:
                rule = self.pick_line(THOUGHTS["trustMid"])
        elif CHAT_WELLBEING.search(q):
            rule = self.pick_line(THOUGHTS[self.ambient_mood()])
        else:
            rule = self.pick_line(THOUGHTS["idleN"])
        if self.reasoner:
            return self.reasoner.chat(self, text, rule) or rule
        return rule

    def chat_send(self, raw):
        text = str(raw or "").strip()
        if not text:
            return {"ok": False, "error": "empty message"}
        self.chat.append({"who": "experimenter", "t": self.t, "text": text})
        self.log_line("chat", f"experimenter \u00b7 {text}")
        self.remember("chat", f"Experimenter: {text}", 0.5, True)
        reply = None
        res, outcome = None, None
        if self.reasoner is not None:
            # llm mode: the MODEL interprets the message itself — question,
            # small talk, or an order to carry out. An immediate move runs
            # through the same safety bridge as the decide cycle; a longer
            # order stands as `instruction` until a decide beat reports it
            # done. No regex directive table runs on this path.
            try:
                res = self.reasoner.chat_act(self, text)
            except Exception as exc:            # noqa: BLE001 - degrade, never crash
                print(f"cognition: chat_act failed ({exc})", file=sys.stderr)
                res = None
            if res:
                reply = res["reply"]
                action = res.get("action")
                if (isinstance(action, dict)
                        and action.get("kind") not in (None, "none")):
                    # the PHYSICAL result, so the chat can show it: the seat
                    # moved as asked / was refused — not just the promise
                    ok, detail, _ = self._perform(action, source="chat")
                    outcome = detail if ok else f"REFUSED \u2014 {detail}"
                if res.get("standing"):
                    self.instruction = text
                    self.remember("order", f"Standing order: {text}", 0.6, True)
                    self.log_line("dir", f"directive \u00b7 standing order \u00b7 "
                                         f"{text[:60]}")
                    if outcome is None:
                        outcome = ("order accepted \u2014 first move on the "
                                   "next think beat")
                        if self.finished:
                            # the step cap ended the session: no further
                            # decide beats exist — never promise a beat that
                            # can never come
                            outcome = ("order received \u2014 the session "
                                       "ENDED at its step cap; restart the "
                                       "ride to carry it out")
        if reply is None:
            # rules mode — and the degrade path when the model is
            # unreachable: orders by regex, then phrase-bank conversation
            reply = self._directive(text) or self._chat_reply(text)
            if self.reasoner is not None:
                # llm lane, the model call FAILED: that fallback line may
                # SOUND compliant while nothing moves (the rules walker is
                # disabled in llm mode) — say so, so a rate-limited no-op
                # can never pass for success in the panel
                outcome = ("the model did not answer this time (rate limit "
                           "or network) \u2014 the line above is a fallback, "
                           "no seat move was made")
        self.chat.append({"who": "phill", "t": self.t, "text": reply})
        if outcome:
            # who="cabin" is not validated by the schema; the chat panel
            # prints it as the machine's line right after Phill's reply
            self.chat.append({"who": "cabin", "t": self.t, "text": outcome})
        del self.chat[: max(0, len(self.chat) - 40)]
        self.speak(reply)
        result = {"ok": True, "reply": reply, "state": self.chat_state()}
        if self.reasoner is not None:      # llm lane: always report honestly;
            result["outcome"] = outcome   # rules mode's payload is untouched
        return result

    # ---- priors (persisted across rides, no personal data) -------------------

    def summarize(self):
        if not self.samples:
            return 0.0, 0.0
        n = len(self.samples)
        return (sum(s["c"] for s in self.samples) / n,
                sum(s["s"] for s in self.samples) / n)

    def apply_priors(self, priors):
        """Previous-ride aggregates re-baseline the suspicion set-point."""
        self.priors = priors or None
        trust = (priors or {}).get("trust")
        if isinstance(trust, (int, float)):
            self.suspicion_base = clamp01(0.5 + (0.5 - float(trust)) * 0.35)

    def make_priors(self, prev, trust_score):
        prev = prev or {}
        avg_c, avg_s = self.summarize()
        return {"rides": int(prev.get("rides", 0)) + 1,
                "trust": trust_score, "comfort": round(avg_c, 4),
                "suspicion": round(avg_s, 4)}
