"""Tests for static-analysis orchestration and the Semgrep process boundary."""

from pathlib import Path
import subprocess
from unittest.mock import Mock

import pytest

from crs.static_analysis.scanner import StaticScanner
from crs.static_analysis.semgrep_runner import SemgrepOutputError, SemgrepRunner


def test_static_scanner_uses_loader_runner_and_normalizer(tmp_path: Path) -> None:
    (tmp_path / "app.py").write_text("print('fixture')\n", encoding="utf-8")
    raw_output = {
        "results": [
            {
                "check_id": "demo.python.rule",
                "path": "app.py",
                "start": {"line": 1},
                "end": {"line": 1},
                "extra": {"message": "Demo finding", "severity": "WARNING"},
            }
        ]
    }
    runner = Mock(spec=SemgrepRunner)
    runner.scan.return_value = raw_output

    findings = StaticScanner(runner=runner).scan(str(tmp_path))

    runner.scan.assert_called_once_with(str(tmp_path.resolve()))
    assert len(findings) == 1
    assert findings[0].file == "app.py"


def test_static_scanner_returns_empty_list(tmp_path: Path) -> None:
    runner = Mock(spec=SemgrepRunner)
    runner.scan.return_value = {"results": []}

    assert StaticScanner(runner=runner).scan(str(tmp_path)) == []


def test_runner_rejects_malformed_json(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = tmp_path / "rules.yml"
    config.write_text("rules: []\n", encoding="utf-8")
    completed = subprocess.CompletedProcess(
        args=[], returncode=0, stdout="not-json", stderr=""
    )
    monkeypatch.setattr(subprocess, "run", lambda *args, **kwargs: completed)

    with pytest.raises(SemgrepOutputError):
        SemgrepRunner(config_path=config).scan(str(tmp_path))


def test_runner_explicitly_decodes_semgrep_output_as_utf8(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = tmp_path / "rules.yml"
    config.write_text("rules: []\n", encoding="utf-8")
    completed = subprocess.CompletedProcess(
        args=[], returncode=0, stdout='{"results": []}', stderr=""
    )
    run = Mock(return_value=completed)
    monkeypatch.setattr(subprocess, "run", run)

    SemgrepRunner(config_path=config).scan(str(tmp_path))

    run.assert_called_once_with(
        ["semgrep", "--config", str(config.resolve()), "--json", str(tmp_path)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        shell=False,
        timeout=60.0,
        check=False,
    )
