"""Offline end-to-end tests for the CRS pipeline composition."""

from pathlib import Path
from unittest.mock import Mock

import pytest

from crs.core.schemas import (
    Evidence,
    ReasoningResult,
    Severity,
    VerificationResult,
    VulnerabilityFinding,
)
from crs.orchestrator import CRSPipeline, NoFindingsError, PipelineError
from crs.patching.patch_generator import FakePatchLLMClient
from crs.reasoning.llm_client import FakeLLMClient


SOURCE = "subprocess.run(command, shell=True, check=False)\n"
DIFF = (
    "--- a/app.py\n"
    "+++ b/app.py\n"
    "@@ -1,1 +1,1 @@\n"
    "-subprocess.run(command, shell=True, check=False)\n"
    "+subprocess.run(command.split(), shell=False, check=False)\n"
)


def repository(tmp_path: Path) -> Path:
    root = tmp_path / "repository"
    root.mkdir()
    (root / "app.py").write_text(SOURCE, encoding="utf-8")
    return root


def finding(root: Path) -> VulnerabilityFinding:
    source = root / "app.py"
    return VulnerabilityFinding(
        finding_id="SF-TEST",
        title="Unsafe shell execution",
        vulnerability_type="Subprocess Shell True",
        severity=Severity.HIGH,
        confidence=0.9,
        file=str(source),
        line_start=1,
        line_end=1,
        evidence=[
            Evidence(
                source="semgrep",
                description="shell=True",
                file=str(source),
                line=1,
                raw_reference="rules.semgrep.subprocess-shell-true",
            )
        ],
    )


def reasoning(confidence: float = 0.9) -> dict[str, object]:
    return {
        "finding_id": "SF-TEST",
        "vulnerability_class": "Command Injection",
        "root_cause": "Input reaches shell=True.",
        "security_impact": "Shell syntax may alter execution.",
        "remediation_strategy": "Use an argument list without a shell.",
        "assumptions": ["Input may be untrusted."],
        "evidence_references": [
            "rules.semgrep.subprocess-shell-true",
            "app.py:1",
        ],
        "confidence": confidence,
    }


def patch(target_file: str = "app.py") -> dict[str, object]:
    return {
        "finding_id": "SF-TEST",
        "target_file": target_file,
        "rationale": "Avoid shell interpretation.",
        "unified_diff": DIFF,
        "expected_security_effect": "No shell=True call remains.",
        "confidence": 0.85,
    }


def verification(approved: bool = True) -> VerificationResult:
    return VerificationResult(
        build_passed=approved,
        tests_passed=approved,
        security_test_passed=approved,
        static_rescan_clean=approved,
        approved=approved,
        reason="verified" if approved else "rejected",
    )


def pipeline(root: Path, *, approved: bool = True) -> tuple[CRSPipeline, Mock]:
    scanner = Mock()
    scanner.scan.return_value = [finding(root)]
    verifier = Mock()
    verifier.verify.return_value = verification(approved)
    return (
        CRSPipeline(
            reasoning_client=FakeLLMClient(reasoning()),
            patch_client=FakePatchLLMClient(patch()),
            scanner=scanner,
            verifier=verifier,
        ),
        verifier,
    )


def test_happy_path_uses_fake_dependencies_and_preserves_original(
    tmp_path: Path,
) -> None:
    root = repository(tmp_path)
    subject, verifier = pipeline(root)

    result = subject.run(str(root))

    assert result.finding.finding_id == "SF-TEST"
    assert isinstance(result.reasoning, ReasoningResult)
    assert result.patch.target_file == "app.py"
    assert result.verification.approved is True
    verifier.verify.assert_called_once()
    assert (root / "app.py").read_text(encoding="utf-8") == SOURCE


def test_no_findings_has_clear_stage_error(tmp_path: Path) -> None:
    root = repository(tmp_path)
    scanner = Mock()
    scanner.scan.return_value = []
    subject = CRSPipeline(
        reasoning_client=FakeLLMClient(reasoning()),
        patch_client=FakePatchLLMClient(patch()),
        scanner=scanner,
        verifier=Mock(),
    )

    with pytest.raises(NoFindingsError, match="No vulnerability findings"):
        subject.run(str(root))


def test_reasoning_failure_is_reported(tmp_path: Path) -> None:
    root = repository(tmp_path)
    scanner = Mock()
    scanner.scan.return_value = [finding(root)]
    subject = CRSPipeline(
        reasoning_client=FakeLLMClient(reasoning(confidence=2.0)),
        patch_client=FakePatchLLMClient(patch()),
        scanner=scanner,
        verifier=Mock(),
    )

    with pytest.raises(PipelineError, match="REASON"):
        subject.run(str(root))


def test_patch_validation_failure_is_reported(tmp_path: Path) -> None:
    root = repository(tmp_path)
    scanner = Mock()
    scanner.scan.return_value = [finding(root)]
    subject = CRSPipeline(
        reasoning_client=FakeLLMClient(reasoning()),
        patch_client=FakePatchLLMClient(patch("other.py")),
        scanner=scanner,
        verifier=Mock(),
    )

    with pytest.raises(PipelineError, match="PATCH"):
        subject.run(str(root))


def test_verification_rejection_is_structured_result(tmp_path: Path) -> None:
    root = repository(tmp_path)
    subject, _ = pipeline(root, approved=False)

    result = subject.run(str(root))

    assert result.verification.approved is False
    assert (root / "app.py").read_text(encoding="utf-8") == SOURCE
