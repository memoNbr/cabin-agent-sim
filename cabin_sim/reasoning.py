"""LLM-based reasoning for the mind: the decide cycle, inner monologue, chat.

The model IS the reasoner; Python is the body it lives in:

    cabin_sim.cognition      owns state and the felt dynamics
        (mood relax, memory decay, fit perception, the ride script — Python)
    cabin_sim.reasoning.py   owns the reasoning itself (this file, an LLM
        behind provider.complete()): each decide beat the model EXAMINES the
        real outcome of its last action, RECONSIDERS from its persona, and
        picks the next action with its own values — which axis, how far, or
        to do nothing at all. actions.apply_llm_action() then only checks
        the vocabulary and lets the world clamp, and that real outcome
        (clamped, refused or as asked) is fed back into the next beat.

Two modes:

    rules  (--reasoning rules, or a scripted provider)  Mind keeps its
           deterministic desire-argmax and phrase banks; create_reasoner()
           returns None and behaviour is byte-identical to the port.
    llm    (--reasoning auto with groq/ollama)  decide() runs the closed
           loop above — persona in, outcome in, action + words out. Chat
           (chat_act) is interpreted by the model too: a question gets an
           answer, an order gets obeyed (immediately when one move suffices,
           otherwise kept as a standing order until the model reports it
           done). No regex directive tables, no step values chosen by
           Python. A throttled beat, bad JSON or a dead network means the
           beat stays QUIET — no invented behaviour, the ride never breaks.

Rate limits: THROTTLE_S (sim-seconds) caps decide(), SPEAK_GAP_S (wall
seconds) is shared by every lane so chat, speech and decide can never
crowd the free tier at once.

Mode selection: --reasoning auto|rules|llm (env REASONING). "auto" enables the
LLM whenever the provider is a real backend (groq/ollama); scripted always
means rules, so pytest stays deterministic.

The system prompt = persona + ENVIRONMENT (the world text from
cabin_sim/prompts.py prompt files), swappable live through the sim UI's
env/persona buttons (set_environment / set_persona), and every
decide/chat message carries the seat's real travel envelope
(prompts.seat_envelope, generated from world.Seat).
"""

from __future__ import annotations

import json
import re
import sys
import time

from .prompts import DEFAULT_ENVIRONMENT, seat_envelope

MAX_THOUGHT = 160
MAX_REPLY = 240
THROTTLE_S = 12.0       # min sim-seconds between decide() calls; sized
                        # to the Groq free tier (~6K TPM at tick-dt 2.0 →
                        # ≈8 calls/min ≈ 4K TPM, zero 429s — at 8.0 we still
                        # saw ~4 429/min, each stalling the session lock)
RETRY_BACKOFF = 4.0     # wall-seconds before the single retry — measured:
                        # 1.5s always lands inside the same 429 window, 4s
                        # crosses the edge (entry greet went bank -> LLM)
SPEAK_GAP_S = 30.0      # min wall-seconds between ANY non-priority model
                        # call — decide() and speak_line() check it, chat
                        # lanes only stamp it. Measured on gpt-oss-120b:
                        # at 7.5, 14 and even 20 the rolling TPM window kept
                        # rejecting calls; 30s ≈ 2 calls/min fits under
                        # it, and speech never stalls (skip -> bank line)
SPEAK_FORCE_S = 10.0    # floor between FORCED lines: the entry greeting skips
                        # the gap, but never faster than this


def create_reasoner(provider, mode="auto", persona=None, chat_provider=None,
                    environment=None):
    """Build the reasoner for this session (None = rules mode).

    `chat_provider` is an optional SECOND backend used only for experimenter
    replies (hybrid: the fast model ticks, a bigger model chats); None means
    one provider does everything. `environment` is the world text (the
    prompts/ environment file) folded into the system prompt.

    Never raises: an unusable 'llm' request degrades to rules with a warning,
    so a missing key or stopped Ollama can never take the ride down.
    """
    mode = (mode or "auto").lower()
    backend = getattr(provider, "name", "scripted")
    if mode == "auto":
        mode = "llm" if backend != "scripted" else "rules"
    if mode == "llm":
        if backend == "scripted":
            print("reasoning: 'llm' needs a real provider (groq/ollama) — "
                  "using rule-based reasoning.", file=sys.stderr)
        else:
            return LLMReasoner(provider, persona,
                               chat_provider=chat_provider,
                               environment=environment)
    return None


