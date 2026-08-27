"""Offline tests for CLI configuration and readable reporting."""

from pathlib import Path
from unittest.mock import Mock

import pytest

from crs import demo
from crs.core.schemas import (
    AnalysisTarget,
    CRSRunResult,
    Evidence,
    PatchProposal,
    ReasoningResult,
    Severity,
    VerificationResult,
    VulnerabilityFinding,
)


def run_result(approved: bool = True) -> CRSRunResult:
    finding = VulnerabilityFinding(
        finding_id="SF-TEST",
        title="Unsafe shell execution",
        vulnerability_type="Command Injection",
        severity=Severity.HIGH,
        confidence=0.9,
        file="app.py",
        line_start=10,
        line_end=10,
        evidence=[Evidence(source="semgrep", description="shell=True")],
    )
    return CRSRunResult(
        target=AnalysisTarget(
            name="repository",
            path="C:/repository",
            languages=["Python"],
            file_count=1,
        ),
        finding=finding,
        reasoning=ReasoningResult(
            finding_id="SF-TEST",
            vulnerability_class="Command Injection",
            root_cause="Input reaches a shell.",
            security_impact="Commands may be altered.",
            remediation_strategy="Avoid shell interpretation.",
            assumptions=[],
            evidence_references=["app.py:10"],
            confidence=0.9,
        ),
        patch=PatchProposal(
            finding_id="SF-TEST",
            target_file="app.py",
            rationale="Remove shell usage.",
            unified_diff="--- a/app.py\n+++ b/app.py\n@@ -1 +1 @@\n-old\n+new\n",
            expected_security_effect="No shell invocation.",
            confidence=0.8,
        ),
        verification=VerificationResult(
            build_passed=approved,
            tests_passed=approved,
            security_test_passed=approved,
            static_rescan_clean=approved,
            approved=approved,
            reason="done",
        ),
    )


@pytest.mark.parametrize(("approved", "decision"), [(True, "VERIFIED"), (False, "REJECTED")])
def test_render_result_contains_all_stages_and_decision(
    approved: bool, decision: str
) -> None:
    output = demo.render_result(run_result(approved), elapsed_seconds=12.34)

    for stage in ("[1/4] FIND", "[2/4] REASON", "[3/4] PATCH", "[4/4] VERIFY"):
        assert stage in output
    assert f"FINAL DECISION : {decision}" in output
    assert "ORIGINAL REPOSITORY MODIFIED : NO" in output
    assert "Reasoning confidence : 0.90 (advisory, not proof)" in output
    assert "AI proposes; deterministic verification decides" in output
    assert "TOTAL RUN TIME : 12.34s" in output
    assert "verification is fail-closed" in output


def test_render_result_can_omit_timing() -> None:
    output = demo.render_result(run_result(True))

    assert "TOTAL RUN TIME" not in output


def test_main_uses_injected_pipeline_without_network(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    pipeline = Mock()
    pipeline.run.return_value = run_result(True)
    monkeypatch.setattr(demo, "pipeline_from_environment", lambda: pipeline)

    exit_code = demo.main(["sample"])

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "FINAL DECISION : VERIFIED" in output
    assert "TOTAL RUN TIME :" in output
    pipeline.run.assert_called_once_with(str(Path("sample").expanduser()))


def test_production_configuration_never_falls_back_to_fake(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("AIKAVACH_LLM_PROVIDER", raising=False)
    monkeypatch.delenv("AIKAVACH_OLLAMA_MODEL", raising=False)

    with pytest.raises(ValueError, match="no fake fallback"):
        demo.pipeline_from_environment()


def test_production_configuration_uses_ollama_timeout(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    client_class = Mock()
    monkeypatch.setenv("AIKAVACH_LLM_PROVIDER", "ollama")
    monkeypatch.setenv("AIKAVACH_OLLAMA_MODEL", "local-model")
    monkeypatch.setenv("AIKAVACH_OLLAMA_TIMEOUT", "180")
    monkeypatch.setattr(demo, "OllamaLLMClient", client_class)

    demo.pipeline_from_environment()

    client_class.assert_called_once_with(
        base_url="http://127.0.0.1:11434", model="local-model", timeout=180.0
    )
    assert capsys.readouterr().out.splitlines() == [
        "Ollama model: local-model",
        "Ollama endpoint: http://127.0.0.1:11434",
        "Ollama timeout: 180.0s",
    ]


def test_production_configuration_rejects_invalid_ollama_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AIKAVACH_LLM_PROVIDER", "ollama")
    monkeypatch.setenv("AIKAVACH_OLLAMA_MODEL", "local-model")
    monkeypatch.setenv("AIKAVACH_OLLAMA_TIMEOUT", "not-a-number")

    with pytest.raises(ValueError, match="AIKAVACH_OLLAMA_TIMEOUT"):
        demo.pipeline_from_environment()
