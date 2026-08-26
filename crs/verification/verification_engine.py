"""Fail-closed orchestration for isolated patch verification."""

from pathlib import Path
from typing import Callable

from crs.core.schemas import PatchProposal, VerificationResult, VulnerabilityFinding
from crs.patching.patch_validator import PatchValidator
from crs.verification.patch_applier import PatchApplier
from crs.verification.security_verifier import SecurityVerifier
from crs.verification.test_runner import TestRunner
from crs.verification.workspace import EphemeralWorkspace


class VerificationEngine:
    """Apply and verify a proposal only within a disposable repository copy."""

    def __init__(
        self,
        patch_validator: PatchValidator | None = None,
        patch_applier: PatchApplier | None = None,
        test_runner: TestRunner | None = None,
        security_verifier: SecurityVerifier | None = None,
        workspace_factory: Callable[[str], EphemeralWorkspace] = EphemeralWorkspace,
    ) -> None:
        self.patch_validator = patch_validator or PatchValidator()
        self.patch_applier = patch_applier or PatchApplier()
        self.test_runner = test_runner or TestRunner()
        self.security_verifier = security_verifier or SecurityVerifier()
        self.workspace_factory = workspace_factory

    def verify(
        self,
        repository_root: str,
        original_finding: VulnerabilityFinding,
        patch: PatchProposal,
    ) -> VerificationResult:
        """Return deterministic approval while leaving the original untouched."""

        validation = self.patch_validator.validate(
            patch, original_finding, repository_root=repository_root
        )
        if not validation.valid:
            return self._rejected(f"Patch validation failed: {validation.reason}")

        build_passed = tests_passed = security_passed = rescan_clean = False
        try:
            with self.workspace_factory(repository_root) as workspace:
                if workspace.path is None:
                    raise RuntimeError("Temporary workspace was not created")
                patched_root = workspace.path
                self.patch_applier.apply(patched_root, patch)

                build = self.test_runner.syntax_check(
                    patched_root, patch.target_file
                )
                build_passed = build.passed
                if not build_passed:
                    return self._result(
                        build_passed, False, False, False, build.reason
                    )

                tests = self.test_runner.run_tests(patched_root)
                tests_passed = tests.passed
                if not tests_passed:
                    return self._result(True, False, False, False, tests.reason)

                security = self.security_verifier.run_regression(
                    patched_root, patch.target_file, original_finding
                )
                security_passed = security.passed
                if not security_passed:
                    return self._result(True, True, False, False, security.reason)

                rescan = self.security_verifier.rescan(
                    patched_root, patch.target_file, original_finding
                )
                rescan_clean = rescan.passed
                if not rescan_clean:
                    return self._result(True, True, True, False, rescan.reason)
        except Exception as exc:
            return self._result(
                build_passed,
                tests_passed,
                security_passed,
                rescan_clean,
                f"Verification failed closed: {exc}",
            )

        return self._result(
            True, True, True, True, "Patch verified in isolated workspace"
        )

    @staticmethod
    def _rejected(reason: str) -> VerificationResult:
        return VerificationEngine._result(False, False, False, False, reason)

    @staticmethod
    def _result(
        build: bool, tests: bool, security: bool, rescan: bool, reason: str
    ) -> VerificationResult:
        return VerificationResult(
            build_passed=build,
            tests_passed=tests,
            security_test_passed=security,
            static_rescan_clean=rescan,
            approved=build and tests and security and rescan,
            reason=reason,
        )
