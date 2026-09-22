"""Tests for cabin_sim.reasoning — LLM reasoning with rules-mode safety.

Two contracts are pinned here:
  1. rules mode is untouched (create_reasoner -> None, snapshots identical);
  2. in llm mode the model CHOOSES AND WORDS, but Python stays the referee:
     illegal intentions, bad JSON, empty lines and provider errors all fall
     back to the deterministic rule answer for that tick.
"""

from cabin_sim.cognition import THOUGHTS, Mind
from cabin_sim.reasoning import (
    LLMReasoner, clean_line, create_reasoner, extract_json, state_block,
)
from cabin_sim.schema import check
from cabin_sim.session import Session
from cabin_sim.sim import SimEngine
from cabin_sim.world import Cabin


class FakeProvider:
    """complete() with canned replies; counts calls; can raise."""

    name = "fake"

    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = 0

    def complete(self, messages):          # noqa: ARG002
        self.calls += 1
        if isinstance(self.replies[0], Exception):
            raise self.replies[0]
        i = min(self.calls - 1, len(self.replies) - 1)   # repeat the last
        return self.replies[i]


class ScriptedLike:
    name = "scripted"

    def complete(self, messages):          # noqa: ARG002
        return "{}"


def llm_mind(persona, replies):
    provider = FakeProvider(replies)
    reasoner = LLMReasoner(provider, persona)
    return Mind(persona, Cabin(), seed=1, reasoner=reasoner), provider


# ---- mode selection ------------------------------------------------------

def test_auto_mode_is_rules_for_scripted():
    assert create_reasoner(ScriptedLike(), "auto") is None


def test_auto_mode_is_llm_for_real_backend():
    r = create_reasoner(FakeProvider(["{}"]), "auto", {"name": "Phill"})
    assert isinstance(r, LLMReasoner)
    assert r.kind == "llm:fake" and r.mode == "llm"


def test_forced_llm_with_scripted_degrades_to_rules():
    assert create_reasoner(ScriptedLike(), "llm") is None


def test_rules_mode_leaves_mind_untouched():
    mind = Mind({"name": "x"}, Cabin(), seed=1)
    assert mind.reasoner is None
    mind.step(1.0)
    assert mind._pending_thought is None


# ---- deliberation ---------------------------------------------------------

def test_llm_choice_wins_when_legal_and_words_the_thought(persona):
    # as-found seat: rule argmax would say settle (desire ~0.81 > 0.15)
    mind, provider = llm_mind(persona, [
        '{"intention": "attend", "thought": "Counting the poles as we pass."}'])
    mind.step(1.0)
    assert mind.bdi["intention"] == "attend"       # LLM overrode the argmax
    assert mind.thoughts[0]["text"] == "Counting the poles as we pass."
    assert provider.calls == 1                     # one call per decision step


def test_illegal_intention_falls_back_to_rule_argmax(persona):
    mind, _ = llm_mind(persona, ['{"intention": "calibrate"}'])  # setup: illegal
    mind.step(1.0)
    assert mind.bdi["intention"] == "settle"       # Python's legality stands
    assert mind.thoughts[0]["text"] in THOUGHTS["settle"]   # rule wording too


def test_prose_reply_falls_back_without_crashing(persona):
    mind, _ = llm_mind(persona, ["I think you should settle the seat."])
    mind.step(1.0)
    assert mind.bdi["intention"] == "settle"


def test_provider_error_falls_back_for_that_tick(persona):
    mind, _ = llm_mind(persona, [RuntimeError("groq unreachable")])
    mind.step(1.0)
    assert mind.bdi["intention"] == "settle"
    mind.step(1.0)                                  # and keeps running
    assert mind.t == 2.0


def test_no_llm_call_when_no_goal_is_legal(persona):
    mind, provider = llm_mind(persona, ['{"intention": "attend"}'])
    mind.memory.traces.clear()
    mind.mood["comfort"] = 1.0
    mind.cabin.seat.rotation_deg = 0               # settle desire 0 / gap low
    mind.cabin.seat.height_mm = 440
    mind.t = mind.ride_end                         # calibrate precondition off
    mind.bdi["last"] = {g: mind.t for g in ("settle", "attend", "calibrate")}
    mind.perceive_fit()
    mind.bdi_reason(1.0)
    assert mind.bdi["intention"] is None
    assert provider.calls == 0                     # nothing legal -> no call


# ---- chat -----------------------------------------------------------------

