from __future__ import annotations
"""Environment-backed configuration for the local Ollama client."""

from dataclasses import dataclass
import math
import os


DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434"
DEFAULT_OLLAMA_TIMEOUT = 180.0


@dataclass(frozen=True)
class OllamaConfig:
    """Validated settings needed to construct an Ollama client."""

    base_url: str
    model: str
    timeout: float


def load_ollama_config() -> OllamaConfig:
    """Load and validate Ollama client settings from the environment."""

    base_url = os.environ.get("AIKAVACH_OLLAMA_URL", DEFAULT_OLLAMA_URL)
    model = os.environ.get("AIKAVACH_OLLAMA_MODEL", "").strip()
    if not model or model == "<model-name>":
        raise ValueError("AIKAVACH_OLLAMA_MODEL must name an installed local model")

    timeout_value = os.environ.get(
        "AIKAVACH_OLLAMA_TIMEOUT", str(DEFAULT_OLLAMA_TIMEOUT)
    )
    try:
        timeout = float(timeout_value)
    except ValueError as exc:
        raise ValueError(
            "AIKAVACH_OLLAMA_TIMEOUT must be a finite number greater than zero"
        ) from exc
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError(
            "AIKAVACH_OLLAMA_TIMEOUT must be a finite number greater than zero"
        )

    return OllamaConfig(base_url=base_url, model=model, timeout=timeout)


def format_ollama_diagnostics(config: OllamaConfig) -> str:
    """Render non-secret Ollama settings for CLI diagnostics."""

    return "\n".join(
        [
            f"Ollama model: {config.model}",
            f"Ollama endpoint: {config.base_url}",
            f"Ollama timeout: {config.timeout}s",
        ]
    )
