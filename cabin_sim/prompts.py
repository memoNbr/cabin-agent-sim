"""Live prompt files: the environment prompt + personas, as code.

Two editable text layers feed the model's system prompt:

    prompts/environment-*.md   THE WORLD the model must understand — a
        fully autonomous vehicle, what the cabin offers, its physical
        seat envelope, how a settled passenger behaves;
    personas/*.json            WHO the model is.

They are plain files on disk, and the sim UI exposes four controls that
all run through this module:

    [env prompt]     one click: apply the active environment file as it
                     now exists on disk (your code edit), else advance to
                     the next environment file;
    [persona]        the same for personas/*.json — a persona click also
                     hot-applies the new person to the RUNNING mind (seat
                     preferences, tolerances, talkativeness, the prompt
                     layer) without resetting the ride;
    [env code]       links (vscode://file/...) to the ACTUAL source
                     files: what you edit there is what the sim runs;
    [persona code]   the same for the persona file.

Safety is untouched here: only the prompt layer and persona-derived
preferences move — actions.apply_llm_action(), the world clamps and the
rules/scripted path are exactly as before, and a missing/broken file
degrades (builtin text, an error payload) instead of taking the run down.
"""

from __future__ import annotations

import json
from pathlib import Path

from .world import Seat

ROOT = Path(__file__).resolve().parent.parent
PROMPTS_DIR = ROOT / "prompts"          # environment prompt files (*)
PERSONAS_DIR = ROOT / "personas"        # persona files (*.json)

# used when prompts/ is missing or empty — a run can never fail on prompts
DEFAULT_ENVIRONMENT = (
    "You are a passenger in a FULLY AUTONOMOUS road vehicle: no steering "
    "wheel, no pedals, no driver — the car does the whole journey itself "
    "and nothing you do affects the driving. The cabin offers a power seat "
    "(slide, height, recline, swivel), a foldable table and a vending "
    "machine. Settle into a position you like and keep it: adjust only "
    "when something bothers you or the experimenter says so."
)

ENV_PLACEHOLDER = "{seat_envelope}"     # filled from world.Seat at load


def seat_envelope() -> str:
    """The seat's physical travel envelope, generated from world.Seat.

    Prompt files may quote it via {seat_envelope} and the decide/chat
    messages carry it too — so the model always sees the REAL numbers,
    however the prose around them is edited.
    """
    return (
        f"slide {Seat.SLIDER_MIN}\u2013{Seat.SLIDER_MAX} mm \u00b7 "
        f"height {Seat.HEIGHT_MIN}\u2013{Seat.HEIGHT_MAX} mm \u00b7 "
        f"recline {Seat.RECLINE_MIN}\u2013{Seat.RECLINE_MAX}\u00b0 \u00b7 "
        f"rotate {Seat.ROT_MIN}\u2013{Seat.ROT_MAX}\u00b0 "
        f"(a full swivel: turning through the "
        f"0/{Seat.ROT_MAX} seam lands on the other side)"
    )


# ---- the files -------------------------------------------------------------

def resolve(path) -> Path:
    """Absolute path for a possibly repo-relative file name."""
    p = Path(path)
    return p if p.is_absolute() else (ROOT / p)


def _list(folder: Path, suffixes) -> list:
    try:
        return [p for p in sorted(folder.iterdir())
                if p.is_file() and p.suffix.lower() in suffixes]
    except OSError:
        return []


def list_environments() -> list:
    """Every environment prompt file, sorted (cycle order)."""
    return _list(PROMPTS_DIR, (".md", ".txt"))


def list_personas() -> list:
    """Every persona file, sorted (cycle order)."""
    return _list(PERSONAS_DIR, (".json",))


def read_environment(path) -> str:
    """The environment file's text with {seat_envelope} filled in."""
    try:
        text = Path(path).read_text(encoding="utf-8")
    except (OSError, ValueError):        # missing or badly encoded file
        return DEFAULT_ENVIRONMENT
    text = text.replace(ENV_PLACEHOLDER, seat_envelope()).strip()
    return text or DEFAULT_ENVIRONMENT


def default_environment():
    """(path, text) of the first environment file, or (None, builtin)."""
    files = list_environments()
    if files:
        return files[0], read_environment(files[0])
    return None, DEFAULT_ENVIRONMENT


def _mtime(path):
    try:
        return Path(path).stat().st_mtime
    except OSError:
        return None


