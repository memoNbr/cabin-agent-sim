"""One simulation session: advances the agent through the cabin over time.

A Session owns the world (Cabin), the persona-aware CognitiveAgent, and a
threaded runner that makes a decision about every step_interval seconds
until max_steps, then administers the MDMT trust questionnaire.
"""

import threading

from . import actions
from .agent import CognitiveAgent
from .questionnaire import run_questionnaire
from .world import Cabin


class Session:
    def __init__(self, persona, provider, max_steps=120, step_interval=1.2,
                 seed=1):
        self.persona = persona
        self.cabin = Cabin()
        self.agent = CognitiveAgent(persona, provider, self.cabin, seed=seed)
        self.max_steps = max_steps
        self.step_interval = step_interval
        self.step = 0
        self.done = False
        self.questionnaire = None
        self.log = []  # every decision and action, in order
        self._lock = threading.RLock()
        self._thread = None

    def note(self, event, **kw):
        with self._lock:
            self.log.append({"step": self.step, "event": event, **kw})

    def start(self):
        self.note("session_start", persona=self.persona["name"])
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self):
        while self.step < self.max_steps and not self.done:
            self.step_once()
            if self.step_interval:
                threading.Event().wait(self.step_interval)
        if not self.done:
            self.finish()

    def step_once(self):
        with self._lock:
            self.step += 1
            decision = self.agent.decide()
            self.note("decide", action=decision.action, say=decision.say)
            if decision.action:
                ok, detail = actions.apply(self.cabin, decision.action)
                self.note("act", ok=ok, detail=detail, action=decision.action)
                self.agent.observe(decision.action, ok)
            else:
                self.note("talk", action=None)
            self.agent.update_mood()

    def finish(self):
        with self._lock:
            if self.done:
                return
            self.questionnaire = run_questionnaire(self.agent, self.persona)
            self.done = True
            self.note("session_end",
                      questionnaire=self.questionnaire["factors"])

    def state(self):
        with self._lock:
            return {
                "persona": self.persona.get("name", "?"),
                "blurb": self.persona.get("blurb", ""),
                "step": self.step,
                "max_steps": self.max_steps,
                "done": self.done,
                "cabin": self.cabin.to_dict(),
                "mood": dict(self.agent.mood),
                "say": self.agent.last_say,
                "succeeded": self.agent.succeeded,
                "blocked": self.agent.blocked,
                "activity": list(self.log[-8:]),
                "questionnaire": self.questionnaire,
            }