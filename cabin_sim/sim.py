"""SimEngine: engine clock + deterministic stepping driver.

This module is the migration boundary of the Python-authoritative phase:

    view (three.js, later)  <--  transport (later)  <--  SimEngine (this file)
        <--  session.py / world.py / agent.py / questionnaire.py

SimEngine owns the simulation clock ``t``, the phase machine, and a seeded rng.
It never draws, never talks to a browser, and never reads wall-clock time.
Headless runs and the future live server both drive this object. Determinism
holds for the scripted provider (``--provider scripted``): same seed -> same
snapshot sequence.

Completion semantics: the engine (not session.step_once, which is unlimited)
owns the step cap. Stepping stops when ``session.done`` or the cap is reached,
and the end-of-session questionnaire is administered exactly once — in ``run``
always, in ``tick`` as soon as the cap is reached.

Step model: one decision step (session.step_once) advances the sim clock by
``tick_dt``. A sub-step physics tick is a later extension carried by the ride
script (PORT, see schema.py / MIGRATION.md); the clock is designed for it.
"""

from __future__ import annotations

import json
import random
from pathlib import Path

from .schema import _mdmt_score, build_snapshot


class SimEngine:
    def __init__(self, session, *, seed: int = 1, tick_dt: float = 1.0,
                 ride_start: float | None = None,
                 priors_path: str | Path | None = None):
        self.session = session
        self.seed = seed
        self.rng = random.Random(seed)
        self.tick_dt = tick_dt
        self.ride_start = ride_start
        self.t = 0.0
        self.running = True          # play/pause flag for the live transport

        # The mind IS the ported cognitive core (cabin_sim.cognition): it owns
        # the ride script, mood dynamics, memory and the BDI loop. The engine
        # owns the clock and steps it once per decision step via session.tick_dt.
        self.mind = session.mind
        self.session.tick_dt = tick_dt
        self.ride = self.mind.ride   # schema reads engine.ride (same dict)

        # Priors: previous-ride aggregates persisted as JSON (opt-in path, so
        # tests and headless runs stay side-effect free by default).
        self.priors_path = Path(priors_path) if priors_path else None
        self.priors = self._load_priors()
        if self.priors:
            self.mind.apply_priors(self.priors)

    # ---- state ------------------------------------------------------------

    @property
    def done(self) -> bool:
        return self.session.done or self.session.step >= self.session.max_steps

    @property
    def phase(self) -> str:
        if self.done:
            return "done"
        if self.ride_start is not None and self.t >= self.ride_start:
            return "ride"
        return "setup"

    # ---- priors -------------------------------------------------------------

    def _load_priors(self) -> dict | None:
        if not self.priors_path or not self.priors_path.exists():
            return None
        try:
            with open(self.priors_path, encoding="utf-8") as fh:
                data = json.load(fh)
            return data if isinstance(data, dict) else None
        except (OSError, ValueError):
            return None

    def save_priors(self) -> None:
        """Persist next-ride priors (aggregate only, no personal data)."""
        if not self.priors_path:
            return
        trust = _mdmt_score(self.session.questionnaire)
        if trust is None:
            trust = round(self.mind.trust_value(), 4)
        payload = self.mind.make_priors(self.priors, trust)
        try:
            self.priors_path.write_text(
                json.dumps(payload, indent=2), encoding="utf-8")
            self.priors = payload
        except OSError:
            pass

    # ---- stepping ---------------------------------------------------------

    def _step_once(self) -> bool:
        """One decision step + clock advance; False when there is nothing left."""
        if self.done or not self.running:
            return False
        self.session.step_once()   # steps the mind with session.tick_dt
        self.t += self.tick_dt
        return True

    def _step_until(self, cap: int) -> None:
        for _ in range(int(cap)):
            if not self._step_once():
                break

    def tick(self, steps: int = 1) -> "SimEngine":
        """Advance up to ``steps`` deterministic decision steps.

        If the session reaches its cap inside the tick, the end-of-session
        questionnaire is administered. Returns self for chaining.
        """
        before = self.session.done
        self._step_until(steps)
        if (not before) and self.done and not self.session.done:
            self.session.finish()
            self.save_priors()
        return self

    def run(self, max_steps: int | None = None) -> "SimEngine":
        """Run, then always complete: cap respected, questionnaire administered.

        Mirrors main.py's headless run (step to the cap, then finish) so the
        snapshot carries trust results regardless of how many steps were taken.
        """
        cap = max_steps if max_steps is not None else self.session.max_steps
        self._step_until(cap)
        self.session.finish()
        self.save_priors()
        return self

    # ---- publishing -------------------------------------------------------

    def snapshot(self) -> dict:
        """The canonical state snapshot for this engine (see cabin_sim.schema)."""
        return build_snapshot(self)