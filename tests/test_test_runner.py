"""Tests for deterministic verification subprocess execution."""

from pathlib import Path
import subprocess
from unittest.mock import Mock

import pytest

from crs.verification.test_runner import TestRunner


def test_no_tests_is_neutral(tmp_path: Path) -> None:
    result = TestRunner().run_tests(tmp_path)

    assert result.passed is True
    assert result.skipped is True
    assert "neutral" in result.reason


def test_syntax_check_uses_safe_utf8_subprocess(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "app.py"
    source.write_text("print('ok')\n", encoding="utf-8")
    completed = subprocess.CompletedProcess(
        args=[], returncode=1, stdout="", stderr="invalid byte: �"
    )
    run = Mock(return_value=completed)
    monkeypatch.setattr(subprocess, "run", run)

    result = TestRunner(timeout=9, python_executable="python").syntax_check(
        tmp_path, "app.py"
    )

    assert result.passed is False
    assert "�" in result.reason
    run.assert_called_once_with(
        ["python", "-m", "py_compile", str(source.resolve())],
        cwd=str(tmp_path.resolve()),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        shell=False,
        timeout=9,
        check=False,
    )


def test_project_test_failure_is_reported(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "tests").mkdir()
    completed = subprocess.CompletedProcess(
        args=[], returncode=1, stdout="failed", stderr=""
    )
    monkeypatch.setattr(subprocess, "run", Mock(return_value=completed))

    result = TestRunner().run_tests(tmp_path)

    assert result.passed is False
    assert "failed" in result.reason


def test_timeout_is_reported(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = tmp_path / "app.py"
    source.write_text("print('ok')\n", encoding="utf-8")
    monkeypatch.setattr(
        subprocess,
        "run",
        Mock(side_effect=subprocess.TimeoutExpired(["python"], 1)),
    )

    result = TestRunner().syntax_check(tmp_path, "app.py")

    assert result.passed is False
    assert "timed out" in result.reason
