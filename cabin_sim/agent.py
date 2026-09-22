"""The cognitive agent: perceive -> reason -> validate -> act.

A light BDI layer on top of an LLM (or the scripted fallback).

  Beliefs     the perceived cabin state and an internal mood
              (comfort, energy, suspicion)
  Desires     goals derived from the persona: the seat settings the
              persona likes and its tolerance for deviation from them
  Intentions  a short memory of recent actions keeps behaviour coherent;
              the reasoner picks ONE action per step toward a desire

The reasoner may only pick from the action whitelist. Every decision is
validated before it touches the cabin, and every cabin change is clamped.
"""

import json
import random
import time

from . import actions


SYSTEM_RULES = """\
You are a human participant inside a highly automated car on a weekend drive.
You can interact with the cabin through a fixed list of actions:
""" + ", ".join(actions.ALL_ACTIONS) + """\

Behaviour rules:
1. Act like a real person with your traits, not like an assistant or a robot.
2. Choose EXACTLY ONE action per reply, in small steps, matching your preferences.
3. Stay inside the safe ranges you are told about.
4. Talk briefly, in character, about why you did what you just did.
5. You do not drive the car. There is no steering wheel.

Reply with EXACTLY one JSON object and nothing else:
{"action": "<one action from the list, or null>", "say": "<one short sentence>"}
No markdown fences, no extra text."""

PHRASES = {
    "seat_forward": "Moving the seat a bit so my legs are not cramped.",
    "seat_back": "Pushing the seat back, I need a little more room.",
    "seat_up": "Raising the seat to see over the dash.",
    "seat_down": "Lowering the seat a touch.",
    "recline_more": "A little more recline. Not too much.",
    "recline_less": "That is enough. Sitting back up.",
    "rotate_cw": "Turning the seat slightly inward.",
    "rotate_ccw": "Turning it back the other way a bit.",
    "get_water": "Just a water. Keeps me going.",
    "get_coffee": "A coffee. It is a long weekend drive.",
    "get_snack": "Something small from the machine.",
    "deploy_table": "There is a table here. Let me try it once.",
    "stow_table": "Folding the table back away.",
}

UNDO = {
    "seat_forward": "seat_back",
    "seat_back": "seat_forward",
    "seat_up": "seat_down",
    "seat_down": "seat_up",
    "recline_more": "recline_less",
    "recline_less": "recline_more",
    "rotate_cw": "rotate_ccw",
    "rotate_ccw": "rotate_cw",
}

SETTLED = [
    "Nothing needed right now.",
    "It is fine.",
    "Good enough.",
    "I will leave it as is.",
    "Fine for now.",
]

SPONTANEOUS = {
    "suspicious": [
        "No steering wheel. Of course.",
        "I keep reaching for pedals that are not there.",
        "Why is this seat twisted to the side?",
        "The car keeps deciding things before I have even looked.",
        "Right... it moves by itself. Taking my time with it.",
    ],
    "content": [
        "Actually, this is not bad.",
        "Almost relaxing.",
        "I could get used to this, maybe.",
        "It rides smoothly, at least.",
        "Plenty of legroom now.",
    ],
    "neutral": [
        "Another weekend commute.",
        "Hope the week will be quiet.",
        "Home in about an hour, probably.",
        "I should reply to that email later.",
        "A bit of quiet before the week starts.",
        "Nice that nobody is honking for a change.",
    ],
}


class AgentDecision:
    def __init__(self, action=None, say=""):
        self.action = action
        self.say = say


