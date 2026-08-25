"""Tests for fail-closed isolated verification orchestration."""

from pathlib import Path
from unittest.mock import Mock

import pytest

from crs.core.schemas import Evidence, PatchProposal, Severity, VulnerabilityFinding
from crs.verification.security_verifier import StaticRescanResult
from crs.verification.test_runner import CheckResult
from crs.verification.verification_engine import VerificationEngine
from crs.verification.workspace import EphemeralWorkspace


ORIGINAL = "import subprocess\nsubprocess.run(command, shell=True)\n"
PATCHED = "import subprocess\nsubprocess.run(command.split(), shell=False)\n"
DIFF = (
    "--- a/app.py\n"
    "+++ b/app.py\n"
    "@@ -1,2 +1,2 @@\n"
    " import subprocess\n"
    "-subprocess.run(command, shell=True)\n"
    "+subprocess.run(command.split(), shell=False)\n"
)


def finding(repository: Path) -> VulnerabilityFinding:
    source = repository / "app.py"
    return VulnerabilityFinding(
        finding_id="SF-TEST",
        title="Unsafe shell execution",
        vulnerability_type="Subprocess Shell True",
        severity=Severity.HIGH,
        confidence=0.9,
        file=str(source),
        line_start=2,
        line_end=2,
        evidence=[
            Evidence(
                source="semgrep",
                description="shell=True",
                file=str(source),
                line=2,
                raw_reference="rules.semgrep.subprocess-shell-true",
            )
        ],
    )


def patch() -> PatchProposal:
    return PatchProposal(
        finding_id="SF-TEST",
        target_file="app.py",
        rationale="Remove shell interpretation.",
        unified_diff=DIFF,
        expected_security_effect="No shell=True call remains.",
        confidence=0.9,
    )


def repository(tmp_path: Path) -> Path:
    root = tmp_path / "repository"
    root.mkdir()
    (root / "app.py").write_text(ORIGINAL, encoding="utf-8")
    return root


def runner(build: bool = True, tests: bool = True) -> Mock:
    value = Mock()
    value.syntax_check.return_value = CheckResult(build, "build result")
    value.run_tests.return_value = CheckResult(tests, "test result")
    return value


def security(regression: bool = True, rescan: bool = True) -> Mock:
    value = Mock()
    value.run_regression.return_value = CheckResult(regression, "security result")
    value.rescan.return_value = StaticRescanResult(rescan, "rescan result", [])
    return value


def test_successful_patch_is_approved_and_original_unchanged(tmp_path: Path) -> None:
    root = repository(tmp_path)

    result = VerificationEngine(
        test_runner=runner(), security_verifier=security()
    ).verify(str(root), finding(root), patch())

    assert result.approved is True
    assert result.reason == "Patch verified in isolated workspace"
    assert (root / "app.py").read_text(encoding="utf-8") == ORIGINAL


@pytest.mark.parametrize(
    ("build", "tests", "regression", "rescan", "failed_field"),
    [
        (False, True, True, True, "build_passed"),
        (True, False, True, True, "tests_passed"),
        (True, True, False, True, "security_test_passed"),
        (True, True, True, False, "static_rescan_clean"),
    ],
)
def test_failed_check_rejects_patch(
    tmp_path: Path,
    build: bool,
    tests: bool,
    regression: bool,
    rescan: bool,
    failed_field: str,
) -> None:
    root = repository(tmp_path)

    result = VerificationEngine(
        test_runner=runner(build, tests),
        security_verifier=security(regression, rescan),
    ).verify(str(root), finding(root), patch())

    assert result.approved is False
    assert getattr(result, failed_field) is False
    assert (root / "app.py").read_text(encoding="utf-8") == ORIGINAL


def test_scanner_failure_rejects_patch(tmp_path: Path) -> None:
    root = repository(tmp_path)
    verifier = security()
    verifier.rescan.side_effect = RuntimeError("scanner unavailable")

    result = VerificationEngine(
        test_runner=runner(), security_verifier=verifier
    ).verify(str(root), finding(root), patch())

    assert result.approved is False
    assert result.static_rescan_clean is False
    assert "scanner unavailable" in (result.reason or "")


def test_invalid_application_fails_safely(tmp_path: Path) -> None:
    root = repository(tmp_path)
    invalid = patch()
    invalid.unified_diff = invalid.unified_diff.replace(
        "subprocess.run(command, shell=True)", "different context"
    )

    result = VerificationEngine(
        test_runner=runner(), security_verifier=security()
    ).verify(str(root), finding(root), invalid)

    assert result.approved is False
    assert "context does not match" in (result.reason or "")
    assert (root / "app.py").read_text(encoding="utf-8") == ORIGINAL


def test_cleanup_occurs_when_check_raises(tmp_path: Path) -> None:
    root = repository(tmp_path)
    created_paths: list[Path] = []

    class TrackingWorkspace(EphemeralWorkspace):
        def __enter__(self) -> "TrackingWorkspace":
            super().__enter__()
            assert self.path is not None
            created_paths.append(self.path)
            return self

    failing_runner = runner()
    failing_runner.syntax_check.side_effect = RuntimeError("unexpected check failure")

    result = VerificationEngine(
        test_runner=failing_runner,
        security_verifier=security(),
        workspace_factory=TrackingWorkspace,
    ).verify(str(root), finding(root), patch())

    assert result.approved is False
    assert created_paths and not created_paths[0].exists()
