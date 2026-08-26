"""Dedicated safe security properties and original-finding Semgrep checks."""

import ast
from dataclasses import dataclass
from pathlib import Path

from crs.core.schemas import VulnerabilityFinding
from crs.static_analysis.scanner import StaticScanner
from crs.verification.test_runner import CheckResult


@dataclass(frozen=True)
class StaticRescanResult:
    passed: bool
    reason: str
    findings: list[VulnerabilityFinding]


class SecurityVerifier:
    """Verify supported security properties without executing dangerous payloads."""

    def __init__(self, scanner: StaticScanner | None = None) -> None:
        self.scanner = scanner or StaticScanner()

    def run_regression(
        self,
        workspace_root: str | Path,
        affected_file: str,
        original_finding: VulnerabilityFinding,
    ) -> CheckResult:
        """For command injection, assert no subprocess call retains shell=True."""

        vulnerability = original_finding.vulnerability_type.lower()
        rule_ids = self._rule_ids(original_finding)
        if "shell true" not in vulnerability and not any(
            "subprocess-shell-true" in rule_id for rule_id in rule_ids
        ):
            return CheckResult(
                False,
                "No dedicated security regression is implemented for this vulnerability class",
            )
        target = (Path(workspace_root).resolve() / affected_file).resolve()
        try:
            tree = ast.parse(target.read_text(encoding="utf-8"), filename=str(target))
        except (OSError, UnicodeError, SyntaxError) as exc:
            return CheckResult(False, f"Security regression could not inspect source: {exc}")
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not self._is_subprocess_run(node.func):
                continue
            for keyword in node.keywords:
                if (
                    keyword.arg == "shell"
                    and isinstance(keyword.value, ast.Constant)
                    and keyword.value.value is True
                ):
                    return CheckResult(
                        False, "Security regression found subprocess.run with shell=True"
                    )
        return CheckResult(True, "Security regression found no subprocess.run with shell=True")

    def rescan(
        self,
        workspace_root: str | Path,
        affected_file: str,
        original_finding: VulnerabilityFinding,
    ) -> StaticRescanResult:
        findings = self.scanner.scan(str(workspace_root))
        original_rules = self._rule_ids(original_finding)
        remaining = [
            finding
            for finding in findings
            if self._same_file(finding.file, affected_file)
            and bool(original_rules & self._rule_ids(finding))
        ]
        if remaining:
            return StaticRescanResult(
                False,
                "Original Semgrep rule remains on the affected file",
                findings,
            )
        return StaticRescanResult(
            True,
            "Original Semgrep finding is absent; unrelated findings are retained",
            findings,
        )

    @staticmethod
    def _is_subprocess_run(function: ast.expr) -> bool:
        return (
            isinstance(function, ast.Attribute)
            and function.attr == "run"
            and isinstance(function.value, ast.Name)
            and function.value.id == "subprocess"
        )

    @staticmethod
    def _rule_ids(finding: VulnerabilityFinding) -> set[str]:
        return {
            evidence.raw_reference
            for evidence in finding.evidence
            if evidence.raw_reference
        }

    @staticmethod
    def _same_file(candidate: str | None, affected_file: str) -> bool:
        if not candidate:
            return False
        normalized_candidate = candidate.replace("\\", "/")
        normalized_affected = affected_file.replace("\\", "/")
        return normalized_candidate == normalized_affected or normalized_candidate.endswith(
            f"/{normalized_affected}"
        )
