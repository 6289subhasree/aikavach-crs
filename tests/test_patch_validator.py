"""Tests for deterministic single-file unified-diff validation."""

from pathlib import Path

import pytest

from crs.core.schemas import Evidence, PatchProposal, Severity, VulnerabilityFinding
from crs.patching.patch_validator import PatchValidator


VALID_DIFF = """--- a/app.py
+++ b/app.py
@@ -10,1 +10,1 @@
-    subprocess.run(command, shell=True, check=False)
+    subprocess.run(command.split(), shell=False, check=False)
"""


def finding(file: str = "app.py", finding_id: str = "SF-TEST") -> VulnerabilityFinding:
    return VulnerabilityFinding(
        finding_id=finding_id,
        title="Unsafe shell execution",
        vulnerability_type="Command Injection",
        severity=Severity.HIGH,
        confidence=0.9,
        file=file,
        line_start=10,
        line_end=10,
        evidence=[Evidence(source="semgrep", description="shell=True")],
    )


def proposal(diff: str = VALID_DIFF, **updates: object) -> PatchProposal:
    values: dict[str, object] = {
        "finding_id": "SF-TEST",
        "target_file": "app.py",
        "rationale": "Avoid invoking a shell.",
        "unified_diff": diff,
        "expected_security_effect": "Prevents shell metacharacter interpretation.",
        "confidence": 0.85,
    }
    values.update(updates)
    return PatchProposal.model_validate(values)


def assert_invalid(candidate: PatchProposal, expected: str) -> None:
    result = PatchValidator().validate(candidate, finding())
    assert result.valid is False
    assert result.reason is not None
    assert expected.lower() in result.reason.lower()


def test_valid_single_file_diff() -> None:
    result = PatchValidator().validate(proposal(), finding())

    assert result.valid is True
    assert result.reason is None
    assert result.files_touched == ["app.py"]


def test_mismatched_finding_id() -> None:
    assert_invalid(proposal(finding_id="SF-WRONG"), "finding_id")


def test_wrong_target_file() -> None:
    assert_invalid(proposal(target_file="other.py"), "target_file")


def test_multi_file_diff_is_rejected() -> None:
    second = VALID_DIFF.replace("app.py", "other.py")
    assert_invalid(proposal(diff=VALID_DIFF + second), "exactly one file header")


def test_path_traversal_is_rejected() -> None:
    diff = VALID_DIFF.replace("a/app.py", "a/../app.py")
    assert_invalid(proposal(diff=diff), "path traversal")


def test_absolute_path_is_rejected() -> None:
    diff = VALID_DIFF.replace("a/app.py", "C:/repository/app.py")
    assert_invalid(proposal(diff=diff), "absolute paths")


def test_deletion_is_rejected() -> None:
    diff = """--- a/app.py
+++ /dev/null
@@ -1,1 +0,0 @@
-unsafe()
"""
    assert_invalid(proposal(diff=diff), "deletion")


def test_new_file_is_rejected() -> None:
    diff = """--- /dev/null
+++ b/app.py
@@ -0,0 +1,1 @@
+replacement()
"""
    assert_invalid(proposal(diff=diff), "new file")


@pytest.mark.parametrize(
    "diff",
    [
        "this is not a diff",
        "--- a/app.py\n+++ b/app.py\n-no hunk header\n+replacement\n",
        "--- a/app.py\n+++ b/app.py\n@@ -10,2 +10,1 @@\n-old\n+new\n",
    ],
)
def test_malformed_diff_is_rejected(diff: str) -> None:
    assert_invalid(proposal(diff=diff), "malformed")


def test_empty_diff_is_rejected() -> None:
    assert_invalid(proposal(diff=""), "empty")


def test_absolute_finding_is_resolved_under_repository(tmp_path: Path) -> None:
    source = tmp_path / "app.py"
    source.write_text("unsafe()\n", encoding="utf-8")

    result = PatchValidator().validate(
        proposal(), finding(str(source)), repository_root=str(tmp_path)
    )

    assert result.valid is True


def test_working_directory_relative_finding_is_resolved_under_repository(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repository = tmp_path / "samples" / "repository"
    repository.mkdir(parents=True)
    (repository / "app.py").write_text("unsafe()\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    result = PatchValidator().validate(
        proposal(),
        finding("samples/repository/app.py"),
        repository_root="samples/repository",
    )

    assert result.valid is True
