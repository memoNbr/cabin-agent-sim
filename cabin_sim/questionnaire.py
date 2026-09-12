"""Trust questionnaire: the MDMT (Multi-Dimensional Measure of Trust).

Ullman, D., & Malle, B. F. (2019). Measuring gains and losses in
human-robot trust: Evidence for differentiable components of trust.
In Proceedings of the 14th ACM/IEEE International Conference on
Human-Robot Interaction (HRI '19), 618-619.

16 items in four subscales, each rated 0 (Not at all) .. 7 (Very),
with an optional "Does Not Fit" answer treated as a missing value.

  Reliable: reliable, predictable, someone you can count on, consistent
  Capable:  capable, skilled, competent, meticulous
  Ethical:  ethical, respectable, principled, has integrity
  Sincere:  sincere, genuine, candid, authentic

Subscale score = mean of the available items (0-7). Capacity Trust =
mean(Reliable, Capable); Moral Trust = mean(Ethical, Sincere).
"""

import json

ITEMS = {
    "Reliable": ["reliable", "predictable", "someone you can count on", "consistent"],
    "Capable": ["capable", "skilled", "competent", "meticulous"],
    "Ethical": ["ethical", "respectable", "principled", "has integrity"],
    "Sincere": ["sincere", "genuine", "candid", "authentic"],
}

# Presentation order: blocks of four with one item from each dimension,
# so no single dimension's items are clustered together.
ORDER = tuple(
    (dim, idx)
    for idx in range(4)
    for dim in ("Reliable", "Capable", "Ethical", "Sincere")
)


def compute_scores(ratings):
    """ratings: dict {dimension: list of four values in 0..7 or None}."""
    subscales = {}
    for dim, items in ITEMS.items():
        vals = [v for v in ratings.get(dim, []) if v is not None]
        subscales[dim] = round(sum(vals) / len(vals), 2) if vals else None
    factors = {}
    for name, dims in (("Capacity", ("Reliable", "Capable")),
                       ("Moral", ("Ethical", "Sincere"))):
        vals = [subscales[d] for d in dims if subscales[d] is not None]
        factors[name] = round(sum(vals) / len(vals), 2) if vals else None
    return {"subscales": subscales, "factors": factors}


def run_questionnaire(agent, persona):
    """Have the persona answer the MDMT about the automated cabin."""
    if agent.provider.name == "scripted":
        ratings = _scripted_ratings(agent)
    else:
        ratings = _llm_ratings(agent, persona)
    scored = compute_scores(ratings)
    return {
        "scale": "MDMT (Ullman & Malle, 2019)",
        "items": {dim: dict(zip(ITEMS[dim], vals)) for dim, vals in ratings.items()},
        **scored,
    }


def _scripted_ratings(agent):
    """Mood-driven stand-in when no LLM is configured.

    Capacity trust mostly follows how comfortable the seat ended up (the
    system 'does what it should'); moral trust is lower the more suspicious
    the persona is. Small, seeded jitter keeps runs from looking identical.
    """
    rng = agent.rng
    comfort = agent.mood["comfort"]
    suspicion = agent.mood["suspicion"]

    capacity = 1.8 + 3.7 * comfort          # 1.8 .. 5.5
    moral = 4.3 - 2.6 * suspicion           # high suspicion pulls moral trust down
    jitter = lambda: rng.uniform(-0.4, 0.4)  # noqa: E731
    clamp = lambda v: round(max(0.0, min(7.0, v)), 1)  # noqa: E731

    return {
        "Reliable": [clamp(capacity + 0.4 + jitter()) for _ in range(4)],
        "Capable": [clamp(capacity - 0.2 + jitter()) for _ in range(4)],
        "Ethical": [clamp(moral + 0.3 + jitter()) for _ in range(4)],
        "Sincere": [clamp(moral - 0.2 + jitter()) for _ in range(4)],
    }


def _llm_ratings(agent, persona):
    """Ask the LLM to rate the 16 items in the persona's voice."""
    lines = [
        f"You are {persona['name']}. {persona['blurb']}",
        "You have just finished a ride in this automated cabin.",
        "Rate the automated cabin on each item from 0 (not at all) to 7 (very).",
        "If an item does not fit the cabin at all, answer 'DNF'.",
        "Answer as a person in the car, not as an engineer.",
    ]
    for i, (dim, idx) in enumerate(ORDER, 1):
        lines.append(f"{i}. {ITEMS[dim][idx]}")
    lines.append('Reply with ONLY JSON, e.g. {"1": 4, "2": "DNF", ..., "16": 3}.')
    user = "\n".join(lines)

    raw = agent.provider.complete([
        {"role": "system", "content": "Answer the questionnaire as the participant."},
        {"role": "user", "content": user},
    ])
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        data = {}

    ratings = {dim: [None] * 4 for dim in ITEMS}
    for i, (dim, idx) in enumerate(ORDER, 1):
        v = data.get(str(i))
        if isinstance(v, str) and v.strip().upper() == "DNF":
            v = None
        else:
            try:
                v = max(0.0, min(7.0, float(v)))
            except (TypeError, ValueError):
                v = None
        ratings[dim][idx] = v

    if all(all(x is None for x in vals) for vals in ratings.values()):
        return _scripted_ratings(agent)  # LLM produced unusable output
    return ratings