def test_chat_uses_llm_reply_but_keeps_rule_side_effects(persona):
    mind, provider = llm_mind(
        persona, ['{"reply": "It sits well enough — I nudged it myself."}'])
    res = mind.chat_send("Could you adjust the seat?")
    assert res["ok"] and res["reply"] == "It sits well enough — I nudged it myself."
    assert mind.bdi["last"]["settle"] == -99.0     # side effect still authoritative
    assert provider.calls == 1


def test_chat_falls_back_to_rule_reply_on_garbage(persona):
    mind, _ = llm_mind(persona, ["no json here"])
    res = mind.chat_send("how are you doing?")
    assert res["reply"] in THOUGHTS["idleN"]


def test_chat_llm_sees_live_state(persona):
    seen = {}

    class Spy(FakeProvider):
        def complete(self, messages):
            seen["user"] = messages[1]["content"]
            return super().complete(messages)

    provider = Spy(['{"reply": "steady"}'])
    mind = Mind(persona, Cabin(), seed=1, reasoner=LLMReasoner(provider, persona))
    mind.mood["suspicion"] = 0.9
    mind.chat_send("do you trust this car?")
    assert "suspicion 0.90" in seen["user"]
    assert "live_trust=" in seen["user"]


# ---- hybrid: separate chat provider ---------------------------------------

def test_hybrid_chat_provider_gets_chat_ticks_keep_their_own(persona):
    ticks = FakeProvider(['{"intention": "attend", "thought": "Poles again."}'])
    chat = FakeProvider(['{"reply": "Ask me after the merge."}'])
    reasoner = LLMReasoner(ticks, persona, chat_provider=chat)
    mind = Mind(persona, Cabin(), seed=1, reasoner=reasoner)
    mind.step(1.0)                                   # tick -> fast provider
    assert ticks.calls == 1 and chat.calls == 0
    res = mind.chat_send("do you trust this car?")   # chat -> chat provider
    assert res["reply"] == "Ask me after the merge."
    assert chat.calls == 1 and ticks.calls == 1      # lanes stayed separate


def test_hybrid_chat_provider_defaults_to_main_provider(persona):
    provider = FakeProvider(['{"reply": "alright"}'])
    reasoner = LLMReasoner(provider, persona)        # no split configured
    mind = Mind(persona, Cabin(), seed=1, reasoner=reasoner)
    mind.chat_send("hi")
    assert provider.calls == 1                       # one provider, both jobs


def test_create_reasoner_forwards_chat_provider(persona):
    ticks = FakeProvider(["{}"])
    chat = FakeProvider(['{"reply": "x"}'])
    r = create_reasoner(ticks, "llm", persona, chat_provider=chat)
    assert isinstance(r, LLMReasoner)
    assert r.provider is ticks and r.chat_provider is chat


# ---- snapshot & helpers ---------------------------------------------------

def test_snapshot_reports_the_reasoning_mode(persona, scripted):
    session = Session(persona, scripted, max_steps=10, seed=1)
    engine = SimEngine(session, seed=1, tick_dt=2.0)
    engine.tick(3)
    snap = engine.snapshot()
    assert snap["agent"]["reasoning"] == "rules"
    assert check(snap) == []


def test_snapshot_reports_llm_mode_when_reasoner_present(persona, scripted):
    session = Session(persona, scripted, max_steps=10, seed=1)
    session.reasoner = LLMReasoner(FakeProvider(['{"intention": "attend"}']),
                                   persona)
    session.mind.reasoner = session.reasoner
    engine = SimEngine(session, seed=1, tick_dt=2.0)
    engine.tick(3)
    assert engine.snapshot()["agent"]["reasoning"] == "llm:fake"


def test_state_block_is_compact_and_complete(persona):
    mind = Mind(persona, Cabin(), seed=1)
    mind.step(2.0)
    block = state_block(mind)
    assert "phase=" in block and "mood comfort" in block
    assert "memories: none" in block              # no events before t=121
    assert len(block) < 600                       # small-model friendly


def test_extract_json_tolerates_fences_and_prose():
    assert extract_json('```json\n{"intention": "attend"}\n```') == {
        "intention": "attend"}
    assert extract_json('Sure: {"reply": "alright"} thanks') == {
        "reply": "alright"}
    assert extract_json("no json") is None
    assert extract_json("") is None


def test_clean_line_strips_and_truncates():
    assert clean_line('  "Fancy that.  " ', 50) == "Fancy that."
    assert clean_line("x" * 300, 40) == "x" * 40
    assert clean_line(None, 40) is None
    assert clean_line(42, 40) is None
