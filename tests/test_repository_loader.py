"""Tests for source repository ingestion."""

from pathlib import Path

import pytest

from crs.ingestion.repository_loader import RepositoryLoader


def test_loads_small_temporary_repository(tmp_path: Path) -> None:
    (tmp_path / "main.py").write_text("print('hello')\n", encoding="utf-8")
    (tmp_path / "README.md").write_text("Documentation\n", encoding="utf-8")

    target = RepositoryLoader().load(str(tmp_path))

    assert target.name == tmp_path.name
    assert target.path == str(tmp_path.resolve())
    assert target.file_count == 1
    assert target.repository_hash is not None
    assert len(target.repository_hash) == 64


def test_detects_python(tmp_path: Path) -> None:
    (tmp_path / "module.py").write_text("VALUE = 1\n", encoding="utf-8")

    target = RepositoryLoader().load(str(tmp_path))

    assert target.languages == ["Python"]


def test_detects_multiple_languages_in_sorted_order(tmp_path: Path) -> None:
    (tmp_path / "service.go").write_text("package main\n", encoding="utf-8")
    (tmp_path / "app.py").write_text("pass\n", encoding="utf-8")
    (tmp_path / "index.ts").write_text("export {};\n", encoding="utf-8")
    (tmp_path / "header.h").write_text("#pragma once\n", encoding="utf-8")

    target = RepositoryLoader().load(str(tmp_path))

    assert target.languages == ["C", "Go", "Python", "TypeScript"]
    assert target.file_count == 4


def test_ignores_internal_directories(tmp_path: Path) -> None:
    (tmp_path / "main.py").write_text("pass\n", encoding="utf-8")
    for directory in (".git", "__pycache__"):
        ignored = tmp_path / directory
        ignored.mkdir()
        (ignored / "ignored.py").write_text("raise RuntimeError\n", encoding="utf-8")

    target = RepositoryLoader().load(str(tmp_path))

    assert target.file_count == 1


def test_hash_is_independent_of_discovery_order(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    first = tmp_path / "first.py"
    second = tmp_path / "second.py"
    first.write_text("FIRST = 1\n", encoding="utf-8")
    second.write_text("SECOND = 2\n", encoding="utf-8")
    loader = RepositoryLoader()
    expected_hash = loader.load(str(tmp_path)).repository_hash

    monkeypatch.setattr(loader, "_discover_files", lambda _: [second, first])

    assert loader.load(str(tmp_path)).repository_hash == expected_hash


def test_hash_changes_when_relevant_content_changes(tmp_path: Path) -> None:
    source = tmp_path / "main.py"
    source.write_text("VALUE = 1\n", encoding="utf-8")
    loader = RepositoryLoader()
    original_hash = loader.load(str(tmp_path)).repository_hash

    source.write_text("VALUE = 2\n", encoding="utf-8")

    assert loader.load(str(tmp_path)).repository_hash != original_hash


def test_nonexistent_path_is_rejected(tmp_path: Path) -> None:
    missing = tmp_path / "missing"

    with pytest.raises(FileNotFoundError):
        RepositoryLoader().load(str(missing))


def test_file_path_is_rejected(tmp_path: Path) -> None:
    file_path = tmp_path / "file.py"
    file_path.write_text("pass\n", encoding="utf-8")

    with pytest.raises(NotADirectoryError):
        RepositoryLoader().load(str(file_path))
