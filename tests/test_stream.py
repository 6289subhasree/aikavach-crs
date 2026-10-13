"""Tests for the dashboard NDJSON stream and the offline rules client."""

import io
import json
from pathlib import Path
import re

import pytest

from crs.orchestrator import CRSPipeline
from crs.patching.patch_validator import PatchValidator
from crs.reasoning.offline_client import OfflineRuleError, OfflineRulesClient
from crs.static_analysis.scanner import StaticScanner
from crs.stream import EventWriter, build_repo_map, run_stream
from crs.verification.security_verifier import SecurityVerifier
from crs.verification.verification_engine import VerificationEngine

VULNERABLE = (
    '"""Fixture."""\n'
    "\n"
    "import subprocess\n"
    "\n"
    "\n"
    "def run_user_command(command: str) -> None:\n"
    "    subprocess.run(command, shell=True, check=False)\n"
)


class RegexSemgrep:
    """Stand-in for the Semgrep CLI that matches the demo rule with a regex."""

    PATTERN = re.compile(r"subprocess\.\w+\(.*shell\s*=\s*True")

    def scan(self, target_path: str) -> dict:
        results = []
        for path in sorted(Path(target_path).rglob("*.py")):
            for number, line in enumerate(path.read_text().splitlines(), start=1):
                if self.PATTERN.search(line):
                    results.append(
                        {
                            "check_id": "aikavach.python.subprocess-shell-true",
                            "path": str(path),
                            "start": {"line": number, "col": 5},
                            "end": {"line": number, "col": 50},
                            "extra": {
                                "message": "subprocess uses shell=True",
                                "severity": "WARNING",
                                "lines": line,
                            },
                        }
                    )
        return {"results": results, "errors": []}


def pipeline_for(client) -> CRSPipeline:
    scanner = StaticScanner(runner=RegexSemgrep())
    validator = PatchValidator()
    verifier = VerificationEngine(
        patch_validator=validator, security_verifier=SecurityVerifier(scanner=scanner)
    )
    return CRSPipeline(
        reasoning_client=client,
        patch_client=client,
        scanner=scanner,
        patch_validator=validator,
        verifier=verifier,
    )


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "target"
    root.mkdir()
    (root / "app.py").write_text(VULNERABLE, encoding="utf-8")
    return root


def collect(repo: Path, tmp_path: Path, **kwargs):
    events: list[tuple[str, dict]] = []
    code = run_stream(
        str(repo),
        mode="offline",
        artifacts_dir=str(tmp_path / "artifacts"),
        emit=lambda kind, data: events.append((kind, data)),
        pipeline_factory=pipeline_for,
        **kwargs,
    )
    return code, events


def test_offline_stream_verifies_and_reports_every_stage(repo: Path, tmp_path: Path):
    code, events = collect(repo, tmp_path)
    kinds = [kind for kind, _ in events]

    assert code == 0
    assert kinds[0] == "hello"
    assert events[0][1]["provider"] == "offline-rules"
    for expected in ("repo_map", "target", "findings", "evidence", "reasoning", "patch", "verification", "artifacts", "done"):
        assert expected in kinds
    stages = [(d["stage"], d["status"]) for k, d in events if k == "stage"]
    assert stages == [
        ("FIND", "running"), ("FIND", "done"),
        ("REASON", "running"), ("REASON", "done"),
        ("PATCH", "running"), ("PATCH", "done"),
        ("VERIFY", "running"), ("VERIFY", "done"),
    ]
    checks = [d["check"] for k, d in events if k == "check"]
    assert checks == ["build", "tests", "security_regression", "static_rescan"]
    done = events[-1][1]
    assert done["decision"] == "VERIFIED"
    assert done["original_repository_modified"] is False
    assert (repo / "app.py").read_text() == VULNERABLE


def test_artifacts_include_labelled_provenance_sarif_and_signed_slsa(repo: Path, tmp_path: Path):
    _, events = collect(repo, tmp_path)
    artifacts = next(d for k, d in events if k == "artifacts")

    assert artifacts["provenance"]["reasoning"]["provider"] == "offline-rules"
    assert artifacts["sarif"]["version"] == "2.1.0"
    assert artifacts["slsa"]["signatures"][0]["sig"]
    assert "BEGIN PUBLIC KEY" in artifacts["slsa"]["publicKey"]
    assert (tmp_path / "artifacts" / "latest_run.json").is_file()


def test_clean_repository_reports_clean(tmp_path: Path):
    root = tmp_path / "clean"
    root.mkdir()
    (root / "ok.py").write_text("print('hi')\n", encoding="utf-8")
    code, events = collect(root, tmp_path)
    assert code == 0
    assert events[-1] == ("done", {"decision": "CLEAN", "elapsed": events[-1][1]["elapsed"]})


def test_missing_target_emits_error(tmp_path: Path):
    code, events = collect(tmp_path / "missing", tmp_path)
    assert code == 1
    assert events[-1][0] == "error"


def test_repo_map_describes_each_file(repo: Path):
    repo_map = build_repo_map(str(repo))
    assert repo_map["total_lines"] == 7
    entry = repo_map["files"][0]
    assert entry["path"] == "app.py"
    assert entry["line_count"] == 7
    assert entry["indent"][6] == 4


def test_event_writer_emits_one_json_object_per_line():
    buffer = io.StringIO()
    writer = EventWriter(buffer)
    writer("stage", {"stage": "FIND"})
    writer("done", {"decision": "VERIFIED"})
    lines = buffer.getvalue().splitlines()
    assert [json.loads(line)["type"] for line in lines] == ["stage", "done"]


def test_offline_client_patches_shell_true_line():
    client = OfflineRulesClient()
    payload = json.dumps({"content": "7:     subprocess.run(command, shell=True, check=False)"})
    prompt = "x\nPATCH_REQUEST_DATA\n" + json.dumps(
        {"affected_line": 7, "code_context": f"BEGIN\n{payload}\nEND"}
    )
    edit = client.generate_patch(prompt)
    assert edit.replacement_line == "    subprocess.run(command.split(), check=False)"


def test_offline_client_refuses_lines_without_shell_true():
    client = OfflineRulesClient()
    payload = json.dumps({"content": "3: os.system(cmd)"})
    prompt = "PATCH_REQUEST_DATA\n" + json.dumps(
        {"affected_line": 3, "code_context": payload}
    )
    with pytest.raises(OfflineRuleError):
        client.generate_patch(prompt)
