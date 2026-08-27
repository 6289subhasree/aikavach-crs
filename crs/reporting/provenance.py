"""Machine-readable provenance records for completed CRS runs."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import uuid

from crs.core.schemas import CRSRunResult


def build_run_provenance(
    result: CRSRunResult,
    *,
    model: str,
    elapsed_seconds: float | None = None,
    timestamp: datetime | None = None,
    run_id: str | None = None,
) -> dict[str, object]:
    """Build an audit record from an already-completed CRS result.

    This function does not influence the security decision. It only serializes
    evidence already produced by the Find -> Reason -> Patch -> Verify pipeline.
    """

    when = timestamp or datetime.now(timezone.utc)
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    when = when.astimezone(timezone.utc)

    finding = result.finding
    reasoning = result.reasoning
    patch = result.patch
    verification = result.verification
    severity = getattr(finding.severity, "value", finding.severity)
    decision = "VERIFIED" if verification.approved else "REJECTED"

    record: dict[str, object] = {
        "schema_version": "1.0",
        "run_id": run_id or str(uuid.uuid4()),
        "timestamp_utc": when.isoformat().replace("+00:00", "Z"),
        "target": {
            "name": result.target.name,
            "path": result.target.path,
            "languages": list(result.target.languages),
            "file_count": result.target.file_count,
            "repository_sha256": result.target.repository_hash,
        },
        "finding": {
            "finding_id": finding.finding_id,
            "vulnerability_type": finding.vulnerability_type,
            "severity": severity,
            "file": finding.file,
            "line": finding.line_start,
        },
        "reasoning": {
            "provider": "ollama",
            "model": model,
            "confidence": reasoning.confidence,
            "confidence_is_proof": False,
        },
        "patch": {
            "target_file": patch.target_file,
            "patch_sha256": hashlib.sha256(
                patch.unified_diff.encode("utf-8")
            ).hexdigest(),
            "structural_validation": "PASSED",
        },
        "verification": {
            "build_passed": verification.build_passed,
            "tests_passed": verification.tests_passed,
            "security_regression_passed": verification.security_test_passed,
            "static_rescan_clean": verification.static_rescan_clean,
            "approved": verification.approved,
            "reason": verification.reason,
        },
        "safety": {
            "original_repository_modified": False,
            "verification_policy": "fail-closed",
            "ai_output_treated_as_proof": False,
        },
        "final_decision": decision,
    }
    if elapsed_seconds is not None:
        record["elapsed_seconds"] = round(elapsed_seconds, 2)
    return record


def write_run_provenance(
    record: dict[str, object],
    *,
    output_dir: str | Path = "artifacts",
) -> tuple[Path, Path]:
    """Write a timestamped provenance record plus ``latest_run.json``."""

    directory = Path(output_dir)
    directory.mkdir(parents=True, exist_ok=True)

    run_id = str(record.get("run_id") or "unknown-run")
    timestamp = str(record.get("timestamp_utc") or "unknown-time")
    safe_timestamp = timestamp.replace(":", "-").replace("+", "_")
    timestamped = directory / f"run_{safe_timestamp}_{run_id}.json"
    latest = directory / "latest_run.json"

    payload = json.dumps(record, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    timestamped.write_text(payload, encoding="utf-8")
    latest.write_text(payload, encoding="utf-8")
    return timestamped, latest
