from __future__ import annotations
"""Run the CRS pipeline and stream progress as newline-delimited JSON.

This is the bridge the VAYU dashboard uses: its Next.js API route spawns
``python -m crs.stream <target>`` and forwards each stdout line to the browser.
Every line is one JSON object: ``{"type": ..., "t": seconds, "data": {...}}``.
Events only report what the pipeline did; they never influence its decision.

Usage:
    python -m crs.stream samples/vulnerable/command_injection --mode auto
"""

import argparse
from collections.abc import Callable
import json
import os
from pathlib import Path
import sys
from time import perf_counter
from typing import Any
import urllib.error
import urllib.request

from crs.cicd.ci_runner import export_sarif_report, format_github_annotations
from crs.ingestion.repository_loader import RepositoryLoader
from crs.orchestrator import CRSPipeline, NoFindingsError, PipelineError
from crs.reasoning.offline_client import OfflineRulesClient
from crs.reasoning.ollama_config import DEFAULT_OLLAMA_URL, load_ollama_config
from crs.reporting.provenance import build_run_provenance, write_run_provenance

MAX_MAP_FILES = 240
MAX_MAP_LINES = 400


class EventWriter:
    """Serialize events to a text stream, one flushed JSON object per line."""

    def __init__(self, stream=sys.stdout) -> None:
        self.stream = stream
        self.started = perf_counter()

    def __call__(self, event_type: str, data: dict[str, Any]) -> None:
        line = json.dumps(
            {"type": event_type, "t": round(perf_counter() - self.started, 3), "data": data},
            default=str,
            ensure_ascii=False,
        )
        self.stream.write(line + "\n")
        self.stream.flush()


def build_repo_map(root: str) -> dict[str, Any]:
    """Describe every source file as a list of line lengths for visualization."""

    loader = RepositoryLoader()
    base = Path(root).expanduser().resolve()
    files = []
    total_lines = 0
    for path in sorted(loader._discover_files(base))[:MAX_MAP_FILES]:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        lines = text.splitlines()
        total_lines += len(lines)
        files.append(
            {
                "path": path.relative_to(base).as_posix(),
                "line_count": len(lines),
                "lines": [len(line.rstrip()) for line in lines[:MAX_MAP_LINES]],
                "indent": [len(line) - len(line.lstrip()) for line in lines[:MAX_MAP_LINES]],
            }
        )
    return {"root": base.name, "files": files, "total_lines": total_lines}


def ollama_available(base_url: str, timeout: float = 1.5) -> bool:
    try:
        with urllib.request.urlopen(f"{base_url.rstrip('/')}/api/tags", timeout=timeout) as response:
            return response.status == 200
    except (urllib.error.URLError, OSError, ValueError):
        return False


def select_clients(mode: str) -> tuple[Any, str, str]:
    """Return (client, provider, model) for the requested reasoning mode."""

    if mode in ("ollama", "auto"):
        base_url = os.environ.get("AIKAVACH_OLLAMA_URL", DEFAULT_OLLAMA_URL)
        if not os.environ.get("AIKAVACH_OLLAMA_MODEL"):
            os.environ["AIKAVACH_OLLAMA_MODEL"] = "qwen2.5-coder:3b"
        if mode == "ollama" or ollama_available(base_url):
            from crs.reasoning.ollama_client import OllamaLLMClient

            config = load_ollama_config()
            client = OllamaLLMClient(
                base_url=config.base_url, model=config.model, timeout=config.timeout
            )
            return client, "ollama", config.model
    client = OfflineRulesClient()
    return client, client.provider, client.model


def build_artifacts(record: dict[str, Any], result, output_dir: str) -> dict[str, Any]:
    """Write provenance, SARIF and a signed SLSA attestation for one run."""

    timestamped, latest = write_run_provenance(record, output_dir=output_dir)
    artifacts: dict[str, Any] = {
        "provenance": record,
        "provenance_path": str(timestamped),
        "github_annotation": format_github_annotations(result),
    }

    sarif_path = Path(output_dir) / "latest_run.sarif"
    export_sarif_report(result, sarif_path)
    artifacts["sarif"] = json.loads(sarif_path.read_text(encoding="utf-8"))

    try:
        from cryptography.hazmat.primitives import serialization

        from crs.reporting.slsa_provenance import build_slsa_attestation, generate_keypair

        private_key, public_key = generate_keypair()
        attestation = build_slsa_attestation(record, private_key=private_key)
        attestation["publicKey"] = public_key.public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode("utf-8")
        (Path(output_dir) / "latest_run.slsa.json").write_text(
            json.dumps(attestation, indent=2), encoding="utf-8"
        )
        artifacts["slsa"] = attestation
    except ImportError:
        artifacts["slsa"] = None
    return artifacts


def run_stream(
    target: str,
    mode: str = "auto",
    artifacts_dir: str = "artifacts",
    max_retries: int = 2,
    emit: Callable[[str, dict[str, Any]], None] | None = None,
    pipeline_factory: Callable[[Any], CRSPipeline] | None = None,
) -> int:
    emit = emit or EventWriter()
    started = perf_counter()
    try:
        client, provider, model = select_clients(mode)
    except Exception as exc:
        emit("error", {"stage": "SETUP", "message": str(exc)})
        return 1

    emit("hello", {"target": target, "mode": mode, "provider": provider, "model": model})
    try:
        emit("repo_map", build_repo_map(target))
    except Exception as exc:
        emit("error", {"stage": "FIND", "message": f"Cannot read target: {exc}"})
        return 1

    pipeline = (pipeline_factory or (lambda c: CRSPipeline(reasoning_client=c, patch_client=c)))(client)
    try:
        result = pipeline.run(target, max_retries=max_retries, on_event=emit)
    except NoFindingsError:
        emit("stage", {"stage": "FIND", "status": "done"})
        emit("done", {"decision": "CLEAN", "elapsed": round(perf_counter() - started, 2)})
        return 0
    except PipelineError as exc:
        emit("error", {"stage": exc.stage, "message": str(exc)})
        return 1
    except Exception as exc:
        emit("error", {"stage": "UNKNOWN", "message": str(exc)})
        return 1

    elapsed = perf_counter() - started
    record = build_run_provenance(result, model=model, provider=provider, elapsed_seconds=elapsed)
    try:
        emit("artifacts", build_artifacts(record, result, artifacts_dir))
    except Exception as exc:
        emit("error", {"stage": "REPORT", "message": f"Could not write artifacts: {exc}"})

    emit(
        "done",
        {
            "decision": record["final_decision"],
            "elapsed": round(elapsed, 2),
            "original_repository_modified": False,
        },
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Stream an AIKavach VAYU run as NDJSON.")
    parser.add_argument("target_path")
    parser.add_argument("--mode", choices=["auto", "ollama", "offline"], default="auto")
    parser.add_argument("--artifacts-dir", default="artifacts")
    parser.add_argument("--max-retries", type=int, default=2)
    args = parser.parse_args(argv)
    return run_stream(args.target_path, args.mode, args.artifacts_dir, args.max_retries)


if __name__ == "__main__":
    raise SystemExit(main())
