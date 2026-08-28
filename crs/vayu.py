import os
import sys
from pathlib import Path

import click
from rich.console import Console
from rich.panel import Panel
from rich.progress import Progress, SpinnerColumn, TextColumn
from rich.text import Text
from rich.table import Table

from crs.core.schemas import CRSRunResult
from crs.orchestrator import CRSPipeline, PipelineError, NoFindingsError
from crs.reasoning.ollama_client import OllamaClientError, OllamaLLMClient
from crs.reasoning.ollama_config import load_ollama_config
from crs.ingestion.repository_loader import RepositoryLoader
from crs.patching.patch_generator import PatchGenerator
from crs.patching.patch_validator import PatchValidator
from crs.reasoning.evidence_builder import EvidenceBuilder
from crs.reasoning.reasoning_engine import ReasoningEngine
from crs.static_analysis.scanner import StaticScanner
from crs.verification.verification_engine import VerificationEngine

console = Console()

ASCII_LOGO = """[bold orange3]
██╗   ██╗ █████╗ ██╗   ██╗██╗   ██╗
██║   ██║██╔══██╗╚██╗ ██╔╝██║   ██║
██║   ██║███████║ ╚████╔╝ ██║   ██║
╚██╗ ██╔╝██╔══██║  ╚██╔╝  ██║   ██║
 ╚████╔╝ ██║  ██║   ██║   ╚██████╔╝
  ╚═══╝  ╚═╝  ╚═╝   ╚═╝    ╚═════╝ 
[/bold orange3]
[dim orange3]Autonomous Cyber Reasoning System[/dim orange3]
"""

def render_finding(finding):
    text = Text()
    text.append(f"ID: ", style="bold")
    text.append(f"{finding.finding_id}\n", style="cyan")
    text.append(f"Type: ", style="bold")
    text.append(f"{finding.vulnerability_type}\n", style="yellow")
    severity = getattr(finding.severity, "value", finding.severity)
    color = "red" if severity == "HIGH" else "yellow"
    text.append(f"Severity: ", style="bold")
    text.append(f"{severity}\n", style=color)
    text.append(f"Location: ", style="bold")
    text.append(f"{finding.file}:{finding.line_start}", style="white")
    return Panel(text, title="[bold orange3]1. Vulnerability Detected[/]", border_style="orange3")

def render_reasoning(reasoning):
    text = Text()
    text.append(f"Root Cause:\n", style="bold")
    text.append(f"{reasoning.root_cause}\n\n", style="white")
    text.append(f"Security Impact:\n", style="bold")
    text.append(f"{reasoning.security_impact}\n\n", style="white")
    text.append(f"Remediation Strategy:\n", style="bold")
    text.append(f"{reasoning.remediation_strategy}\n\n", style="white")
    text.append(f"Confidence: ", style="bold")
    text.append(f"{reasoning.confidence:.0%}", style="green")
    return Panel(text, title="[bold orange3]2. AI Reasoning[/]", border_style="orange3")

def render_patch(patch):
    text = Text()
    text.append(f"Target File: ", style="bold")
    text.append(f"{patch.target_file}\n", style="cyan")
    text.append(f"Validation: ", style="bold")
    text.append(f"PASSED\n", style="green")
    text.append(f"Expected Security Effect:\n", style="bold")
    text.append(f"{patch.expected_security_effect}", style="white")
    return Panel(text, title="[bold orange3]3. Patch Generation[/]", border_style="orange3")

def _status_color(passed: bool) -> str:
    return "[bold green]PASSED[/]" if passed else "[bold red]FAILED[/]"

