# Python-authoritative phase — migration boundary & minimal contract

Status: **port landed**. The cognitive core from `src/cognitive.js` now lives in
`cabin_sim/cognition.py` (`Mind`), driven by `cabin_sim.sim.SimEngine` and published
through `cabin_sim/schema.py`. The three.js page is a **view adapter**: it polls
`GET /api/snapshot`, forwards input (`POST /api/seat`) and chat (`POST /api/chat`),
and runs no reasoning of its own (the pre-port mind is archived at
`src/cognitive.legacy.js`). Covered by deterministic tests (`python -m pytest tests -q`).

## Ownership

| Layer | Owns | Files |
|---|---|---|
| Core (authoritative) | world state, action gate, persona, MDMT, **BDI/mood/memory/trust/ride/chat** | `cabin_sim/world.py`, `actions.py`, `agent.py`, `provider.py`, `session.py`, `questionnaire.py`, **`cognition.py`** |
| Clock + contract | sim time `t`, phase machine, seeded rng, canonical snapshot, priors file | `cabin_sim/sim.py`, `cabin_sim/schema.py` |
| Reasoning | who words/chooses: LLM among Python-legal goals, rules fallback, validation | `cabin_sim/reasoning.py` |
| Transport | stdlib HTTP: `/`, `/api/state`, `/api/snapshot`, `/api/chat`, `/api/seat`, `/api/control` + ticker thread | `cabin_sim/server.py` |
| View | rendering/interpolation only — draws the snapshot, POSTs input | `src/cognitive.js` (adapter), `cabin.js`, `avatar.js`, `ui.js`, `main.js`, `index.html` |

## Boundary rules

1. **Only `SimEngine` advances the sim clock and steps the core.** The server's
   ticker thread calls `engine.tick(1)`; never wall-clock time, never the browser.
2. **`schema.build_snapshot` is the only snapshot producer.** The view consumes
   the schema shape; it never reads `world`/`agent`/`session` internals.
3. **Determinism is guaranteed for `--provider scripted` only.** All randomness is
   seeded (`Session(seed=…)` → `Mind.rng`, plus `engine.rng`); snapshot building
   consumes no randomness. LLM paths are non-deterministic by nature.
4. **JSON is the only config/transport encoding.** Persona JSON stays; snapshots
   and API bodies are JSON.
5. **The view never decides.** `src/cognitive.js` may compute display-only
   figures (rate-table gauges, timeline markers, fit text) but nothing it
   computes feeds back into state — input goes through `POST /api/seat`, which
   is clamped by `world.Seat` and marks `belief.user_hands` in the mind.
6. **The LLM chooses and words, never owns state.** `reasoning.py` receives
   only Python-legal options (cooldowns/preconditions applied in `cognition`)
   plus a read-only STATE line built from the mind. An illegal intention, bad
   JSON, empty line, rate limit or network error falls back to the rule answer
   for that tick. `--reasoning auto` resolves to **rules** whenever the
   provider is scripted, so pytest snapshots stay byte-identical.

## Canonical units

Millimetres for slide/height, degrees for recline/rotation (matches `world.Seat`).
**Seat model (updated in the port): full swivel `rotation_deg` 0..359 (clamped,
no wrap — the seam at 0/359 stops travel) and `height_mm` 380..460 (38..46 cm,
matching the cognitive.js `hgt` axis); swivel self-adjust moves in 10° steps**
(the same human-sized step the JS used). `schema.SEAT_AXES` / `SEAT_LIMITS` mirror
`world.Seat` and are drift-guarded by `tests/test_world.py`. The view converts for
display only (mm→cm, centre-offset slide) — it never redefines state.

## Step model

- One decision step (`session.step_once()`) advances `engine.t` **and** `mind.t`
  by `tick_dt` (default 1.0; CLI default 2.0 so 300 steps cover the 600 s ride).
- Phases: `setup` → `ride` (`t >= ride_start`, default 120) → `done` (session
  finished + questionnaire administered). The mind's own phase gate
  (`Mind.phase`) drives the `calibrate` goal the same way.
- Ride events fire from `cognition.EVENTS` (t = 121…590), advance-safe: a big
  `tick_dt` still fires each event exactly once.

## Port backlog from cognitive.js — DONE

| Slot | Schema field | Ported to |
|---|---|---|
| ride dynamics (EVENTS) | `ride.{speed,g,jolt,rain}` | `cognition.EVENTS` + `Mind.perceive_event` / `Mind.step` |
| BDI intention | `agent.intention` (+ `agent.intentionSince`) | `BDI_GOALS` → `Mind._desire`/`_pre`/`bdi_reason`, cooldowns 9 / 3.2 / 10 s |
| thoughts queue | `agent.thoughts` | `THOUGHTS` + `Mind.think` (cap 3) |
| live trust value | `agent.trust.live` | `Mind.trust_value` (MDMT stays the canonical end score in `trust.score`) |
| memory / forgot | `agent.memory`, `agent.forgot`, `agent.forgotCount` | `cognition.Memory` (λ=0.004, floor 0.09, cap 8, rehearsal +0.22) |
| mood dynamics | `agent.mood` | `Mind.step` (comfort target, suspicion set-point, event impulses) |
| seat self-adjust | (writes `world.seat`) | `Mind.self_adjust` via whitelisted `actions.apply` |
| experimenter chat | `agent.chat` | `Mind.chat_send` + `POST /api/chat` (legacy hook shape kept) |
| priors persistence | `priors` | JSON file via `SimEngine(priors_path=…)` (opt-in, no side effects in tests) |
| samples/trail (summary charts) | `agent.samples`, `agent.trail` | `Mind.sample` every ~3 s |
| persona display prefs | `agent.prefs` | `Mind` target/tolerance (view renders gauges from it) |
| actor itinerary | *(view-owned; not in authoritative schema)* | `avatar.js` waypoints stay visual |
| reasoning (intention / thought / chat voice) | `agent.reasoning` | `cabin_sim/reasoning.py` — LLM behind `provider.complete()`, opt-in via `--reasoning`, rules fallback |

## Tests & commands

```bash
.venv\Scripts\activate
python -m pytest tests -q          # deterministic, no network (scripted only)
python -m cabin_sim.main --steps 300 --seed 1 --provider scripted --headless --tick-dt 2.0
python -m cabin_sim.main --server --provider groq     # DEFAULT (.env): Groq free tier, ~300 ms/call
python -m cabin_sim.main --server --provider ollama   # offline fallback: local Qwen 3 (think off)
# hybrid split (optional): CHAT_MODEL=<bigger model> writes experimenter chat
# on a second backend while OLLAMA_MODEL keeps driving the ticks
python -m cabin_sim.main --server --reasoning rules   # force deterministic reasoning
npm run dev                        # view on :5173, /api proxied to :8000
npm run build                      # production bundle in dist/
```
