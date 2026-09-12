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

    def __init__(self):
        import httpx

        self.client = httpx.Client(base_url="https://api.groq.com/openai/v1")
        self.key = os.environ["GROQ_API_KEY"]
        self.model = os.environ.get("GROQ_MODEL", "llama-3.1-8b-instant")

    def complete(self, messages):
        resp = self.client.post(
            "/chat/completions",
            headers={"Authorization": f"Bearer {self.key}"},
            json={
                "model": self.model,
                "messages": messages,
                "temperature": 0.7,
                "max_tokens": 240,
            },
            timeout=60,
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]


class OllamaProvider:
    """Fully local inference via Ollama (docker or ollama.com), no key needed."""

    name = "ollama"

    def __init__(self):
        import httpx

        base = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
        self.client = httpx.Client(base_url=base)
        self.model = os.environ.get("OLLAMA_MODEL", "llama3.2")

    def complete(self, messages):
        resp = self.client.post(
            "/api/chat",
            json={"model": self.model, "messages": messages, "stream": False},
            timeout=120,
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


def create_provider(name=None):
    name = (name or os.environ.get("LLM_PROVIDER", "scripted")).lower()
    if name == "groq":
        if not os.environ.get("GROQ_API_KEY"):
            print("No GROQ_API_KEY set - using the scripted provider.", file=sys.stderr)
        else:
            return GroqProvider()
    if name == "ollama":
        try:
            return OllamaProvider()
        except Exception as exc:  # noqa: BLE001 - surface and fall through
            print(f"Could not start Ollama provider ({exc}) - using scripted.",
                  file=sys.stderr)
    elif name != "scripted":
        print(f"Unknown provider '{name}' - using the scripted provider.",
              file=sys.stderr)
    return ScriptedProvider()