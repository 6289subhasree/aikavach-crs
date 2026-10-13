from __future__ import annotations
"""End-to-end composition for the AIKavach CRS MVP workflow."""

from collections.abc import Callable
from typing import Any

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


EventCallback = Callable[[str, dict[str, Any]], None]


def _noop(_event: str, _data: dict[str, Any]) -> None:
    return None


class CRSPipeline:
    """Compose existing Find, Reason, Patch, and Verify components with retry self-correction."""

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

    def run(
        self,
        repository_root: str,
        max_retries: int = 1,
        on_event: EventCallback | None = None,
    ) -> CRSRunResult:
        """Run the complete pipeline against one repository without modifying it.

        ``on_event`` receives stage progress for live dashboards. It is purely
        observational: nothing it does can influence the security decision.
        """

        emit = on_event or _noop
        emit("stage", {"stage": "FIND", "status": "running"})
        try:
            target = self.repository_loader.load(repository_root)
            emit("target", target.model_dump())
            findings = self.scanner.scan(target.path)
        except Exception as exc:
            raise PipelineError("FIND", str(exc)) from exc
        emit("findings", {"findings": [f.model_dump(mode="json") for f in findings]})
        if not findings:
            raise NoFindingsError("FIND", "No vulnerability findings were detected")
        finding = findings[0]
        emit("stage", {"stage": "FIND", "status": "done"})

        emit("stage", {"stage": "REASON", "status": "running"})
        try:
            evidence = self.evidence_builder.build(
                finding, target.path, target.repository_hash
            )
            emit("evidence", evidence.code_context.model_dump())
            reasoning = self.reasoning_engine.reason_from_evidence(evidence)
        except Exception as exc:
            raise PipelineError("REASON", str(exc)) from exc
        emit("reasoning", reasoning.model_dump())
        emit("stage", {"stage": "REASON", "status": "done"})

        last_error = None
        for attempt in range(max(1, max_retries)):
            emit("stage", {"stage": "PATCH", "status": "running", "attempt": attempt + 1})
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
                emit("patch", patch.model_dump())
                emit("stage", {"stage": "PATCH", "status": "done"})

                emit("stage", {"stage": "VERIFY", "status": "running"})
                verification = self.verifier.verify(
                    target.path,
                    finding,
                    patch,
                    on_check=lambda name, passed, reason: emit(
                        "check", {"check": name, "passed": passed, "reason": reason}
                    ),
                )
                emit("verification", verification.model_dump())
                emit("stage", {"stage": "VERIFY", "status": "done"})
                if verification.approved or attempt == max_retries - 1:
                    return CRSRunResult(
                        target=target,
                        finding=finding,
                        reasoning=reasoning,
                        patch=patch,
                        verification=verification,
                    )
                last_error = verification.reason
                emit("retry", {"attempt": attempt + 1, "reason": last_error})
            except Exception as exc:
                last_error = str(exc)
                if attempt == max_retries - 1:
                    raise PipelineError("PATCH", str(exc)) from exc

        raise PipelineError("VERIFY", f"Failed after {max_retries} attempts: {last_error}")


Orchestrator = CRSPipeline
