"""Tests for bounded and path-safe reasoning evidence construction."""

from pathlib import Path

import pytest

from crs.core.schemas import Evidence, Severity, VulnerabilityFinding
from crs.reasoning.evidence_builder import EvidenceBuildError, EvidenceBuilder


def make_finding(file: str, start: int, end: int | None = None) -> VulnerabilityFinding:
    return VulnerabilityFinding(
        finding_id="SF-TEST",
        title="Unsafe operation",
        vulnerability_type="Command Injection",
        severity=Severity.HIGH,
        confidence=0.9,
        file=file,
        line_start=start,
        line_end=end or start,
        evidence=[
            Evidence(
                source="semgrep",
                description="Unsafe operation",
                file=file,
                line=start,
                raw_reference="rules.test.command-injection",
            )
        ],
    )


def write_numbered_source(path: Path, count: int = 20) -> None:
    path.write_text(
        "\n".join(f"source line {number}" for number in range(1, count + 1)),
        encoding="utf-8",
    )


def test_extracts_only_small_numbered_context(tmp_path: Path) -> None:
    source = tmp_path / "app.py"
    write_numbered_source(source)
    package = EvidenceBuilder().build(make_finding("app.py", 10), str(tmp_path))

    assert package.code_context.start_line == 5
    assert package.code_context.end_line == 15
    assert package.code_context.content.splitlines()[0] == "5: source line 5"
    assert package.code_context.content.splitlines()[-1] == "15: source line 15"
    assert package.code_context.trust_level == "UNTRUSTED_REPOSITORY_CONTENT"


def test_context_clamps_at_beginning_of_file(tmp_path: Path) -> None:
    source = tmp_path / "app.py"
    write_numbered_source(source)

    context = EvidenceBuilder().build(make_finding("app.py", 2), str(tmp_path)).code_context

    assert (context.start_line, context.end_line) == (1, 7)


def test_context_clamps_at_end_of_file(tmp_path: Path) -> None:
    source = tmp_path / "app.py"
    write_numbered_source(source)

    context = EvidenceBuilder().build(make_finding("app.py", 19), str(tmp_path)).code_context

    assert (context.start_line, context.end_line) == (14, 20)


def test_path_traversal_is_rejected(tmp_path: Path) -> None:
    repository = tmp_path / "repository"
    repository.mkdir()
    outside = tmp_path / "outside.py"
    outside.write_text("unsafe()\n", encoding="utf-8")

    with pytest.raises(EvidenceBuildError, match="outside repository root"):
        EvidenceBuilder().build(make_finding("../outside.py", 1), str(repository))


def test_missing_source_file_has_clear_error(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match="Finding source file does not exist"):
        EvidenceBuilder().build(make_finding("missing.py", 1), str(tmp_path))


def test_evidence_does_not_include_unrelated_files(tmp_path: Path) -> None:
    source = tmp_path / "app.py"
    source.write_text("dangerous_call()\n", encoding="utf-8")
    unrelated_secret = "UNRELATED_FILE_SENTINEL"
    (tmp_path / "unrelated.py").write_text(unrelated_secret, encoding="utf-8")

    package = EvidenceBuilder().build(make_finding("app.py", 1), str(tmp_path))

    assert unrelated_secret not in package.model_dump_json()
    assert package.code_context.file == "app.py"