class CognitiveAgent:
    def __init__(self, persona, provider, cabin, seed=1, mood=None):
        self.persona = persona
        self.provider = provider
        self.cabin = cabin
        self.rng = random.Random(seed)
        self.memory = []  # recent decisions (short-term intentions)
        self.last_say = ""
        self.succeeded = 0
        self.blocked = 0

        if mood is not None:
            # shared with cabin_sim.cognition.Mind - the mind owns the mood
            # dynamics (comfort/energy/suspicion relax & impulses), this object
            # only reads them and adds action impulses via observe().
            self.mood = mood
        else:
            base_mood = persona.get("mood", {})
            self.mood = {
                "energy": float(base_mood.get("energy", 0.6)),
                "suspicion": float(base_mood.get("suspicion", 0.3)),
                "comfort": 0.0,
            }
        if provider.name == "scripted":
            provider.attach(self)

    # ---- beliefs ----------------------------------------------------------
    # The comfort/relax dynamics live in cognition.Mind (the ported cognitive
    # core): comfort_target(), trust_value() and the suspicion set-point are
    # evaluated there once per tick. The agent only reacts to what it did.

    def observe(self, action, ok):
        if ok:
            self.succeeded += 1
            if action == "get_coffee":
                self.mood["energy"] = min(1.0, self.mood["energy"] + 0.20)
            elif action in ("get_water", "get_snack"):
                self.mood["energy"] = min(1.0, self.mood["energy"] + 0.12)
            if action in actions.DEFAULT_STEP:
                # a seat step that lands lowers suspicion a little
                self.mood["suspicion"] = max(0.0, self.mood["suspicion"] - 0.02)
        else:
            self.blocked += 1
            self.mood["suspicion"] = min(1.0, self.mood["suspicion"] + 0.04)
            self.mood["energy"] = max(0.0, self.mood["energy"] - 0.02)

    # ---- reason ------------------------------------------------------------

    def _system_prompt(self):
        p = self.persona
        interest = p.get("vending_interest", "low")
        vending_rule = {
            "low": "It is a short weekend drive and you do not need anything from the vending machine. Ignore it unless you are actually parched or hungry.",
            "medium": "You use the vending machine occasionally, at most one item at a time.",
            "high": "You use the vending machine freely.",
        }[interest]
        talk = p.get("talkativeness", 0.5)
        talk_rule = (
            "often" if talk >= 0.66 else
            "occasionally" if talk >= 0.33 else "rarely"
        )
        intro = p.get("self") or (
            f"You are {p['name']}, a person on a weekend drive. "
            f"{p.get('blurb', '')}"
        )
        return (
            f"{intro}\n"
            f"Traits: {', '.join(p['traits'])}.\n"
            f"You speak briefly, in a down-to-earth way, never like an assistant, "
            "and you never announce yourself or your name.\n"
            f"Preferred seat settings: {p['seat']}. "
            f"Tolerance for deviation: {p['tolerance']}.\n"
            f"Vending rule: {vending_rule}\n"
            "3a. Move ONE seat axis at a time and stop as soon as it is within "
            "the tolerance of your preferred value - do not overshoot it.\n"
            "3b. Never push the same adjustment more than twice in a row.\n"
            "3c. Pick EXACTLY one action per step. Never combine actions.\n"
            "3d. There is no steering wheel and no pedals. Never mention them.\n"
            "4a. You also talk {talk_rule}, whenever you feel like it: react to "
            "the drive, mutter, comment on the cabin. In that case say it with "
            "\"action\": null - a comment or reaction, not a plan of what you "
            "will do next.\n"
            "You are not an assistant and not a robot. You are a person in a car.\n"
            + SYSTEM_RULES
        )

    def _build_messages(self):
        recent = " | ".join(
            f"{m['action'] or 'talk'}: {m['say'][:40]}"
            for m in self.memory[-4:]
        )
        v = self.cabin.vending
        taken = [k for k, start in (("snack", 5), ("water", 5), ("coffee", 5))
                 if start - v.stock.get(k, start) > 0]
        note = ""
        if taken:
            item = taken[0]
            if item == "snack":
                note = "\nYou already had a snack earlier. Do not take more."
            elif item == "water":
                note = "\nYou already had a drink earlier. No more vending for now."
        user = (
            json.dumps({"cabin": self.cabin.to_dict(),
                        "mood": self.mood}, indent=2)
            + note
            + "\n\nWhat do you do next? Keep it a single small step.\n"
            + (f"Recent: {recent}\n" if recent else "")
            + "(If you would rather just talk this step, \"action\": null is fine.)"
        )
        return [
            {"role": "system", "content": self._system_prompt()},
            {"role": "user", "content": user},
        ]

    def decide(self):
        if self.provider.name == "scripted":
            raw = self.provider.complete([])
        else:
            try:
                raw = self.provider.complete(self._build_messages())
            except Exception:  # noqa: BLE001 - be resilient to rate limits etc.
                time.sleep(3.0)
                try:
                    raw = self.provider.complete(self._build_messages())
                except Exception:  # noqa: BLE001 - still down? use scripted brain
                    self.provider_failures = getattr(self, "provider_failures", 0) + 1
                    raw = scripted_decision(self)
        decision = self._parse(raw)
        self.last_say = decision.say
        self.memory.append({"action": decision.action, "say": decision.say})
        del self.memory[:-6]
        return decision

    def _parse(self, raw):
        try:
            data = json.loads(raw)
        except (TypeError, ValueError):
            data = {}
        action = str(data.get("action") or "").strip().lower()
        if action and action not in actions.ALL_ACTIONS:
            action = None
        say = str(data.get("say") or "").strip()
        return AgentDecision(action=action or None, say=say)


