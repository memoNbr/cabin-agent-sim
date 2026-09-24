"""Tests for cabin_sim.reasoning — the LLM decide loop, rules safety.

Two contracts are pinned here:
  1. rules mode is untouched (create_reasoner -> None, snapshots identical);
  2. in llm mode the MODEL reasons end to end: decide() examines the REAL
     outcome of its last action, reconsiders from its persona and proposes
     the next action with its own values — Python only whitelists the
     vocabulary and lets the world clamp (safety), and a throttled beat,
     bad JSON or a provider error stays QUIET: no rule fallback, no
     invented behaviour, the ride never breaks.
"""

from cabin_sim.cognition import THOUGHTS, Mind
from cabin_sim.reasoning import (
    LLMReasoner, clean_line, create_reasoner, extract_json, state_block,
)
from cabin_sim.schema import check
from cabin_sim.session import Session
from cabin_sim.sim import SimEngine
from cabin_sim.world import Cabin, Seat


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


# ---- the prompt layer: environment world + live swapping -------------------

def test_system_prompt_carries_the_environment_world_and_voice():
    reasoner = LLMReasoner(FakeProvider(["{}"]), {"name": "Phill"})
    assert "ENVIRONMENT" in reasoner.system
    assert "autonomous" in reasoner.system.lower()   # the builtin world text
    assert "Voice:" in reasoner.system


def test_environment_and_persona_swap_rebuild_the_system_prompt():
    reasoner = LLMReasoner(FakeProvider(["{}"]),
                           {"name": "X", "self": "You are X."},
                           environment="THE LAB, 3am.")
    assert "THE LAB, 3am." in reasoner.system
    reasoner.set_environment("THE DESERT AT NOON")
    assert "THE DESERT AT NOON" in reasoner.system
    assert "THE LAB" not in reasoner.system          # old world is gone
    reasoner.set_persona({"name": "Y", "self": "You are Y.",
                          "voice": "flat, clipped sentences"})
    assert "You are Y." in reasoner.system
    assert "Voice: flat, clipped sentences" in reasoner.system


def test_every_decide_and_chat_message_carries_the_real_seat_envelope(persona):
    seen = []

    class Spy(FakeProvider):
        def complete(self, messages):
            seen.append(messages[1]["content"])
            return super().complete(messages)

    reasoner = LLMReasoner(Spy([DECIDE_OK]), persona)
    mind = Mind(persona, Cabin(), seed=1, reasoner=reasoner)
    mind.step(1.0)                                  # one decide beat
    assert "ENVELOPE (physical):" in seen[0]
    assert str(Seat.SLIDER_MIN) in seen[0]          # real numbers, not prose
    reasoner.chat_act(mind, "face the window")
    assert "ENVELOPE (physical):" in seen[-1]       # the chat lane too


# ---- the decide cycle: examine -> reconsider -> act -----------------------

DECIDE_OK = (
    '{"examine": "Went back further than I meant.", '
    '"reconsider": "That is enough recline, try the height next.", '
    '"action": {"kind": "seat", "axis": "slider_mm", "delta": 25}, '
    '"say": "There. Better.", "order_done": false}')


def test_llm_cycle_applies_the_models_own_delta_and_records_outcome(persona):
    mind, provider = llm_mind(persona, [DECIDE_OK])
    before = mind.cabin.seat.slider_mm
    mind.step(1.0)
    # the model's number lands — no fixed step table chose it
    assert mind.cabin.seat.slider_mm == before + 25
    assert mind.last_outcome["ok"] is True
    assert mind.cycle["name"] == "seat_move"
    assert mind.thoughts[0]["text"].startswith("Went back")   # examine on top
    assert mind.speech == "There. Better."
    assert provider.calls == 1                     # one call per decision beat


