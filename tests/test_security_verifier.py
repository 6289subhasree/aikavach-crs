"""Tests for safe security regression and original-rule rescan decisions."""

from pathlib import Path
from unittest.mock import Mock

from crs.core.schemas import Evidence, Severity, VulnerabilityFinding
from crs.verification.security_verifier import SecurityVerifier


def finding(file: str, rule: str = "rules.semgrep.subprocess-shell-true") -> VulnerabilityFinding:
    return VulnerabilityFinding(
        finding_id="SF-TEST",
        title="Unsafe shell execution",
        vulnerability_type="Subprocess Shell True",
        severity=Severity.HIGH,
        confidence=0.9,
        file=file,
        line_start=2,
        line_end=2,
        evidence=[
            Evidence(
                source="semgrep",
                description="shell=True",
                file=file,
                line=2,
                raw_reference=rule,
            )
        ],
    )


def test_security_regression_inspects_ast_without_execution(tmp_path: Path) -> None:
    source = tmp_path / "app.py"
    source.write_text(
        "import subprocess\nsubprocess.run(command, shell=True)\n",
        encoding="utf-8",
    )
    verifier = SecurityVerifier(scanner=Mock())

    vulnerable = verifier.run_regression(tmp_path, "app.py", finding(str(source)))
    source.write_text(
        "import subprocess\nsubprocess.run(command.split(), shell=False)\n",
        encoding="utf-8",
    )
    fixed = verifier.run_regression(tmp_path, "app.py", finding(str(source)))

    assert vulnerable.passed is False
    assert fixed.passed is True


def test_rescan_rejects_original_rule_but_allows_unrelated_findings(
    tmp_path: Path,
) -> None:
    source = tmp_path / "app.py"
    source.write_text("safe()\n", encoding="utf-8")
    original = finding(str(source))
    scanner = Mock()
    unrelated = finding(str(source), rule="rules.semgrep.unrelated-rule")
    scanner.scan.return_value = [unrelated]
    verifier = SecurityVerifier(scanner=scanner)

    clean = verifier.rescan(tmp_path, "app.py", original)
    scanner.scan.return_value = [unrelated, finding(str(source))]
    remains = verifier.rescan(tmp_path, "app.py", original)

    assert clean.passed is True
    assert clean.findings == [unrelated]
    assert remains.passed is False
