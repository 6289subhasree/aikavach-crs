"""Tests for isolated repository copying and cleanup."""

from pathlib import Path

import pytest

from crs.verification.workspace import EphemeralWorkspace


def test_workspace_is_created_copied_and_cleaned(tmp_path: Path) -> None:
    repository = tmp_path / "repository"
    repository.mkdir()
    (repository / "app.py").write_text("original\n", encoding="utf-8")
    (repository / ".git").mkdir()
    (repository / ".git" / "config").write_text("ignored", encoding="utf-8")

    with EphemeralWorkspace(str(repository)) as workspace:
        assert workspace.path is not None
        copied_root = workspace.path
        assert copied_root.is_dir()
        assert (copied_root / "app.py").read_text(encoding="utf-8") == "original\n"
        assert not (copied_root / ".git").exists()
        (copied_root / "app.py").write_text("patched\n", encoding="utf-8")

    assert not copied_root.exists()
    assert (repository / "app.py").read_text(encoding="utf-8") == "original\n"


def test_workspace_cleans_up_after_exception(tmp_path: Path) -> None:
    repository = tmp_path / "repository"
    repository.mkdir()
    (repository / "app.py").write_text("original\n", encoding="utf-8")
    copied_root: Path | None = None

    with pytest.raises(RuntimeError, match="forced"):
        with EphemeralWorkspace(str(repository)) as workspace:
            copied_root = workspace.path
            raise RuntimeError("forced")

    assert copied_root is not None
    assert not copied_root.exists()


def test_workspace_does_not_copy_symlinks(tmp_path: Path) -> None:
    repository = tmp_path / "repository"
    repository.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_text("secret", encoding="utf-8")
    link = repository / "outside-link"
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("Symlink creation is unavailable on this host")

    with EphemeralWorkspace(str(repository)) as workspace:
        assert workspace.path is not None
        assert not (workspace.path / "outside-link").exists()
