"""Tests for deterministic Semgrep result normalization."""

import pytest

from crs.core.schemas import Severity
from crs.static_analysis.normalizer import (
    SemgrepNormalizationError,
    SemgrepNormalizer,
)


def semgrep_result(
    severity: str = "WARNING",
    check_id: str = "aikavach.python.subprocess-shell-true",
    path: str = "app.py",
    line: int = 8,
) -> dict[str, object]:
    return {
        "check_id": check_id,
        "path": path,
        "start": {"line": line, "col": 5},
        "end": {"line": line, "col": 48},
        "extra": {
            "message": "Unsafe subprocess call uses shell=True.",
            "severity": severity,
        },
    }


def test_warning_maps_to_medium_with_expected_confidence() -> None:
    finding = SemgrepNormalizer().normalize(semgrep_result("WARNING"))

    assert finding.severity is Severity.MEDIUM
    assert finding.confidence == 0.80


def test_error_maps_to_high_with_expected_confidence() -> None:
    finding = SemgrepNormalizer().normalize(semgrep_result("ERROR"))

    assert finding.severity is Severity.HIGH
    assert finding.confidence == 0.90


def test_evidence_contains_rule_and_location() -> None:
    finding = SemgrepNormalizer().normalize(semgrep_result())
    evidence = finding.evidence[0]

    assert evidence.source == "semgrep"
    assert evidence.raw_reference == "aikavach.python.subprocess-shell-true"
    assert evidence.file == "app.py"
    assert evidence.line == 8


def test_info_confidence_is_deterministic() -> None:
    finding = SemgrepNormalizer().normalize(semgrep_result("INFO"))

    assert finding.severity is Severity.INFO
    assert finding.confidence == 0.65


def test_finding_id_is_deterministic() -> None:
    normalizer = SemgrepNormalizer()

    first = normalizer.normalize(semgrep_result()).finding_id
    second = normalizer.normalize(semgrep_result()).finding_id

    assert first == second
    assert first.startswith("SF-")
    assert len(first) == 11


def test_different_findings_have_different_ids() -> None:
    normalizer = SemgrepNormalizer()

    first = normalizer.normalize(semgrep_result(line=8)).finding_id
    second = normalizer.normalize(semgrep_result(line=9)).finding_id

    assert first != second


def test_empty_results_return_empty_list() -> None:
    assert SemgrepNormalizer().normalize_results({"results": []}) == []


def test_missing_optional_fields_use_documented_fallbacks() -> None:
    finding = SemgrepNormalizer().normalize({"check_id": "custom.rule-id"})

    assert finding.file is None
    assert finding.line_start is None
    assert finding.line_end is None
    assert finding.severity is Severity.INFO
    assert finding.confidence == 0.65
    assert finding.title == "Semgrep finding: custom.rule-id"
    assert finding.vulnerability_type == "Rule Id"


def test_malformed_results_collection_is_rejected() -> None:
    with pytest.raises(SemgrepNormalizationError):
        SemgrepNormalizer().normalize_results({"results": "invalid"})
