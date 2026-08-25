"""Shared data contracts for the AIKavach CRS pipeline."""

from enum import Enum

from pydantic import BaseModel, Field, model_validator


class Severity(str, Enum):
    """Standard severity levels used to prioritize security findings."""

    INFO = "INFO"
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


class Evidence(BaseModel):
    """A traceable observation supporting a vulnerability finding."""

    source: str
    description: str
    file: str | None = None
    line: int | None = None
    raw_reference: str | None = None


class VulnerabilityFinding(BaseModel):
    """A normalized security finding shared by analysis and remediation stages."""

    finding_id: str
    title: str
    vulnerability_type: str
    severity: Severity
    confidence: float = Field(ge=0.0, le=1.0)
    file: str | None = None
    line_start: int | None = None
    line_end: int | None = None
    evidence: list[Evidence]
    exploit_reproduced: bool = False
    root_cause: str | None = None
    proposed_fix: str | None = None


class CodeContext(BaseModel):
    """A bounded source excerpt that must be treated as untrusted data."""

    file: str
    start_line: int = Field(ge=1)
    end_line: int = Field(ge=1)
    content: str
    trust_level: str = "UNTRUSTED_REPOSITORY_CONTENT"

    @model_validator(mode="after")
    def validate_line_range(self) -> "CodeContext":
        if self.end_line < self.start_line:
            raise ValueError("Code context end_line must not precede start_line")
        return self


class EvidencePackage(BaseModel):
    """Compact evidence supplied to a guarded reasoning provider."""

    finding: VulnerabilityFinding
    code_context: CodeContext
    scanner_evidence: list[Evidence]
    repository_hash: str | None = None
    instructions: dict[str, str] | None = None


class ReasoningResult(BaseModel):
    """Schema-validated vulnerability reasoning, not proof of exploitation."""

    finding_id: str
    vulnerability_class: str
    root_cause: str
    security_impact: str
    remediation_strategy: str
    assumptions: list[str]
    evidence_references: list[str]
    confidence: float = Field(ge=0.0, le=1.0)


class PatchProposal(BaseModel):
    """An unapplied candidate source change proposed for one finding."""

    finding_id: str
    target_file: str
    rationale: str
    unified_diff: str
    expected_security_effect: str
    confidence: float = Field(ge=0.0, le=1.0)


class PatchValidationResult(BaseModel):
    """Deterministic structural validation of an unapplied patch proposal."""

    valid: bool
    reason: str | None = None
    files_touched: list[str]


class AnalysisTarget(BaseModel):
    """Repository metadata describing the codebase submitted for analysis."""

    name: str
    path: str
    languages: list[str]
    file_count: int
    repository_hash: str | None = None


class VerificationResult(BaseModel):
    """Outcome of checks used to decide whether a proposed fix is acceptable."""

    build_passed: bool
    tests_passed: bool
    security_test_passed: bool
    static_rescan_clean: bool
    approved: bool
    reason: str | None = None


class CRSRunResult(BaseModel):
    """Structured outcome of one complete Find-Reason-Patch-Verify run."""

    target: AnalysisTarget
    finding: VulnerabilityFinding
    reasoning: ReasoningResult
    patch: PatchProposal
    verification: VerificationResult
