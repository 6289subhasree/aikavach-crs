"""Subprocess boundary for executing Semgrep and parsing its JSON output."""

import json
from pathlib import Path
import subprocess
from typing import Any


class SemgrepError(RuntimeError):
    """Base exception for Semgrep execution failures."""


class SemgrepNotFoundError(SemgrepError):
    """Raised when the Semgrep executable is unavailable."""


class SemgrepTimeoutError(SemgrepError):
    """Raised when Semgrep exceeds its configured execution timeout."""


class SemgrepOutputError(SemgrepError):
    """Raised when Semgrep does not return a valid JSON result object."""


class SemgrepExecutionError(SemgrepError):
    """Raised when Semgrep reports a genuine scanner execution failure."""


class SemgrepRunner:
    """Execute Semgrep with a local configuration and return raw JSON results."""

    DEFAULT_CONFIG = (
        Path(__file__).resolve().parents[2] / "rules" / "semgrep" / "demo_rules.yml"
    )

    def __init__(
        self,
        config_path: str | Path | None = None,
        timeout_seconds: float = 60.0,
        executable: str = "semgrep",
    ) -> None:
        """Configure the rule path, execution timeout, and CLI executable."""

        if timeout_seconds <= 0:
            raise ValueError("Semgrep timeout must be greater than zero")
        self.config_path = Path(config_path or self.DEFAULT_CONFIG).expanduser().resolve()
        self.timeout_seconds = timeout_seconds
        self.executable = executable

    def scan(self, target_path: str) -> dict[str, Any]:
        """Run Semgrep against ``target_path`` and return validated raw output."""

        if not self.config_path.is_file():
            raise SemgrepExecutionError(
                f"Semgrep configuration does not exist: {self.config_path}"
            )

        command = [
            self.executable,
            "--config",
            str(self.config_path),
            "--json",
            target_path,
        ]
        try:
            completed = subprocess.run(
                command,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                shell=False,
                timeout=self.timeout_seconds,
                check=False,
            )
        except FileNotFoundError as exc:
            raise SemgrepNotFoundError(
                f"Semgrep executable was not found: {self.executable}"
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise SemgrepTimeoutError(
                f"Semgrep exceeded the {self.timeout_seconds:g}-second timeout"
            ) from exc
        except OSError as exc:
            raise SemgrepExecutionError(f"Unable to execute Semgrep: {exc}") from exc

        if completed.returncode != 0:
            detail = completed.stderr.strip() or "no error details provided"
            raise SemgrepExecutionError(
                f"Semgrep exited with code {completed.returncode}: {detail}"
            )

        try:
            output = json.loads(completed.stdout)
        except (json.JSONDecodeError, TypeError) as exc:
            raise SemgrepOutputError("Semgrep returned malformed JSON output") from exc

        if not isinstance(output, dict) or not isinstance(output.get("results"), list):
            raise SemgrepOutputError("Semgrep JSON must contain a results list")
        errors = output.get("errors", [])
        if errors:
            raise SemgrepExecutionError(f"Semgrep reported scanner errors: {errors}")
        return output
