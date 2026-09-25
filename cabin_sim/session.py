"""One simulation session: advances the agent through the cabin over time.

A Session owns the world (Cabin), the persona-aware CognitiveAgent, and a
threaded runner that makes a decision about every step_interval seconds
until max_steps, then administers the MDMT trust questionnaire.
"""

import threading
import time

from . import actions
from .agent import CognitiveAgent
from .cognition import Mind
from .questionnaire import run_questionnaire
from .reasoning import create_reasoner
from .world import Cabin


class Session:
    def __init__(self, persona, provider, max_steps=300, step_interval=1.2,
                 duration=0.0, seed=1, reasoning="auto", chat_provider=None,
                 environment=None, environment_path=None, persona_path=None,
                 persona_guard=True):
        self.persona = persona
        self.reasoning = reasoning       # requested mode (auto|rules|llm)
        # live prompt state (cabin_sim/prompts.py): the environment text the
        # reasoner is built with + the source files behind the UI buttons
        self.environment_text = environment
        self.environment_path = environment_path
        self.persona_path = persona_path
        self.persona_guard = bool(persona_guard)  # sim toggle: ON = persona
        # defends itself against chat meta-instructions; OFF = experimenter
        self._environment_mtime = None   # set on apply — see prompts.cycle()
        self._persona_mtime = None
        self.cabin = Cabin()
        # the reasoner decides WHO words/chooses: None = deterministic rules,
        # LLMReasoner = provider-backed reasoning (see cabin_sim/reasoning.py).
        # chat_provider = optional second backend for experimenter replies only
        # (hybrid: small/fast model ticks, bigger model chats).
        self.chat_provider = chat_provider   # kept so /api/control reset can
        # rebuild the SAME hybrid setup (main.py passes it at startup only)
        self.reasoner = create_reasoner(provider, reasoning, persona,
                                        chat_provider=chat_provider,
                                        environment=environment,
                                        persona_guard=self.persona_guard)
        self.mind = Mind(persona, self.cabin, seed=seed,
                         reasoner=self.reasoner)
        self.agent = CognitiveAgent(persona, provider, self.cabin, seed=seed,
                                    mood=self.mind.mood)
        self.max_steps = max_steps
        self.step_interval = step_interval
        self.duration = duration
        self.tick_dt = 1.0          # sim seconds per decision step (set by engine)
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
        deadline = time.monotonic() + self.duration if self.duration > 0 else None
        while (self.step < self.max_steps and not self.done and
               (deadline is None or time.monotonic() < deadline)):
            self.step_once()
            if self.step_interval:
                threading.Event().wait(self.step_interval)
        if not self.done:
            self.finish()

    def step_once(self):
        with self._lock:
            self.step += 1
            if self.mind.reasoner is not None:
                # ONE reasoning mind: mind.step runs the LLM cycle
                # (examine the real outcome -> reconsider -> act,
                # safety-clamped) and records what happened; the session
                # only narrates it and counts the result.
                self.mind.step(self.tick_dt)
                cycle = self.mind.consume_cycle()
                if cycle:
                    self.note("decide", action=cycle.get("name"),
                              say=cycle.get("say") or "")
                    say = cycle.get("say") or ""
                    if say:
                        self.agent.last_say = say
                    self.agent.memory.append({"action": cycle.get("name"),
                                              "say": say})
                    del self.agent.memory[:-6]
                res = self.mind.consume_action_result()
                if res:
                    self.note("act", ok=res["ok"], detail=res["detail"],
                              action=res["name"])
                    self.agent.observe(res["name"], res["ok"])
                return
            decision = self.agent.decide()
            self.note("decide", action=decision.action, say=decision.say)
            if decision.action:
                ok, detail = actions.apply(self.cabin, decision.action)
                self.note("act", ok=ok, detail=detail, action=decision.action)
                self.agent.observe(decision.action, ok)
            else:
                self.note("talk", action=None)
            # the cognitive core: ride events, mood relaxation, memory decay and
            # the BDI loop (perceive -> desire -> intention -> act)
            self.mind.step(self.tick_dt)

    def note_user_input(self, axis=None):
        """The human grabbed a control: sets belief.user_hands in the mind."""
        with self._lock:
            self.mind.note_user_input(axis)

    def finish(self):
        with self._lock:
            if self.done:
                return
            self.questionnaire = run_questionnaire(self.agent, self.persona)
            self.done = True
            self.mind.finished = True
            self.note("session_end",
                      questionnaire=self.questionnaire["factors"])

    def state(self):
        # Deliberately lock-free: the view polls this every 700 ms while
        # writers (step_once, chat, seat) hold _lock — often for seconds at a
        # time while a provider inference is in flight. The GIL keeps each
        # field read consistent (a mixed frame is harmless for display);
        # taking the lock here would freeze the view behind every model call
        # (and, with impatient pollers, storm the log with WinError 10053s).
        mind = self.mind
        return {
            "persona": self.persona.get("name", "?"),
            "blurb": self.persona.get("blurb", ""),
            "step": self.step,
            "max_steps": self.max_steps,
            "done": self.done,
            "t": mind.t,
            "cabin": self.cabin.to_dict(),
            "mood": dict(self.agent.mood),
            "say": self.agent.last_say or mind.speech,
            "speech": mind.speech,
            "intention": mind.bdi["intention"],
            "thoughts": list(mind.thoughts),
            "succeeded": self.agent.succeeded,
            "blocked": self.agent.blocked,
            "activity": list(self.log[-8:]),
            "questionnaire": self.questionnaire,
        }