def render_verification(verification):
    table = Table(show_header=False, box=None)
    table.add_column("Check", style="bold white")
    table.add_column("Result", justify="right")
    
    table.add_row("Build Integration", _status_color(verification.build_passed))
    table.add_row("Functional Tests", _status_color(verification.tests_passed))
    table.add_row("Security Regression", _status_color(verification.security_test_passed))
    table.add_row("Static Rescan", _status_color(verification.static_rescan_clean))
    
    decision_color = "bold green" if verification.approved else "bold red"
    decision_text = "VERIFIED (Approved for Deployment)" if verification.approved else "REJECTED"
    
    text = Text()
    text.append("\nFinal Decision: ", style="bold")
    text.append(decision_text, style=decision_color)
    
    return Panel.fit(
        table, 
        title="[bold orange3]4. Formal Verification[/]", 
        border_style="orange3",
        subtitle=f"[{decision_color}]{decision_text}[/]"
    )


@click.command()
@click.argument('target_path', type=click.Path(exists=True))
def main(target_path):
    """Run the Vayu Autonomous Cyber Reasoning System on a target repository."""
    console.print(ASCII_LOGO)
    
    provider = os.environ.get("AIKAVACH_LLM_PROVIDER", "").strip().lower()
    if provider != "ollama":
        console.print("[bold red]Error:[/] AIKAVACH_LLM_PROVIDER must be set to 'ollama'")
        sys.exit(1)
        
    try:
        config = load_ollama_config()
        client = OllamaLLMClient(
            base_url=config.base_url,
            model=config.model,
            timeout=config.timeout,
        )
    except Exception as e:
        console.print(f"[bold red]Configuration Error:[/] {e}")
        sys.exit(1)

    console.print(f"[dim]Model:[/] [orange3]{config.model}[/]\n")
    
    # Initialize components
    repository_loader = RepositoryLoader()
    scanner = StaticScanner()
    evidence_builder = EvidenceBuilder()
    reasoning_engine = ReasoningEngine(client, evidence_builder=evidence_builder)
    patch_validator = PatchValidator()
    patch_generator = PatchGenerator(client, validator=patch_validator)
    verifier = VerificationEngine(patch_validator=patch_validator)
    
    target_dir = str(Path(target_path).expanduser())
    
    try:
        with Progress(
            SpinnerColumn(style="orange3"),
            TextColumn("[progress.description]{task.description}"),
            transient=True,
            console=console
        ) as progress:
            
            # Stage 1: FIND
            task_id = progress.add_task("[orange3]Scanning for vulnerabilities...", total=None)
            target = repository_loader.load(target_dir)
            findings = scanner.scan(target.path)
            
            if not findings:
                progress.stop()
                console.print(Panel("[bold green]No vulnerabilities detected.[/]", title="[bold orange3]Scan Complete[/]", border_style="orange3"))
                sys.exit(0)
                
            finding = findings[0]
            progress.stop()
            console.print(render_finding(finding))
            progress.start()
            
            # Stage 2: REASON
            progress.update(task_id, description="[orange3]AI is reasoning about exploitability...")
            evidence = evidence_builder.build(finding, target.path, target.repository_hash)
            reasoning = reasoning_engine.reason_from_evidence(evidence)
            
            progress.stop()
            console.print(render_reasoning(reasoning))
            progress.start()
            
            # Stage 3: PATCH
            progress.update(task_id, description="[orange3]AI is generating secure patch...")
            patch = patch_generator.generate(finding, reasoning, evidence.code_context)
            validation = patch_validator.validate(
                patch,
                finding,
                repository_root=target.path,
                intended_file=evidence.code_context.file,
            )
            if not validation.valid:
                raise ValueError(validation.reason or "Patch proposal is invalid")
                
            progress.stop()
            console.print(render_patch(patch))
            progress.start()
            
            # Stage 4: VERIFY
            progress.update(task_id, description="[orange3]Verifying patch via regression tests...")
            verification = verifier.verify(target.path, finding, patch)
            
            progress.stop()
            console.print(render_verification(verification))
            
    except (PipelineError, OllamaClientError, ValueError, OSError) as exc:
        console.print(Panel(f"[bold red]{exc}[/]", title="[bold red]Pipeline Error[/]"))
        sys.exit(1)

if __name__ == "__main__":
    main()
