"""Tests for machine-readable CRS provenance records."""

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

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
from crs.reporting.provenance import build_run_provenance, write_run_provenance


DIFF = "--- a/app.py\n+++ b/app.py\n@@ -1 +1 @@\n-old\n+new\n"


def result() -> CRSRunResult:
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
            repository_hash="abc123",
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
            unified_diff=DIFF,
            expected_security_effect="No shell invocation.",
            confidence=0.8,
        ),
        verification=VerificationResult(
            build_passed=True,
            tests_passed=True,
            security_test_passed=True,
            static_rescan_clean=True,
            approved=True,
            reason="verified",
        ),
    )


def test_build_run_provenance_contains_auditable_security_evidence() -> None:
    timestamp = datetime(2026, 8, 27, 5, 0, tzinfo=timezone.utc)

    record = build_run_provenance(
        result(),
        model="qwen2.5-coder:3b",
        elapsed_seconds=128.58,
        timestamp=timestamp,
        run_id="run-test",
    )

    assert record["schema_version"] == "1.0"
    assert record["run_id"] == "run-test"
    assert record["timestamp_utc"] == "2026-08-27T05:00:00Z"
    assert record["target"]["repository_sha256"] == "abc123"
    assert record["finding"]["finding_id"] == "SF-TEST"
    assert record["reasoning"]["model"] == "qwen2.5-coder:3b"
    assert record["reasoning"]["confidence_is_proof"] is False
    assert record["patch"]["patch_sha256"] == hashlib.sha256(DIFF.encode()).hexdigest()
    assert record["verification"]["approved"] is True
    assert record["safety"]["original_repository_modified"] is False
    assert record["safety"]["verification_policy"] == "fail-closed"
    assert record["final_decision"] == "VERIFIED"
    assert record["elapsed_seconds"] == 128.58


def test_write_run_provenance_writes_latest_and_timestamped_files(tmp_path: Path) -> None:
    record = build_run_provenance(
        result(),
        model="local-model",
        timestamp=datetime(2026, 8, 27, 5, 0, tzinfo=timezone.utc),
        run_id="run-test",
    )

    timestamped, latest = write_run_provenance(record, output_dir=tmp_path)

    assert timestamped.name == "run_2026-08-27T05-00-00Z_run-test.json"
    assert latest.name == "latest_run.json"
    assert json.loads(timestamped.read_text(encoding="utf-8")) == record
    assert json.loads(latest.read_text(encoding="utf-8")) == record
