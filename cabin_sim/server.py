"""A tiny stdlib HTTP server: the browser pages + the live state feed.

It deliberately uses only the standard library so there is no web framework
to learn. The engine (not a session thread) drives the simulation: a ticker
thread calls engine.tick(1) every ``interval`` wall seconds.

Endpoints:

  GET  /               the SVG visual (web/index.html)
  GET  /api/state      session feed (existing shape, polled by web/index.html)
  GET  /api/snapshot   canonical schema snapshot (the view adapter polls this)
  GET  /api/prompt     active environment/persona prompt files + choices
                       + the active file's `content` (editable on the page)
  POST /api/chat       experimenter chat      {"text": "..."}
  POST /api/seat       set a seat axis        {"axis": "rot|hgt|sl", "value": n}
  POST /api/control    play/pause             {"running": true|false}
  POST /api/prompt     the two prompt buttons:
                       {"kind": "environment|persona", "text": "<edited source>"}
                           save the panel's edit to the file + apply it live;
                       {"kind": "...", "file": "name.md"}  switch to that file;
                       {"kind": "..."}                     legacy cycle click.
"""

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import prompts as prompt_files
from .schema import build_snapshot

_ROOT = Path(__file__).resolve().parent.parent
# The view. The real cockpit is the Vite app at the project root; `npm run
# build` bundles it (three.js included) into dist/, which this server can
# hand out statically — same origin as /api, so the page just works at
# http://127.0.0.1:8000/. Until a build exists we fall back to the legacy
# page in web/ rather than serving nothing.
WEB_DIR = _ROOT / "dist"
LEGACY_WEB_DIR = _ROOT / "web"
if not (WEB_DIR / "index.html").exists():
    WEB_DIR = LEGACY_WEB_DIR

# view axis key -> canonical seat attribute (mm/deg) and conversion
SEAT_AXES = {"slider_mm": "slider_mm", "height_mm": "height_mm",
             "recline_deg": "recline_deg", "rotation_deg": "rotation_deg"}


