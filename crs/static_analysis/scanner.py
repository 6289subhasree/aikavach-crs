"""Orchestration for deterministic repository static analysis."""

from crs.core.schemas import VulnerabilityFinding
from crs.ingestion.repository_loader import RepositoryLoader
from crs.static_analysis.normalizer import SemgrepNormalizer
from crs.static_analysis.semgrep_runner import SemgrepRunner


class StaticScanner:
    """Validate a repository, run Semgrep, and normalize its findings."""

    def __init__(
        self,
        repository_loader: RepositoryLoader | None = None,
        runner: SemgrepRunner | None = None,
        normalizer: SemgrepNormalizer | None = None,
    ) -> None:
        self.repository_loader = repository_loader or RepositoryLoader()
        self.runner = runner or SemgrepRunner()
        self.normalizer = normalizer or SemgrepNormalizer()

    def scan(self, target_path: str) -> list[VulnerabilityFinding]:
        """Run the static-analysis pipeline for a repository directory."""

        target = self.repository_loader.load(target_path)
        raw_output = self.runner.scan(target.path)
        return self.normalizer.normalize_results(raw_output)
