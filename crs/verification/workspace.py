from __future__ import annotations
"""Temporary repository copies for side-effect-free verification."""

import os
from pathlib import Path
import shutil
import tempfile
from types import TracebackType


class EphemeralWorkspace:
    """Copy a repository into a cleaned-up temporary directory."""

    IGNORED_DIRECTORIES = {
        ".git",
        ".venv",
        "venv",
        "__pycache__",
        ".pytest_cache",
        "node_modules",
        "dist",
        "build",
    }

    def __init__(self, repository_root: str) -> None:
        self.repository_root = Path(repository_root).expanduser().resolve()
        self._temporary_directory: tempfile.TemporaryDirectory[str] | None = None
        self.path: Path | None = None

    def __enter__(self) -> "EphemeralWorkspace":
        if not self.repository_root.is_dir():
            raise NotADirectoryError(
                f"Repository root is not a directory: {self.repository_root}"
            )
        self._temporary_directory = tempfile.TemporaryDirectory(
            prefix="aikavach-verification-"
        )
        destination = Path(self._temporary_directory.name) / self.repository_root.name
        try:
            shutil.copytree(
                self.repository_root,
                destination,
                ignore=self._ignore_entries,
                symlinks=True,
            )
        except Exception:
            self._temporary_directory.cleanup()
            self._temporary_directory = None
            raise
        self.path = destination
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        if self._temporary_directory is not None:
            self._temporary_directory.cleanup()
        self._temporary_directory = None
        self.path = None

    def _ignore_entries(self, directory: str, names: list[str]) -> set[str]:
        """Skip generated directories and every symlink without following it."""

        current = Path(directory)
        return {
            name
            for name in names
            if name in self.IGNORED_DIRECTORIES or os.path.islink(current / name)
        }