def ensure(session):
    """Bind the active file paths (default = first on disk).

    Content is only loaded when the session has none yet (so a Session
    built without a prompt still picks the code's files up on the first
    status/cycle call). The mtime is deliberately NOT stamped here: the
    first click therefore always re-reads the active file, applying any
    edit you made before clicking.
    """
    if not getattr(session, "environment_path", None):
        files = list_environments()
        if files:
            session.environment_path = str(files[0])
            if getattr(session, "environment_text", None) is None:
                session.environment_text = read_environment(files[0])
                if getattr(session, "reasoner", None) is not None:
                    session.reasoner.set_environment(session.environment_text)
    if not getattr(session, "persona_path", None):
        files = list_personas()
        target = None
        for p in files:                       # the file the session already is
            try:
                if json.loads(p.read_text(encoding="utf-8")).get("name") \
                        == session.persona.get("name"):
                    target = p
                    break
            except (OSError, ValueError):
                continue
        if target is None and files:
            target = files[0]
        if target is not None:
            session.persona_path = str(target)


def _brief(path_str, fallback_name):
    if not path_str:
        return {"name": fallback_name, "path": None}
    p = Path(path_str)
    return {"name": p.name, "path": str(p)}


def status(session) -> dict:
    """What is active right now (GET /api/prompt): names, paths, choices."""
    ensure(session)
    return {
        "environment": _brief(getattr(session, "environment_path", None),
                              "(builtin)"),
        "persona": _brief(getattr(session, "persona_path", None),
                          str(session.persona.get("name", "?"))),
        "environments": [p.name for p in list_environments()],
        "personas": [p.name for p in list_personas()],
    }


def _pick_target(active, files, stored_mtime):
    """One click: apply the on-disk edit of the active file, else advance."""
    if not files:
        return None
    if active in files:
        disk = _mtime(active)
        if stored_mtime is None or (disk is not None
                                    and disk > stored_mtime + 1e-6):
            return active                     # edited since we loaded it
        i = files.index(active)
        return files[(i + 1) % len(files)]    # unchanged: next file
    return files[0]


def apply_persona(session, path) -> None:
    """Load a persona file and hot-apply it to the RUNNING session.

    The person behind the body changes (prompt layer + persona-derived
    mind fields); the ride, the clock, the mood and the memory traces
    keep running. Raises ValueError for an unusable file — cycle()
    turns that into an error payload, never a crash.
    """
    path = Path(path)
    try:
        persona = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"persona file {path.name}: {exc}") from exc
    if not isinstance(persona, dict) or not persona.get("name"):
        raise ValueError(f"persona file {path.name}: needs at least a name")

    session.persona = persona
    session.persona_path = str(path)
    session._persona_mtime = _mtime(path)
    session.agent.persona = persona
    session.mind.apply_persona(persona)       # prefs, tolerances, tunables
    session.mind.perceive_fit()               # new preferences rescore now
    if getattr(session, "reasoner", None) is not None:
        session.reasoner.set_persona(persona)  # rebuild the system prompt


def cycle(session, kind) -> dict:
    """One UI click (POST /api/prompt): apply edits, or switch files."""
    ensure(session)
    if kind == "environment":
        files = list_environments()
        active = (Path(session.environment_path)
                  if getattr(session, "environment_path", None) else None)
        target = _pick_target(active, files,
                              getattr(session, "_environment_mtime", None))
        if target is None:
            return dict(status(session), applied=None,
                        error="no environment files in prompts/")
        text = read_environment(target)
        session.environment_text = text
        session.environment_path = str(target)
        session._environment_mtime = _mtime(target)
        if getattr(session, "reasoner", None) is not None:
            session.reasoner.set_environment(text)
        session.note("prompt", kind="environment", name=target.name)
        return dict(status(session), applied="environment", error=None)

    if kind == "persona":
        files = list_personas()
        active = (Path(session.persona_path)
                  if getattr(session, "persona_path", None) else None)
        target = _pick_target(active, files,
                              getattr(session, "_persona_mtime", None))
        if target is None:
            return dict(status(session), applied=None,
                        error="no persona files in personas/")
        try:
            apply_persona(session, target)
        except ValueError as exc:
            return dict(status(session), applied=None, error=str(exc))
        session.note("prompt", kind="persona", name=target.name)
        return dict(status(session), applied="persona", error=None)

    return dict(status(session), applied=None,
                error=f"unknown prompt kind {kind!r}")
