"""Offline tests for the manual Ollama entry point."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from crs.reasoning import ollama_demo


def test_ollama_demo_forwards_configured_timeout(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    client_class = Mock()
    loader = Mock()
    loader.load.return_value = SimpleNamespace(repository_hash="repository-hash")
    scanner = Mock()
    finding = object()
    scanner.scan.return_value = [finding]
    engine = Mock()
    engine.reason.return_value = "reasoning-result"

    monkeypatch.setenv("AIKAVACH_OLLAMA_MODEL", "local-model")
    monkeypatch.setenv("AIKAVACH_OLLAMA_TIMEOUT", "180")
    monkeypatch.setattr(ollama_demo, "OllamaLLMClient", client_class)
    monkeypatch.setattr(ollama_demo, "RepositoryLoader", Mock(return_value=loader))
    monkeypatch.setattr(ollama_demo, "StaticScanner", Mock(return_value=scanner))
    monkeypatch.setattr(ollama_demo, "ReasoningEngine", Mock(return_value=engine))

    ollama_demo.main()

    client_class.assert_called_once_with(
        base_url="http://127.0.0.1:11434", model="local-model", timeout=180.0
    )
    engine.reason.assert_called_once_with(
        finding,
        "samples/vulnerable/command_injection",
        repository_hash="repository-hash",
    )
    assert capsys.readouterr().out.splitlines() == [
        "Ollama model: local-model",
        "Ollama endpoint: http://127.0.0.1:11434",
        "Ollama timeout: 180.0s",
        "reasoning-result",
    ]
