"""Normalize raw Semgrep findings into shared CRS security schemas."""

import hashlib
import re
from typing import Any

from crs.core.schemas import Evidence, Severity, VulnerabilityFinding


class SemgrepNormalizationError(ValueError):
    """Raised when raw Semgrep output has an invalid structural shape."""


class SemgrepNormalizer:
    """Translate Semgrep JSON findings into deterministic CRS findings.

    Confidence values are initial scanner-confidence constants. A later phase can
    replace them with multi-source evidence scoring. Missing or unknown Semgrep
    severities conservatively fall back to INFO and its 0.65 confidence value.
    """

    SEVERITY_MAP = {
        "INFO": Severity.INFO,
        "WARNING": Severity.MEDIUM,
        "ERROR": Severity.HIGH,
    }
    CONFIDENCE_MAP = {
        "INFO": 0.65,
        "WARNING": 0.80,
        "ERROR": 0.90,
    }

    def normalize_results(
        self, raw_output: dict[str, Any]
    ) -> list[VulnerabilityFinding]:
        """Normalize every finding in a Semgrep JSON result document."""

        results = raw_output.get("results")
        if not isinstance(results, list):
            raise SemgrepNormalizationError("Semgrep output must contain a results list")
        return [self.normalize(result) for result in results]

    def normalize(self, result: dict[str, Any]) -> VulnerabilityFinding:
        """Normalize one raw Semgrep result, tolerating absent optional fields."""

        if not isinstance(result, dict):
            raise SemgrepNormalizationError("Each Semgrep result must be an object")

        check_id = self._text(result.get("check_id")) or "unknown-rule"
        file_path = self._normalized_path(result.get("path"))
        start_line = self._line(result.get("start"))
        end_line = self._line(result.get("end"))
        extra = result.get("extra")
        if not isinstance(extra, dict):
            extra = {}
        message = self._text(extra.get("message")) or f"Semgrep finding: {check_id}"
        raw_severity = (self._text(extra.get("severity")) or "INFO").upper()
        severity = self.SEVERITY_MAP.get(raw_severity, Severity.INFO)
        confidence = self.CONFIDENCE_MAP.get(raw_severity, 0.65)

        return VulnerabilityFinding(
            finding_id=self._finding_id(check_id, file_path, start_line),
            title=message,
            vulnerability_type=self._vulnerability_type(check_id),
            severity=severity,
            confidence=confidence,
            file=file_path,
            line_start=start_line,
            line_end=end_line,
            evidence=[
                Evidence(
                    source="semgrep",
                    description=message,
                    file=file_path,
                    line=start_line,
                    raw_reference=check_id,
                )
            ],
        )

    @staticmethod
    def _text(value: object) -> str | None:
        return value if isinstance(value, str) and value else None

    @classmethod
    def _normalized_path(cls, value: object) -> str | None:
        path = cls._text(value)
        if path is None:
            return None
        normalized = path.replace("\\", "/")
        while normalized.startswith("./"):
            normalized = normalized[2:]
        return normalized

    @staticmethod
    def _line(value: object) -> int | None:
        if not isinstance(value, dict):
            return None
        line = value.get("line")
        return line if isinstance(line, int) and not isinstance(line, bool) else None

    @staticmethod
    def _vulnerability_type(check_id: str) -> str:
        concise_id = check_id.rsplit(".", maxsplit=1)[-1]
        words = re.sub(r"[-_]+", " ", concise_id).strip()
        return words.title() or "Unknown"

    @staticmethod
    def _finding_id(check_id: str, file_path: str | None, line: int | None) -> str:
        identity = "\0".join(
            ("semgrep", check_id, file_path or "", str(line) if line is not None else "")
        )
        identifier = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:8].upper()
        return f"SF-{identifier}"
