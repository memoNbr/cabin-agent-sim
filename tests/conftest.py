import pytest

from cabin_sim.provider import create_provider
from cabin_sim.session import Session

# Minimal valid persona for deterministic scripted runs (matches the shape of
# personas/phill.py: seat prefs, tolerance, mood, talkativeness, vending).
PERSONA = {
    "name": "Phill",
    "blurb": "test persona for the deterministic suite",
    "seat": {
        "slider_mm": 330,
        "height_mm": 440,
        "recline_deg": 95,
        "rotation_deg": 0,
    },
    "tolerance": {
        "slider_mm": 90,
        "height_mm": 20,
        "recline_deg": 12,
        "rotation_deg": 20,
    },
    "mood": {"energy": 0.6, "suspicion": 0.5},
    "talkativeness": 0.5,
    "vending_interest": "low",
    "curiosity": 0.1,
}


def make_session(seed=1, max_steps=40):
    return Session(PERSONA, create_provider("scripted"),
                   max_steps=max_steps, seed=seed)


@pytest.fixture
def persona():
    return dict(PERSONA)


@pytest.fixture
def scripted():
    return create_provider("scripted")


@pytest.fixture
def session():
    return make_session()