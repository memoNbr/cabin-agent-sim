"""Live prompt files: the environment prompt + personas, as code.

Two editable text layers feed the model's system prompt:

    prompts/environment-*.md   THE WORLD the model must understand — a
        fully autonomous vehicle, what the cabin offers, its physical
        seat envelope, how a settled passenger behaves;
    personas/*.py | *.json     WHO the model is. Python files define a
        PERSONA = {...} dict (comments allowed — the loader exec()s the
        file, so treat persona files as trusted local code); .json files
        still load for backwards compatibility.

Plain files on disk, and the sim UI exposes exactly TWO buttons that all
run through this module:

    [environment prompt]  opens the ACTIVE environment file's source ON
                          THE SAME PAGE — edit it in the panel, press
                          apply → save() writes the file and the running
                          reasoner picks it up; the dropdown switches
                          between prompts/*.md (select());
    [persona prompt]      the same for personas/*.py — switching also
                          hot-applies the new person to the RUNNING mind
                          (seat preferences, tolerances, talkativeness,
                          the prompt layer) without resetting the ride.

cycle() (apply-on-disk-edit-else-advance) stays available for scripted
use and the tests.

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
PERSONAS_DIR = ROOT / "personas"        # persona files (*.py, *.json)

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
    """Every persona file, sorted (cycle order). Python first-class, JSON kept."""
    return _list(PERSONAS_DIR, (".py", ".json"))


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


def _raw_text(path_str, fallback="") -> str:
    """The file's source EXACTLY as it sits on disk (for the page editor)."""
    if not path_str:
        return fallback
    try:
        return Path(path_str).read_text(encoding="utf-8")
    except (OSError, ValueError):
        return fallback


# ---- personas: .py (PERSONA = {...}) and .json ----------------------------

def _persona_from_text(text, suffix, name="prompt") -> dict:
    """Parse persona SOURCE text by its file language.

    .py is exec()d (a persona file is trusted local code — comments and
    normal Python allowed) and must define PERSONA = {...} with a name;
    .json must decode to an object with at least a name. Raises ValueError
    with the file name — callers turn that into an error payload, never a
    crash.
    """
    if suffix == ".py":
        ns = {}
        try:
            exec(compile(text, name, "exec"), ns)   # noqa: S102 - local config
        except Exception as exc:                    # noqa: BLE001
            raise ValueError(f"{name}: {exc}") from exc
        persona = ns.get("PERSONA")
        if not isinstance(persona, dict) or not persona.get("name"):
            raise ValueError(f"{name}: define PERSONA = {{...}} with a name")
        return persona
    try:
        persona = json.loads(text)
    except ValueError as exc:
        raise ValueError(f"{name}: {exc}") from exc
    if not isinstance(persona, dict) or not persona.get("name"):
        raise ValueError(f"{name}: needs a JSON object with at least a name")
    return persona


def load_persona(path) -> dict:
    """The persona defined by a .py or .json file. Raises ValueError."""
    path = Path(path)
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, ValueError) as exc:
        raise ValueError(f"persona file {path.name}: {exc}") from exc
    return _persona_from_text(text, path.suffix.lower(), path.name)


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
                if load_persona(p).get("name") \
                        == session.persona.get("name"):
                    target = p
                    break
            except ValueError:
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


def _first_line(text, fallback):
    """Display title: the file's first real line (its own naming)."""
    for line in str(text or "").splitlines():
        line = line.strip().lstrip("#").strip().strip("-").strip()
        if line:
            return line[:90]
    return fallback