def scripted_decision(agent) -> str:
    """Deterministic 'human-ish' decision used when no LLM is configured.

    Follows the persona's preferences in small steps, shows suspicion by
    occasionally undoing the last seat action, rarely touches the vending
    machine, and settles when comfortable.
    """
    s = agent.cabin.seat
    pref, tol = agent.persona["seat"], agent.persona["tolerance"]
    rng = agent.rng

    # suspicion "test": sometimes undo the last seat action
    if agent.memory:
        last = agent.memory[-1].get("action")
        if last in UNDO and rng.random() < agent.mood["suspicion"] * 0.6:
            return _json(UNDO[last], "Hm. Let me put that back where it was.")

    # seat comfort: move toward the preferred setting when off target
    off = [
        (abs(pref[k] - getattr(s, k)) / max(1, tol[k]), pref[k] - getattr(s, k),
         pos, neg)
        for k, pos, neg in (
            ("slider_mm", "seat_forward", "seat_back"),
            ("height_mm", "seat_up", "seat_down"),
            ("recline_deg", "recline_more", "recline_less"),
            ("rotation_deg", "rotate_cw", "rotate_ccw"),
        )
    ]
    off.sort(key=lambda t: (t[0], abs(t[1])), reverse=True)
    gap, delta, pos_a, neg_a = off[0]
    if gap > 0.35 and delta != 0:
        action = pos_a if delta > 0 else neg_a
        return _json(action, PHRASES[action])

    # low energy -> a drink, but Phill is cautious so not always
    interest = agent.persona.get("vending_interest", "low")
    if agent.mood["energy"] < 0.25 and interest in ("low", "medium", "high"):
        if rng.random() < 0.5:
            action = "get_coffee" if interest == "high" else "get_water"
            return _json(action, PHRASES[action])

    # settled: occasionally try the novelty, otherwise talk or hold
    if rng.random() < agent.persona.get("curiosity", 0.1):
        action = "deploy_table" if agent.cabin.table.folded else "stow_table"
        return _json(action, PHRASES[action])

    if rng.random() < agent.persona.get("talkativeness", 0.5) * 0.6:
        if agent.mood["suspicion"] > 0.55:
            pool = SPONTANEOUS["suspicious"]
        elif agent.mood["comfort"] > 0.6:
            pool = SPONTANEOUS["content"]
        else:
            pool = SPONTANEOUS["neutral"]
    else:
        # quiet beat: mostly say nothing, sometimes a short remark
        if rng.random() < 0.6:
            return _json(None, "")
        pool = SETTLED
    last = agent.memory[-1].get("say") if agent.memory else ""
    candidates = [line for line in pool if line != last] or pool
    return _json(None, rng.choice(candidates))


def _json(action, say):
    return json.dumps({"action": action, "say": say}, ensure_ascii=False)