from __future__ import annotations
"""Deterministic, model-free reasoning and patch client for offline demos.

This is not an LLM. It encodes fixed remediation knowledge for the vulnerability
classes AIKavach's verifier supports, so the full Find -> Reason -> Patch ->
Verify loop can be demonstrated on machines without Ollama. Every record it
produces is labelled ``offline-rules`` so it is never mistaken for model output.
The verification harness treats its proposals exactly like a model's: nothing
is accepted without passing every check.
"""

import json
import re

from crs.core.schemas import EvidencePackage, PatchEdit, ReasoningResult
from crs.reasoning.llm_client import allowed_evidence_references


class OfflineRuleError(ValueError):
    """Raised when no offline rule covers the requested finding."""


class OfflineRulesClient:
    """Rule-based stand-in for the reasoning and patch model."""

    provider = "offline-rules"
    model = "offline-rules"

    SHELL_TRUE = re.compile(r",\s*shell\s*=\s*True\b")
    FIRST_ARG = re.compile(r"(subprocess\.\w+\(\s*)([A-Za-z_][\w.]*)(\s*,)")
    LINE = re.compile(r"^(\d+): ?(.*)$")

    def reason(self, evidence: EvidencePackage) -> ReasoningResult:
        finding = evidence.finding
        if not self._is_shell_true(finding.vulnerability_type, evidence):
            raise OfflineRuleError(
                f"No offline rule for {finding.vulnerability_type}; use Ollama mode"
            )
        allowed = allowed_evidence_references(evidence)
        location = f"{evidence.code_context.file}:{finding.line_start}"
        references = sorted(
            ref
            for ref in {location, *(e.raw_reference for e in evidence.scanner_evidence if e.raw_reference)}
            if ref in allowed
        )
        return ReasoningResult(
            finding_id=finding.finding_id,
            vulnerability_class="OS command injection (CWE-78)",
            root_cause=(
                "A command string reaches subprocess with shell=True, so the system "
                "shell interprets metacharacters such as ; | && and $()."
            ),
            security_impact=(
                "Anyone controlling the input can chain arbitrary commands and run "
                "them with the application's privileges."
            ),
            remediation_strategy=(
                "Pass an argument list instead of a shell string and drop shell=True, "
                "so input is never parsed by a shell."
            ),
            assumptions=["The command argument may contain untrusted input."],
            evidence_references=references,
            confidence=0.9,
        )

    def generate_patch(self, prompt: str) -> PatchEdit:
        request = self._request(prompt)
        line_number = int(request["affected_line"])
        source = self._affected_source(request["code_context"], line_number)
        if not self.SHELL_TRUE.search(source):
            raise OfflineRuleError("Affected line has no shell=True argument to remove")
        patched = self.SHELL_TRUE.sub("", source, count=1)
        patched = self.FIRST_ARG.sub(
            lambda m: f"{m.group(1)}{m.group(2)}.split(){m.group(3)}", patched, count=1
        )
        return PatchEdit(replacement_line=patched)

    @staticmethod
    def _is_shell_true(vulnerability_type: str, evidence: EvidencePackage) -> bool:
        if "shell" in vulnerability_type.lower():
            return True
        return any(
            e.raw_reference and "subprocess-shell-true" in e.raw_reference
            for e in evidence.scanner_evidence
        )

    @staticmethod
    def _request(prompt: str) -> dict:
        marker = "PATCH_REQUEST_DATA\n"
        if marker not in prompt:
            raise OfflineRuleError("Patch prompt is missing its request data")
        return json.loads(prompt.split(marker, 1)[1])

    @classmethod
    def _affected_source(cls, guarded_context: str, line_number: int) -> str:
        for raw in guarded_context.splitlines():
            raw = raw.strip()
            if not raw.startswith("{"):
                continue
            payload = json.loads(raw)
            for line in str(payload.get("content", "")).splitlines():
                match = cls.LINE.fullmatch(line)
                if match and int(match.group(1)) == line_number:
                    return match.group(2)
        raise OfflineRuleError(f"Line {line_number} is not in the supplied evidence")
