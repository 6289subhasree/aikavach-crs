"""Orchestrate evidence construction, prompt guarding, and structured reasoning."""

from crs.core.schemas import EvidencePackage, ReasoningResult, VulnerabilityFinding
from crs.guardrails.prompt_firewall import PromptFirewall
from crs.reasoning.evidence_builder import EvidenceBuilder
from crs.reasoning.llm_client import LLMClient, allowed_evidence_references


class ReasoningValidationError(ValueError):
    """Raised when model output is inconsistent with supplied evidence."""


class ReasoningEngine:
    """Run an injected, tool-free LLM client against guarded local evidence."""

    def __init__(
        self,
        llm_client: LLMClient,
        evidence_builder: EvidenceBuilder | None = None,
        prompt_firewall: PromptFirewall | None = None,
    ) -> None:
        self.llm_client = llm_client
        self.evidence_builder = evidence_builder or EvidenceBuilder()
        self.prompt_firewall = prompt_firewall or PromptFirewall()

    def reason(
        self,
        finding: VulnerabilityFinding,
        repository_root: str,
        repository_hash: str | None = None,
    ) -> ReasoningResult:
        evidence = self.evidence_builder.build(
            finding, repository_root, repository_hash
        )
        return self.reason_from_evidence(evidence)

    def reason_from_evidence(self, evidence: EvidencePackage) -> ReasoningResult:
        """Reason from an already-built package without rereading repository files."""

        finding = evidence.finding
        guarded_evidence = self._guard(evidence)
        result = ReasoningResult.model_validate(self.llm_client.reason(guarded_evidence))
        if result.finding_id != finding.finding_id:
            raise ReasoningValidationError(
                "Reasoning result finding_id does not match the input finding"
            )
        allowed_references = allowed_evidence_references(evidence)
        unknown = set(result.evidence_references) - allowed_references
        if unknown:
            raise ReasoningValidationError(
                f"Reasoning result contains unsupported evidence references: {sorted(unknown)}"
            )
        return result

    def _guard(self, evidence: EvidencePackage) -> EvidencePackage:
        wrapped = self.prompt_firewall.wrap_untrusted_code(evidence.code_context)
        instructions = dict(evidence.instructions or {})
        instructions["system_prompt"] = self.prompt_firewall.SYSTEM_INSTRUCTIONS
        return evidence.model_copy(
            update={
                "code_context": evidence.code_context.model_copy(
                    update={"content": wrapped}
                ),
                "instructions": instructions,
            }
        )
