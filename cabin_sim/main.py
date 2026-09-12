"""Entry point.

Not running a template: this is the CLI of the sim.

  python -m cabin_sim.main                  # browser view on :8000
  python -m cabin_sim.main --steps 40       # headless run, prints the log
  python -m cabin_sim.main --persona personas/phill.json --provider groq
"""

import argparse
import json
import sys
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent


def _parse(argv):
    parser = argparse.ArgumentParser(description="Cabin Agent Sim")
    parser.add_argument("--persona", default="personas/phill.json",
                        help="path to a persona JSON file")
    parser.add_argument("--provider", default=None,
                        help="groq | ollama | scripted (default: from .env)")
    parser.add_argument("--steps", type=int, default=300,
                        help="decision steps per session (server) or total (headless)")
    parser.add_argument("--interval", type=float, default=1.2,
                        help="seconds between decisions in the browser run")
    parser.add_argument("--seed", type=int, default=1,
                        help="random seed for reproducible runs")
    parser.add_argument("--port", type=int, default=8000,
                        help="port for the browser view")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--headless", action="store_true",
                       help="run N steps and print, without a browser")
    group.add_argument("--server", action="store_true",
                       help="explicitly start the browser view (default)")
    return parser.parse_args(argv)


def _load_persona(path):
    resolved = Path(path)
    if not resolved.is_absolute():
        resolved = ROOT / resolved
    with open(resolved, encoding="utf-8") as fh:
        return json.load(fh)


def main(argv=None):
    args = _parse(argv)
    load_dotenv()

    persona = _load_persona(args.persona)
    from .provider import create_provider

    provider = create_provider(args.provider)
    print(f"Persona: {persona['name']}   Provider: {provider.name}", flush=True)

    from .session import Session

    session = Session(persona, provider, max_steps=args.steps,
                      step_interval=args.interval, seed=args.seed)

    if args.headless:
        _run_headless(session)
        return 0

    from .server import serve

    url = f"http://127.0.0.1:{args.port}"
    print(f"Open {url} in your browser. (Ctrl+C to stop)", flush=True)
    try:
        serve(session, args.port)
    except KeyboardInterrupt:
        pass
    return 0


def _run_headless(session):
    session.note("session_start", persona=session.persona["name"])
    for _ in range(session.max_steps):
        session.step_once()
    session.finish()

    for entry in session.log:
        print(json.dumps(entry, ensure_ascii=False))

    print("\n--- summary ---")
    print(f"actions succeeded: {session.agent.succeeded}   "
          f"blocked: {session.agent.blocked}")
    print("final cabin:", json.dumps(session.cabin.to_dict()))
    if session.questionnaire:
        q = session.questionnaire
        print("\n", q["scale"])
        print("subscales:", q["subscales"])
        print("factors:  ", q["factors"])


if __name__ == "__main__":
    sys.exit(main())