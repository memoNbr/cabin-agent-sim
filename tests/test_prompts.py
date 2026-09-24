"""Tests for cabin_sim.prompts — the live prompt files behind the UI buttons.

Three contracts are pinned here:
  1. prompts are FILES — a click applies the on-disk edit of the active
     file BEFORE advancing to the next one (what you write in the code
     is what the sim runs);
  2. switching is prompt-layer only: the reasoner's system prompt and
     the persona-derived mind fields move, the ride keeps running, and
     rules mode (no reasoner) survives a cycle untouched;
  3. missing/broken files degrade (builtin text, an error payload) —
     never a crash.
"""

import json
import os

import pytest

from cabin_sim import prompts
from cabin_sim.provider import create_provider
from cabin_sim.session import Session


class FakeProvider:
    """complete() with canned replies; counts calls."""

    name = "fake"

    def __init__(self, replies=None):
        self.replies = list(replies or ["{}"])
        self.calls = 0

    def complete(self, messages):          # noqa: ARG001
        self.calls += 1
        return self.replies[min(self.calls - 1, len(self.replies) - 1)]


def _phill(name="Phill", slider=330):
    return {
        "name": name,
        "self": f"You are {name}, a passenger in a fully autonomous car.",
        "voice": "dry, clipped test voice",
        "talkativeness": 0.5,
        "seat": {"slider_mm": slider, "height_mm": 440,
                 "recline_deg": 95, "rotation_deg": 0},
        "tolerance": {"slider_mm": 90, "height_mm": 20,
                      "recline_deg": 12, "rotation_deg": 20},
        "mood": {"energy": 0.6, "suspicion": 0.5},
        "cognition": {},
    }


def _nadia():
    p = _phill("Nadia", slider=390)
    p["self"] = "You are Nadia, a physiotherapist who sits tall."
    return p


@pytest.fixture
def files(tmp_path, monkeypatch):
    env_dir = tmp_path / "prompts"
    per_dir = tmp_path / "personas"
    env_dir.mkdir()
    per_dir.mkdir()
    monkeypatch.setattr(prompts, "PROMPTS_DIR", env_dir)
    monkeypatch.setattr(prompts, "PERSONAS_DIR", per_dir)
    return env_dir, per_dir


def _write_env(env_dir, name, body):
    (env_dir / name).write_text(body, encoding="utf-8")


def _write_persona(per_dir, persona):
    (per_dir / f"{persona['name'].lower()}.json").write_text(
        json.dumps(persona), encoding="utf-8")


def _session(persona=None, provider=None, reasoning="llm"):
    return Session(persona or _phill(),
                   provider or FakeProvider(["{}"]), reasoning=reasoning)


def _bump_mtime(path, seconds=30):
    """Force a visibly newer mtime (Windows can be coarse)."""
    st = path.stat()
    os.utime(path, (st.st_atime + seconds, st.st_mtime + seconds))


# ---- the files -------------------------------------------------------------


def test_builtin_environment_keeps_a_run_alive_without_files(files):
    env_dir, _ = files
    path, text = prompts.default_environment()
    assert path is None and "autonomous" in text.lower()
    assert prompts.read_environment(env_dir / "ghost.md") == prompts.DEFAULT_ENVIRONMENT


def test_environment_file_gets_the_real_seat_envelope(files):
    env_dir, _ = files
    _write_env(env_dir, "world.md", "sitting here: {seat_envelope}")
    text = prompts.read_environment(env_dir / "world.md")
    assert "{seat_envelope}" not in text
    assert str(prompts.Seat.SLIDER_MIN) in text      # numbers from world.Seat
    assert str(prompts.Seat.ROT_MAX) in text


def test_seat_envelope_names_every_adjustable_axis():
    env = prompts.seat_envelope()
    for word in ("slide", "height", "recline", "rotate"):
        assert word in env


# ---- one click: apply the edit, else advance --------------------------------


def test_click_applies_the_edited_file_before_advancing(files):
    env_dir, _ = files
    _write_env(env_dir, "a.md", "WORLD A")
    _write_env(env_dir, "b.md", "WORLD B")
    s = _session()

    first = prompts.cycle(s, "environment")
    assert first["error"] is None
    assert first["environment"]["name"] == "a.md"
    assert "WORLD A" in s.reasoner.system

    _write_env(env_dir, "a.md", "WORLD A EDITED")     # you edit the code…
    _bump_mtime(env_dir / "a.md")
    again = prompts.cycle(s, "environment")           # …one click applies it
    assert again["environment"]["name"] == "a.md"     # NOT advanced yet
    assert s.environment_text == "WORLD A EDITED"
    assert "WORLD A EDITED" in s.reasoner.system
    assert "WORLD A\n" not in s.reasoner.system

    third = prompts.cycle(s, "environment")           # unchanged -> next file
    assert third["environment"]["name"] == "b.md"
    assert "WORLD B" in s.reasoner.system


def test_status_lists_both_kinds_with_active_names_and_paths(files):
    env_dir, per_dir = files
    _write_env(env_dir, "world.md", "WORLD")
    _write_persona(per_dir, _phill())
    s = _session()
    st = prompts.status(s)
    assert st["environment"]["name"] == "world.md"
    assert st["environment"]["path"].endswith("world.md")
    assert st["environments"] == ["world.md"]
    assert st["persona"]["name"] == "phill.json"      # matched by persona name
    assert st["personas"] == ["phill.json"]


# ---- persona cycling hot-applies the person --------------------------------


def test_persona_click_hot_swaps_the_person_and_prompt(files):
    _, per_dir = files
    _write_persona(per_dir, _phill())
    _write_persona(per_dir, _nadia())
    s = _session()
    s.mind.t = 42.0                                   # a ride already under way

    prompts.cycle(s, "persona")                       # bind + apply Phill
    assert s.persona["name"] == "Phill"

    result = prompts.cycle(s, "persona")              # unchanged -> advance
    assert result["error"] is None
    assert s.persona["name"] == "Nadia"
    assert s.persona_path.endswith("nadia.json")
    assert s.mind.persona["name"] == "Nadia"
    assert s.agent.persona["name"] == "Nadia"
    assert s.mind.target_slider_mm == 390.0           # new preferences live
    assert s.mind.t == 42.0                           # the ride kept running
    assert s.mind.memory.lam == s.mind.memory_lambda  # traces kept, new rate
    assert "Nadia" in s.reasoner.system               # the prompt layer too


def test_rules_session_cycles_files_without_a_reasoner(files):
    env_dir, _ = files
    _write_env(env_dir, "world.md", "WORLD A")
    s = _session(provider=create_provider("scripted"), reasoning="auto")
    assert s.reasoner is None
    result = prompts.cycle(s, "environment")
    assert result["error"] is None and s.reasoner is None
    assert s.environment_text == "WORLD A"


# ---- broken files degrade, never crash -------------------------------------


def test_broken_persona_file_returns_an_error_payload(files):
    _, per_dir = files
    (per_dir / "aaa-broken.json").write_text("{{ not json", encoding="utf-8")
    _write_persona(per_dir, _phill())
    s = _session(persona=_phill("Ghost"))             # matches no file name
    result = prompts.cycle(s, "persona")
    assert result["error"] and "aaa-broken" in result["error"]
    assert s.persona["name"] == "Ghost"               # nothing was applied


def test_unknown_prompt_kind_is_reported(files):
    result = prompts.cycle(_session(), "mood")
    assert result["error"] and result["applied"] is None
