from __future__ import annotations
"""Load source repositories into the common analysis target schema."""

from collections.abc import Iterable
import hashlib
import os
from pathlib import Path

from crs.core.schemas import AnalysisTarget


class RepositoryLoader:
    """Inspect a source directory and describe its analysis-ready contents."""

    EXTENSION_LANGUAGES = {
        ".py": "Python",
        ".c": "C",
        ".h": "C",
        ".cpp": "C++",
        ".cc": "C++",
        ".hpp": "C++",
        ".java": "Java",
        ".js": "JavaScript",
        ".ts": "TypeScript",
        ".go": "Go",
        ".rs": "Rust",
    }
    IGNORED_DIRECTORIES = {
        ".git",
        ".venv",
        "venv",
        "__pycache__",
        "node_modules",
        "dist",
        "build",
        ".pytest_cache",
    }

    def load(self, path: str) -> AnalysisTarget:
        """Validate and inspect ``path``, returning its normalized metadata."""

        target_path = Path(path).expanduser()
        if not target_path.exists():
            raise FileNotFoundError(f"Repository path does not exist: {path}")
        if not target_path.is_dir():
            raise NotADirectoryError(f"Repository path is not a directory: {path}")

        target_path = target_path.resolve()
        files = self._readable_files(target_path, self._discover_files(target_path))
        languages = sorted(
            {self.EXTENSION_LANGUAGES[file.suffix.lower()] for file, _ in files}
        )

        return AnalysisTarget(
            name=target_path.name,
            path=str(target_path),
            languages=languages,
            file_count=len(files),
            repository_hash=self._repository_hash(target_path, files),
        )

    def _discover_files(self, root: Path) -> list[Path]:
        """Find supported source files while pruning ignored directories."""

        files: list[Path] = []
        for directory, directory_names, file_names in os.walk(root):
            directory_names[:] = [
                name for name in directory_names if name not in self.IGNORED_DIRECTORIES
            ]
            current_directory = Path(directory)
            files.extend(
                current_directory / name
                for name in file_names
                if Path(name).suffix.lower() in self.EXTENSION_LANGUAGES
            )
        return files

    @staticmethod
    def _readable_files(
        root: Path, files: Iterable[Path]
    ) -> list[tuple[Path, bytes]]:
        """Read files as bytes, skipping entries that cannot be read safely."""

        readable: list[tuple[Path, bytes]] = []
        for file in sorted(files, key=lambda item: item.relative_to(root).as_posix()):
            try:
                readable.append((file, file.read_bytes()))
            except OSError:
                continue
        return readable

    @staticmethod
    def _repository_hash(root: Path, files: list[tuple[Path, bytes]]) -> str:
        """Hash normalized relative paths and contents in deterministic order."""

        digest = hashlib.sha256()
        for file, content in files:
            relative_path = file.relative_to(root).as_posix().encode("utf-8")
            digest.update(len(relative_path).to_bytes(8, byteorder="big"))
            digest.update(relative_path)
            digest.update(len(content).to_bytes(8, byteorder="big"))
            digest.update(content)
        return digest.hexdigest()