class Handler(BaseHTTPRequestHandler):
    # ---- helpers ---------------------------------------------------------

    @property
    def engine(self):
        return self.server.engine

    def _json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send(self, path, content_type):
        try:
            body = path.read_bytes()
        except OSError:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    CONTENT_TYPES = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml", ".png": "image/png",
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".webp": "image/webp", ".ico": "image/x-icon",
        ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
        ".woff2": "font/woff2",
    }

    def _serve_static(self, rel):
        """Hand out a file from WEB_DIR (the built sim), never outside it."""
        root = WEB_DIR.resolve()
        try:
            target = (root / rel.lstrip("/")).resolve()
            target.relative_to(root)          # no path traversal
        except (ValueError, OSError):
            self.send_error(404)
            return
        if target.is_dir():
            target = target / "index.html"
        ctype = self.CONTENT_TYPES.get(target.suffix.lower(),
                                       "application/octet-stream")
        self._send(target, ctype)

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            data = json.loads(raw.decode("utf-8") or "{}")
            return data if isinstance(data, dict) else {}
        except (ValueError, UnicodeDecodeError):
            return {}

    def log_message(self, *args):  # keep the console clean
        pass

    # ---- GET --------------------------------------------------------------

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if not path.startswith("/api/"):
            # the view itself: the built cockpit from dist/ (or legacy web/)
            rel = "index.html" if path in ("/", "/index.html") else path
            self._serve_static(rel)
            return
        if path == "/api/state":
            self._json(self.engine.session.state())
        elif path == "/api/snapshot":
            self._json(build_snapshot(self.engine))
        elif path == "/api/prompt":
            with self.engine.session._lock:
                st = prompt_files.status(self.engine.session)
                # the persona-guard toggle rides along: the prompt panel's
                # button paints from the same payload it already fetches
                st["persona_guard"] = getattr(self.engine.session,
                                              "persona_guard", True)
                self._json(st)
        else:
            self.send_error(404)

    # ---- POST -------------------------------------------------------------

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        data = self._read_json()

        if path == "/api/chat":
            if data.get("clear"):
                engine = self.engine
                engine.session.mind.chat.clear()
                self._json({"ok": True, "history": []})
                return
            session = self.engine.session
            # lock: the ticker may be deliberating (LLM call) on the same mind
            with session._lock:
                result = session.mind.chat_send(data.get("text", ""))
            if result.get("ok") and isinstance(result.get("state"), dict):
                # legacy hook shape: state.trustScore was the questionnaire score
                from .schema import _mdmt_score
                score = _mdmt_score(session.questionnaire)
                result["state"]["trustScore"] = (score if score is not None
                                                 else round(result["state"]["trust"], 4))
            self._json(result, 200 if result.get("ok") else 400)

        elif path == "/api/seat":
            self._set_seat(data)

        elif path == "/api/entered":
            # the view's avatar just sat down in the seat: greet like a human
            # (LLM line, phrase-bank fallback) — same lock as chat, the ticker
            # may be deliberating on the same mind
            session = self.engine.session
            with session._lock:
                session.mind.greet()
                speech = session.mind.speech
            self._json({"ok": True, "speech": speech})

        elif path == "/api/control":
            self._control(data)

        elif path == "/api/prompt":
            # two buttons: {"text"} saves the panel's edit to the source
            # file and applies it, {"file"} switches to a named file, no
            # payload = the legacy cycle click (cabin_sim/prompts.py)
            session = self.engine.session
            kind = data.get("kind")
            kind = kind if isinstance(kind, str) else ""
            try:
                with session._lock:
                    if isinstance(data.get("file"), str):
                        result = prompt_files.select(session, kind,
                                                     data["file"])
                    elif isinstance(data.get("text"), str):
                        result = prompt_files.save(session, kind,
                                                   data["text"])
                    else:
                        result = prompt_files.cycle(session, kind)
                self._json(result, 200 if result.get("error") is None else 400)
            except ValueError as exc:        # an unusable persona file: 400,
                self._json({"ok": False,  # never a dead ticker
                            "error": str(exc)}, 400)

        else:
            self.send_error(404)

    def _control(self, data):
        engine = self.engine
        if data.get("reset"):
            # rebuild session + engine from the same persona/provider/seed
            from .session import Session
            from .sim import SimEngine
            old = engine.session
            fresh = Session(old.persona, old.agent.provider,
                            max_steps=old.max_steps,
                            step_interval=old.step_interval,
                            duration=old.duration, seed=engine.seed,
                            reasoning=getattr(old, "reasoning", "auto"),
                            # rebuild the SAME setup: hybrid chat backend and
                            # persona-guard state are session properties, not
                            # something to silently drop on restart
                            chat_provider=getattr(old, "chat_provider", None),
                            persona_guard=getattr(old, "persona_guard", True),
                            environment=getattr(old, "environment_text", None),
                            environment_path=getattr(old, "environment_path",
                                                     None),
                            persona_path=getattr(old, "persona_path", None))
            self.server.engine = SimEngine(
                fresh, seed=engine.seed, tick_dt=engine.tick_dt,
                ride_start=engine.ride_start, priors_path=engine.priors_path)
            self._json({"ok": True, "reset": True})
            return
        if data.get("advance") == "ride":
            # fast-forward through the setup phase (the old "skip" button)
            limit = 0
            while (not engine.done and engine.t < engine.mind.ride_start
                   and limit < 400):
                engine.tick(1)
                limit += 1
            self._json({"ok": True, "t": engine.t})
            return
        if "persona_guard" in data:
            # the persona-guard button: ON = the persona hears chat
            # meta-instructions as words, OFF = the experimenter decides
            on = bool(data.get("persona_guard"))
            session = engine.session
            with session._lock:
                session.persona_guard = on
                if session.reasoner is not None:
                    session.reasoner.set_persona_guard(on)
                session.mind.log_line(
                    "ctrl", f"persona guard {'on' if on else 'off'}")
            self._json({"ok": True, "persona_guard": on})
            return
        running = bool(data.get("running", engine.running))
        engine.running = running
        self._json({"ok": True, "running": running})

    def _set_seat(self, data):
        """Set one seat axis in canonical units and mark 'human hands'."""
        alias = {"rot": "rotation_deg", "hgt": "height_mm",
                 "sl": "slider_mm", "rec": "recline_deg"}
        axis = str(data.get("axis", ""))
        attr = SEAT_AXES.get(axis) or SEAT_AXES.get(alias.get(axis, ""))
        value = data.get("value")
        if attr is None or not isinstance(value, (int, float)):
            self._json({"ok": False, "error": "unknown axis"}, 400)
            return
        engine = self.engine
        session = engine.session
        view_axis = {"rotation_deg": "rot", "height_mm": "hgt",
                     "slider_mm": "sl", "recline_deg": "rec"}[attr]
        with session._lock:
            seat = session.cabin.seat
            delta = int(round(value)) - getattr(seat, attr)
            seat.move(attr, delta)          # clamps through Seat's own bounds
            session.note_user_input(view_axis)
            session.mind.log_line("adj", f"{attr} → {getattr(seat, attr)}")
        self._json({"ok": True, "seat": session.cabin.to_dict()["seat"]})


def serve(engine, port=8000, interval=1.2):
    """Serve the pages and step the engine every ``interval`` wall seconds."""
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    httpd.engine = engine
    stop = threading.Event()

    def ticker():
        # reads httpd.engine every pass so POST /api/control {"reset": true}
        # can swap in a fresh engine while the ticker keeps running
        while not stop.is_set():
            eng = httpd.engine
            if eng.running and not eng.done:
                eng.tick(1)
            time.sleep(interval)

    thread = threading.Thread(target=ticker, daemon=True)
    thread.start()
    try:
        httpd.serve_forever()
    finally:
        stop.set()
        thread.join(timeout=2)