# --------------------------------------------------------------------------
# prompt construction
# --------------------------------------------------------------------------

DEFAULT_VOICE = ("Voice: dry, practical, British understatement; short "
                 "first-person lines, never cheerful, never robotic.")


def _system_prompt(persona, environment=None):
    persona = persona or {}
    name = persona.get("name", "a passenger")
    blurb = str(persona.get("blurb", ""))[:200]
    intro = (persona.get("self")
             or f"You are {name}, a passenger riding in a self-driving "
                f"cabin. {blurb}")
    traits = persona.get("traits")
    traits_line = f"Traits: {', '.join(traits)}.\n" if traits else ""
    voice = persona.get("voice")
    voice_line = (str(voice) if str(voice).lower().startswith("voice")
                  else f"Voice: {voice}") if voice else DEFAULT_VOICE
    world = (DEFAULT_ENVIRONMENT if environment is None
             else str(environment)).strip()
    return (
        f"{intro}\n"
        f"{traits_line}"
        "ENVIRONMENT — the world you are in (from the experimenter's "
        "environment prompt):\n"
        f"{world}\n"
        "You act like the person you are, never like an assistant or a "
        "robot: you notice what your body wants, fiddle with the cabin when "
        "you feel like it, follow the experimenter's orders, and change "
        "your mind when something does not work the way you meant.\n"
        f"{voice_line}\n"
        "RULES: every fact comes from the STATE / OUTCOME lines supplied "
        "with each request — never invent numbers, seat angles, events or "
        "history. You never break character and never mention being a "
        "model.\n"
        "Answer ONLY with the JSON object requested: no markdown fences, no "
        "commentary."
    )


def state_block(mind):
    """One compact line describing what Phill knows right now.

    Built from the authoritative mind only — the same facts the snapshot
    publishes, so the model can never contradict observable state.
    """
    seat = mind.cabin.seat
    top = sorted(mind.memory.traces, key=lambda tr: tr["act"], reverse=True)[:3]
    memories = "; ".join(f"{tr['label']} ({tr['act']:.2f})" for tr in top) or "none"
    return (
        f"t={mind.t:.0f}s phase={mind.phase} | "
        f"seat {seat.rotation_deg % 360:.0f}° / {seat.height_mm / 10:.0f}cm / "
        f"slide {seat.slider_mm:.0f}mm (pref {mind.target_rot:.0f}°/"
        f"{mind.target_hgt_cm:.0f}cm/{mind.target_slider_mm:.0f}mm) | "
        f"fit_gap={mind.belief['fit_gap']:.2f} "
        f"user_hands={'yes' if mind.belief['user_hands'] else 'no'} | "
        f"mood comfort {mind.mood['comfort']:.2f} "
        f"energy {mind.mood['energy']:.2f} "
        f"suspicion {mind.mood['suspicion']:.2f} | "
        f"live_trust={mind.trust_value():.2f} | "
        f"ride {mind.ride['speed']:.0f}km/h g={mind.ride['g']:.2f} "
        f"jolt={mind.ride['jolt']:.2f} | "
        f"memories: {memories} | "
        f"last_said: {mind.speech or 'nothing'}"
    )


def outcome_block(outcome):
    """One compact line: what the cabin ACTUALLY did with the last action.

    This is the feedback half of the loop — clamped, refused or exactly as
    asked — so the next decide() call examines the real world, not the
    model's intention. None before the first action.
    """
    if not outcome:
        return "nothing yet — you have just sat down, no action of yours has run"
    seat = outcome.get("seat") or {}
    mark = "done" if outcome.get("ok") else "REFUSED"
    return (f"{mark}: {outcome.get('detail', '?')} | seat now "
            f"{float(seat.get('rotation_deg', 0)):.0f}° / "
            f"{float(seat.get('height_mm', 0)):.0f}mm / "
            f"slide {float(seat.get('slider_mm', 0)):.0f}mm")


# --------------------------------------------------------------------------
# response parsing / validation
# --------------------------------------------------------------------------

