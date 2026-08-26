"""Tests for the shared AIKavach CRS schemas."""

import pytest
from pydantic import ValidationError

from crs.core.schemas import Evidence, Severity, VerificationResult, VulnerabilityFinding


def finding_data() -> dict[str, object]:
    """Return a minimal valid vulnerability finding payload."""

    return {
        "finding_id": "finding-001",
        "title": "SQL injection in user lookup",
        "vulnerability_type": "CWE-89",
        "severity": "HIGH",
        "confidence": 0.95,
        "file": "app/database.py",
        "line_start": 42,
        "line_end": 44,
        "evidence": [
            Evidence(
                source="static-analysis",
                description="User input is interpolated into a SQL query.",
                file="app/database.py",
                line=42,
            )
        ],
    }


def test_valid_vulnerability_finding_creation() -> None:
    finding = VulnerabilityFinding(**finding_data())

    assert finding.finding_id == "finding-001"
    assert finding.severity is Severity.HIGH
    assert finding.confidence == 0.95
    assert len(finding.evidence) == 1


def test_confidence_above_one_is_rejected() -> None:
    payload = finding_data()
    payload["confidence"] = 1.01

    with pytest.raises(ValidationError):
        VulnerabilityFinding(**payload)


def test_invalid_severity_is_rejected() -> None:
    payload = finding_data()
    payload["severity"] = "URGENT"

    with pytest.raises(ValidationError):
        VulnerabilityFinding(**payload)


def test_exploit_reproduced_defaults_to_false() -> None:
    finding = VulnerabilityFinding(**finding_data())

    assert finding.exploit_reproduced is False


def test_verification_result_creation() -> None:
    result = VerificationResult(
        build_passed=True,
        tests_passed=True,
        security_test_passed=True,
        static_rescan_clean=True,
        approved=True,
        reason="All verification checks passed.",
    )

    assert result.approved is True
    assert result.reason == "All verification checks passed."
