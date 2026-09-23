"""LLM backends.

All providers share one tiny interface: complete(messages) -> text.
Two real backends (Groq, Ollama) and a deterministic 'scripted' stand-in so
the sim always runs, even with no API key and no local model installed.

Pick the backend with create_provider(): it honours --provider, then
.env's LLM_PROVIDER, and it never fails - unknown or missing config falls
back to the scripted provider with a warning.
"""

import os
import sys


class GroqProvider:
    """Free cloud inference (console.groq.com). Default small, fast model."""

    name = "groq"

    def __init__(self, model=None):
        import httpx

        self.client = httpx.Client(base_url="https://api.groq.com/openai/v1")
        self.key = os.environ["GROQ_API_KEY"]
        self.model = model or os.environ.get("GROQ_MODEL", "allam-2-7b")

    def complete(self, messages):
        payload = {
            "model": self.model,
            "messages": messages,
            "temperature": 0.7,
        }
        # Reasoning models (gpt-oss, qwen3, …) think before they answer: cap
        # the effort and give the completion its own budget, or the thinking
        # eats `max_tokens` and `content` comes back empty (observed: every
        # deliberate call). Legacy models reject these params (400), so they
        # keep the plain field.
        if self.model.startswith(("openai/", "qwen/")):
            payload["reasoning_effort"] = "low"
            payload["include_reasoning"] = False
            payload["max_completion_tokens"] = 512
        else:
            payload["max_tokens"] = 240
        resp = self.client.post(
            "/chat/completions",
            headers={"Authorization": f"Bearer {self.key}"},
            json=payload,
            timeout=60,
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]


class OllamaProvider:
    """Fully local inference via Ollama (docker or ollama.com), no key needed."""

    name = "ollama"

    def __init__(self, model=None, keep_alive=None):
        import httpx

        base = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
        self.client = httpx.Client(base_url=base)
        self.model = model or os.environ.get("OLLAMA_MODEL", "llama3.2")
        # seconds the weights stay resident after a call (None = Ollama's
        # default 5 min). The hybrid CHAT provider sets a short one so its
        # model leaves 16 GB-box RAM soon after the experimenter stops typing.
        self.keep_alive = keep_alive

    def complete(self, messages):
        # num_ctx caps the KV cache: 8b @ the default 4096 ctx allocates
        # ~1.2 GB of RAM this 16 GB box does not have to spare; 1536 fits
        # every prompt with ~0.75 GB saved. Generation speed is model-bound,
        # not ctx-bound, so nothing is lost but RAM.
        num_ctx = int(os.environ.get("OLLAMA_NUM_CTX", "1536"))
        # Qwen3-family models 'think' before answering; unbounded on a
        # CPU-only box that meant minutes per call (measured: 19 s of
        # thinking for zero output vs 0.75 s with it off). Off by default;
        # OLLAMA_THINK=1 re-enables it on hardware that can afford it.
        think = os.environ.get("OLLAMA_THINK", "0").lower() in ("1", "true", "yes")
        # hard cap on generated tokens so a runaway reply stalls one tick
        # at worst; over-long/garbled JSON degrades to rules (never crashes).
        num_predict = int(os.environ.get("OLLAMA_NUM_PREDICT", "160"))
        body = {"model": self.model, "messages": messages, "stream": False,
                "think": think,
                "options": {"num_ctx": num_ctx, "num_predict": num_predict}}
        if self.keep_alive is not None:
            body["keep_alive"] = self.keep_alive
        resp = self.client.post(
            "/api/chat",
            json=body,
            timeout=300,   # 8b on CPU: one call can legitimately take minutes
        )
        resp.raise_for_status()
        return resp.json()["message"]["content"]


class ScriptedProvider:
    """Deterministic stand-in: never calls a network, always replies.

    Actual decisions are produced by cabin_sim.agent.scripted_decision().
    """

    name = "scripted"

    def complete(self, messages):  # noqa: ARG002 - kept for interface parity
        from .agent import scripted_decision

        return scripted_decision(self.agent)

    def attach(self, agent):
        self.agent = agent


def create_provider(name=None, model=None, keep_alive=None):
    """Build a backend. `model` overrides its default so split setups work:
    hybrid = small/fast model drives ticks, a bigger one writes chat."""
    name = (name or os.environ.get("LLM_PROVIDER", "scripted")).lower()
    if name == "groq":
        if not os.environ.get("GROQ_API_KEY"):
            print("No GROQ_API_KEY set - using the scripted provider.", file=sys.stderr)
        else:
            return GroqProvider(model=model)
    if name == "ollama":
        try:
            return OllamaProvider(model=model, keep_alive=keep_alive)
        except Exception as exc:  # noqa: BLE001 - surface and fall through
            print(f"Could not start Ollama provider ({exc}) - using scripted.",
                  file=sys.stderr)
    elif name != "scripted":
        print(f"Unknown provider '{name}' - using the scripted provider.",
              file=sys.stderr)
    return ScriptedProvider()