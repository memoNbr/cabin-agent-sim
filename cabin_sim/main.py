"""Entry point.

Not running a template: this is the CLI of the sim.

  python -m cabin_sim.main                  # browser view on :8000
  python -m cabin_sim.main --duration 300   # 5-minute browser session
  python -m cabin_sim.main --steps 40       # headless run, prints the log
  python -m cabin_sim.main --persona personas/phill.py --provider groq
"""

import argparse
import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent


def _parse(argv):
    parser = argparse.ArgumentParser(description="Cabin Agent Sim")
    parser.add_argument("--persona", default="personas/phill.py",
                        help="path to a persona file (.py with PERSONA = {...} "
                             "or .json)")
    parser.add_argument("--provider", default=None,
                        help="groq | ollama | scripted (default: from .env)")
    parser.add_argument("--reasoning", default="auto",
                        choices=["auto", "rules", "llm"],
                        help="who reasons: auto = LLM when the provider is "
                             "groq/ollama, rules = deterministic phrase banks "
                             "(tests), llm = force the model")
    parser.add_argument("--chat-model", default=None,
                        help="model used ONLY for experimenter chat replies "
                             "(default: .env CHAT_MODEL; unset = same model as "
                             "ticks) — hybrid: fast model ticks, big model chats")
    parser.add_argument("--steps", type=int, default=None,
                        help="decision steps: total for --headless (default "
                             "300 = the full ride); safety cap for the "
                             "browser session (default: unlimited — the mind "
                             "keeps working until you press restart; 300 = "
                             "the designed ~6-min ride with questionnaire)")
    parser.add_argument("--interval", type=float, default=1.2,
                        help="seconds between decisions in the browser run")
    parser.add_argument("--duration", type=float, default=300.0,
                        help="inert: browser session length is governed by "
                             "--steps (kept for compatibility)")
    parser.add_argument("--seed", type=int, default=1,
                        help="random seed for reproducible runs")
    parser.add_argument("--port", type=int, default=8000,
                        help="port for the browser view")
    parser.add_argument("--tick-dt", type=float, default=2.0,
                        help="sim seconds per decision step (default 2.0: "
                             "300 steps cover the 600 s ride script)")
    parser.add_argument("--ride-start", type=float, default=120.0,
                        help="sim second the ride phase begins")
    parser.add_argument("--priors", default=None,
                        help="path to a priors JSON (persisted between rides)")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--headless", action="store_true",
                       help="run N steps and print, without a browser")
    group.add_argument("--server", action="store_true",
                       help="explicitly start the browser view (default)")
    return parser.parse_args(argv)


def _load_persona(path):
    from . import prompts as prompt_files   # .py (PERSONA = {...}) or .json
    return prompt_files.load_persona(prompt_files.resolve(path))


UNLIMITED_STEPS = 10 ** 9


def _resolve_steps(headless, steps):
    """--steps semantics: explicit >0 wins; otherwise the headless default
    is 300 (the full 600 sim-s ride) and the BROWSER default is unlimited —
    a browser session must never silently freeze at a step cap while the
    experimenter is still chatting with it (the old default, 300 steps,
    stopped the ticker after ~6 wall-minutes mid-conversation)."""
    if steps and steps > 0:
        return steps
    return 300 if headless else UNLIMITED_STEPS


def main(argv=None):
    args = _parse(argv)
    load_dotenv()

    steps = _resolve_steps(args.headless, args.steps)
    persona = _load_persona(args.persona)
    from .provider import create_provider

    provider = create_provider(args.provider)
    print(f"Persona: {persona['name']}   Provider: {provider.name}", flush=True)

    # hybrid: an optional second backend whose model answers ONLY experimenter
    # chat (default .env CHAT_MODEL); ticks/deliberation keep `provider`.
    chat_model = args.chat_model or os.environ.get("CHAT_MODEL")
    chat_provider = None
    if (chat_model and provider.name != "scripted"
            and chat_model != getattr(provider, "model", None)):
        keep_alive = (int(os.environ.get("CHAT_OLLAMA_KEEP_ALIVE", "120"))
                      if provider.name == "ollama" else None)
        chat_provider = create_provider(args.provider, model=chat_model,
                                        keep_alive=keep_alive)

    from . import prompts as prompt_files
    from .session import Session

    env_path, env_text = prompt_files.default_environment()
    session = Session(persona, provider, max_steps=steps,
                      step_interval=args.interval, duration=args.duration,
                      seed=args.seed, reasoning=args.reasoning,
                      chat_provider=chat_provider,
                      environment=env_text,
                      environment_path=str(env_path) if env_path else None,
                      persona_path=str(prompt_files.resolve(args.persona)))
    mode = session.reasoner.kind if session.reasoner else "rules"
    if chat_provider is not None and session.reasoner is not None:
        mode += f"   chat: {chat_model}"
    print(f"Reasoning: {mode}", flush=True)
    if session.environment_path:
        print(f"Environment prompt: {session.environment_path}", flush=True)

    from .sim import SimEngine

    engine = SimEngine(session, seed=args.seed, tick_dt=args.tick_dt,
                       ride_start=args.ride_start,
                       priors_path=args.priors)

    if args.headless:
        _run_headless(engine)
        return 0

    from .server import serve

    url = f"http://127.0.0.1:{args.port}"
    cap = ("unlimited" if steps >= UNLIMITED_STEPS
           else f"{steps} steps ({steps * args.tick_dt:g} sim-s)")
    session_txt = f"Session: {cap}."   # the ride script itself ends at 600 s
    print(f"Open {url} in your browser. {session_txt} "
          f"(Ctrl+C to stop)", flush=True)
    try:
        serve(engine, args.port, interval=args.interval)
    except KeyboardInterrupt:
        pass
    return 0


def _run_headless(engine):
    session = engine.session
    session.note("session_start", persona=session.persona["name"])
    engine.run()

    for entry in session.log:
        print(json.dumps(entry, ensure_ascii=False))

    snap = engine.snapshot()
    print("\n--- summary ---")
    print(f"actions succeeded: {session.agent.succeeded}   "
          f"blocked: {session.agent.blocked}")
    print(f"phase: {snap['phase']}   t: {snap['t']}s   "
          f"intention: {snap['agent']['intention']}")
    print(f"reasoning: {snap['agent']['reasoning']}   "
          f"trust live: {snap['agent']['trust']['live']}   "
          f"mood: {json.dumps(snap['agent']['mood'])}")
    print(f"ride: {json.dumps(snap['ride'])}   "
          f"memory: {len(snap['agent']['memory'])} traces")
    print("final cabin:", json.dumps(session.cabin.to_dict()))
    if session.questionnaire:
        q = session.questionnaire
        print("\n", q["scale"])
        print("subscales:", q["subscales"])
        print("factors:  ", q["factors"])


if __name__ == "__main__":
    sys.exit(main())