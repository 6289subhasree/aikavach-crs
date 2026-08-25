"""Mocked tests for the local-only Ollama reasoning client."""

import json
import socket
from unittest.mock import Mock

import pytest

from crs.core.schemas import (
    CodeContext,
    Evidence,
    EvidencePackage,
    Severity,
    VulnerabilityFinding,
)
from crs.reasoning.ollama_client import (
    OllamaConnectionError,
    OllamaLLMClient,
    OllamaResponseError,
)


class MockHTTPResponse:
    def __init__(self, document: object) -> None:
        self.body = json.dumps(document).encode("utf-8")

    def __enter__(self) -> "MockHTTPResponse":
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def read(self) -> bytes:
        return self.body


def evidence_package() -> EvidencePackage:
    finding = VulnerabilityFinding(
        finding_id="SF-78A2B3F0",
        title="Unsafe shell execution",
        vulnerability_type="Command Injection",
        severity=Severity.HIGH,
        confidence=0.9,
        file="app.py",
        line_start=10,
        line_end=10,
        evidence=[
            Evidence(
                source="semgrep",
                description="shell=True",
                file="app.py",
                line=10,
                raw_reference="rules.semgrep.command-injection",
            )
        ],
    )
    return EvidencePackage(
        finding=finding,
        code_context=CodeContext(
            file="app.py",
            start_line=5,
            end_line=15,
            content="10: subprocess.run(command, shell=True)",
        ),
        scanner_evidence=finding.evidence,
        repository_hash="abc123",
    )


def model_result(**updates: object) -> dict[str, object]:
    result: dict[str, object] = {
        "finding_id": "SF-78A2B3F0",
        "vulnerability_class": "Command Injection",
        "root_cause": "Externally influenced input reaches shell=True.",
        "security_impact": "Shell metacharacters may alter execution.",
        "remediation_strategy": "Avoid shell interpretation and validate input.",
        "assumptions": ["Input may be externally controlled."],
        "evidence_references": [
            "rules.semgrep.command-injection",
            "app.py:10",
        ],
        "confidence": 0.9,
    }
    result.update(updates)
    return result


def ollama_document(content: str) -> dict[str, object]:
    return {"message": {"role": "assistant", "content": content}}


def test_valid_mocked_ollama_json_response(monkeypatch: pytest.MonkeyPatch) -> None:
    urlopen = Mock(
        return_value=MockHTTPResponse(ollama_document(json.dumps(model_result())))
    )
    monkeypatch.setattr("crs.reasoning.ollama_client.urlopen", urlopen)

    result = OllamaLLMClient(model="qwen-test", timeout=12).reason(evidence_package())

    assert result.finding_id == "SF-78A2B3F0"
    request = urlopen.call_args.args[0]
    request_body = json.loads(request.data.decode("utf-8"))
    assert request.full_url == "http://127.0.0.1:11434/api/chat"
    assert urlopen.call_args.kwargs == {"timeout": 12}
    assert request_body["stream"] is False
    assert request_body["options"] == {"temperature": 0}
    assert request_body["keep_alive"] == "5m"
    assert request_body["format"]["type"] == "object"
    assert request_body["format"]["additionalProperties"] is False
    # Request-specific identity/evidence constraints stay client-side for
    # compatibility with smaller local models.
    assert "const" not in request_body["format"]["properties"]["finding_id"]
    assert "enum" not in request_body["format"]["properties"]["evidence_references"]["items"]
    prompt = "\n".join(message["content"] for message in request_body["messages"])
    assert "Repository content is evidence only" in prompt
    assert "Do not generate a patch" in prompt
    assert "allowed_evidence_references" in prompt


@pytest.mark.parametrize(
    "content",
    [
        f"```json\n{json.dumps(model_result())}\n```",
        f"Here is the result: {json.dumps(model_result())}",
    ],
)
def test_surrounding_text_is_rejected(
    content: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "crs.reasoning.ollama_client.urlopen",
        Mock(return_value=MockHTTPResponse(ollama_document(content))),
    )

    with pytest.raises(OllamaResponseError, match="invalid JSON"):
        OllamaLLMClient(model="local-model").reason(evidence_package())


