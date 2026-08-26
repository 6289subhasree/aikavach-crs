"""Optional manual Semgrep-to-Ollama integration helper."""

from crs.ingestion.repository_loader import RepositoryLoader
from crs.reasoning.ollama_client import OllamaLLMClient
from crs.reasoning.ollama_config import format_ollama_diagnostics, load_ollama_config
from crs.reasoning.reasoning_engine import ReasoningEngine
from crs.static_analysis.scanner import StaticScanner


def main() -> None:
    """Scan the command-injection fixture and print validated local reasoning."""

    root = "samples/vulnerable/command_injection"
    config = load_ollama_config()
    client = OllamaLLMClient(
        base_url=config.base_url,
        model=config.model,
        timeout=config.timeout,
    )
    print(format_ollama_diagnostics(config))
    target = RepositoryLoader().load(root)
    finding = StaticScanner().scan(root)[0]
    result = ReasoningEngine(client).reason(
        finding, root, repository_hash=target.repository_hash
    )
    print(result)


if __name__ == "__main__":
    main()
