"""End-to-end composition for the AIKavach CRS MVP workflow."""

from crs.core.schemas import CRSRunResult
from crs.ingestion.repository_loader import RepositoryLoader
from crs.patching.patch_generator import PatchGenerator, PatchLLMClient
from crs.patching.patch_validator import PatchValidator
from crs.reasoning.evidence_builder import EvidenceBuilder
from crs.reasoning.llm_client import LLMClient
from crs.reasoning.reasoning_engine import ReasoningEngine
from crs.static_analysis.scanner import StaticScanner
from crs.verification.verification_engine import VerificationEngine


class PipelineError(RuntimeError):
    """Raised when an MVP pipeline stage cannot produce a result."""

    def __init__(self, stage: str, message: str) -> None:
        self.stage = stage
        super().__init__(f"{stage}: {message}")


class NoFindingsError(PipelineError):
    """Raised when deterministic scanning produces no demo finding."""


class CRSPipeline:
    """Compose existing Find, Reason, Patch, and Verify components."""

    def __init__(
        self,
        reasoning_client: LLMClient,
        patch_client: PatchLLMClient,
        repository_loader: RepositoryLoader | None = None,
        scanner: StaticScanner | None = None,
        evidence_builder: EvidenceBuilder | None = None,
        patch_validator: PatchValidator | None = None,
        verifier: VerificationEngine | None = None,
    ) -> None:
        self.repository_loader = repository_loader or RepositoryLoader()
        self.scanner = scanner or StaticScanner()
        self.evidence_builder = evidence_builder or EvidenceBuilder()
        self.reasoning_engine = ReasoningEngine(
            reasoning_client, evidence_builder=self.evidence_builder
        )
        self.patch_validator = patch_validator or PatchValidator()
        self.patch_generator = PatchGenerator(
            patch_client, validator=self.patch_validator
        )
        self.verifier = verifier or VerificationEngine(
            patch_validator=self.patch_validator
        )

    def run(self, repository_root: str) -> CRSRunResult:
        """Run the complete MVP against one repository without modifying it."""

        try:
            target = self.repository_loader.load(repository_root)
            findings = self.scanner.scan(target.path)
        except Exception as exc:
            raise PipelineError("FIND", str(exc)) from exc
        if not findings:
            raise NoFindingsError("FIND", "No vulnerability findings were detected")
        finding = findings[0]

        try:
            evidence = self.evidence_builder.build(
                finding, target.path, target.repository_hash
            )
            reasoning = self.reasoning_engine.reason_from_evidence(evidence)
        except Exception as exc:
            raise PipelineError("REASON", str(exc)) from exc

        try:
            patch = self.patch_generator.generate(
                finding, reasoning, evidence.code_context
            )
            validation = self.patch_validator.validate(
                patch,
                finding,
                repository_root=target.path,
                intended_file=evidence.code_context.file,
            )
            if not validation.valid:
                raise ValueError(validation.reason or "Patch proposal is invalid")
        except Exception as exc:
            raise PipelineError("PATCH", str(exc)) from exc

        try:
            verification = self.verifier.verify(target.path, finding, patch)
        except Exception as exc:
            raise PipelineError("VERIFY", str(exc)) from exc

        return CRSRunResult(
            target=target,
            finding=finding,
            reasoning=reasoning,
            patch=patch,
            verification=verification,
        )


Orchestrator = CRSPipeline