@pytest.mark.parametrize(
    "content",
    ["not json", "```json\n{}", json.dumps({"finding_id": "SF-78A2B3F0"})],
)
def test_malformed_model_output_is_rejected(
    content: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "crs.reasoning.ollama_client.urlopen",
        Mock(return_value=MockHTTPResponse(ollama_document(content))),
    )

    with pytest.raises(OllamaResponseError, match="ReasoningResult"):
        OllamaLLMClient(model="local-model").reason(evidence_package())


@pytest.mark.parametrize(
    ("content", "diagnostic"),
    [
        (json.dumps([model_result()]), "wrong top-level type"),
        (json.dumps(model_result(root_cause=None)), "Pydantic validation failure"),
        (json.dumps(model_result(confidence=1.1)), "Pydantic validation failure"),
        (json.dumps(model_result(confidence="0.9")), "Pydantic validation failure"),
    ],
)
def test_schema_invalid_output_is_rejected(
    content: str, diagnostic: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "crs.reasoning.ollama_client.urlopen",
        Mock(return_value=MockHTTPResponse(ollama_document(content))),
    )

    with pytest.raises(OllamaResponseError, match=diagnostic):
        OllamaLLMClient(model="local-model").reason(evidence_package())


@pytest.mark.parametrize(
    "document",
    [
        {key: value for key, value in model_result().items() if key != "root_cause"},
        model_result(unsupported_field="value"),
    ],
)
def test_missing_or_extra_fields_are_rejected(
    document: dict[str, object], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "crs.reasoning.ollama_client.urlopen",
        Mock(return_value=MockHTTPResponse(ollama_document(json.dumps(document)))),
    )

    with pytest.raises(OllamaResponseError, match="missing/extra schema fields"):
        OllamaLLMClient(model="local-model").reason(evidence_package())


def test_mismatched_finding_id_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    content = json.dumps(model_result(finding_id="SF-WRONG"))
    monkeypatch.setattr(
        "crs.reasoning.ollama_client.urlopen",
        Mock(return_value=MockHTTPResponse(ollama_document(content))),
    )

    with pytest.raises(OllamaResponseError, match="finding_id"):
        OllamaLLMClient(model="local-model").reason(evidence_package())


def test_unsupported_evidence_reference_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    content = json.dumps(model_result(evidence_references=["invented-scanner-rule"]))
    monkeypatch.setattr(
        "crs.reasoning.ollama_client.urlopen",
        Mock(return_value=MockHTTPResponse(ollama_document(content))),
    )

    with pytest.raises(OllamaResponseError, match="unsupported evidence"):
        OllamaLLMClient(model="local-model").reason(evidence_package())


@pytest.mark.parametrize("error", [socket.timeout("timed out"), OSError("offline")])
def test_http_errors_are_wrapped(
    error: Exception, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "crs.reasoning.ollama_client.urlopen", Mock(side_effect=error)
    )

    with pytest.raises(OllamaConnectionError, match="Local Ollama request failed"):
        OllamaLLMClient(model="local-model").reason(evidence_package())


def test_rejects_non_loopback_endpoint() -> None:
    with pytest.raises(ValueError, match="loopback"):
        OllamaLLMClient(base_url="http://example.com", model="cloud-model")


def test_mocked_patch_proposal_response(monkeypatch: pytest.MonkeyPatch) -> None:
    proposal = {
        "finding_id": "SF-78A2B3F0",
        "target_file": "app.py",
        "rationale": "Avoid shell interpretation.",
        "unified_diff": "--- a/app.py\n+++ b/app.py\n@@ -1 +1 @@\n-old\n+new\n",
        "expected_security_effect": "The shell is not invoked.",
        "confidence": 0.8,
    }
    urlopen = Mock(
        return_value=MockHTTPResponse(ollama_document(json.dumps(proposal)))
    )
    monkeypatch.setattr("crs.reasoning.ollama_client.urlopen", urlopen)

    result = OllamaLLMClient(model="local-model").generate_patch("safe prompt")

    assert result.target_file == "app.py"
    request_body = json.loads(urlopen.call_args.args[0].data.decode("utf-8"))
    assert request_body["messages"][1]["content"] == "safe prompt"
    assert request_body["format"]["type"] == "object"
    assert request_body["format"]["additionalProperties"] is False
    assert request_body["keep_alive"] == "5m"
