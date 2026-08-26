"""Tests for environment-backed Ollama configuration."""

import pytest

from crs.reasoning.ollama_config import (
    DEFAULT_OLLAMA_URL,
    OllamaConfig,
    format_ollama_diagnostics,
    load_ollama_config,
)


def test_load_ollama_config_uses_defaults(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AIKAVACH_OLLAMA_MODEL", "local-model")
    monkeypatch.delenv("AIKAVACH_OLLAMA_URL", raising=False)
    monkeypatch.delenv("AIKAVACH_OLLAMA_TIMEOUT", raising=False)

    assert load_ollama_config() == OllamaConfig(
        base_url=DEFAULT_OLLAMA_URL,
        model="local-model",
        timeout=180.0,
    )


def test_load_ollama_config_reads_all_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AIKAVACH_OLLAMA_URL", "http://localhost:11434")
    monkeypatch.setenv("AIKAVACH_OLLAMA_MODEL", "custom-model")
    monkeypatch.setenv("AIKAVACH_OLLAMA_TIMEOUT", "45.5")

    assert load_ollama_config() == OllamaConfig(
        base_url="http://localhost:11434",
        model="custom-model",
        timeout=45.5,
    )


def test_format_ollama_diagnostics_contains_only_non_secret_settings() -> None:
    config = OllamaConfig(
        base_url="http://127.0.0.1:11434", model="local-model", timeout=180.0
    )

    assert format_ollama_diagnostics(config) == "\n".join(
        [
            "Ollama model: local-model",
            "Ollama endpoint: http://127.0.0.1:11434",
            "Ollama timeout: 180.0s",
        ]
    )


@pytest.mark.parametrize(
    "value", ["not-a-number", "0", "-1", "nan", "inf", "-inf"]
)
def test_load_ollama_config_rejects_invalid_timeout(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    monkeypatch.setenv("AIKAVACH_OLLAMA_MODEL", "local-model")
    monkeypatch.setenv("AIKAVACH_OLLAMA_TIMEOUT", value)

    with pytest.raises(ValueError, match="AIKAVACH_OLLAMA_TIMEOUT"):
        load_ollama_config()
