from __future__ import annotations
"""Evidence-packaged, guarded vulnerability reasoning."""

from crs.reasoning.evidence_builder import EvidenceBuilder
from crs.reasoning.llm_client import FakeLLMClient, LLMClient
from crs.reasoning.ollama_client import OllamaLLMClient
from crs.reasoning.reasoning_engine import ReasoningEngine

__all__ = [
    "EvidenceBuilder",
    "FakeLLMClient",
    "LLMClient",
    "OllamaLLMClient",
    "ReasoningEngine",
]