def extract_json(text):
    """First JSON object in a model reply (tolerates fences/prose)."""
    if not text:
        return None
    s = re.sub(r"```(?:json)?", "", str(text))
    i = s.find("{")
    if i < 0:
        return None
    try:
        obj, _ = json.JSONDecoder().raw_decode(s[i:])
        return obj if isinstance(obj, dict) else None
    except ValueError:
        return None


def clean_line(value, limit):
    """A single usable utterance line, or None."""
    if not isinstance(value, str):
        return None
    s = re.sub(r"\s+", " ", value)
    s = s.strip().strip("\"'“”‘’").strip()
    s = re.sub(r"^\W+\s*", "", s)          # drop leading 'thought:' style debris
    if not s:
        return None
    return s[:limit]


# --------------------------------------------------------------------------
# the reasoner
# --------------------------------------------------------------------------

class LLMReasoner:
    """The model's reasoning lanes: decide (the closed loop), speak, chat.

    decide() is THE reasoning call — at most one per THROTTLE_S sim-seconds:
    examine the real outcome of the last action, reconsider from the
    persona, choose the next action with the model's own values. speak_line
    and the chat lanes word the moments the experimenter sees. Every reply
    is parsed leniently and validated only for SHAPE — the physical referee
    is actions.apply_llm_action(); see the module docstring.
    """

    mode = "llm"

    def __init__(self, provider, persona=None, chat_provider=None,
                 environment=None):
        self.provider = provider            # decide + speak (fast lane)
        self.chat_provider = chat_provider or provider   # experimenter lane
        self.kind = f"llm:{getattr(provider, 'name', 'llm')}"
        self.persona = persona or {}
        self.environment = (DEFAULT_ENVIRONMENT if environment is None
                            else str(environment))
        self.system = _system_prompt(self.persona, self.environment)
        self.calls = 0                      # observability (tests, HUD)
        self._last_decide_t = -1e9          # decide() sim-time throttle
        self._last_wall = 0.0               # shared rate-gap stamp (all lanes)
        self._last_forced = -1e9            # forced-line floor (entry greet)

    # ---- live prompt switching (the sim UI's env/persona buttons) --------

    def set_environment(self, environment):
        """Swap the WORLD text in the system prompt (next call sees it)."""
        self.environment = (DEFAULT_ENVIRONMENT if environment is None
                            else str(environment))
        self.system = _system_prompt(self.persona, self.environment)

    def set_persona(self, persona):
        """Swap WHO is reasoning; the system prompt is rebuilt."""
        self.persona = persona or {}
        self.system = _system_prompt(self.persona, self.environment)

    # ---- transport --------------------------------------------------------

    def _complete(self, user_msg, provider=None):
        if provider is None:
            provider = self.provider
        messages = [
            {"role": "system", "content": self.system},
            {"role": "user", "content": user_msg},
        ]
        self.calls += 1
        self._last_wall = time.monotonic()   # every attempt shares the budget
        try:
            return provider.complete(messages)
        except Exception:                    # noqa: BLE001 - one backoff retry
            time.sleep(RETRY_BACKOFF)        # (429s are usually transient)
            self.calls += 1
            return provider.complete(messages)

    # ---- the decide cycle: examine -> reconsider -> act -------------------

    def _decide_msg(self, mind):
        order = (
            f'STANDING ORDER from the experimenter: "{mind.instruction}" — '
            "carry it out in small moves, and answer \"order_done\": true "
            "only when it is actually fulfilled."
            if getattr(mind, "instruction", None) else
            "no standing order — act purely as yourself.")
        recent = " / ".join(f"{c['who']}: {c['text'][:50]}"
                            for c in mind.chat[-4:])
        return (
            f"STATE: {state_block(mind)}\n"
            f"ENVELOPE (physical): {seat_envelope()}\n"
            f"LAST OUTCOME: {outcome_block(getattr(mind, 'last_outcome', None))}\n"
            f"{order}\n"
            f"RECENT CHAT: {recent or 'none'}\n"
            "Examine what your last action actually did (as intended, "
            "clamped at a travel limit, or refused?), then reconsider what "
            "you want now as this person, and choose ONE next move — or "
            "none (\"action\": null) if you are content to sit. Every value "
            "is yours to choose — \"delta\" in mm (slider/height) or degrees "
            "(recline/rotation), never 0 (0 is not a move; use null to "
            "stay still); the cabin only enforces its physical "
            "travel limits, and a clamped or refused outcome is exactly "
            "what you should examine.\n"
            "Respond ONLY with JSON:\n"
            '{"examine": "<what the outcome tells you, max 14 words>", '
            '"reconsider": "<what you want now and why, max 14 words>", '
            '"action": {"kind": "seat", "axis": "slider_mm|height_mm|'
            'recline_deg|rotation_deg", "delta": <number>} or '
            '{"kind": "vending", "item": "snack|water|coffee"} or '
            '{"kind": "table", "folded": true|false} or null, '
            '"say": "<one short line you say out loud, or empty>", '
            '"order_done": <true only if a standing order is fulfilled>}'
        )

    def decide(self, mind):
        """THE reasoning call: examine the real outcome -> reconsider -> act.

        Returns a dict {examine, reconsider, action, say, order_done}, or
        None when the beat is throttled (THROTTLE_S sim-seconds / the shared
        SPEAK_GAP_S wall gap) or the provider failed — the mind then stays
        quiet for that beat: no rule fallback, no invented behaviour, a
        person simply sits still until the next allowed call.

        `action` is the model's own proposal (or None) — only its SHAPE is
        checked here; the physical whitelist/clamp lives in
        actions.apply_llm_action() and its real result comes back in
        mind.last_outcome for the NEXT call to examine.
        """
        now = mind.t
        if now - self._last_decide_t < THROTTLE_S:
            return None                      # too soon: quiet beat
        if time.monotonic() - self._last_wall < SPEAK_GAP_S:
            return None     # a speak/chat just spent the rate budget;
                            # deliberately NOT stamped — next tick retries
        self._last_decide_t = now
        try:
            data = extract_json(self._complete(self._decide_msg(mind)))
        except Exception as exc:            # noqa: BLE001 - degrade, never crash
            print(f"reasoning: decide failed ({exc}) — quiet beat.",
                  file=sys.stderr)
            return None
        if not data:
            print("reasoning: decide: empty answer — quiet beat.",
                  file=sys.stderr)
            return None
        action = data.get("action")
        if not isinstance(action, dict):
            action = None
        return {
            "examine": clean_line(data.get("examine"), MAX_THOUGHT),
            "reconsider": clean_line(data.get("reconsider"), MAX_THOUGHT),
            "action": action,
            "say": clean_line(data.get("say"), MAX_THOUGHT),
            "order_done": bool(data.get("order_done")),
        }

    # ---- spoken lines (LLM first, phrase bank as fallback) ----------------

    def speak_line(self, mind, situation, force=False):
        """One short in-character line to say out loud (None = use the bank).

        Shares the wall-clock rate gap with decide()/chat(): when the gap
        or the provider says no, the caller falls back to its phrase bank, so
        a run can never stall or break on this call. force=True lets a rare,
        user-visible moment (the entry greeting) skip the gap — still floored
        by SPEAK_FORCE_S so replays cannot hammer the provider.
        """
        now = time.monotonic()
        if force:
            if now - self._last_forced < SPEAK_FORCE_S:
                return None
            self._last_forced = now
        elif now - self._last_wall < SPEAK_GAP_S:
            return None                     # budget spent — bank answers this one
        msg = (
            f"STATE: {state_block(mind)}\n"
            f"SITUATION: {situation}\n"
            "Say ONE line Phill would say out loud right now (max 14 words, "
            'first person, in character). Respond with JSON:\n'
            '{"line": "<the line>"}'
        )
        data = None
        try:
            data = extract_json(self._complete(msg))
        except Exception as exc:            # noqa: BLE001 - degrade, never crash
            if not force:
                print(f"reasoning: speak_line failed ({exc}) — bank used.",
                      file=sys.stderr)
                return None
            time.sleep(RETRY_BACKOFF)   # a visible moment earns the shared
            try:                        # retry;4s crosses the429 window edge
                data = extract_json(self._complete(msg))
            except Exception as exc2:
                print(f"reasoning: speak_line failed ({exc2}) — bank used.",
                      file=sys.stderr)
                return None
        return clean_line((data or {}).get("line"), MAX_THOUGHT) or None

    # ---- experimenter chat -------------------------------------------------

    def chat(self, mind, text, rule_reply):
        """Answer the experimenter as Phill from live state (None = use rules)."""
        recent = mind.chat[-4:]
        history = " / ".join(f"{c['who']}: {c['text'][:60]}" for c in recent)
        msg = (
            f"STATE: {state_block(mind)}\n"
            f"RECENT CHAT: {history or 'none'}\n"
            f'THE EXPERIMENTER SAYS: "{text[:300]}"\n'
            "Reply as Phill (max 30 words). If asked for a number you do not "
            "have in STATE, deflect in character. Respond with JSON:\n"
            '{"reply": "<your answer>"}'
        )
        try:
            data = extract_json(self._complete(msg, self.chat_provider))
        except Exception as exc:            # noqa: BLE001 - degrade, never crash
            print(f"reasoning: chat failed ({exc}) — rule reply used.",
                  file=sys.stderr)
            return None
        reply = clean_line((data or {}).get("reply"), MAX_REPLY)
        return reply or None

    def chat_act(self, mind, text):
        """Interpret an experimenter message: reply AND (if ordered) act.

        The model decides what the message IS — a question, small talk, or
        an order — there is no regex/directive table in this lane. Returns
        {reply, action, standing} (action = an immediate move to make now or
        None, standing = keep it as a standing order across decide beats) —
        or None when the provider/answer fails, so the caller can fall back
        to the rules conversation path.

        Not throttled: the experimenter is waiting for the answer; the call
        stamps the shared wall budget so the next decide() waits its turn.
        """
        recent = mind.chat[-4:]
        history = " / ".join(f"{c['who']}: {c['text'][:60]}" for c in recent)
        order = (f'\nSTANDING ORDER you are already under: "{mind.instruction}"'
                 if getattr(mind, "instruction", None) else "")
        msg = (
            f"STATE: {state_block(mind)}\n"
            f"ENVELOPE (physical): {seat_envelope()}\n"
            f"LAST OUTCOME: {outcome_block(getattr(mind, 'last_outcome', None))}\n"
            f"RECENT CHAT: {history or 'none'}\n"
            f'THE EXPERIMENTER SAYS: "{text[:300]}"'
            f"{order}\n"
            "Reply as Phill (max 30 words): answer a question from STATE, "
            "chat naturally otherwise, and if it is an INSTRUCTION carry it "
            "out — an order ONE move can fulfil (turn the seat, raise it, "
            "recline, fetch water) MUST return that action in this very "
            "reply, not just a promise; confirm it in character. For an "
            "order that takes several moves, make the FIRST move now too "
            'and set "standing": true (you keep the order until you report '
            '"order_done": true in a decide call). Give "action": null '
            "only when nothing needs moving. Confirming an order with "
            '"action": null AND "standing": false is never acceptable — '
            "either act now or set standing. The seat axes are exactly: "
            "slider_mm, height_mm, recline_deg, rotation_deg. "
            '"delta" is the move YOU choose, in mm (slider/height) or '
            "degrees (recline/rotation) — never 0: when the order does not "
            "name a direction or amount, pick one yourself and make a "
            "noticeable real move (e.g. 15-45 degrees of swivel), then say "
            "what you did. Respond with "
            "JSON:\n"
            '{"reply": "<your answer, max 30 words>", '
            '"action": {"kind": "seat", "axis": '
            '"<slider_mm|height_mm|recline_deg|rotation_deg>", "delta": <n>} '
            'or {"kind": "vending", "item": "<item>"} or {"kind": "table", '
            '"folded": <bool>} or null, "standing": true|false}'
        )
        try:
            data = extract_json(self._complete(msg, self.chat_provider))
        except Exception as exc:            # noqa: BLE001 - degrade, never crash
            print(f"reasoning: chat_act failed ({exc}) — rules path used.",
                  file=sys.stderr)
            return None
        if not data:
            return None
        reply = clean_line(data.get("reply"), MAX_REPLY)
        if not reply:
            return None
        action = data.get("action")
        if not isinstance(action, dict):
            action = None
        return {"reply": reply, "action": action,
                "standing": bool(data.get("standing"))}
