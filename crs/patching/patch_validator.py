"""Deterministic structural validation for unapplied unified diffs."""

from pathlib import Path, PurePosixPath, PureWindowsPath
import re

from crs.core.schemas import PatchProposal, PatchValidationResult, VulnerabilityFinding


class PatchValidator:
    """Reject patch proposals outside the Phase 5 single-file safety boundary."""

    HUNK_HEADER = re.compile(
        r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$"
    )

    def validate(
        self,
        proposal: PatchProposal,
        finding: VulnerabilityFinding,
        repository_root: str | None = None,
        intended_file: str | None = None,
    ) -> PatchValidationResult:
        """Validate metadata, paths, and unified-diff structure without applying it."""

        if proposal.finding_id != finding.finding_id:
            return self._invalid("Patch finding_id does not match the input finding")
        if not proposal.unified_diff.strip():
            return self._invalid("Unified diff must not be empty")

        expected, path_error = self._expected_file(
            finding, repository_root, intended_file
        )
        if path_error:
            return self._invalid(path_error)
        target, path_error = self._safe_relative_path(proposal.target_file)
        if path_error:
            return self._invalid(f"Invalid target_file: {path_error}")
        if target != expected:
            return self._invalid(
                f"Patch target_file does not match affected file: {expected}"
            )

        lines = proposal.unified_diff.splitlines()
        lowered = proposal.unified_diff.lower()
        if "git binary patch" in lowered or "binary files " in lowered:
            return self._invalid("Binary patches are not allowed")
        if any(line.startswith("deleted file mode ") for line in lines):
            return self._invalid("File deletion is not allowed")
        if any(line.startswith("new file mode ") for line in lines):
            return self._invalid("New file creation is not allowed")

        header_pairs = [
            index
            for index, line in enumerate(lines[:-1])
            if line.startswith("--- ") and lines[index + 1].startswith("+++ ")
        ]
        if len(header_pairs) != 1:
            return self._invalid("Malformed unified diff: expected exactly one file header")
        header_index = header_pairs[0]
        if any(
            line.startswith("diff --git ")
            for line in lines[header_index + 2 :]
        ):
            return self._invalid("Diff touches more than one file")

        old_raw = self._header_path(lines[header_index])
        new_raw = self._header_path(lines[header_index + 1])
        if old_raw == "/dev/null":
            return self._invalid("New file creation is not allowed")
        if new_raw == "/dev/null":
            return self._invalid("File deletion is not allowed")
        old_path, old_error = self._diff_path(old_raw, "a/")
        new_path, new_error = self._diff_path(new_raw, "b/")
        if old_error or new_error:
            return self._invalid(
                f"Invalid diff path: {old_error or new_error}"
            )
        files_touched = sorted({old_path, new_path})
        if old_path != new_path:
            return self._invalid("Diff renames or touches more than one file", files_touched)
        if old_path != expected:
            return self._invalid(
                f"Diff modifies unintended file: {old_path}", files_touched
            )

        hunk_error = self._validate_hunks(lines[header_index + 2 :])
        if hunk_error:
            return self._invalid(hunk_error, files_touched)
        return PatchValidationResult(valid=True, files_touched=files_touched)

    def _validate_hunks(self, lines: list[str]) -> str | None:
        if not lines or not lines[0].startswith("@@ "):
            return "Malformed unified diff: missing hunk header"
        index = 0
        hunk_count = 0
        while index < len(lines):
            match = self.HUNK_HEADER.fullmatch(lines[index])
            if not match:
                return "Malformed unified diff: invalid hunk header"
            hunk_count += 1
            old_expected = int(match.group(2) or 1)
            new_expected = int(match.group(4) or 1)
            old_seen = new_seen = 0
            changed = False
            index += 1
            while index < len(lines) and not lines[index].startswith("@@ "):
                line = lines[index]
                if line.startswith("\\ No newline at end of file"):
                    index += 1
                    continue
                if not line or line[0] not in {" ", "+", "-"}:
                    return "Malformed unified diff: invalid hunk line"
                if line[0] in {" ", "-"}:
                    old_seen += 1
                if line[0] in {" ", "+"}:
                    new_seen += 1
                changed = changed or line[0] in {"+", "-"}
                index += 1
            if old_seen != old_expected or new_seen != new_expected:
                return "Malformed unified diff: hunk line counts do not match header"
            if not changed:
                return "Malformed unified diff: hunk contains no change"
        return None if hunk_count else "Malformed unified diff: missing hunk"

    def _expected_file(
        self,
        finding: VulnerabilityFinding,
        repository_root: str | None,
        intended_file: str | None,
    ) -> tuple[str, str | None]:
        candidate = intended_file or finding.file
        if not candidate:
            return "", "Finding does not identify an affected file"
        path = Path(candidate).expanduser()
        if repository_root is not None:
            root = Path(repository_root).expanduser().resolve()
            if path.is_absolute():
                resolved = path.resolve()
            else:
                working_directory_path = path.resolve()
                resolved = (
                    working_directory_path
                    if working_directory_path.is_relative_to(root)
                    else (root / path).resolve()
                )
            if not resolved.is_relative_to(root):
                return "", "Affected file is outside repository root"
            candidate = resolved.relative_to(root).as_posix()
        return self._safe_relative_path(candidate)

    @classmethod
    def _diff_path(cls, raw_path: str, expected_prefix: str) -> tuple[str, str | None]:
        raw, error = cls._safe_relative_path(raw_path)
        if error:
            return "", error
        if not raw.startswith(expected_prefix):
            return "", f"path must start with {expected_prefix}"
        return cls._safe_relative_path(raw[len(expected_prefix) :])

    @staticmethod
    def _header_path(header: str) -> str:
        return header[4:].split("\t", maxsplit=1)[0].strip()

    @staticmethod
    def _safe_relative_path(value: str) -> tuple[str, str | None]:
        normalized = value.replace("\\", "/")
        if not normalized:
            return "", "path must not be empty"
        if PurePosixPath(normalized).is_absolute() or PureWindowsPath(value).is_absolute():
            return "", "absolute paths are not allowed"
        parts = PurePosixPath(normalized).parts
        if ".." in parts:
            return "", "path traversal is not allowed"
        if "." in parts:
            parts = tuple(part for part in parts if part != ".")
        return PurePosixPath(*parts).as_posix(), None

    @staticmethod
    def _invalid(
        reason: str, files_touched: list[str] | None = None
    ) -> PatchValidationResult:
        return PatchValidationResult(
            valid=False, reason=reason, files_touched=files_touched or []
        )
