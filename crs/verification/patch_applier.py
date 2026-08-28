from __future__ import annotations
"""Atomic, in-process application of one validated unified diff."""

from pathlib import Path, PurePosixPath, PureWindowsPath
import re

from crs.core.schemas import PatchProposal


class PatchApplicationError(ValueError):
    """Raised when a patch cannot be applied completely and safely."""


class PatchApplier:
    """Apply a single-file patch only inside an ephemeral workspace."""

    HUNK_HEADER = re.compile(
        r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$"
    )

    def apply(self, workspace_root: str | Path, patch: PatchProposal) -> Path:
        """Apply ``patch`` atomically in memory, then write the completed file."""

        root = Path(workspace_root).resolve()
        if not root.is_dir():
            raise PatchApplicationError(f"Workspace root is not a directory: {root}")
        relative = self._safe_relative_path(patch.target_file)
        target = (root / relative).resolve()
        if not target.is_relative_to(root):
            raise PatchApplicationError("Patch target escapes the temporary workspace")
        if not target.is_file():
            raise PatchApplicationError(f"Patch target does not exist: {relative}")

        lines = patch.unified_diff.splitlines()
        header_indexes = [
            index
            for index, line in enumerate(lines[:-1])
            if line.startswith("--- ") and lines[index + 1].startswith("+++ ")
        ]
        if len(header_indexes) != 1:
            raise PatchApplicationError("Malformed patch: expected one file header")
        header_index = header_indexes[0]
        old_path = self._diff_path(lines[header_index][4:], "a/")
        new_path = self._diff_path(lines[header_index + 1][4:], "b/")
        if old_path != relative or new_path != relative:
            raise PatchApplicationError("Patch headers do not match the target file")

        hunks = self._parse_hunks(lines[header_index + 2 :])
        try:
            source_text = target.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            raise PatchApplicationError(f"Unable to read patch target: {target}") from exc
        source_lines = source_text.splitlines()
        trailing_newline = source_text.endswith(("\n", "\r"))
        result: list[str] = []
        source_index = 0

        for old_start, hunk_lines in hunks:
            hunk_start = old_start - 1 if old_start > 0 else 0
            if hunk_start < source_index or hunk_start > len(source_lines):
                raise PatchApplicationError("Patch hunk location is invalid or overlaps")
            result.extend(source_lines[source_index:hunk_start])
            source_index = hunk_start
            for marker, content in hunk_lines:
                if marker in {" ", "-"}:
                    if source_index >= len(source_lines) or source_lines[source_index] != content:
                        raise PatchApplicationError(
                            "Patch context does not match the target file"
                        )
                    if marker == " ":
                        result.append(content)
                    source_index += 1
                elif marker == "+":
                    result.append(content)
        result.extend(source_lines[source_index:])
        output = "\n".join(result)
        if trailing_newline:
            output += "\n"
        try:
            target.write_text(output, encoding="utf-8", newline="")
        except OSError as exc:
            raise PatchApplicationError(f"Unable to write patched file: {target}") from exc
        return target

    def _parse_hunks(self, lines: list[str]) -> list[tuple[int, list[tuple[str, str]]]]:
        if not lines:
            raise PatchApplicationError("Malformed patch: missing hunk")
        hunks: list[tuple[int, list[tuple[str, str]]]] = []
        index = 0
        while index < len(lines):
            match = self.HUNK_HEADER.fullmatch(lines[index])
            if not match:
                raise PatchApplicationError("Malformed patch hunk header")
            old_start = int(match.group(1))
            old_expected = int(match.group(2) or 1)
            new_expected = int(match.group(4) or 1)
            old_seen = new_seen = 0
            body: list[tuple[str, str]] = []
            index += 1
            while index < len(lines) and not lines[index].startswith("@@ "):
                line = lines[index]
                if line.startswith("\\ No newline at end of file"):
                    index += 1
                    continue
                if not line or line[0] not in {" ", "+", "-"}:
                    raise PatchApplicationError("Malformed patch hunk line")
                marker, content = line[0], line[1:]
                body.append((marker, content))
                old_seen += marker in {" ", "-"}
                new_seen += marker in {" ", "+"}
                index += 1
            if old_seen != old_expected or new_seen != new_expected:
                raise PatchApplicationError("Patch hunk line counts do not match header")
            if not any(marker in {"+", "-"} for marker, _ in body):
                raise PatchApplicationError("Patch hunk contains no change")
            hunks.append((old_start, body))
        return hunks

    @classmethod
    def _diff_path(cls, header_value: str, prefix: str) -> Path:
        raw = header_value.split("\t", maxsplit=1)[0].strip()
        if not raw.startswith(prefix):
            raise PatchApplicationError(f"Patch path must start with {prefix}")
        return cls._safe_relative_path(raw[len(prefix) :])

    @staticmethod
    def _safe_relative_path(value: str) -> Path:
        normalized = value.replace("\\", "/")
        if (
            not normalized
            or PurePosixPath(normalized).is_absolute()
            or PureWindowsPath(value).is_absolute()
        ):
            raise PatchApplicationError("Absolute or empty patch paths are not allowed")
        if ".." in PurePosixPath(normalized).parts:
            raise PatchApplicationError("Patch path traversal is not allowed")
        return Path(*PurePosixPath(normalized).parts)
