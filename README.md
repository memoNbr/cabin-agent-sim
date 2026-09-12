# cabin-agent-sim

A tiny learning project: a **cognitive agent with a persona** sits down
inside an **automated car interior** — movable seat, head-up display,
vending machine, no steering wheel, a foldable table — and plays with it,
step by step, for a short session. At the end the persona answers a
standardized **trust questionnaire** (the MDMT).

The intuition you can test here: give the same cabin to different
personas and watch their behaviour and their trust answers change.
Editing a persona is editing one JSON file — the agent code stays the same.

## How it works

**Agent loop (light BDI):**

1. **Perceive** — reads the cabin state and its own mood (comfort, energy, suspicion).
2. **Reason** — an LLM prompted with the persona answers *"as this person, what do I do next?"* with one JSON decision; without a key, a deterministic scripted fallback plays the same role.
3. **Validate** — the chosen action is checked against a whitelist; the cabin clamps every change, so nothing can go out of bounds.
4. **Act + narrate** — the action is applied, mood updates, and the persona's words show in the browser.

**Trust questionnaire** — at the end of the session the persona rates the
automated cabin on the 16-item MDMT:

| Subscale | Items |
| --- | --- |
| Reliable | reliable, predictable, someone you can count on, consistent |
| Capable | capable, skilled, competent, meticulous |
| Ethical | ethical, respectable, principled, has integrity |
| Sincere | sincere, genuine, candid, authentic |

Each item 0 (not at all) to 7 (very), with an optional "Does Not Fit"
(treated as missing). Subscale score = mean; **Capacity trust** =
mean(Reliable, Capable), **Moral trust** = mean(Ethical, Sincere).

## Quick start

```bash
python -m venv .venv
.venv\Scripts\activate            # Windows (macOS/Linux: source .venv/bin/activate)
pip install -r requirements.txt

python -m cabin_sim.main          # opens the browser view on http://127.0.0.1:8000
```

Then open http://127.0.0.1:8000 and watch the persona iterate.

Headless run (no browser) for quick checks:

```bash
python -m cabin_sim.main --steps 40
```

## Using a real LLM (free + fast)

Edit `.env` (copy from `.env.example`):

```ini
# Free, small and very fast cloud model
LLM_PROVIDER=groq
GROQ_API_KEY=your_key             # free at console.groq.com

# OR fully local, no key
LLM_PROVIDER=ollama
OLLAMA_MODEL=llama3.2
```

Provider is picked from `--provider`, then `.env`. Unknown or missing
config never breaks a run — it falls back to the scripted provider.

## Personas

`personas/phill.json` ships as the first persona: *Phill, 33, entry-level
officer from Aachen, married, no kids, weekend commute, first time in a
highly automated interior.* Introvert, suspicious, confident, uninterested
in the car — he wants a functional neutral seat and to get somewhere.

A persona file holds: name, background story, traits, preferred seat
settings + tolerance, starting mood (energy, suspicion), vending interest
and curiosity. Copy the file, change the numbers and the story, and run
`python -m cabin_sim.main --persona personas/you.json` to try it out.

## Project layout

```
cabin_sim/
  world.py          car interior: Seat + VendingMachine + Table (pure state)
  actions.py        the agent's action whitelist; every change is clamped
  agent.py          perceive -> reason -> validate -> act  (persona-aware)
  provider.py       groq | ollama | scripted fallback
  questionnaire.py  MDMT (16 items, 4 subscales, scoring)
  session.py        1 session = timed decisions + end-of-session questionnaire
  server.py         stdlib HTTP: the page + /api/state feed
  main.py           CLI
web/index.html      the browser visual (inline SVG, polls /api/state)
personas/           editable persona JSON files
```

## References

- Ullman, D., & Malle, B. F. (2019). Measuring gains and losses in
  human-robot trust: Evidence for differentiable components of trust.
  In *Proceedings of the 14th ACM/IEEE International Conference on
  Human-Robot Interaction (HRI '19)*, 618–619. https://doi.org/10.1145/3319502.3374821
- Malle, B. F., & Ullman, D. (2021). A multidimensional conception and
  measure of human-robot trust. In *Trust in Human-Robot Interaction*
  (pp. 3–25). Academic Press. https://doi.org/10.1016/B978-0-12-819472-0.00001-0
- Ullman, D., & Malle, B. F. (2018). What does it mean to trust a robot?
  Steps toward a multidimensional measure of trust. In *Companion of the
  ACM/IEEE International Conference on Human-Robot Interaction (HRI '18)*,
  263–264. https://doi.org/10.1145/3173386.3176991
  (Source of the scale items: https://research.clps.brown.edu/SocCogSci/Measures)