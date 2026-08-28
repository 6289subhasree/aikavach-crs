from __future__ import annotations
"""Command-line demo for the complete AIKavach CRS MVP."""

import argparse
import os
from pathlib import Path
import sys
from time import perf_counter

from crs.core.schemas import CRSRunResult
from crs.orchestrator import CRSPipeline, PipelineError
from crs.reasoning.ollama_client import OllamaClientError, OllamaLLMClient
from crs.reasoning.ollama_config import format_ollama_diagnostics, load_ollama_config
from crs.reporting.provenance import build_run_provenance, write_run_provenance


RULE = "=" * 68


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run the AIKavach Find -> Reason -> Patch -> Verify demo."
    )
    parser.add_argument("target_path", help="Repository directory to analyze")
    parser.add_argument(
        "--artifacts-dir",
        default="artifacts",
        help="Directory for machine-readable provenance records (default: artifacts)",
    )
    return parser


def pipeline_from_environment() -> CRSPipeline:
    """Create the production pipeline with an explicitly configured local Ollama."""

    provider = os.environ.get("AIKAVACH_LLM_PROVIDER", "").strip().lower()
    if provider != "ollama":
        raise ValueError(
            "AIKAVACH_LLM_PROVIDER must be set to 'ollama'; no fake fallback is used"
        )
    config = load_ollama_config()
    client = OllamaLLMClient(
        base_url=config.base_url,
        model=config.model,
        timeout=config.timeout,
    )
    print(format_ollama_diagnostics(config))
    return CRSPipeline(reasoning_client=client, patch_client=client)


def render_result(result: CRSRunResult, elapsed_seconds: float | None = None) -> str:
    """Render a complete run in a readable four-stage submission format."""

    finding = result.finding
    reasoning = result.reasoning
    patch = result.patch
    verification = result.verification
    decision = "VERIFIED" if verification.approved else "REJECTED"
    severity = getattr(finding.severity, "value", finding.severity)
    lines = [
        RULE,
        "AIKAVACH CRS | AUTONOMOUS CYBER REASONING SYSTEM",
        RULE,
        f"Target: {result.target.path}",
        "Mode: LOCAL / AIR-GAPPED-READY",
        "Safety policy: AI proposes; deterministic verification decides",
        "",
        "[1/4] FIND  | deterministic static analysis",
        f"  Finding ID : {finding.finding_id}",
        f"  Type       : {finding.vulnerability_type}",
        f"  Severity   : {severity}",
        f"  File       : {finding.file or 'unknown'}",
        f"  Line       : {finding.line_start or 'unknown'}",
        "  Status     : FOUND",
        "",
        "[2/4] REASON | guarded local LLM",
        f"  Root cause           : {reasoning.root_cause}",
        f"  Security impact      : {reasoning.security_impact}",
        f"  Remediation strategy : {reasoning.remediation_strategy}",
        f"  Reasoning confidence : {reasoning.confidence:.2f} (advisory, not proof)",
        "  Status               : REASONED",
        "",
        "[3/4] PATCH | model edit intent + trusted diff construction",
        f"  Target file              : {patch.target_file}",
        "  Structural validation    : PASSED",
        f"  Expected security effect : {patch.expected_security_effect}",
        "  Status                   : CANDIDATE ACCEPTED",
        "",
        "[4/4] VERIFY | isolated deterministic harness",
        f"  Build               : {_status(verification.build_passed)}",
        f"  Tests               : {_status(verification.tests_passed)}",
        f"  Security regression : {_status(verification.security_test_passed)}",
        f"  Static rescan       : {_status(verification.static_rescan_clean)}",
        "",
        RULE,
        f"FINAL DECISION : {decision}",
        "ORIGINAL REPOSITORY MODIFIED : NO",
    ]
    if elapsed_seconds is not None:
        lines.append(f"TOTAL RUN TIME : {elapsed_seconds:.2f}s")
    lines.extend(
        [
            RULE,
            "AI output is never treated as proof; verification is fail-closed.",
        ]
    )
    return "\n".join(lines)


def _status(passed: bool) -> str:
    return "PASSED" if passed else "FAILED"


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    target = str(Path(args.target_path).expanduser())
    started = perf_counter()
    try:
        result = pipeline_from_environment().run(target)
    except (PipelineError, OllamaClientError, ValueError, OSError) as exc:
        elapsed = perf_counter() - started
        print(RULE, file=sys.stderr)
        print("AIKAVACH CRS | RUN REJECTED", file=sys.stderr)
        print(RULE, file=sys.stderr)
        print(f"Target: {target}", file=sys.stderr)
        print(f"ERROR: {exc}", file=sys.stderr)
        print("ORIGINAL REPOSITORY MODIFIED : NO", file=sys.stderr)
        print("FINAL DECISION : REJECTED", file=sys.stderr)
        print(f"TOTAL RUN TIME : {elapsed:.2f}s", file=sys.stderr)
        print(RULE, file=sys.stderr)
        return 1

    elapsed = perf_counter() - started
    config = load_ollama_config()
    provenance = build_run_provenance(
        result,
        model=config.model,
        elapsed_seconds=elapsed,
    )
    _, latest_path = write_run_provenance(
        provenance,
        output_dir=args.artifacts_dir,
    )

    print(render_result(result, elapsed_seconds=elapsed))
    print(f"PROVENANCE RECORD : {latest_path}")
    return 0 if result.verification.approved else 2


if __name__ == "__main__":
    raise SystemExit(main())
