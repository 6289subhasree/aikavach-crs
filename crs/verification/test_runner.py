from __future__ import annotations
"""Deterministic Python build and project-test execution."""

from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath
import subprocess
import sys


@dataclass(frozen=True)
class CheckResult:
    """Internal result for one deterministic verification command."""

    passed: bool
    reason: str
    skipped: bool = False
    stdout: str = ""
    stderr: str = ""


class TestRunner:
    """Run Python checks only inside the supplied temporary workspace."""

    __test__ = False

    def __init__(self, timeout: float = 60.0, python_executable: str | None = None) -> None:
        if timeout <= 0:
            raise ValueError("Verification timeout must be greater than zero")
        self.timeout = timeout
        self.python_executable = python_executable or sys.executable

    def syntax_check(self, workspace_root: str | Path, affected_file: str) -> CheckResult:
        root = Path(workspace_root).resolve()
        target = self._safe_target(root, affected_file)
        return self._run(
            [self.python_executable, "-m", "py_compile", str(target)], root
        )

    def run_tests(self, workspace_root: str | Path) -> CheckResult:
        root = Path(workspace_root).resolve()
        tests = root / "tests"
        if not tests.is_dir():
            return CheckResult(
                passed=True,
                skipped=True,
                reason="No project tests found; treated as neutral for MVP verification",
            )
        return self._run(
            [self.python_executable, "-m", "pytest", str(tests)], root
        )

    def _run(self, command: list[str], cwd: Path) -> CheckResult:
        try:
            completed = subprocess.run(
                command,
                cwd=str(cwd),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                shell=False,
                timeout=self.timeout,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return CheckResult(False, "Verification command timed out")
        except OSError as exc:
            return CheckResult(False, f"Unable to run verification command: {exc}")
        detail = completed.stderr.strip() or completed.stdout.strip()
        return CheckResult(
            passed=completed.returncode == 0,
            reason=(
                "Verification command passed"
                if completed.returncode == 0
                else f"Verification command failed: {detail or 'no details'}"
            ),
            stdout=completed.stdout,
            stderr=completed.stderr,
        )

    @staticmethod
    def _safe_target(root: Path, affected_file: str) -> Path:
        normalized = affected_file.replace("\\", "/")
        if PurePosixPath(normalized).is_absolute() or PureWindowsPath(affected_file).is_absolute():
            raise ValueError("Affected file must be relative to temporary workspace")
        if ".." in PurePosixPath(normalized).parts:
            raise ValueError("Affected file traversal is not allowed")
        target = (root / Path(*PurePosixPath(normalized).parts)).resolve()
        if not target.is_relative_to(root):
            raise ValueError("Affected file escapes temporary workspace")
        return target
