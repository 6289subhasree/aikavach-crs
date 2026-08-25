"""Provider-neutral reasoning client contracts and deterministic test client."""

from collections.abc import Callable
from typing import Protocol

from crs.core.schemas import EvidencePackage, ReasoningResult


def allowed_evidence_references(evidence: EvidencePackage) -> set[str]:
    """Return identifiers a model may cite for this evidence package."""

    references = {evidence.code_context.file}
    finding = evidence.finding
    if finding.file:
        references.add(finding.file)
    for item in evidence.scanner_evidence:
        if item.raw_reference:
            references.add(item.raw_reference)
        if item.file:
            references.add(item.file)
        if item.file and item.line:
            references.add(f"{item.file}:{item.line}")
            references.add(f"{evidence.code_context.file}:{item.line}")
    references.add(
        f"{evidence.code_context.file}:{evidence.code_context.start_line}-{evidence.code_context.end_line}"
    )
    if finding.line_start:
        references.add(f"{evidence.code_context.file}:{finding.line_start}")
        end = finding.line_end or finding.line_start
        references.add(f"{evidence.code_context.file}:{finding.line_start}-{end}")
    return references


class LLMClient(Protocol):
    """Minimal interface for a structured vulnerability reasoning provider."""

    def reason(self, evidence: EvidencePackage) -> ReasoningResult:
        """Return a structured result derived only from supplied evidence."""
        ...


class FakeLLMClient:
    """Deterministic, network-free reasoning client for tests and local wiring."""

    def __init__(
        self,
        result: ReasoningResult
        | dict[str, object]
        | Callable[[EvidencePackage], ReasoningResult | dict[str, object]]
        | None = None,
    ) -> None:
        self.result = result
        self.last_evidence: EvidencePackage | None = None

    def reason(self, evidence: EvidencePackage) -> ReasoningResult:
        self.last_evidence = evidence
        candidate = self.result(evidence) if callable(self.result) else self.result
        if candidate is None:
            finding = evidence.finding
            references = [
                item.raw_reference
                for item in evidence.scanner_evidence
                if item.raw_reference is not None
            ]
            references.append(
                f"{evidence.code_context.file}:{finding.line_start or evidence.code_context.start_line}"
            )
            candidate = {
                "finding_id": finding.finding_id,
                "vulnerability_class": finding.vulnerability_type,
                "root_cause": finding.title,
                "security_impact": "Security impact requires review of the supplied evidence.",
                "remediation_strategy": "Use a safer API pattern and validate untrusted input.",
                "assumptions": [],
                "evidence_references": references,
                "confidence": finding.confidence,
            }
        return ReasoningResult.model_validate(candidate)