def test_real_outcome_is_fed_back_into_the_next_decide_call(persona):
    seen = []

    class Spy(FakeProvider):
        def complete(self, messages):
            seen.append(messages[1]["content"])
            return super().complete(messages)

    provider = Spy([DECIDE_OK,
                    '{"examine": "still short", "reconsider": "again", '
                    '"action": null, "say": "", "order_done": false}'])
    mind = Mind(persona, Cabin(), seed=1, reasoner=LLMReasoner(provider, persona))
    mind.step(1.0)                                  # first beat: acts (390 → 415)
    mind.reasoner._last_decide_t = -1e9            # the next beat is due
    mind.reasoner._last_wall = 0.0
    mind.step(1.0)
    assert len(seen) == 2
    assert "LAST OUTCOME: done: slider_mm 390 \u2192 415" in seen[1]
    assert "seat now" in seen[1]                   # what REALLY happened


def test_refused_action_is_reported_and_never_applied(persona):
    mind, _ = llm_mind(persona, [
        '{"examine": "-", "reconsider": "-", "say": "", "order_done": false, '
        '"action": {"kind": "seat", "axis": "doors", "delta": 5}}'])
    before = mind.cabin.seat.as_dict()
    mind.step(1.0)
    assert mind.cabin.seat.as_dict() == before       # nothing moved
    assert mind.last_outcome["ok"] is False
    assert "refused" in mind.last_outcome["detail"]  # the model examines it
    assert mind.cycle["name"] == "seat_move"         # still counted as an attempt
    assert mind.cycle["ok"] is False


def test_clamped_move_reports_the_limit_for_the_model_to_examine(persona):
    mind, _ = llm_mind(persona, [
        '{"examine": "-", "reconsider": "-", "say": "", "order_done": false, '
        '"action": {"kind": "seat", "axis": "slider_mm", "delta": 5000}}'])
    mind.step(1.0)
    assert mind.cabin.seat.slider_mm == mind.cabin.seat.SLIDER_MAX
    assert mind.last_outcome["ok"] is True          # it DID move — to the stop
    assert "clamped" in mind.last_outcome["detail"]


def test_decide_is_throttled_so_the_gap_stays_quiet(persona):
    mind, provider = llm_mind(persona, [DECIDE_OK])
    mind.step(1.0)
    mind.step(1.0)                                  # too soon: THROTTLE_S
    assert provider.calls == 1 and mind.t == 2.0    # quiet, no rule fallback


def test_non_json_and_failed_provider_keep_the_ride_running(persona):
    mind, _ = llm_mind(persona, ["I think you should settle the seat."])
    mind.step(1.0)                                  # prose: no JSON → quiet beat
    assert mind.cycle is None and mind.thoughts == []
    mind, _ = llm_mind(persona, [RuntimeError("groq unreachable")])
    mind.step(1.0)
    assert mind.last_outcome is None and mind.cycle is None
    mind.step(1.0)                                  # and keeps running
    assert mind.t == 2.0


# ---- chat: the model interprets question vs order --------------------------

def test_chat_reply_alone_leaves_no_order_and_moves_nothing(persona):
    mind, provider = llm_mind(
        persona, ['{"reply": "It sits well enough — I nudged it myself."}'])
    res = mind.chat_send("Could you adjust the seat?")
    assert res["ok"] and res["reply"] == "It sits well enough — I nudged it myself."
    assert mind.instruction is None                 # not a standing order
    assert mind.last_outcome is None                # nothing was moved
    assert provider.calls == 1


def test_chat_order_is_obeyed_now_and_stands_until_the_model_reports_done(persona):
    mind, provider = llm_mind(persona, [
        '{"reply": "Fine — moving it back.", "standing": true, '
        '"action": {"kind": "seat", "axis": "recline_deg", "delta": 6}}',
        '{"examine": "It went where he wanted.", '
        '"reconsider": "Job done, back to sitting.", '
        '"action": null, "say": "", "order_done": true}'])
    recl = mind.cabin.seat.recline_deg                # as found: 103°
    res = mind.chat_send("recline the backrest a bit")
    assert res["reply"] == "Fine — moving it back."
    assert mind.cabin.seat.recline_deg == recl + 6    # obeyed at once
    assert mind.instruction == "recline the backrest a bit"
    assert mind.last_outcome and mind.last_outcome["ok"]
    # the next decide beat carries the STANDING ORDER + that chat outcome...
    mind.reasoner._last_wall = 0.0                    # ...and is due now
    mind.step(1.0)
    assert mind.instruction is None                   # ...and clears it when done


