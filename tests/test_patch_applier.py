"""Tests for atomic in-process patch application."""

from pathlib import Path

import pytest

from crs.core.schemas import PatchProposal
from crs.verification.patch_applier import PatchApplicationError, PatchApplier


def proposal(diff: str, target: str = "app.py") -> PatchProposal:
    return PatchProposal(
        finding_id="SF-TEST",
        target_file=target,
        rationale="Remove shell interpretation.",
        unified_diff=diff,
        expected_security_effect="shell=True is removed.",
        confidence=0.9,
    )


def valid_diff() -> str:
    return (
        "--- a/app.py\n"
        "+++ b/app.py\n"
        "@@ -1,2 +1,2 @@\n"
        " import subprocess\n"
        "-subprocess.run(command, shell=True)\n"
        "+subprocess.run(command.split(), shell=False)\n"
    )


def test_valid_patch_applies_only_to_workspace(tmp_path: Path) -> None:
    original = tmp_path / "original"
    workspace = tmp_path / "workspace"
    original.mkdir()
    workspace.mkdir()
    content = "import subprocess\nsubprocess.run(command, shell=True)\n"
    (original / "app.py").write_text(content, encoding="utf-8")
    (workspace / "app.py").write_text(content, encoding="utf-8")

    PatchApplier().apply(workspace, proposal(valid_diff()))

    assert "shell=False" in (workspace / "app.py").read_text(encoding="utf-8")
    assert (original / "app.py").read_text(encoding="utf-8") == content


def test_context_mismatch_fails_without_partial_write(tmp_path: Path) -> None:
    source = tmp_path / "app.py"
    original = "import subprocess\nsubprocess.run(safe_args, shell=False)\n"
    source.write_text(original, encoding="utf-8")

    with pytest.raises(PatchApplicationError, match="context does not match"):
        PatchApplier().apply(tmp_path, proposal(valid_diff()))

    assert source.read_text(encoding="utf-8") == original


@pytest.mark.parametrize("target", ["../app.py", "C:/repository/app.py", "/app.py"])
def test_unsafe_target_path_is_rejected(tmp_path: Path, target: str) -> None:
    (tmp_path / "app.py").write_text("unchanged\n", encoding="utf-8")

    with pytest.raises(PatchApplicationError):
        PatchApplier().apply(tmp_path, proposal(valid_diff(), target))

    assert (tmp_path / "app.py").read_text(encoding="utf-8") == "unchanged\n"


def test_malformed_hunk_fails_without_write(tmp_path: Path) -> None:
    source = tmp_path / "app.py"
    source.write_text("original\n", encoding="utf-8")
    malformed = "--- a/app.py\n+++ b/app.py\n@@ malformed @@\n-old\n+new\n"

    with pytest.raises(PatchApplicationError, match="hunk header"):
        PatchApplier().apply(tmp_path, proposal(malformed))

    assert source.read_text(encoding="utf-8") == "original\n"