def status(session) -> dict:
    """What is active right now (GET /api/prompt): the panel's payload.

    Beyond names/paths/choices it carries `content` (the source EXACTLY
    as on disk, editable on the page), plus the intention lines: the
    environment file's first line as its title, the persona's name and
    blurb — so a click shows WHAT each prompt is without leaving the page.
    """
    ensure(session)
    env_path = getattr(session, "environment_path", None)
    per_path = getattr(session, "persona_path", None)

    env_content = _raw_text(env_path, DEFAULT_ENVIRONMENT)
    env = _brief(env_path, "(builtin)")
    env["content"] = env_content
    env["title"] = _first_line(env_content, env["name"])

    per = _brief(per_path, str(session.persona.get("name", "?")))
    who = str(session.persona.get("name", "?"))
    blurb = str(session.persona.get("blurb", ""))
    if per_path:
        try:
            loaded = load_persona(per_path)      # who/blurb as the file says
            who = str(loaded.get("name", who))
            blurb = str(loaded.get("blurb", blurb))
            per["content"] = _raw_text(per_path, "")
        except ValueError:
            per["content"] = _raw_text(
                per_path, json.dumps(session.persona, indent=2,
                                     ensure_ascii=False))
    else:
        per["content"] = json.dumps(session.persona, indent=2,
                                    ensure_ascii=False)
    per["who"] = who
    per["blurb"] = blurb

    return {
        "environment": env,
        "persona": per,
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


def _apply_environment(session, path) -> None:
    """Read the environment file (envelope filled) and apply it live."""
    text = read_environment(path)
    session.environment_text = text
    session.environment_path = str(path)
    session._environment_mtime = _mtime(path)
    if getattr(session, "reasoner", None) is not None:
        session.reasoner.set_environment(text)


def apply_persona(session, path) -> None:
    """Load a persona file and hot-apply it to the RUNNING session.

    The person behind the body changes (prompt layer + persona-derived
    mind fields); the ride, the clock, the mood and the memory traces
    keep running. Raises ValueError for an unusable file — cycle()/select()
    turn that into an error payload, never a crash.
    """
    path = Path(path)
    persona = load_persona(path)           # raises ValueError, name included

    session.persona = persona
    session.persona_path = str(path)
    session._persona_mtime = _mtime(path)
    session.agent.persona = persona
    session.mind.apply_persona(persona)       # prefs, tolerances, tunables
    session.mind.perceive_fit()               # new preferences rescore now
    if getattr(session, "reasoner", None) is not None:
        session.reasoner.set_persona(persona)  # rebuild the system prompt


def cycle(session, kind) -> dict:
    """One legacy UI click: apply edits, or advance to the next file."""
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
        _apply_environment(session, target)
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


def select(session, kind, filename) -> dict:
    """Open a NAMED file of either kind (the panel's file dropdown)."""
    ensure(session)
    if kind == "environment":
        for p in list_environments():
            if p.name == filename:
                _apply_environment(session, p)
                session.note("prompt", kind="environment", name=p.name,
                             selected=True)
                return dict(status(session), applied="environment", error=None)
        return dict(status(session), applied=None,
                    error=f"no environment file {filename!r}")
    if kind == "persona":
        for p in list_personas():
            if p.name == filename:
                try:
                    apply_persona(session, p)
                except ValueError as exc:
                    return dict(status(session), applied=None, error=str(exc))
                session.note("prompt", kind="persona", name=p.name,
                             selected=True)
                return dict(status(session), applied="persona", error=None)
        return dict(status(session), applied=None,
                    error=f"no persona file {filename!r}")
    return dict(status(session), applied=None,
                error=f"unknown prompt kind {kind!r}")


def save(session, kind, text) -> dict:
    """Write the EDITED source from the page's panel, then apply it.

    The active file of `kind` is overwritten with `text` (validated first:
    a persona file must still parse in its own language — a syntax error
    is an error payload and the file on disk stays untouched), and the
    running session picks the new text up immediately.
    """
    ensure(session)
    if not isinstance(text, str) or not text.strip():
        return dict(status(session), applied=None,
                    error="nothing to save — the file is empty")

    if kind == "environment":
        path = getattr(session, "environment_path", None)
        if not path:
            return dict(status(session), applied=None,
                        error="no environment file to save into")
        try:
            Path(path).write_text(text, encoding="utf-8", newline="\n")
        except OSError as exc:
            return dict(status(session), applied=None,
                        error=f"{path}: {exc}")
        _apply_environment(session, Path(path))   # re-read + envelope + live
        session.note("prompt", kind="environment", name=Path(path).name,
                     saved=True)
        return dict(status(session), applied="environment", error=None)

    if kind == "persona":
        path = getattr(session, "persona_path", None)
        if not path:
            return dict(status(session), applied=None,
                        error="no persona file to save into")
        p = Path(path)
        try:                              # validate in the file's language
            _persona_from_text(text, p.suffix.lower(), p.name)
        except ValueError as exc:
            return dict(status(session), applied=None, error=str(exc))
        try:
            p.write_text(text, encoding="utf-8", newline="\n")
        except OSError as exc:
            return dict(status(session), applied=None, error=f"{p}: {exc}")
        try:
            apply_persona(session, p)     # re-read what landed on disk
        except ValueError as exc:         # (validation passed, belt + braces)
            return dict(status(session), applied=None, error=str(exc))
        session.note("prompt", kind="persona", name=p.name, saved=True)
        return dict(status(session), applied="persona", error=None)

    return dict(status(session), applied=None,
                error=f"unknown prompt kind {kind!r}")
