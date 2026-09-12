"""A tiny stdlib HTTP server: the browser page + the live state feed.

It deliberately uses only the standard library so there is no web
framework to learn. Two endpoints:

  /            the SVG visual (web/index.html)
  /api/state   JSON snapshot of the running session (polled each second)
"""

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            self._send(WEB_DIR / "index.html", "text/html; charset=utf-8")
        elif path == "/api/state":
            body = json.dumps(self.server.session.state()).encode("utf-8")
            self._send_bytes(body, "application/json; charset=utf-8")
        else:
            self.send_error(404)

    def _send(self, path, content_type):
        try:
            body = path.read_bytes()
        except OSError:
            self.send_error(404)
            return
        self._send_bytes(body, content_type)

    def _send_bytes(self, body, content_type):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # keep the console clean
        pass


def serve(session, port=8000):
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    httpd.session = session
    session.start()
    httpd.serve_forever()