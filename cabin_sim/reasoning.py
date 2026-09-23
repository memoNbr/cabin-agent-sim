"""LLM-based reasoning for the mind: deliberation, inner monologue, chat.

The architecture separates WHO decides from WHAT is decided:

    cabin_sim.cognition      owns state, dynamics and legality
        (cooldowns, preconditions, clamps, memory decay, mood relax — Python)
    cabin_sim.reasoning.py   owns WORDING and CHOICE among legal options
        (this file — an LLM behind provider.complete(), or rules/None)

Two modes:

    rules  (default)  Mind keeps its deterministic desire-argmax and phrase
                      banks. create_reasoner() returns None; behaviour is
                      byte-identical to the pre-LLM port (all 61 tests).
    llm               Each decision step the model is handed ONLY the legal
                      goals (cooldowns/preconditions already applied in
                      Python) and picks one plus a one-line thought; chat
                      replies are written from the live state. Anything the
                      model returns is validated — an illegal intention, bad
                      JSON, an empty line or a network error silently falls
                      back to the rule answer for that tick.

Mode selection: --reasoning auto|rules|llm (env REASONING). "auto" enables the
LLM whenever the provider is a real backend (groq/ollama); scripted always
means rules, so pytest stays deterministic.
"""

from __future__ import annotations

import json
import re
import sys
import time

MAX_THOUGHT = 160
MAX_REPLY = 240
THROTTLE_S = 12.0       # min sim-seconds between deliberation calls; sized
                        # to the Groq free tier (~6K TPM at tick-dt 2.0 →
                        # ≈8 calls/min ≈ 4K TPM, zero 429s — at 8.0 we still
                        # saw ~4 429/min, each stalling the session lock)
RETRY_BACKOFF = 4.0     # wall-seconds before the single retry — measured:
                        # 1.5s always lands inside the same 429 window, 4s
                        # crosses the edge (entry greet went bank -> LLM)
SPEAK_GAP_S = 30.0      # min wall-seconds between ANY non-priority model
                        # call — deliberate() and speak_line() check it,
                        # chat() only stamps it. Measured on gpt-oss-120b:
                        # at 7.5, 14 and even 20 the rolling TPM window kept
                        # rejecting deliberate; 30s ≈ 2 calls/min fits under
                        # it, and speech never stalls (skip -> bank line)
SPEAK_FORCE_S = 10.0    # floor between FORCED lines: the entry greeting skips
                        # the gap, but never faster than this


def create_reasoner(provider, mode="auto", persona=None, chat_provider=None):
    """Build the reasoner for this session (None = rules mode).

    `chat_provider` is an optional SECOND backend used only for experimenter
    replies (hybrid: the fast model ticks, a bigger model chats); None means
    one provider does everything.

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
            return LLMReasoner(provider, persona, chat_provider=chat_provider)
    return None


# --------------------------------------------------------------------------
# prompt construction
# --------------------------------------------------------------------------

def _system_prompt(persona):
    persona = persona or {}
    name = persona.get("name", "a passenger")
    blurb = str(persona.get("blurb", ""))[:200]
    return (
        f"You are {name}, a passenger riding in a self-driving cabin. {blurb}\n"
        "Voice: dry, practical, British understatement; short first-person "
        "lines, never cheerful, never robotic.\n"
        "RULES: every fact comes from the STATE line supplied with each "
        "request — never invent numbers, seat angles, events or history. "
        "You never break character and never mention being a model.\n"
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
    """Full LLM reasoning: intention choice + inner thought + chat replies.

    At most ONE model call is made per decision step (deliberation returns the
    intention and the thought together); chat is a second call only when the
    experimenter actually sends a line. Every result is validated against the
    options Python supplied — see the module docstring.
    """

    mode = "llm"

    def __init__(self, provider, persona=None, chat_provider=None):
        self.provider = provider            # ticks + deliberation (fast lane)
        self.chat_provider = chat_provider or provider   # experimenter lane
        self.kind = f"llm:{getattr(provider, 'name', 'llm')}"
        self.system = _system_prompt(persona)
        self.calls = 0                      # observability (tests, HUD)
        self._last_offered = None           # deliberation throttle
        self._last_deliberate_t = -1e9
        self._last_wall = 0.0               # shared rate-gap stamp (all lanes)
        self._last_forced = -1e9            # forced-line floor (entry greet)

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

    # ---- BDI deliberation -------------------------------------------------

    def deliberate(self, mind, offered, rule_best):
        """Pick among the LEGAL goals; also write this tick's inner thought.

        Returns (intention, thought): intention is re-validated by the caller
        against `offered`, thought may be None (rules line is then used).

        Throttled: an unchanged legal set within THROTTLE_S sim-seconds is
        answered from the previous call's outcome-less skip — the rule argmax
        and phrase banks cover the gap. This caps model calls at ~1 per
        THROTTLE_S seconds, respecting provider rate limits.
        """
        key = tuple(offered)
        now = mind.t
        if (key == self._last_offered
                and now - self._last_deliberate_t < THROTTLE_S):
            return None, None                # too soon: rules cover this tick
        if time.monotonic() - self._last_wall < SPEAK_GAP_S:
            return None, None     # a speak/chat just spent the rate budget;
                                  # deliberately NOT stamped — next tick retries
        self._last_offered, self._last_deliberate_t = key, now
        legal = " | ".join(f"{g} (desire {v:.2f})" for g, v in
                           ((g, mind._desire(g)) for g in offered))
        msg = (
            f"STATE: {state_block(mind)}\n"
            f"LEGAL GOALS — you may pick exactly ONE: {legal}\n"
            "Choose the goal worth pursuing right now, given your body, mood "
            "and memories. Respond with JSON:\n"
            '{"intention": "<one legal goal>", '
            '"thought": "<your inner monologue line, max 14 words>"}'
        )
        try:
            data = extract_json(self._complete(msg))
        except Exception as exc:            # noqa: BLE001 - degrade, never crash
            print(f"reasoning: deliberate failed ({exc}) — rules this tick.",
                  file=sys.stderr)
            return None, None
        if not data:
            print("reasoning: deliberate: empty answer — rules this tick.",
                  file=sys.stderr)
            return None, None
        intention = data.get("intention")
        intention = intention.strip() if isinstance(intention, str) else None
        thought = clean_line(data.get("thought"), MAX_THOUGHT)
        return intention, thought

    # ---- spoken lines (LLM first, phrase bank as fallback) ----------------

    def speak_line(self, mind, situation, force=False):
        """One short in-character line to say out loud (None = use the bank).

        Shares the wall-clock rate gap with deliberate()/chat(): when the gap
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