def test_session_llm_step_narrates_and_counts_the_minds_action(persona):
    session = Session(persona, FakeProvider([DECIDE_OK]), max_steps=5, seed=1)
    session.step_once()                              # auto → llm ("fake")
    assert session.mind.cabin.seat.slider_mm == 415  # 390 + the model's 25
    events = [e["event"] for e in session.log]
    assert "decide" in events and "act" in events
    assert session.agent.succeeded == 1
    assert session.state()["intention"] == "settle"  # HUD label only
    assert session.mind.mood["suspicion"] < 0.5      # seat_move parity


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


# ---- chat orders: the PHYSICAL outcome reaches the panel -------------------


def test_chat_action_reports_the_physical_outcome_to_the_panel(persona):
    mind, _ = llm_mind(
        persona,
        ['{"reply": "Turning it now.", '
         '"action": {"kind": "seat", "axis": "rotation_deg", "delta": 10}}'])
    rot = mind.cabin.seat.rotation_deg                # as found: 90°
    res = mind.chat_send("please rotate the seat")
    assert res["reply"] == "Turning it now."
    assert mind.cabin.seat.rotation_deg == (rot + 10) % 360   # it REALLY moved
    assert res["outcome"] and "rotation_deg" in res["outcome"]
    assert mind.chat[-1]["who"] == "cabin"            # the panel's machine line


def test_chat_standing_order_without_a_move_says_when_it_lands(persona):
    mind, _ = llm_mind(
        persona,
        ['{"reply": "On it \u2014 working through it.", "standing": true}'])
    res = mind.chat_send("recline all the way and sit tall")
    assert mind.instruction == "recline all the way and sit tall"
    assert "next think beat" in (res["outcome"] or "")
    assert mind.last_outcome is None                  # nothing has moved yet


def test_chat_degrade_says_no_move_honestly(persona):
    """A failed model call must never masquerade as compliance: the fallback
    line may sound agreeable while nothing moved, so the llm lane always
    carries an outcome line that says exactly that."""
    mind, _ = llm_mind(persona, ["no json here"])
    res = mind.chat_send("how are you doing?")
    assert res["ok"]
    assert "did not answer" in res["outcome"]
    assert "no seat move was made" in res["outcome"]
    assert mind.chat[-1]["who"] == "cabin"            # the panel shows it too


def test_rules_mode_chat_payload_has_no_outcome_key(persona):
    """Rules mode's response shape stays byte-stable (determinism contract)."""
    mind = Mind(persona, Cabin(), seed=1)             # no reasoner
    res = mind.chat_send("how are you doing?")
    assert res["ok"] and "outcome" not in res         # rules payload unchanged


def test_chat_standing_order_after_the_step_cap_says_the_session_ended(persona):
    """After the step cap no decide beat will ever come — never promise one."""
    mind, _ = llm_mind(
        persona,
        ['{"reply": "Queued.", "standing": true}'])
    mind.finished = True                              # session.finish() ran
    res = mind.chat_send("raise the seat")
    assert "ENDED" in res["outcome"]


# ---- hybrid: separate chat provider ---------------------------------------

def test_hybrid_chat_provider_gets_chat_ticks_keep_their_own(persona):
    ticks = FakeProvider(['{"examine": "poles again", "reconsider": "steady", '
                          '"action": null, "say": "", "order_done": false}'])
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
    session.reasoner = LLMReasoner(
        FakeProvider(['{"examine": "-", "reconsider": "-", "action": null, '
                      '"say": "", "order_done": false}']), persona)
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
