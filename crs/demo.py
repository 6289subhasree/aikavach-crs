"""Command-line demo for the complete AIKavach CRS MVP."""

import argparse
import os
from pathlib import Path
import sys

from crs.core.schemas import CRSRunResult
from crs.orchestrator import CRSPipeline, PipelineError
from crs.reasoning.ollama_client import OllamaClientError, OllamaLLMClient
from crs.reasoning.ollama_config import format_ollama_diagnostics, load_ollama_config


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run the AIKavach Find -> Reason -> Patch -> Verify demo."
    )
    parser.add_argument("target_path", help="Repository directory to analyze")
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


def render_result(result: CRSRunResult) -> str:
    """Render a complete run in a readable four-stage submission format."""

    finding = result.finding
    reasoning = result.reasoning
    patch = result.patch
    verification = result.verification
    decision = "VERIFIED" if verification.approved else "REJECTED"
    severity = getattr(finding.severity, "value", finding.severity)
    return "\n".join(
        [
            "AIKavach CRS",
            f"Target: {result.target.path}",
            "",
            "[1/4] FIND",
            f"Finding ID: {finding.finding_id}",
            f"Type: {finding.vulnerability_type}",
            f"Severity: {severity}",
            f"File: {finding.file or 'unknown'}",
            f"Line: {finding.line_start or 'unknown'}",
            "",
            "[2/4] REASON",
            f"Root cause: {reasoning.root_cause}",
            f"Security impact: {reasoning.security_impact}",
            f"Remediation strategy: {reasoning.remediation_strategy}",
            f"Reasoning confidence: {reasoning.confidence:.2f} (not proof)",
            "",
            "[3/4] PATCH",
            f"Target file: {patch.target_file}",
            "Patch validation: PASSED",
            f"Expected security effect: {patch.expected_security_effect}",
            "",
            "[4/4] VERIFY",
            f"Build: {_status(verification.build_passed)}",
            f"Tests: {_status(verification.tests_passed)}",
            f"Security regression: {_status(verification.security_test_passed)}",
            f"Static rescan: {_status(verification.static_rescan_clean)}",
            f"Final decision: {decision}",
            "",
            "Original repository modified: NO",
            f"FINAL DECISION: {decision}",
        ]
    )


def _status(passed: bool) -> str:
    return "PASSED" if passed else "FAILED"


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    target = str(Path(args.target_path).expanduser())
    try:
        result = pipeline_from_environment().run(target)
    except (PipelineError, OllamaClientError, ValueError, OSError) as exc:
        print("AIKavach CRS", file=sys.stderr)
        print(f"Target: {target}", file=sys.stderr)
        print(f"ERROR: {exc}", file=sys.stderr)
        print("Original repository modified: NO", file=sys.stderr)
        print("FINAL DECISION: REJECTED", file=sys.stderr)
        return 1
    print(render_result(result))
    return 0 if result.verification.approved else 2


if __name__ == "__main__":
    raise SystemExit(main())
