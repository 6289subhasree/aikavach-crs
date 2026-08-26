"""Safe, proposal-only source patch generation and validation."""

from crs.patching.patch_generator import (
    FakePatchLLMClient,
    PatchGenerationError,
    PatchGenerator,
    PatchLLMClient,
)
from crs.patching.patch_validator import PatchValidator

__all__ = [
    "FakePatchLLMClient",
    "PatchGenerationError",
    "PatchGenerator",
    "PatchLLMClient",
    "PatchValidator",
]
